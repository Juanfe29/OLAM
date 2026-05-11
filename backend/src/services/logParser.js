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

// CallFlow — 3CX V20 (server `.33`):
// El formato del 3CX V20 NO usa INVITE/BYE/callId en CallFlow.log. El módulo
// _3CX.ScriptRunner emite la línea `CallStorageSize=N(M)` que indica el número
// EXACTO de llamadas activas en cada momento. Es mejor signal que correlacionar
// INVITE/BYE — no requiere tracking de callIds, no se desincroniza con retries.
//
// Ejemplo:
//   2026/05/06 18:15:19.899|0004|Info| [_3CX.ScriptRunner] CallStorageSize=1(1)
//   2026/05/06 18:15:19.908|0004|Info| [_3CX.ScriptRunner] CallStorageSize=0(0)
//
// El primer dígito (CallStorageSize) es el conteo activo; el segundo entre
// paréntesis es el conteo por instancia, irrelevante para el dashboard.
const CALL_STORAGE_SIZE_RE = /\bCallStorageSize=(\d+)/;

// "Route failed" / "lastrouting result Failed" — falla de routing
const ROUTE_FAILED_RE = /(Route\s+failed|lastrouting\s+result\s+(?:Failed|Error))/i;

// Patrones legacy del formato anterior (3CX viejo, .28). Los dejamos por si
// algún tipo de evento todavía aparece — son no-ops si no matchean.
const CALL_INVITE_RE  = /\bINVITE\b.*?\b(?:Call[Ii]d|callId)[:\s=]*([\w@.-]+)/;
const CALL_ENDED_KW   = /\b(BYE|CANCEL|TerminatedByUser|ParentConnectionTerminated|Released)\b/i;

// GatewayService: 408/503 estricto en contexto SIP, evita matchear timestamps
const ERR_408_RE   = /\b(SIP\/2\.0\s+408|408\s+Request\s+Timeout|status[:=]\s*408)\b/i;
const ERR_503_RE   = /\b(SIP\/2\.0\s+503|503\s+Service\s+Unavailable|status[:=]\s*503)\b/i;
const REGISTERED_RE = /\btrunk\b.*?\b(register(ed)?|active)\b/i;
const UNREG_RE      = /\b(unregister(ed)?|deregister(ed)?|trunk\s+down|registration\s+failed)\b/i;

// QueueManager: el formato real con tráfico se descubre cuando haya agentes activos.
// Patrones defensivos basados en docs 3CX:
// El formato periódico "=Total: N requests / M active" es la fuente confiable de
// llamadas activas (actualizada cada ~10s cuando hay tráfico).
const QUEUE_WAIT_RE   = /\b(waiting|in\s+queue)[:\s=]+(\d+)/i;
const AGENT_RE        = /\bagent.*?(online|available|registered)[:\s=]+(\d+)/i;
const QUEUE_TOTAL_RE  = /^=Total:\s*(\d+)\s+requests\s+\/\s+(\d+)\s+active/;

// VCEHostPlugIn dump — header que inicia el bloque de agentes (cada ~30s)
const VCE_STATS_RE = /\bVCEHostPlugIn\b.*Statistics/;
// Línea de agente dentro del dump: "- Ag.XXXX Dial:... Logged-IN/OUT ..."
const AGENT_DUMP_LINE_RE = /^-\s+Ag\.\d+.*?Logged-(IN|OUT)\b/;
// OmCallsManager: "OmCallsManager number of calls: N, N, N"
const OM_CALLS_RE = /\bOmCallsManager\b.*number\s+of\s+calls:\s*(\d+),\s*(\d+),\s*(\d+)/;

// IVR: RTCP quality per call leg emitted every ~5s
// Ejemplo: "RTCP ssrctx=... tx=... ssrcrx=... rx=... ex=... delta=... loss%=0 jitter=0.570113"
const RTCP_RE = /\bRTCP\b.*\bloss%=([\d.]+).*\bjitter=([\d.]+)/;

export function parseLine(rawLine) {
  const fileType = detectFile(rawLine);
  if (!fileType || !rawLine.trim()) return null;

  const ts = parseTimestamp(rawLine);
  const line = rawLine.trim();

  switch (fileType) {
    case 'CallFlow': {
      // 3CX V20: signal canónico — `CallStorageSize=N` da el conteo exacto.
      // Tiene precedencia sobre los patterns legacy de INVITE/BYE.
      const css = CALL_STORAGE_SIZE_RE.exec(line);
      if (css) return { type: 'call_count', count: parseInt(css[1]), ts };

      if (ROUTE_FAILED_RE.test(line)) return { type: 'call_failed', ts, raw: line };

      // Patterns legacy (3CX viejo). En .33 no matchean — quedan como red de
      // seguridad si algún día corremos sobre un 3CX que sí los emite.
      const inv = CALL_INVITE_RE.exec(line);
      if (inv) return { type: 'call_active', callId: inv[1], ts };
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
      // "=Total: N requests / M active" — llamadas activas en cola (fuente confiable)
      const qt = QUEUE_TOTAL_RE.exec(line);
      if (qt) return { type: 'call_count', count: parseInt(qt[2]), ts };

      // VCEHostPlugIn dump header → inicio de snapshot de agentes
      if (VCE_STATS_RE.test(line)) return { type: 'agent_dump_start', ts };

      // Línea individual de agente dentro del dump
      const adm = AGENT_DUMP_LINE_RE.exec(line);
      if (adm) return { type: 'agent_line', loggedIn: adm[1] === 'IN', ts };

      // OmCallsManager: primer número = conexiones activas totales
      const om = OM_CALLS_RE.exec(line);
      if (om) return { type: 'om_calls', count: parseInt(om[1]), ts };

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
    case 'IVR': {
      const rtcp = RTCP_RE.exec(line);
      if (rtcp) return { type: 'rtcp', loss: parseFloat(rtcp[1]), jitter: parseFloat(rtcp[2]), ts };
      break;
    }
    default:
      break;
  }

  return null;
}
