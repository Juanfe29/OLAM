import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { insertTest, finalizeTest, insertSnapshot } from '../db/queries.js';
import { validateDestinationOrThrow } from './destinationValidator.js';
import { readSippStatistics, newSippWorkingDir } from './sippStatisticsReader.js';

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

export function initSippManager({ onTestProgress, onTestComplete }) {
  onProgress = onTestProgress;
  onComplete = onTestComplete;
}

export function getScenarios() {
  return SCENARIOS;
}

export function getTestStatus() {
  return currentTest
    ? { running: true, ...currentTest }
    : { running: false };
}

export async function runTest(params, initiatedBy) {
  if (currentTest) {
    throw new Error('Ya hay una prueba en curso. Detené la prueba actual antes de iniciar otra.');
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
  const useAuthScenario = Boolean(authUser && authPass);

  const scenarioArgs = useAuthScenario
    ? ['-sf', path.resolve(process.cwd(), 'sipp-scenarios', 'uac_auth.xml')]
    : ['-sn', 'uac'];

  const args = [
    target,
    ...scenarioArgs,
    '-s',  params.destination,
    '-m',  String(params.max_calls),
    '-r',  String(params.ramp_rate),
    '-d',  String(durationMs),
    '-t',  'u1',
    '-recv_timeout', '15000',
    '-trace_err',
    '-trace_stat',
    '-nostdin',
  ];

  if (useAuthScenario) {
    args.push('-au', authUser, '-ap', authPass);
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

  const startTime  = Date.now();
  const snapshots  = [];

  // SIPp writes stats to stderr periodically — los seguimos consumiendo
  // para progreso en vivo y como FALLBACK si el CSV final no aparece.
  sippProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    parseSippStats(line, snapshots, testId);
    // DIAGNÓSTICO: loguear TODO stderr crudo, sin filtro.
    // Antes filtrábamos por /error|fatal|.../ pero perdíamos mensajes útiles
    // cuando SIPp moría sin matchear esos patrones.
    console.error('[SIPp:stderr]', line.trimEnd());
    if (currentTest) {
      currentTest.elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress({ ...currentTest });
    }
  });

  sippProcess.stdout.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.log('[SIPp:stdout]', line);
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
    stopUasSipp();

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

    const summary = csvSummary
      ? buildSummaryFromCsv(csvSummary, params, snapshots)
      : buildSummary(snapshots, params);

    console.log('[SIPp] summary final:', JSON.stringify(summary));

    if (!csvSummary) {
      console.warn('[SIPp] _statistics.csv no apareció — usando snapshots de stderr (fallback).');
      summary.csvMissing = true;
    }

    finishTest(testId, code === 0 ? (summary.passed ? 'PASS' : 'FAIL') : 'ERROR', summary);
  });

  sippProcess.on('error', (err) => {
    console.error('[SIPp] Process error:', err.message);
    stopUasSipp();
    finishTest(testId, 'ERROR', { error: err.message });
  });
}

function parseSippStats(line, snapshots, testId) {
  // SIPp CSV-like output: parse call counts
  const callsMatch = /(\d+)\s+calls/i.exec(line);
  if (callsMatch && currentTest) {
    const calls = parseInt(callsMatch[1]);
    currentTest.activeCalls = calls;
  }
}

function buildSummary(snapshots, params) {
  if (!snapshots.length) return { passed: false };

  const avgCalls   = snapshots.reduce((s, x) => s + (x.calls || 0), 0) / snapshots.length;
  const maxCalls   = Math.max(...snapshots.map(x => x.calls || 0));
  const avgError   = snapshots.reduce((s, x) => s + (x.errorRate || 0), 0) / snapshots.length;
  const peakReached = maxCalls >= params.max_calls * 0.9;
  const passed     = peakReached && avgError < 5;

  return { avgCalls: Math.round(avgCalls), maxCalls, avgErrorRate: Math.round(avgError * 10) / 10, peakReached, passed };
}

// BLOCK-02: summary canónico desde el _statistics.csv de SIPp.
// Más confiable que parsear stderr — usa los cumulativos finales que
// SIPp persiste explícitamente.
function buildSummaryFromCsv(csv, params, fallbackSnapshots = []) {
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
    source: 'csv',
  };
}

function finishTest(testId, result, summary) {
  finalizeTest(testId, { result, summary }).catch(e => console.error('[DB] Finalize error:', e.message));

  const finished = { ...currentTest, result, summary, status: 'finished' };
  currentTest = null;

  if (onComplete) onComplete(finished);
  console.log(`[SIPp] Test ${testId} finished: ${result}`);
}
