import axios from 'axios';
import { getLogState } from './logReader.js';

const MOCK = process.env.MOCK_MODE === 'true';
const POLL_INTERVAL = parseInt(process.env.LOG_POLL_INTERVAL || '5000');
const NODE_EXPORTER_URL = process.env.NODE_EXPORTER_URL || 'http://172.18.164.28:9100/metrics';

let currentMetrics = null;
let pollTimer = null;

// Track previous CPU counters for delta calculation
let prevCpuCounters = null;

// Mock state with realistic drift
const mockState = {
  activeCalls: 18,
  errors408: 0,
  trunkRegistered: true,
  tick: 0,
};

function jitter(range) {
  return (Math.random() - 0.5) * 2 * range;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function buildMockMetrics(testOverride = null) {
  mockState.tick++;

  // Gradually drift active calls
  mockState.activeCalls = clamp(
    mockState.activeCalls + jitter(1.5),
    testOverride ? testOverride.targetCalls * 0.85 : 8,
    testOverride ? testOverride.targetCalls * 1.05 : 30,
  );

  // Simulate occasional 408 burst
  if (Math.random() < 0.05) mockState.errors408++;

  const calls = Math.round(mockState.activeCalls);
  const ratio = calls / 32; // SC32 baseline

  return buildMetricsShape({
    cpu:           clamp(35 + ratio * 32 + jitter(4), 0, 100),
    ram:           clamp(55 + ratio * 18 + jitter(3), 0, 100),
    loadAvg:       [clamp(1.1 + ratio * 1.2, 0, 16), clamp(1.0 + ratio, 0, 16), clamp(0.9 + ratio * 0.8, 0, 16)],
    diskOs:        42,
    diskRec:       28,
    netRx:         Math.round(4_000_000 + ratio * 3_000_000 + jitter(200_000)),
    netTx:         Math.round(3_500_000 + ratio * 2_500_000 + jitter(150_000)),
    activeCalls:   calls,
    errors408:     mockState.errors408,
    errors503:     0,
    trunkReg:      mockState.trunkRegistered,
    channelsUsed:  Math.round(calls * 0.45),
    channelsTotal: 30,
    pdd:           clamp(1.2 + ratio * 1.8 + jitter(0.2), 0.5, 8),
    asr:           clamp(98.5 - ratio * 4 + jitter(0.5), 0, 100),
    errorRate:     clamp(ratio * 2.5 + jitter(0.4), 0, 100),
    mos:           clamp(4.3 - ratio * 0.7 + jitter(0.1), 1, 5),
    jitterMs:      clamp(8 + ratio * 18 + jitter(2), 0, 150),
    packetLoss:    clamp(0.1 + ratio * 0.9 + jitter(0.1), 0, 100),
    queueWaiting:  Math.max(0, Math.round(ratio * 5 + jitter(1))),
    agentsOnline:  12,
    serviceLevel:  clamp(87 - ratio * 18 + jitter(3), 0, 100),
    abandonment:   clamp(2.5 + ratio * 9 + jitter(1), 0, 100),
  });
}

function buildMetricsShape(d) {
  return {
    timestamp: new Date().toISOString(),
    host: {
      cpu:      Math.round(d.cpu * 10) / 10,
      ram:      Math.round(d.ram * 10) / 10,
      loadAvg:  d.loadAvg.map(v => Math.round(v * 100) / 100),
      disk:     { os: d.diskOs, recordings: d.diskRec },
      network:  { rx: d.netRx, tx: d.netTx },
    },
    calls: {
      active:    d.activeCalls,
      tier:      32,
      pdd_p95:   Math.round(d.pdd * 100) / 100,
      asr:       Math.round(d.asr * 10) / 10,
      errorRate: Math.round(d.errorRate * 10) / 10,
    },
    quality: {
      mos:        Math.round(d.mos * 100) / 100,
      jitter_p95: Math.round(d.jitterMs * 10) / 10,
      packetLoss: Math.round(d.packetLoss * 100) / 100,
    },
    trunk: {
      registered:     d.trunkReg,
      channelsUsed:   d.channelsUsed,
      channelsTotal:  d.channelsTotal,
      errors408:      d.errors408,
      errors503:      d.errors503,
      pddToCarrier:   Math.round((d.pdd * 0.6) * 100) / 100,
    },
    queue: {
      waiting:      d.queueWaiting,
      agentsOnline: d.agentsOnline,
      serviceLevel: Math.round(d.serviceLevel * 10) / 10,
      abandonment:  Math.round(d.abandonment * 10) / 10,
    },
  };
}

// Prometheus text format parser — extract specific metric values
function parsePrometheus(text) {
  const lines = text.split('\n');
  const values = {};
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    const spaceIdx = line.lastIndexOf(' ');
    if (spaceIdx === -1) continue;
    const key = line.substring(0, spaceIdx);
    const val = parseFloat(line.substring(spaceIdx + 1));
    if (!isNaN(val)) values[key] = val;
  }
  return values;
}

function extractCpuPercent(metrics) {
  // Sum idle and total across all CPUs to calculate usage %
  let idleTotal = 0, allTotal = 0;
  for (const [key, val] of Object.entries(metrics)) {
    if (!key.startsWith('node_cpu_seconds_total')) continue;
    allTotal += val;
    if (key.includes('mode="idle"')) idleTotal += val;
  }

  if (!prevCpuCounters) {
    prevCpuCounters = { idle: idleTotal, all: allTotal };
    return 0;
  }

  const idleDelta = idleTotal - prevCpuCounters.idle;
  const allDelta  = allTotal  - prevCpuCounters.all;
  prevCpuCounters = { idle: idleTotal, all: allTotal };

  if (allDelta === 0) return 0;
  return clamp((1 - idleDelta / allDelta) * 100, 0, 100);
}

async function fetchRealMetrics() {
  const logState = getLogState();

  let hostMetrics = null;
  try {
    const { data } = await axios.get(NODE_EXPORTER_URL, { timeout: 4000 });
    const pm = parsePrometheus(data);

    const cpuPct = extractCpuPercent(pm);
    const memTotal = pm['node_memory_MemTotal_bytes'] || 1;
    const memAvail = pm['node_memory_MemAvailable_bytes'] || 0;
    const ramPct   = ((memTotal - memAvail) / memTotal) * 100;

    const diskOs   = pm['node_filesystem_size_bytes{mountpoint="/"}']
      ? (1 - pm['node_filesystem_free_bytes{mountpoint="/"}'] / pm['node_filesystem_size_bytes{mountpoint="/"}']) * 100
      : 0;

    hostMetrics = {
      cpu:     Math.round(cpuPct * 10) / 10,
      ram:     Math.round(ramPct * 10) / 10,
      loadAvg: [pm['node_load1'] || 0, pm['node_load5'] || 0, pm['node_load15'] || 0],
      disk:    { os: Math.round(diskOs), recordings: 0 },
      network: {
        rx: pm['node_network_receive_bytes_total{device="eth0"}']  || 0,
        tx: pm['node_network_transmit_bytes_total{device="eth0"}'] || 0,
      },
    };
  } catch (err) {
    hostMetrics = { cpu: 0, ram: 0, loadAvg: [0, 0, 0], disk: { os: 0, recordings: 0 }, network: { rx: 0, tx: 0 } };
  }

  const calls = logState.activeCalls;
  const ratio  = calls / 32;

  return buildMetricsShape({
    ...hostMetrics,
    activeCalls:   calls,
    errors408:     logState.errors408,
    errors503:     logState.errors503,
    trunkReg:      logState.trunkRegistered,
    channelsUsed:  logState.activeCalls,
    channelsTotal: 30,
    pdd:           0,
    asr:           100,
    errorRate:     0,
    mos:           0,
    jitterMs:      0,
    packetLoss:    0,
    queueWaiting:  logState.queueWaiting,
    agentsOnline:  logState.agentsOnline,
    serviceLevel:  100,
    abandonment:   0,
    diskOs: hostMetrics.disk.os,
    diskRec: 0,
    netRx: hostMetrics.network.rx,
    netTx: hostMetrics.network.tx,
  });
}

export function startMetricsCollection(onMetrics) {
  const collect = async () => {
    try {
      currentMetrics = MOCK ? buildMockMetrics() : await fetchRealMetrics();
      onMetrics(currentMetrics);
    } catch (err) {
      console.error('[Metrics] Collection error:', err.message);
    }
  };

  collect();
  pollTimer = setInterval(collect, POLL_INTERVAL);
}

// Called by sippManager to inject test-time overrides into mock data
export function setMockTestOverride(override) {
  if (MOCK) {
    if (override) {
      mockState.activeCalls = override.targetCalls * 0.3;
    } else {
      mockState.activeCalls = 18;
    }
  }
}

export function getCurrentMetrics() {
  return currentMetrics;
}
