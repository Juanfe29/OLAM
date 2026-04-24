import { NodeSSH } from 'node-ssh';

const MOCK = process.env.MOCK_MODE === 'true';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ssh = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let streamCleanups = [];

async function connect() {
  if (MOCK) {
    connected = true;
    console.log('[SSH] Mock mode — no real SSH connection');
    return;
  }

  ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: process.env.SSH_HOST,
      port: parseInt(process.env.SSH_PORT || '22'),
      username: process.env.SSH_USER || 'root',
      privateKeyPath: process.env.SSH_KEY_PATH,
      readyTimeout: 10000,
    });
    connected = true;
    reconnectAttempts = 0;
    console.log(`[SSH] Connected to ${process.env.SSH_HOST}`);

    ssh.connection.on('error', (err) => {
      console.error('[SSH] Connection error:', err.message);
      connected = false;
      scheduleReconnect();
    });

    ssh.connection.on('end', () => {
      console.warn('[SSH] Connection ended');
      connected = false;
      scheduleReconnect();
    });
  } catch (err) {
    console.error('[SSH] Connect failed:', err.message);
    connected = false;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  streamCleanups.forEach(fn => fn());
  streamCleanups = [];

  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts++;
  console.log(`[SSH] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connect();
  }, delay);
}

export async function execCommand(cmd) {
  if (MOCK) return { stdout: '', stderr: '' };
  if (!connected || !ssh) throw new Error('SSH not connected');
  return ssh.execCommand(cmd, { execOptions: { pty: false } });
}

export function execStream(cmd, onData, onClose) {
  if (MOCK) return () => {};

  if (!connected || !ssh?.connection) {
    console.warn('[SSH] execStream called but not connected');
    return () => {};
  }

  let closed = false;
  ssh.connection.exec(cmd, (err, stream) => {
    if (err) {
      console.error('[SSH] execStream error:', err.message);
      return;
    }
    stream.on('data', chunk => {
      if (!closed) onData(chunk.toString());
    });
    stream.stderr.on('data', chunk => {
      // 3CX logs occasionally write to stderr — treat as data
      if (!closed) onData(chunk.toString());
    });
    stream.on('close', (code) => {
      if (!closed) {
        closed = true;
        if (onClose) onClose(code);
      }
    });
  });

  const cleanup = () => { closed = true; };
  streamCleanups.push(cleanup);
  return cleanup;
}

export function isConnected() {
  return connected;
}

export async function startSSH() {
  await connect();
}
