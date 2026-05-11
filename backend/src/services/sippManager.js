import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { insertTest, finalizeTest, insertSnapshot } from '../db/queries.js';
import { validateDestinationOrThrow } from './destinationValidator.js';
import { readSippStatistics, newSippWorkingDir, watchCsvLive } from './sippStatisticsReader.js';
import { generateReport } from './reportGenerator.js';
import { startCapture, stopCapture } from './logReader.js';

// Hard limits — enforced regardless of what the frontend sends
const LIMITS = {
  maxCalls:    256,
  maxRamp:     20,
  maxDuration: 8 * 3600,
};

const SCENARIOS = {
  smoke:  { calls: 1,   duration: 30,    ramp: 1,  name: 'Smoke test'  },
  light:  { calls: 10,  duration: 60,    ramp: 2,  name: 'Light load'  },
  medium: { calls: 50,  duration: 120,   ramp: 5,  name: 'Medium load' },
  peak:   { calls: 180, duration: 300,   ramp: 10, name: 'Peak load'   },
  stress: { calls: 220, duration: 180,   ramp: 15, name: 'Stress test' },
  soak:   { calls: 125, duration: 14400, ramp: 5,  name: 'Soak test'   },
  max:    { calls: 256, duration: 300,   ramp: 15, name: 'Max capacity' },
};

let currentTest = null;
let sippProcess  = null;
let uasProcess   = null;  // SIPp UAS para B2BUA real (load testing profesional)
let onProgress   = null;
let onComplete   = null;

let currentBattery             = null;
let batteryAborted             = false;
let batteryTestCompleteResolve = null;
let onBatteryProgress          = null;
let onBatteryComplete          = null;
let getCurrentMetricsRef       = () => null;

export function initSippManager({ onTestProgress, onTestComplete, onBatteryProgress: onBP, onBatteryComplete: onBC, getMetrics }) {
  onProgress           = onTestProgress;
  onComplete           = onTestComplete;
  onBatteryProgress    = onBP  || null;
  onBatteryComplete    = onBC  || null;
  getCurrentMetricsRef = getMetrics || (() => null);
}

export function getScenarios() {
  return SCENARIOS;
}

export function getTestStatus() {
  return currentTest
    ? { running: true, ...currentTest }
    : { running: false };
}

// Conteo de calls activas DEL TEST EN CURSO. Lo usa metricsCollector para
// que el dashboard refleje el peak real durante un test SIPp (el CSV de SIPp
// es la fuente confiable, mientras que el log del 3CX solo captura el routing
// transient de ~100ms y se pierde entre samples del dashboard).
// Devuelve null si no hay test corriendo — el dashboard cae al log parser.
export function getCurrentTestActiveCalls() {
  return currentTest ? currentTest.activeCalls : null;
}

export async function runTest(params, initiatedBy, _fromBattery = false) {
  if (currentTest) {
    throw new Error('Ya hay una prueba en curso. Detené la prueba actual antes de iniciar otra.');
  }
  if (currentBattery && !_fromBattery) {
    throw new Error('Hay una batería en curso. Usá "Detener batería" para cancelarla.');
  }

  // Resolve scenario preset or use custom params
  const preset = params.scenario && SCENARIOS[params.scenario];
  const resolved = {
    scenario:    params.scenario || 'custom',
    max_calls:   Math.min(parseInt(preset?.calls   ?? params.max_calls   ?? 10), LIMITS.maxCalls),
    duration:    Math.min(parseInt(preset?.duration ?? params.duration   ?? 60), LIMITS.maxDuration),
    ramp_rate:   Math.min(parseInt(preset?.ramp     ?? params.ramp_rate  ?? 2),  LIMITS.maxRamp),
    destination: params.destination || '100',
  };

  // BLOCK-01: validar destino antes de tocar la DB o invocar SIPp.
  // Si falla, throw — la route lo convierte en 400 sin crear testId.
  validateDestinationOrThrow(resolved.destination);

  const testId = await insertTest({ ...resolved, initiated_by: initiatedBy });

  currentTest = {
    id: testId,
    ...resolved,
    startedAt: Date.now(),
    elapsed: 0,
    activeCalls: 0,
    errorRate: 0,
    status: 'running',
  };

  runRealSipp(testId, resolved);

  return { testId, ...resolved };
}

export function stopTest() {
  if (!currentTest) throw new Error('No hay prueba en curso');

  if (sippProcess) {
    sippProcess.kill('SIGTERM');
    sippProcess = null;
  }
  stopUasSipp();

  finishTest(currentTest.id, 'STOPPED', {});
}

// --- SIPp UAS (load testing profesional con B2BUA real) ---
//
// Con SIPP_UAS_ENABLED=true, el manager spawnea un proceso SIPp UAS antes
// del UAC. El UAS escucha en SIPP_UAS_PORT (default 5070) y responde 200 OK
// automáticamente a cualquier INVITE que reciba.
//
// El 3CX rutea via outbound rule las llamadas hacia este UAS, haciendo
// B2BUA real igual que en producción (Tigo UNE → 3CX → agente). Cada call
// activa consume 2 channels del 3CX (un leg por trunk), reflejando el
// comportamiento real del PBX bajo carga.
//
// Sin UAS, el destino es una extensión/queue/IVR interno cuyos límites
// propios opacan la verdadera capacidad del 3CX.

function startUasSipp(sippBin, childEnv) {
  if (process.env.SIPP_UAS_ENABLED !== 'true') return false;
  if (uasProcess) {
    console.log('[SIPp UAS] ya corriendo, reusando');
    return true;
  }

  const uasPort     = process.env.SIPP_UAS_PORT || '5070';
  const uasScenario = path.resolve(process.cwd(), 'sipp-scenarios', 'uas_answer.xml');

  if (!fs.existsSync(uasScenario)) {
    console.error(`[SIPp UAS] scenario no encontrado en ${uasScenario}, abortando`);
    return false;
  }

  const args = [
    '-sf', uasScenario,
    '-p',  uasPort,
    '-bg',                // bg mode: SIPp se daemoniza pero spawn sigue capturando stdio
    '-trace_err',
    '-nostdin',
  ];

  console.log(`[SIPp UAS] iniciando en :${uasPort} con scenario ${uasScenario}`);
  try {
    uasProcess = spawn(sippBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   childEnv,
    });
  } catch (err) {
    console.error('[SIPp UAS] spawn falló:', err.message);
    uasProcess = null;
    return false;
  }

  uasProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString().trimEnd();
    if (line) console.error('[SIPp UAS:stderr]', line);
  });
  uasProcess.stdout.on('data', (chunk) => {
    const line = chunk.toString().trimEnd();
    if (line) console.log('[SIPp UAS:stdout]', line);
  });
  uasProcess.on('close', (code) => {
    console.log(`[SIPp UAS] proceso terminó: code=${code}`);
    uasProcess = null;
  });
  uasProcess.on('error', (err) => {
    console.error('[SIPp UAS] error:', err.message);
  });

  return true;
}

function stopUasSipp() {
  if (uasProcess) {
    console.log('[SIPp UAS] deteniendo');
    try { uasProcess.kill('SIGTERM'); } catch { /* noop */ }
    uasProcess = null;
  }
}

// --- Real SIPp execution ---

function runRealSipp(testId, params) {
  const target      = `${process.env.SSH_HOST}:5060`;
  const sippBin     = process.env.SIPP_BIN || (os.platform() === 'win32' ? 'sipp.exe' : 'sipp');
  const durationMs  = params.duration * 1000;

  // BLOCK-02: SIPp escribe `_statistics.csv` en su cwd cuando se invoca
  // con `-trace_stat`. Damos un cwd dedicado para encontrarlo después
  // sin mezclar con basura del repo.
  const sippCwd = newSippWorkingDir();
  fs.mkdirSync(sippCwd, { recursive: true });

  // El scenario built-in `-sn uac` no maneja el 407 challenge digest del 3CX:
  // la primera respuesta es Proxy-Authenticate y aborta la llamada sin
  // reintentar con Authorization. Cuando hay credenciales en .env usamos
  // un scenario XML custom (uac_auth.xml) que hace el handshake completo:
  // INVITE → 407 → ACK → INVITE+[authentication] → 200 → ACK → BYE.
  const authUser = process.env.SIPP_AUTH_USER;
  const authPass = process.env.SIPP_AUTH_PASS;
  const callerId = process.env.SIPP_CALLER_ID;
  const useAuthScenario = Boolean(authUser && authPass);

  // SIPp (Cygwin build) escribe el CSV en el directorio del -sf, no en el cwd.
  // Copiamos el XML al sippCwd para que CSV y logs queden en el dir dedicado.
  let scenarioArgs;
  if (useAuthScenario) {
    const src = path.resolve(process.cwd(), 'sipp-scenarios', 'uac_auth.xml');
    const dst = path.join(sippCwd, 'uac_auth.xml');
    fs.copyFileSync(src, dst);
    scenarioArgs = ['-sf', dst];
  } else if (callerId) {
    const src = path.resolve(process.cwd(), 'sipp-scenarios', 'uac_ip_trunk.xml');
    const dst = path.join(sippCwd, 'uac_ip_trunk.xml');
    fs.copyFileSync(src, dst);
    scenarioArgs = ['-sf', dst];
  } else {
    scenarioArgs = ['-sn', 'uac'];
  }

  const args = [
    target,
    ...scenarioArgs,
    '-s',  params.destination,
    '-m',  String(params.max_calls),
    '-r',  String(params.ramp_rate),
    '-d',  String(durationMs),
    '-t',  'u1',
    '-recv_timeout', '30000',
    '-trace_err',
    '-trace_stat',
    '-nostdin',
  ];

  if (useAuthScenario) {
    args.push('-au', authUser, '-ap', authPass);
  }
  if (!useAuthScenario && callerId) {
    args.push('-key', 'caller_id', callerId);
  }

  const logArgs = args.map((a, i) => (args[i - 1] === '-ap' ? '***' : a));
  console.log(`[SIPp] ${sippBin} ${logArgs.join(' ')}  (cwd=${sippCwd})`);

  // Cygwin en Windows: sipp.exe depende de cygwin1.dll y demás en cygwin64\bin.
  // El shell de Cygwin las tiene en su PATH, pero `child_process.spawn` hereda
  // solo el PATH del backend (Windows nativo) — sin esto SIPp arranca y muere
  // por DLL faltante antes de escribir el _statistics.csv.
  const cygwinBin = process.env.CYGWIN_BIN_PATH;
  const childEnv = cygwinBin
    ? { ...process.env, PATH: cygwinBin + path.delimiter + (process.env.PATH || '') }
    : process.env;

  // UAS first: el 3CX necesita el destino respondiendo cuando llegue el primer
  // INVITE ruteado por la outbound rule. Si UAS no arranca (puerto ocupado,
  // scenario faltante), seguimos sin él — el test caerá en el destino interno
  // que estaba configurado antes (extensión/queue/IVR), comportamiento legacy.
  startUasSipp(sippBin, childEnv);

  try {
    sippProcess = spawn(sippBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: sippCwd,
      env: childEnv,
    });
  } catch (err) {
    stopUasSipp();
    finishTest(testId, 'ERROR', { error: err.message });
    throw err;
  }

  startCapture(); // capturar líneas del 3CX durante toda la prueba

  const startTime  = Date.now();
  const snapshots  = [];
  const stderrBuf  = [];

  // Live watch del CSV de SIPp para `CurrentCall` real durante el test.
  // El CSV se actualiza cada ~1s (controlado por SIPp con -fd) y mantiene el
  // conteo concurrente durante toda la duración de las calls — a diferencia
  // del log del 3CX (CallStorageSize) que solo se escribe durante el routing.
  const stopCsvWatcher = watchCsvLive(sippCwd, (currentCalls) => {
    if (currentTest) {
      currentTest.activeCalls = currentCalls;
      if (onProgress) onProgress({ ...currentTest });
    }
  });

  // SIPp writes stats to stderr periodically — los seguimos consumiendo
  // para progreso en vivo y como FALLBACK si el CSV final no aparece.
  sippProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    // Acumular en buffer (máx 200 líneas) para el reporte de debug
    const newLines = line.split('\n').map(l => l.trimEnd()).filter(Boolean);
    stderrBuf.push(...newLines);
    if (stderrBuf.length > 200) stderrBuf.splice(0, stderrBuf.length - 200);
    parseSippStats(line, snapshots, testId);
    console.error('[SIPp:stderr]', line.trimEnd());
    if (currentTest) {
      currentTest.elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress({ ...currentTest });
    }
  });

  // Acumular stdout para extraer la tabla de mensajes al final.
  // SIPp imprime el "Scenario Screen" justo antes de terminar — ahí están
  // los conteos de cada paso (incluyendo códigos de error 4xx/5xx recibidos).
  const stdoutBuf = [];
  sippProcess.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t) { stdoutBuf.push(t); console.log('[SIPp:stdout]', t); }
    }
    if (stdoutBuf.length > 200) stdoutBuf.splice(0, stdoutBuf.length - 200);
  });

  sippProcess.on('close', async (code, signal) => {
    console.log(`[SIPp] proceso terminó: code=${code} signal=${signal}`);
    try {
      const cwdEntries = fs.readdirSync(sippCwd);
      console.log(`[SIPp] cwd contents (${sippCwd}):`, cwdEntries);
    } catch (e) {
      console.warn('[SIPp] no se pudo listar cwd:', e.message);
    }
    sippProcess = null;
    stopCsvWatcher();
    stopUasSipp();
    const logLines3cx = stopCapture();

    // BLOCK-02: leer el _statistics.csv final de SIPp en lugar de
    // depender solo del parser de stderr. Si no aparece (SIPp crasheó
    // antes de escribirlo), caer al snapshot in-memory.
    let csvSummary = null;
    try {
      csvSummary = await readSippStatistics(sippCwd, { timeoutMs: 8000, graceMs: 500 });
    } catch (e) {
      console.warn('[SIPp] No se pudo leer _statistics.csv:', e.message);
    }

    console.log('[SIPp] csvSummary parseado:', JSON.stringify(csvSummary));

    const sipErrors = parseSippScenarioErrors(stdoutBuf);
    const summary = csvSummary
      ? buildSummaryFromCsv(csvSummary, params, snapshots, sipErrors)
      : buildSummary(snapshots, params, sipErrors);

    console.log('[SIPp] summary final:', JSON.stringify(summary));

    if (!csvSummary) {
      console.warn('[SIPp] _statistics.csv no apareció — usando snapshots de stderr (fallback).');
      summary.csvMissing = true;
    }

    // Adjuntar datos de debug al summary para el reporte HTML.
    // scenarioScreen: tabla de mensajes que SIPp imprime al terminar (stdout).
    // stderrTail: últimas líneas de stderr — útil para ver mensajes de error crudos.
    // logLines3cx: líneas crudas de los logs del 3CX capturadas durante la prueba.
    summary.debug = {
      scenarioScreen: stdoutBuf.join('\n'),
      stderrTail:     stderrBuf.join('\n'),
      logLines3cx:    logLines3cx,
      sippCwd:        sippCwd,
    };

    const hasCsvData = csvSummary && csvSummary.totalCalls > 0;
    const terminatedBySignal = signal != null;
    const result = hasCsvData
      ? (summary.passed ? 'PASS' : 'FAIL')
      : (terminatedBySignal ? 'STOPPED' : 'ERROR');
    finishTest(testId, result, summary);
  });

  sippProcess.on('error', (err) => {
    console.error('[SIPp] Process error:', err.message);
    stopCsvWatcher();
    stopUasSipp();
    const logLines3cx = stopCapture();
    finishTest(testId, 'ERROR', {
      error: err.message,
      debug: { scenarioScreen: stdoutBuf.join('\n'), stderrTail: stderrBuf.join('\n'), logLines3cx, sippCwd },
    });
  });
}

// Parsea el "Scenario Screen" que SIPp imprime al terminar.
// Extrae códigos de respuesta SIP 3xx/4xx/5xx y timeouts de cada paso.
//
// Formato de línea con respuesta: "1 :   407 <------   256   0   0   0"
//                                  step   code <arrow  count ret to  unexp
// Formato de línea de envío:      "0 :   INVITE --->   256   0   256"
//                                  step  msg   arrow   count ret timeout
// El timeout está en la 3ª columna numérica de líneas de envío (--->>>).
function parseSippScenarioErrors(lines) {
  // Respuestas recibidas (4xx/5xx): "N :   CODE <---   COUNT ..."
  const responseRE = /^\d+\s*:\s+(\d{3})\s+<[-]+\s+(\d+)/;
  // Líneas de envío con timeout en col 3: "N :   MSG --->   sent  retrans  timeout"
  const sendRE = /^\d+\s*:\s+\S.*?[-]+>\s+(\d+)\s+(\d+)\s+(\d+)/;
  const errors = {};
  let timeouts = 0;

  for (const line of lines) {
    const rm = responseRE.exec(line);
    if (rm) {
      const code  = parseInt(rm[1]);
      const count = parseInt(rm[2]);
      if (code >= 300 && count > 0) errors[code] = (errors[code] || 0) + count;
      continue;
    }
    const sm = sendRE.exec(line);
    if (sm) {
      const timeout = parseInt(sm[3]);
      if (timeout > 0) timeouts += timeout;
    }
  }
  if (timeouts > 0) errors['timeout'] = timeouts;
  return errors; // { 407: 256 } | { timeout: 256 } | { 487: 10, timeout: 2 }
}

function parseSippStats(line, snapshots, testId) {
  // SIPp CSV-like output: parse call counts
  const callsMatch = /(\d+)\s+calls/i.exec(line);
  if (callsMatch && currentTest) {
    const calls = parseInt(callsMatch[1]);
    currentTest.activeCalls = calls;
  }
}

function buildSummary(snapshots, params, sipErrors = {}) {
  if (!snapshots.length) return { passed: false, sipErrors };

  const avgCalls   = snapshots.reduce((s, x) => s + (x.calls || 0), 0) / snapshots.length;
  const maxCalls   = Math.max(...snapshots.map(x => x.calls || 0));
  const avgError   = snapshots.reduce((s, x) => s + (x.errorRate || 0), 0) / snapshots.length;
  const peakReached = maxCalls >= params.max_calls * 0.9;
  const passed     = peakReached && avgError < 5;

  let failReason = null;
  if (!passed) {
    const errDetail = formatSipErrors(sipErrors);
    if (!peakReached)
      failReason = `Peak no alcanzado: máximo ${maxCalls} / objetivo ${params.max_calls} (umbral: 90%)${errDetail ? `. ${errDetail}` : ''}`;
    else
      failReason = `Tasa de error promedio ${Math.round(avgError * 10) / 10}% supera el umbral del 5%${errDetail ? `. ${errDetail}` : ''}`;
  }

  return { avgCalls: Math.round(avgCalls), maxCalls, avgErrorRate: Math.round(avgError * 10) / 10, peakReached, passed, failReason, sipErrors };
}

// BLOCK-02: summary canónico desde el _statistics.csv de SIPp.
// Más confiable que parsear stderr — usa los cumulativos finales que
// SIPp persiste explícitamente.
const SIP_ERROR_NAMES = {
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Moved Temporarily',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Auth Required',
  408: 'Request Timeout', 410: 'Gone', 413: 'Request Entity Too Large',
  415: 'Unsupported Media Type', 420: 'Bad Extension', 480: 'Temporarily Unavailable',
  481: 'Call Leg Does Not Exist', 482: 'Loop Detected', 483: 'Too Many Hops',
  484: 'Address Incomplete', 486: 'Busy Here', 487: 'Request Terminated',
  488: 'Not Acceptable Here', 491: 'Request Pending', 493: 'Undecipherable',
  500: 'Server Internal Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Server Time-out', 505: 'Version Not Supported',
  600: 'Busy Everywhere', 603: 'Decline', 604: 'Does Not Exist', 606: 'Not Acceptable',
};

function formatSipErrors(sipErrors) {
  if (!sipErrors || Object.keys(sipErrors).length === 0) return '';
  return Object.entries(sipErrors)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => {
      const name = code === 'timeout'
        ? 'Sin respuesta (recv_timeout)'
        : (SIP_ERROR_NAMES[parseInt(code)] ? `${code} ${SIP_ERROR_NAMES[parseInt(code)]}` : `SIP ${code}`);
      return `${name} ×${count}`;
    })
    .join(', ');
}

function buildSummaryFromCsv(csv, params, fallbackSnapshots = [], sipErrors = {}) {
  const total      = csv.totalCalls ?? 0;
  const successful = csv.successful ?? 0;
  const failed     = csv.failed ?? 0;
  const maxCalls   = csv.maxConcurrent ?? Math.max(0, ...fallbackSnapshots.map(s => s.calls || 0));
  const errorRate  = total > 0 ? (failed / total) * 100 : 0;
  // peakReached basado en `total` (TotalCallCreated) en vez de `maxConcurrent`:
  // los snapshots periódicos del CSV pueden caer en momentos donde CurrentCall=0
  // (entre el inicio y fin de una llamada corta), perdiendo el pico real.
  // `total` es cumulativo y captura el verdadero alcance del test.
  const peakReached = total >= params.max_calls * 0.9;
  const passed     = peakReached && errorRate < 5 && successful > 0;

  const errDetail = formatSipErrors(sipErrors);

  let failReason = null;
  if (!passed) {
    if (successful === 0)
      failReason = `Ninguna llamada completó exitosamente${errDetail ? ` — ${errDetail}` : ''}`;
    else if (!peakReached)
      failReason = `Peak no alcanzado: ${total} de ${params.max_calls} llamadas completadas (umbral: 90%)${errDetail ? `. ${errDetail}` : ''}`;
    else if (errorRate >= 5)
      failReason = `Tasa de error ${Math.round(errorRate * 10) / 10}% (${failed}/${total} llamadas fallaron)${errDetail ? `. ${errDetail}` : ''}`;
  }

  return {
    totalCalls: total,
    successful,
    failed,
    maxCalls,
    avgErrorRate: Math.round(errorRate * 10) / 10,
    callRate: csv.callRate,
    responseAvgMs: csv.responseAvgMs,
    peakReached,
    passed,
    failReason,
    sipErrors,
    source: 'csv',
  };
}

function finishTest(testId, result, summary) {
  finalizeTest(testId, { result, summary })
    .then(() => generateReport(testId))
    .catch(e => console.error('[Report] Error:', e.message));

  const finished = { ...currentTest, result, summary, status: 'finished' };
  currentTest = null;

  if (onComplete) onComplete(finished);
  if (batteryTestCompleteResolve) {
    const r = batteryTestCompleteResolve;
    batteryTestCompleteResolve = null;
    r(finished);
  }
  console.log(`[SIPp] Test ${testId} finished: ${result}`);
}

// ─── Battery ──────────────────────────────────────────────────────────────────

const DEFAULT_BATTERY_LEVELS = [
  { key: 'light',  label: 'Light',  calls: 10,  duration: 89, ramp: 2  },
  { key: 'medium', label: 'Medium', calls: 50,  duration: 89, ramp: 5  },
  { key: 'peak',   label: 'Peak',   calls: 180, duration: 89, ramp: 10 },
  { key: 'stress', label: 'Stress', calls: 220, duration: 89, ramp: 15 },
  { key: 'max',    label: 'Max',    calls: 256, duration: 89, ramp: 15 },
];

export function getBatteryStatus() {
  return currentBattery ? { running: true, ...currentBattery } : { running: false };
}

export function stopBattery() {
  if (!currentBattery) throw new Error('No hay batería en curso');
  batteryAborted = true;
  if (currentTest && sippProcess) {
    sippProcess.kill('SIGTERM');
    sippProcess = null;
    stopUasSipp();
  }
}

export async function runBattery({ destination, levels }, initiatedBy) {
  if (currentTest)   throw new Error('Hay una prueba individual en curso. Detenela antes de iniciar una batería.');
  if (currentBattery) throw new Error('Ya hay una batería en curso.');

  validateDestinationOrThrow(destination);

  const selectedLevels = levels || DEFAULT_BATTERY_LEVELS;
  batteryAborted = false;

  currentBattery = {
    destination,
    totalLevels: selectedLevels.length,
    currentLevelIdx: -1,
    currentLevel: null,
    results: [],
    startedAt: Date.now(),
  };

  _runBatterySequence(destination, selectedLevels, initiatedBy).catch(err => {
    console.error('[Battery] Error inesperado:', err.message);
    const report = {
      destination,
      completedAt: new Date().toISOString(),
      levels: currentBattery?.results || [],
      aborted: true,
      error: err.message,
    };
    currentBattery = null;
    if (onBatteryComplete) onBatteryComplete(report);
  });

  return { levelCount: selectedLevels.length };
}

async function _runBatterySequence(destination, levels, initiatedBy) {
  const results = [];

  for (let i = 0; i < levels.length; i++) {
    if (batteryAborted) break;

    const level = levels[i];
    currentBattery.currentLevelIdx = i;
    currentBattery.currentLevel    = level;

    if (onBatteryProgress) onBatteryProgress({
      type:        'level:start',
      levelIdx:    i,
      totalLevels: levels.length,
      level,
      results:     [...results],
    });

    console.log(`[Battery] Nivel ${i + 1}/${levels.length} — ${level.label} (${level.calls} llamadas, ${level.duration}s)`);

    // Captura CPU/RAM durante el test muestreando getCurrentMetrics cada 2s.
    const cpuSamples = [];
    const ramSamples = [];
    const metricsInterval = setInterval(() => {
      const m = getCurrentMetricsRef();
      if (m) {
        cpuSamples.push(m.host.cpu);
        ramSamples.push(m.host.ram);
      }
    }, 2000);

    let levelResult;
    try {
      levelResult = await new Promise((resolve) => {
        batteryTestCompleteResolve = resolve;
        runTest(
          { max_calls: level.calls, duration: level.duration, ramp_rate: level.ramp, destination },
          initiatedBy,
          true,   // _fromBattery — bypasses the battery guard
        ).catch(err => {
          batteryTestCompleteResolve = null;
          resolve({ result: 'ERROR', summary: { error: err.message } });
        });
      });
    } finally {
      clearInterval(metricsInterval);
    }

    // CPU steady: promedio del bloque central (excluye primeras y últimas muestras de rampa)
    const cpuMid    = cpuSamples.length > 6 ? cpuSamples.slice(3, -3) : cpuSamples;
    const cpuSteady = cpuMid.length > 0
      ? Math.round(cpuMid.reduce((a, b) => a + b, 0) / cpuMid.length * 10) / 10
      : (cpuSamples[0] ?? 0);
    const cpuPeak = cpuSamples.length > 0 ? Math.round(Math.max(...cpuSamples) * 10) / 10 : 0;
    const ramPeak = ramSamples.length > 0 ? Math.round(Math.max(...ramSamples) * 10) / 10 : 0;

    const levelReport = {
      key:        level.key,
      label:      level.label,
      calls:      level.calls,
      successful: levelResult.summary?.successful ?? 0,
      failed:     levelResult.summary?.failed     ?? 0,
      cpuSteady,
      cpuPeak,
      ramPeak,
      result:     batteryAborted ? 'STOPPED' : (levelResult.result ?? 'ERROR'),
      failReason: levelResult.summary?.failReason ?? null,
    };

    results.push(levelReport);
    currentBattery.results = [...results];

    if (onBatteryProgress) onBatteryProgress({
      type:          'level:complete',
      levelIdx:      i,
      totalLevels:   levels.length,
      levelReport,
      results:       [...results],
    });

    if (batteryAborted) break;

    // No continúa si el proceso SIPp crasheó (ERROR = sin datos CSV).
    // Un FAIL (umbral superado) no detiene la batería — queremos ver todos los niveles.
    if (levelResult.result === 'ERROR') {
      console.log(`[Battery] Nivel ${level.key} ERROR — abortando batería`);
      break;
    }

    // Pausa breve entre niveles para que el 3CX drene las conexiones
    if (i < levels.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  const batteryReport = {
    destination,
    completedAt:    new Date().toISOString(),
    levels:         results,
    aborted:        batteryAborted,
    totalLevels:    levels.length,
    completedLevels: results.length,
  };

  currentBattery = null;
  batteryAborted = false;

  if (onBatteryComplete) onBatteryComplete(batteryReport);
}
