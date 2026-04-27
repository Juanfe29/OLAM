// Parses raw lines from 3CX log files into structured events.
// Each log has its own format; this module handles all five.

const LOG_TYPES = {
  CallFlow:       '3CXCallFlow.log',
  GatewayService: '3CXGatewayService.log',
  QueueManager:   '3CXQueueManager.log',
  SystemService:  '3cxSystemService.log',
  IVR:            '3CXIVR.log',
};

// Detect which log file a line came from based on the tail -Fq prefix
// tail -Fq prepends "==> /path/to/file <==" when switching files
let currentFile = null;

function detectFile(line) {
  if (line.startsWith('==>')) {
    for (const [type, filename] of Object.entries(LOG_TYPES)) {
      if (line.includes(filename)) {
        currentFile = type;
        return null;
      }
    }
    return null;
  }
  return currentFile;
}

// Formatos reales de los logs del 3CX v20:
//   - 4 logs (CallFlow, Gateway, Queue, System): "YYYY/MM/DD HH:MM:SS.mmm|####|Level| ..."
//   - IVR: "DD/MM/YYYY HH:MM:SS.mmm [hex] ..."
const TS_YMD_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})[.,](\d+)/;
const TS_DMY_RE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})[.,](\d+)/;

function parseTimestamp(line) {
  let m = TS_YMD_RE.exec(line);
  if (m) {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7].padEnd(3, '0').slice(0, 3)}Z`).toISOString();
  }
  m = TS_DMY_RE.exec(line);
  if (m) {
    return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}.${m[7].padEnd(3, '0').slice(0, 3)}Z`).toISOString();
  }
  return new Date().toISOString();
}

// Nivel de severidad en el formato pipe-separated (col 3): "...|Erro|", "|Warn|", "|Crit|"
const LEVEL_PIPE_RE = /\|(Erro|Crit|Fatal|Warn)\|/;

// CallFlow: el formato exacto cambia con tráfico real. Parser probado:
//  - "Route failed:" → call_failed
//  - palabras clave INVITE/BYE/CANCEL/200 OK con un id de llamada hex/numérico
const CALL_INVITE_RE  = /\bINVITE\b.*?\b(?:Call[Ii]d|callId)[:\s=]*([\w@.-]+)/;
const CALL_ENDED_KW   = /\b(BYE|CANCEL|TerminatedByUser|ParentConnectionTerminated|Released)\b/i;
const ROUTE_FAILED_RE = /Route\s+failed/i;

// GatewayService: 408/503 estricto en contexto SIP, evita matchear timestamps
const ERR_408_RE   = /\b(SIP\/2\.0\s+408|408\s+Request\s+Timeout|status[:=]\s*408)\b/i;
const ERR_503_RE   = /\b(SIP\/2\.0\s+503|503\s+Service\s+Unavailable|status[:=]\s*503)\b/i;
const REGISTERED_RE = /\btrunk\b.*?\b(register(ed)?|active)\b/i;
const UNREG_RE      = /\b(unregister(ed)?|deregister(ed)?|trunk\s+down|registration\s+failed)\b/i;

// QueueManager: el formato real con tráfico se descubre cuando haya agentes activos.
// Patrones defensivos basados en docs 3CX:
const QUEUE_WAIT_RE = /\b(waiting|in\s+queue)[:\s=]+(\d+)/i;
const AGENT_RE      = /\bagent.*?(online|available|registered)[:\s=]+(\d+)/i;

export function parseLine(rawLine) {
  const fileType = detectFile(rawLine);
  if (!fileType || !rawLine.trim()) return null;

  const ts = parseTimestamp(rawLine);
  const line = rawLine.trim();

  switch (fileType) {
    case 'CallFlow': {
      const inv = CALL_INVITE_RE.exec(line);
      if (inv) return { type: 'call_active', callId: inv[1], ts };
      if (ROUTE_FAILED_RE.test(line)) return { type: 'call_failed', ts, raw: line };
      if (CALL_ENDED_KW.test(line))   return { type: 'call_ended', ts };
      break;
    }
    case 'GatewayService': {
      if (ERR_408_RE.test(line)) return { type: 'error_408', ts, raw: line };
      if (ERR_503_RE.test(line)) return { type: 'error_503', ts, raw: line };
      if (UNREG_RE.test(line))   return { type: 'trunk_unregistered', ts };
      if (REGISTERED_RE.test(line)) return { type: 'trunk_registered', ts };
      break;
    }
    case 'QueueManager': {
      const wm = QUEUE_WAIT_RE.exec(line);
      if (wm) return { type: 'queue_waiting', count: parseInt(wm[2]), ts };
      const am = AGENT_RE.exec(line);
      if (am) return { type: 'agents_online', count: parseInt(am[2]), ts };
      break;
    }
    case 'SystemService': {
      const lvl = LEVEL_PIPE_RE.exec(line);
      if (lvl && /Erro|Crit|Fatal/.test(lvl[1])) return { type: 'system_error', ts, raw: line };
      break;
    }
    default:
      break;
  }

  return null;
}
