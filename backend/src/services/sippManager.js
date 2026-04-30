import { spawn } from 'child_process';
import os from 'os';
import { insertTest, finalizeTest, insertSnapshot } from '../db/queries.js';
import { setMockTestOverride } from './metricsCollector.js';

const MOCK = process.env.MOCK_MODE === 'true';

// Hard limits — enforced regardless of what the frontend sends
const LIMITS = {
  maxCalls:    200,
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
};

let currentTest = null;
let sippProcess  = null;
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

  if (MOCK) {
    runMockTest(testId, resolved);
  } else {
    runRealSipp(testId, resolved);
  }

  return { testId, ...resolved };
}

export function stopTest() {
  if (!currentTest) throw new Error('No hay prueba en curso');

  if (sippProcess) {
    sippProcess.kill('SIGTERM');
    sippProcess = null;
  }

  finishTest(currentTest.id, 'STOPPED', {});
}

// --- Mock test simulation ---

function runMockTest(testId, params) {
  setMockTestOverride({ targetCalls: params.max_calls });

  const rampMs    = (params.max_calls / params.ramp_rate) * 1000;
  const totalMs   = params.duration * 1000;
  const startTime = Date.now();
  let   snapshotTimer = null;
  const snapshots = [];

  const tick = setInterval(() => {
    if (!currentTest) { clearInterval(tick); return; }

    const elapsed   = Date.now() - startTime;
    const progress  = Math.min(elapsed / totalMs, 1);
    const rampProg  = Math.min(elapsed / rampMs, 1);
    const calls     = Math.round(rampProg * params.max_calls * (1 + (Math.random() - 0.5) * 0.1));
    const errorRate = calls > params.max_calls * 0.9 ? (Math.random() * 8) : (Math.random() * 1.5);

    currentTest.elapsed     = Math.round(elapsed / 1000);
    currentTest.activeCalls = calls;
    currentTest.errorRate   = Math.round(errorRate * 10) / 10;
    currentTest.progress    = Math.round(progress * 100);

    const snap = { calls, errorRate: currentTest.errorRate, elapsed: currentTest.elapsed };
    snapshots.push(snap);
    if (snapshots.length % 6 === 0) insertSnapshot(testId, snap).catch(e => console.error('[DB] Snapshot error:', e.message)); // persist every 30s

    if (onProgress) onProgress({ ...currentTest });

    if (elapsed >= totalMs) {
      clearInterval(tick);
      setMockTestOverride(null);

      const summary = buildSummary(snapshots, params);
      finishTest(testId, summary.passed ? 'PASS' : 'FAIL', summary);
    }
  }, 1000);
}

// --- Real SIPp execution ---

function runRealSipp(testId, params) {
  const target      = `${process.env.SSH_HOST}:5060`;
  const sippBin     = process.env.SIPP_BIN || (os.platform() === 'win32' ? 'sipp.exe' : 'sipp');
  const durationMs  = params.duration * 1000;

  const args = [
    target,
    '-sn', 'uac',
    '-s',  params.destination,
    '-m',  String(params.max_calls),
    '-r',  String(params.ramp_rate),
    '-d',  String(durationMs),
    '-trace_err',
    '-trace_stat',
    '-nostdin',
  ];

  console.log(`[SIPp] ${sippBin} ${args.join(' ')}`);

  try {
    sippProcess = spawn(sippBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    finishTest(testId, 'ERROR', { error: err.message });
    throw err;
  }

  const startTime  = Date.now();
  const snapshots  = [];

  // SIPp writes stats to stderr periodically
  sippProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    parseSippStats(line, snapshots, testId);
    if (currentTest) {
      currentTest.elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress({ ...currentTest });
    }
  });

  sippProcess.on('close', (code) => {
    sippProcess = null;
    const summary = buildSummary(snapshots, params);
    finishTest(testId, code === 0 ? (summary.passed ? 'PASS' : 'FAIL') : 'ERROR', summary);
  });

  sippProcess.on('error', (err) => {
    console.error('[SIPp] Process error:', err.message);
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

function finishTest(testId, result, summary) {
  finalizeTest(testId, { result, summary }).catch(e => console.error('[DB] Finalize error:', e.message));

  const finished = { ...currentTest, result, summary, status: 'finished' };
  currentTest = null;

  if (onComplete) onComplete(finished);
  console.log(`[SIPp] Test ${testId} finished: ${result}`);
}
