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

// Shared timestamp pattern: [DD/MM/YYYY HH:MM:SS.mmm]
const TS_RE = /\[(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}[.,]\d+)\]/;

function parseTimestamp(line) {
  const m = TS_RE.exec(line);
  return m ? new Date(m[1].replace(',', '.')).toISOString() : new Date().toISOString();
}

// CallFlow: active calls, states, durations
// Example: [01/01/2024 10:00:00.000] Call 12345: INVITE from 101 to 901 (ACTIVE)
const CALL_ACTIVE_RE   = /Call\s+(\d+).*?\bACTIVE\b/i;
const CALL_ENDED_RE    = /Call\s+(\d+).*?\b(ENDED|RELEASED|BYE)\b/i;
const CALL_DURATION_RE = /duration[:\s]+(\d+)/i;

// GatewayService: trunk errors
const ERR_408_RE   = /408/;
const ERR_503_RE   = /503/;
const REGISTERED_RE = /registered|registration/i;
const UNREG_RE      = /unregistered|deregistered/i;

// QueueManager: queue state
const QUEUE_WAIT_RE  = /waiting[:\s]+(\d+)/i;
const AGENT_RE       = /agents?.*?online[:\s]+(\d+)/i;

export function parseLine(rawLine) {
  const fileType = detectFile(rawLine);
  if (!fileType || !rawLine.trim()) return null;

  const ts = parseTimestamp(rawLine);
  const line = rawLine.trim();

  switch (fileType) {
    case 'CallFlow': {
      if (CALL_ACTIVE_RE.test(line)) return { type: 'call_active', callId: CALL_ACTIVE_RE.exec(line)?.[1], ts };
      if (CALL_ENDED_RE.test(line)) {
        const m = CALL_ENDED_RE.exec(line);
        const dur = CALL_DURATION_RE.exec(line);
        return { type: 'call_ended', callId: m?.[1], duration: dur ? parseInt(dur[1]) : null, ts };
      }
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
      if (wm) return { type: 'queue_waiting', count: parseInt(wm[1]), ts };
      const am = AGENT_RE.exec(line);
      if (am) return { type: 'agents_online', count: parseInt(am[1]), ts };
      break;
    }
    case 'SystemService': {
      if (/error|critical|fatal/i.test(line)) return { type: 'system_error', ts, raw: line };
      break;
    }
    default:
      break;
  }

  return null;
}
