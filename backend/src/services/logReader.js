import { execStream, isConnected } from './sshClient.js';
import { parseLine } from './logParser.js';
import { addExternalAlert, clearExternalAlert } from './anomalyDetector.js';

const LOGS_PATH = process.env.LOGS_PATH || '/var/lib/3cxpbx/Instance1/Data/Logs';
const MOCK = process.env.MOCK_MODE === 'true';
const PARSER_STALE_MS = 2 * 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 1000; // mínimo entre re-emisiones del mismo estado

const LOG_FILES = [
  '3CXCallFlow.log',
  '3CXGatewayService.log',
  '3CXQueueManager.log',
  '3cxSystemService.log',
  '3CXIVR.log',
].map(f => `${LOGS_PATH}/${f}`);

const state = {
  activeCalls: 0,
  errors408: 0,
  errors503: 0,
  trunkRegistered: true,
  queueWaiting: 0,
  agentsOnline: 0,
  lastParsedAt: null,

  // BLOCK-03: contadores para distinguir 3 estados del parser.
  // - linesReceived: cualquier línea que llegó por el stream SSH
  // - linesMatched:  líneas que parseLine() reconoció como evento conocido
  // El ratio matched/received indica si el parser sigue funcionando o
  // si los regex quedaron desactualizados tras un update del 3CX.
  linesReceived: 0,
  linesMatched: 0,
  lastReceivedAt: null,

  // Estado actual del watchdog (para no spamear alertas iguales).
  lastAlertId: null,
  lastAlertAt: 0,
};

let onAlertCallback = null;
let parserWatchdog = null;
let streamCleanup = null;

export function startLogReader(onAlert) {
  onAlertCallback = onAlert;

  if (MOCK) {
    console.log('[LogReader] Mock mode — no SSH log tailing');
    return;
  }

  attachStream();
  startWatchdog();
}

function attachStream() {
  // - stdbuf -oL fuerza line-buffered (sino tail bufferiza por bloques sobre el pipe SSH)
  // - SIN -q porque necesitamos los headers "==> file <==" para que detectFile()
  //   sepa qué archivo es cada línea; con -q el parser nunca puede asignar fileType.
  // - -n 0 evita el dump del histórico al arrancar (solo seguimos lo nuevo).
  const cmd = `stdbuf -oL tail -F -n 0 ${LOG_FILES.join(' ')} 2>&1`;

  streamCleanup = execStream(
    cmd,
    (chunk) => {
      const now = Date.now();
      state.lastReceivedAt = now;
      const lines = chunk.split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        state.linesReceived++;
        const event = parseLine(line);
        if (!event) return;
        state.linesMatched++;
        state.lastParsedAt = now;
        applyEvent(event);
      });
    },
    (code) => {
      console.warn(`[LogReader] Stream closed (code ${code}), will re-attach`);
      // SSH client handles reconnect; we'll re-attach after reconnection
      setTimeout(attachStream, 5000);
    }
  );
}

function applyEvent(event) {
  switch (event.type) {
    case 'call_active':
      state.activeCalls++;
      break;
    case 'call_ended':
    case 'call_failed':
      state.activeCalls = Math.max(0, state.activeCalls - 1);
      break;
    case 'error_408':
      state.errors408++;
      break;
    case 'error_503':
      state.errors503++;
      break;
    case 'trunk_registered':
      state.trunkRegistered = true;
      break;
    case 'trunk_unregistered':
      state.trunkRegistered = false;
      if (onAlertCallback) onAlertCallback({ id: 'trunk_down', level: 'CRITICO', msg: 'Troncal Tigo UNE desregistrada', ts: event.ts });
      break;
    case 'queue_waiting':
      state.queueWaiting = event.count;
      break;
    case 'agents_online':
      state.agentsOnline = event.count;
      break;
    default:
      break;
  }
}

// Alertas del watchdog que tracked como "externas" en anomalyDetector
// para que aparezcan en el snapshot de /api/status y al reconectar el WS.
const PARSER_ALERT_IDS = ['ssh_down', 'parser_broken', 'no_traffic'];

function emitOnce(alert) {
  const now = Date.now();
  // Si es el mismo estado que ya alertamos hace poco, no spamear el WS.
  const sameAlert = state.lastAlertId === alert.id;
  const shouldEmitWs = !sameAlert || (now - state.lastAlertAt) >= ALERT_COOLDOWN_MS;

  // Persistir en el snapshot SIEMPRE (no solo cuando emitimos al WS).
  // Esto asegura que un cliente que se conecta justo ahora vea la alerta.
  addExternalAlert(alert);

  if (shouldEmitWs) {
    state.lastAlertId = alert.id;
    state.lastAlertAt = now;
    if (onAlertCallback) onAlertCallback(alert);
  }
}

function clearParserAlerts() {
  // Cuando volvemos a 'ok', limpiar las 3 alertas posibles del watchdog.
  for (const id of PARSER_ALERT_IDS) clearExternalAlert(id);
}

// BLOCK-03: state machine del parser/SSH.
// Devuelve uno de: 'ok' | 'no_traffic' | 'parser_broken' | 'ssh_down'.
function diagnoseParserState() {
  // 1. SSH caído: la conexión está down. Es la condición más severa.
  if (!isConnected()) return 'ssh_down';

  // 2. Sin datos en >2min — distinguimos entre "sin tráfico" y "parser roto":
  //    - Si NO llegaron líneas (lastReceivedAt stale) → sin tráfico real
  //      (3CX silencioso, fuera de horario, sin llamadas).
  //    - Si llegaron líneas pero ninguna matcheó → parser roto / regex drift.
  const now = Date.now();
  const sinceReceived = state.lastReceivedAt ? now - state.lastReceivedAt : Infinity;
  const sinceParsed   = state.lastParsedAt   ? now - state.lastParsedAt   : Infinity;

  if (sinceReceived > PARSER_STALE_MS) {
    // No llegan líneas crudas — SSH up pero el 3CX está callado.
    return 'no_traffic';
  }
  if (sinceParsed > PARSER_STALE_MS && state.linesReceived > 0) {
    // Llegan líneas pero nada matchea → regex desactualizado.
    return 'parser_broken';
  }
  return 'ok';
}

function startWatchdog() {
  parserWatchdog = setInterval(() => {
    const status = diagnoseParserState();

    switch (status) {
      case 'ssh_down':
        emitOnce({
          id: 'ssh_down',
          level: 'CRITICO',
          msg: 'Conexión SSH al 3CX caída — sin métricas en vivo. La plataforma intenta reconectar automáticamente.',
          ts: new Date().toISOString(),
        });
        break;
      case 'parser_broken':
        emitOnce({
          id: 'parser_broken',
          level: 'ALTO',
          msg: `Parser de logs sin matches ${Math.round((Date.now() - state.lastParsedAt) / 60000)}min — el formato del 3CX puede haber cambiado tras un update. Revisar regex en logParser.js.`,
          ts: new Date().toISOString(),
        });
        break;
      case 'no_traffic':
        emitOnce({
          id: 'no_traffic',
          level: 'BAJO',
          msg: 'Sin tráfico real en los logs del 3CX (>2min). SSH OK, 3CX silencioso. Esperado fuera de horario operativo.',
          ts: new Date().toISOString(),
        });
        break;
      case 'ok':
      default:
        // Si veníamos en estado degradado, limpiamos las alertas del watchdog
        // del snapshot y reseteamos el cooldown para que el próximo problema
        // emita inmediatamente.
        if (state.lastAlertId && PARSER_ALERT_IDS.includes(state.lastAlertId)) {
          clearParserAlerts();
          state.lastAlertId = null;
          state.lastAlertAt = 0;
        }
        break;
    }
  }, 30_000);
}

// Reset rolling error counters periodically (called by metricsCollector)
export function resetHourlyCounters() {
  state.errors408 = 0;
  state.errors503 = 0;
}

export function getLogState() {
  return {
    activeCalls: state.activeCalls,
    errors408:   state.errors408,
    errors503:   state.errors503,
    trunkRegistered: state.trunkRegistered,
    queueWaiting: state.queueWaiting,
    agentsOnline: state.agentsOnline,
    lastParsedAt: state.lastParsedAt,
    lastReceivedAt: state.lastReceivedAt,
    linesReceived: state.linesReceived,
    linesMatched: state.linesMatched,
    parserState: diagnoseParserState(),
  };
}
