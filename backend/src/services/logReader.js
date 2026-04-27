import { execStream, isConnected } from './sshClient.js';
import { parseLine } from './logParser.js';

const LOGS_PATH = process.env.LOGS_PATH || '/var/lib/3cxpbx/Instance1/Data/Logs';
const MOCK = process.env.MOCK_MODE === 'true';
const PARSER_STALE_MS = 2 * 60 * 1000;

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
      state.lastParsedAt = Date.now();
      chunk.split('\n').forEach(line => {
        const event = parseLine(line);
        if (!event) return;
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

function startWatchdog() {
  parserWatchdog = setInterval(() => {
    if (state.lastParsedAt && Date.now() - state.lastParsedAt > PARSER_STALE_MS) {
      console.warn('[LogReader] No log data for 2+ minutes — parser may be broken');
      if (onAlertCallback) {
        onAlertCallback({
          id: 'parser_stale',
          level: 'ALTO',
          msg: 'Sin datos de logs por más de 2 minutos — el parser puede estar roto (posible cambio de formato tras update del 3CX)',
          ts: new Date().toISOString(),
        });
      }
    }
  }, 60_000);
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
  };
}
