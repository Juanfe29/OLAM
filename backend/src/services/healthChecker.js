import axios from 'axios';
import fs from 'fs';
import { isConnected } from './sshClient.js';
import { getLogState } from './logReader.js';

const POLL_INTERVAL = 30000;
const LOG_STALE_MS = 2 * 60 * 1000;
const EXPORTER_TIMEOUT = 4000;
const NODE_EXPORTER_URL = process.env.NODE_EXPORTER_URL || 'http://127.0.0.1:9100/metrics';
const SIPP_BIN = process.env.SIPP_BIN || 'sipp';

let currentHealth = {
  ssh: { ok: false, lastUpdate: new Date().toISOString(), message: 'Not checked yet' },
  logs: { ok: false, lastUpdate: new Date().toISOString(), message: 'Not checked yet' },
  exporter: { ok: false, lastUpdate: new Date().toISOString(), message: 'Not checked yet' },
  sipp: { ok: false, lastUpdate: new Date().toISOString(), message: 'Not checked yet' },
  timestamp: new Date().toISOString(),
};

let healthPollTimer = null;

async function checkSSH() {
  const ok = isConnected();
  const message = ok ? 'Connected to 172.18.164.28' : 'SSH disconnected';
  return { ok, message, lastUpdate: new Date().toISOString() };
}

function checkLogs() {
  const logState = getLogState();
  const lastParsedAt = logState?.lastParsedAt;
  if (!lastParsedAt) {
    return { ok: false, message: 'Logs not yet parsed', lastUpdate: new Date().toISOString() };
  }
  const now = Date.now();
  const age = now - lastParsedAt;
  const ok = age < LOG_STALE_MS;
  const seconds = Math.round(age / 1000);
  const message = ok ? `${seconds}s ago` : `STALE: ${seconds}s (limit 120s)`;
  return { ok, message, lastUpdate: new Date().toISOString() };
}

async function checkExporter() {
  try {
    await axios.get(NODE_EXPORTER_URL, { timeout: EXPORTER_TIMEOUT });
    return { ok: true, message: 'Responding normally', lastUpdate: new Date().toISOString() };
  } catch (err) {
    const message = err.code === 'ECONNREFUSED' ? 'Connection refused' : 'Timeout';
    return { ok: false, message, lastUpdate: new Date().toISOString() };
  }
}

function checkSIPp() {
  const ok = fs.existsSync(SIPP_BIN);
  const message = ok ? `Found at ${SIPP_BIN}` : `Not found: ${SIPP_BIN}`;
  return { ok, message, lastUpdate: new Date().toISOString() };
}

export async function startHealthChecker() {
  const poll = async () => {
    try {
      currentHealth.ssh = await checkSSH();
      currentHealth.logs = checkLogs();
      currentHealth.exporter = await checkExporter();
      currentHealth.sipp = checkSIPp();
      currentHealth.timestamp = new Date().toISOString();
    } catch (err) {
      console.error('[HealthChecker] Poll error:', err.message);
    }
  };
  await poll();
  healthPollTimer = setInterval(poll, POLL_INTERVAL);
  console.log('[HealthChecker] Started (30s interval)');
}

export function getCurrentHealth() {
  return currentHealth;
}
