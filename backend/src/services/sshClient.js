import { NodeSSH } from 'node-ssh';
import net from 'net';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

// SSH tunnel para node_exporter cuando el firewall upstream bloquea :9100
const TUNNEL_VIA_SSH = process.env.NODE_EXPORTER_VIA_SSH === 'true';
const TUNNEL_LOCAL_PORT = parseInt(process.env.NODE_EXPORTER_TUNNEL_PORT || '9100');
const TUNNEL_REMOTE_PORT = 9100;

let ssh = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let streamCleanups = [];
let tunnelServer = null;

async function connect() {

  ssh = new NodeSSH();
  try {
    const sshConfig = {
      host: process.env.SSH_HOST,
      port: parseInt(process.env.SSH_PORT || '22'),
      username: process.env.SSH_USER || 'root',
      readyTimeout: 10000,
    };

    // Usar password si está disponible, si no usar key
    if (process.env.SSH_PASSWORD) {
      sshConfig.password = process.env.SSH_PASSWORD;
    } else {
      sshConfig.privateKeyPath = process.env.SSH_KEY_PATH;
    }

    await ssh.connect(sshConfig);
    connected = true;
    reconnectAttempts = 0;
    console.log(`[SSH] Connected to ${process.env.SSH_HOST}`);

    startTunnel();

    ssh.connection.on('error', (err) => {
      console.error('[SSH] Connection error:', err.message);
      connected = false;
      stopTunnel();
      scheduleReconnect();
    });

    ssh.connection.on('end', () => {
      console.warn('[SSH] Connection ended');
      connected = false;
      stopTunnel();
      scheduleReconnect();
    });
  } catch (err) {
    console.error('[SSH] Connect failed:', err.message);
    connected = false;
    scheduleReconnect();
  }
}

function startTunnel() {
  if (!TUNNEL_VIA_SSH || !ssh?.connection) return;
  if (tunnelServer) return;

  tunnelServer = net.createServer((socket) => {
    if (!ssh?.connection) {
      socket.destroy();
      return;
    }
    ssh.connection.forwardOut(
      '127.0.0.1', 0,
      '127.0.0.1', TUNNEL_REMOTE_PORT,
      (err, stream) => {
        if (err) {
          console.error('[SSH tunnel] forwardOut error:', err.message);
          socket.destroy();
          return;
        }
        // Listeners primero — un ECONNRESET durante un pipe sin handler tira el proceso
        socket.on('error', () => stream.destroy());
        stream.on('error', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
      },
    );
    socket.on('error', () => {}); // catch antes de que forwardOut resuelva
  });

  tunnelServer.on('error', (err) => {
    console.error(`[SSH tunnel] Listener error on :${TUNNEL_LOCAL_PORT}:`, err.message);
    tunnelServer = null;
  });

  tunnelServer.listen(TUNNEL_LOCAL_PORT, '127.0.0.1', () => {
    console.log(`[SSH tunnel] Forwarding 127.0.0.1:${TUNNEL_LOCAL_PORT} → 3CX:${TUNNEL_REMOTE_PORT}`);
  });
}

function stopTunnel() {
  if (tunnelServer) {
    tunnelServer.close();
    tunnelServer = null;
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
  if (!connected || !ssh) throw new Error('SSH not connected');
  return ssh.execCommand(cmd, { execOptions: { pty: false } });
}

export function execStream(cmd, onData, onClose) {
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
