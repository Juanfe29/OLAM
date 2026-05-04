import axios from 'axios';
import { getLogState } from './logReader.js';

const POLL_INTERVAL = parseInt(process.env.LOG_POLL_INTERVAL || '5000');
const NODE_EXPORTER_URL = process.env.NODE_EXPORTER_URL || 'http://172.18.164.28:9100/metrics';

let currentMetrics = null;
let pollTimer = null;

// Track previous CPU counters for delta calculation
let prevCpuCounters = null;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

// Busca el primer metric cuyo nombre coincida y cumpla el matcher de labels
function findByLabel(metrics, name, labelMatch) {
  const prefix = name + '{';
  for (const [key, val] of Object.entries(metrics)) {
    if (!key.startsWith(prefix)) continue;
    if (labelMatch(key)) return val;
  }
  return undefined;
}

// Suma todos los metrics que coincidan en nombre y labels (ej: total de tráfico
// sumando todas las interfaces físicas del host)
function sumByLabel(metrics, name, labelMatch) {
  const prefix = name + '{';
  let total = 0;
  for (const [key, val] of Object.entries(metrics)) {
    if (!key.startsWith(prefix)) continue;
    if (labelMatch && !labelMatch(key)) continue;
    total += val;
  }
  return total;
}

// Excluye loopback y virtuales — el 3CX usa ens192/ens224 (VMware)
const PHYSICAL_IFACE = (key) => !/device="(lo|docker|veth|br-|tun|tap)/.test(key);

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

    // Disco "/" — match por mountpoint sin importar device/fstype.
    // El 3CX no tiene mount separado para grabaciones; recordings queda en 0
    // hasta que el ops del cliente monte un volumen dedicado.
    const fsSize = findByLabel(pm, 'node_filesystem_size_bytes', k => k.includes('mountpoint="/"'));
    const fsFree = findByLabel(pm, 'node_filesystem_free_bytes', k => k.includes('mountpoint="/"'));
    const diskOs = (fsSize && fsFree) ? (1 - fsFree / fsSize) * 100 : 0;

    hostMetrics = {
      cpu:     Math.round(cpuPct * 10) / 10,
      ram:     Math.round(ramPct * 10) / 10,
      loadAvg: [pm['node_load1'] || 0, pm['node_load5'] || 0, pm['node_load15'] || 0],
      disk:    { os: Math.round(diskOs), recordings: 0 },
      network: {
        rx: sumByLabel(pm, 'node_network_receive_bytes_total',  PHYSICAL_IFACE),
        tx: sumByLabel(pm, 'node_network_transmit_bytes_total', PHYSICAL_IFACE),
      },
    };
  } catch (err) {
    hostMetrics = { cpu: 0, ram: 0, loadAvg: [0, 0, 0], disk: { os: 0, recordings: 0 }, network: { rx: 0, tx: 0 } };
  }

  const calls = logState.activeCalls;

  return buildMetricsShape({
    ...hostMetrics,
    activeCalls:   calls,
    errors408:     logState.errors408,
    errors503:     logState.errors503,
    trunkReg:      logState.trunkRegistered,
    channelsUsed:  logState.activeCalls,
    channelsTotal: 30,
    pdd:           null,
    asr:           null,
    errorRate:     null,
    mos:           null,
    jitterMs:      null,
    packetLoss:    null,
    queueWaiting:  logState.queueWaiting,
    agentsOnline:  logState.agentsOnline,
    serviceLevel:  null,
    abandonment:   null,
    diskOs: hostMetrics.disk.os,
    diskRec: 0,
    netRx: hostMetrics.network.rx,
    netTx: hostMetrics.network.tx,
  });
}

export function startMetricsCollection(onMetrics) {
  const collect = async () => {
    try {
      currentMetrics = await fetchRealMetrics();
      onMetrics(currentMetrics);
    } catch (err) {
      console.error('[Metrics] Collection error:', err.message);
    }
  };

  collect();
  pollTimer = setInterval(collect, POLL_INTERVAL);
}


export function getCurrentMetrics() {
  return currentMetrics;
}
