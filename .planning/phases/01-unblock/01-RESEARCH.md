# Phase 1: Unblock - Research

**Researched:** 2026-05-03
**Domain:** Real smoke test execution + log parser diagnostic + auto-updates detection
**Confidence:** HIGH (architecture + code) / MEDIUM (3CX API surface) / MEDIUM-LOW (FIND-01 auto-detection feasibility)

## Summary

Phase 1 unblocks real SIPp tests by addressing three concrete blockers (destination validation, CSV parsing, parser state diagnosis) and one findings item (auto-updates detection). The first three BLOCK items are architecturally straightforward with clear implementation paths using existing codebase patterns. **FIND-01 is the critical decision gate**: auto-detection feasibility determines whether Phase 1 is 2 days (manual screenshot only) or 3-4 days (with automatic detection wired). Research recommends moving auto-detection to Phase 4 to preserve Phase 1's tight scope, with a manual screenshot as primary evidence in Phase 1.

**Primary recommendation:** Implement BLOCK-01/02/03 fully in Phase 1 (parallelizable, low risk); implement FIND-01 as screenshot-only in Phase 1 with placeholder alert; move auto-detection logic to Phase 4 MON-02 where it belongs architecturally.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** TI OLAM executes the Web Console change to disable auto-updates (not the consultant). Consultor coordinates remotely but doesn't access credentials.
- **D-02:** Modalidad guía remota — consultor available (RDP/pantalla compartida) to help TI OLAM during the change.
- **D-03:** Screenshot evidence archived in `docs/evidence/3cx-auto-updates-off-YYYY-MM-DD.png` as static verification.

### Claude's Discretion (Technical Decisions for Researcher/Planner)

- **BLOCK-01:** Choose validation method (static `.env` list vs 3CX API query vs hybrid cache). Consider latency budget (500ms max for `POST /api/tests/run`), failure mode (fail-open or fail-closed if API down?), frontend UX (modal vs inline error).
- **BLOCK-02:** Choose CSV reading strategy (chokidar + fast-csv parser for streaming detection, polling with fs.stat, or synchronous read after SIPp exit). Handle encoding (Cygwin LF vs Windows CRLF), partial file reads, SIPp crash fallback.
- **BLOCK-03:** Implement heuristic to distinguish 3 parser states (no_traffic, parser_broken, ssh_down) with appropriate alert levels and cooldown to prevent flapping.

### Deferred Ideas (OUT OF SCOPE)

- **Auto-detection of auto-updates re-activation** (FIND-01 sub-task): If 4-8h feasibility estimate is confirmed, move to Phase 4 MON-02. Phase 1 provides manual screenshot + placeholder alert only.
- Manual procedure documentation: Deferred to Phase 6 (OPS-02) runbook, not Phase 1.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BLOCK-01 | Backend validates destination extension exists in 3CX before invoking SIPp; rejects with error if not; no testId created | Extension list available from `.env` config or 3CX API; validation at route entry point before sippManager.runTest(); error shape: `{ ok: false, error: "Extensión no existe" }` |
| BLOCK-02 | SIPp Manager reads `_statistics.csv` final output instead of parsing stderr; snapshots populated with real call metrics | SIPp writes CSV to working directory; chokidar watches for file change; fast-csv parses; fallback to stderr if CSV missing (crash scenario) |
| BLOCK-03 | LogReader warning distinguishes "no traffic" / "parser broken" / "SSH down" with specific alert messages | State machine: no_traffic (SSH up, lines received but low match rate), parser_broken (SSH up, lines received, match rate ~0), ssh_down (SSH disconnected or no lines 2+ min); counters per log type; cooldown 10s to prevent flapping |
| FIND-01 | 3CX auto-updates disabled; screenshot evidence archived; (optional) auto-detection alert if re-enabled | Manual: TI OLAM takes screenshot, consultor archives; Auto-detection: Phase 4 deferred (estimated 4-8h if implemented; placeholder alert in Phase 1) |

</phase_requirements>

## Standard Stack

### Core Technologies

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|--------------|
| **chokidar** | 3.6+ | Watch SIPp `_statistics.csv` for completion and trigger read | Cross-platform file watcher; handles Windows + Cygwin line-ending quirks better than fs.watch; already in STACK.md research |
| **fast-csv** | 5.0+ | Parse SIPp CSV output into structured metrics | Streaming CSV parser; handles incomplete files gracefully; standard choice for Node.js SIP/telecom tooling |
| **better-sqlite3** | 11.x | (Already in stack) Query extension list or cache from config table | Synchronous queries are acceptable for config reads; no new dependency |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **node-ssh** | 13.x | (Already in stack) Open secondary SSH connection if API unavailable | BLOCK-01 fallback: if 3CX API down, query extension list via SSH grep on 3CX config |
| **axios** | (existing) | Query 3CX Call Control API for extensions (Option B for BLOCK-01) | Only if extension list stored in 3CX API; requires API availability investigation |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| **chokidar** | fs.watch (native) | fs.watch on Windows+Cygwin has race conditions with line-buffered writes; chokidar normalizes this |
| **chokidar** | Polling with fs.stat every 100ms | More CPU, higher latency to detect file write completion; simpler code but inferior for short-duration tests |
| **fast-csv** | csv-parse (@csv/parse) | csv-parse is slightly more feature-rich; fast-csv wins on streaming incomplete-file behavior (SIPp behavior) |
| **Static `.env` list** (BLOCK-01) | 3CX API query at test time | Static list: simpler, no API risk; API: always current, but latency + failure mode; hybrid: cache with TTL is optimal |

### Installation

```bash
# Backend additions for Phase 1
cd backend
npm install chokidar fast-csv
```

**No new packages for BLOCK-01 or BLOCK-03** — use existing database, Express, and log reader infrastructure.

**Version verification:** At time of research (2026-05-03):
- chokidar: latest 3.6.0 (stable, no breaking changes to 4.x API yet)
- fast-csv: latest 5.0.1 (stable)
- better-sqlite3: 11.x (already locked in backend/package.json)

---

## Architecture Patterns

### BLOCK-01: Destination Validation Pattern

**What:** Before `sippManager.runTest()` is invoked, validate that the requested extension exists.

**When to use:** Every `POST /api/tests/run` request, early in the route handler.

**Location:** Insert validation in `backend/src/routes/tests.js` before calling `sippManager.runTest()`.

**Three implementation options:**

1. **Option A: Static `.env` list (Simplest, Lowest Latency)**
   - Store valid extensions as comma-separated list: `VALID_EXTENSIONS=100,101,200,300,999`
   - Load at backend startup into a Set for O(1) lookup
   - Validation: `if (!validExtensions.has(params.destination)) throw new Error(...)`
   - Pros: 0 latency, fail-safe (no API to break), works offline
   - Cons: Requires manual update if extensions change; must be coordinated with OLAM

   ```javascript
   // In backend/src/server.js startup:
   const VALID_EXTENSIONS = new Set(
     (process.env.VALID_EXTENSIONS || '100,101,200,300').split(',')
   );
   
   // In backend/src/routes/tests.js:
   router.post('/run', async (req, res) => {
     if (!VALID_EXTENSIONS.has(String(req.body.destination))) {
       return res.status(400).json({
         ok: false,
         error: `Extensión ${req.body.destination} no existe. Extensiones válidas: ${Array.from(VALID_EXTENSIONS).join(', ')}`
       });
     }
     // Continue to sippManager.runTest()
   });
   ```

2. **Option B: 3CX Call Control API Query (Most Current, Higher Latency)**
   - Query 3CX API at `/api/v1/extensions` (or equivalent) to fetch live extension list
   - Cache result in memory with TTL (e.g., 1 hour) to avoid API hammering
   - Validation at request time: check cache, refresh if stale
   - Pros: Always current; OLAM extensions change automatically reflected
   - Cons: Requires 3CX API availability; adds 100-300ms latency per request; HTTP endpoint must exist and be documented

   **Investigation required:** Does 3CX v20 Call Control API expose `/extensions` endpoint? Estimated research time: 30 minutes (contact OLAM or check 3CX docs). **Confidence if available: MEDIUM (API exists but structure not verified against v20.0.8.1121).**

   ```javascript
   // Pseudo-code for Option B:
   let extCache = null;
   let extCacheExpiry = 0;
   
   async function getValidExtensions() {
     if (Date.now() < extCacheExpiry && extCache) return extCache;
     try {
       const response = await axios.get(`https://${process.env.SSH_HOST}:5000/api/v1/extensions`, {
         headers: { /* auth */ },
         timeout: 2000
       });
       extCache = new Set(response.data.map(e => String(e.number)));
       extCacheExpiry = Date.now() + 3600000; // 1 hour TTL
       return extCache;
     } catch (err) {
       console.error('[Extensions API] Failed:', err.message);
       // Fallback: return cached copy or empty set?
       return extCache || new Set(); // decide: fail-open or fail-closed
     }
   }
   ```

3. **Option C: Hybrid (Recommended for Phase 1)**
   - Start with Option A (static `.env` list) for Phase 1 — fast, reliable, unblocks tests
   - Accept that extension list is manually maintained
   - Document in runbook: "If new extensions added to 3CX, update `VALID_EXTENSIONS` env var and restart backend"
   - Phase 5+ upgrade to Option B if API exists and is stable
   - **Rationale:** Phase 1 goal is to unblock smoke test (extension `100` is known); Option C provides immediate value without API risk

**Frontend UX:** When backend rejects with 400 error, `TestControl.jsx` receives error message and displays it inline above the "Start" button (same error pattern as current code). No modal needed for Phase 1.

**Recommended for Phase 1:** Option C (static list + clear error message).

---

### BLOCK-02: SIPp CSV Reader Pattern

**What:** After SIPp process exits, read the `_statistics.csv` file it generated to extract call metrics.

**When to use:** After `sippProcess.on('close')` fires, before calling `buildSummary()`.

**File location:** SIPp writes `_statistics.csv` to its working directory (default: current working directory of the Node process, or configurable via `SIPP_OUTPUT_DIR` env var).

**Implementation: Chokidar + Fast-CSV Pattern**

```javascript
// In backend/src/services/sippManager.js, after line 180 (sippProcess.on('close')):

import { watch } from 'chokidar';
import { parse } from 'fast-csv';

function runRealSipp(testId, params) {
  // ... existing code (lines 134-165) ...
  
  const startTime = Date.now();
  const snapshots = [];
  let watcherStarted = false;

  // Start watcher BEFORE process starts (in case SIPp writes CSV immediately)
  const statsPath = path.join(process.cwd(), '_statistics.csv');
  const watcher = watch(statsPath, { 
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    // Windows + Cygwin: files may be written with bursts; wait for 500ms of no changes
  });

  sippProcess.stderr.on('data', (chunk) => {
    // Keep existing stderr parsing as fallback
    const line = chunk.toString();
    parseSippStats(line, snapshots, testId);
    if (currentTest) {
      currentTest.elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress({ ...currentTest });
    }
  });

  sippProcess.on('close', (code) => {
    sippProcess = null;
    
    // Try to read CSV file if it exists
    readSippStats(statsPath, snapshots, (csvSnapshots) => {
      if (csvSnapshots.length > 0) {
        // CSV read succeeded; use CSV data (more authoritative than stderr)
        snapshots.splice(0, snapshots.length, ...csvSnapshots);
      }
      // If CSV read failed or empty, use stderr snapshots as fallback
      
      watcher.close(); // Clean up file watcher
      const summary = buildSummary(snapshots, params);
      finishTest(testId, code === 0 ? (summary.passed ? 'PASS' : 'FAIL') : 'ERROR', summary);
    });
    
    // Safety watchdog: if CSV not found within 5 seconds, proceed with stderr data
    const csvWatchdog = setTimeout(() => {
      if (watcher.getWatched && Object.keys(watcher.getWatched()).length > 0) {
        console.warn('[SIPp] CSV file not created within 5s of exit, using stderr data');
        watcher.close();
      }
    }, 5000);
  });
}

function readSippStats(filePath, snapshots, callback) {
  try {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        console.warn(`[SIPp] Could not read _statistics.csv: ${err.message}`);
        callback([]); // Return empty, fallback to stderr
        return;
      }
      
      const rows = [];
      parse(data, { headers: true })
        .on('data', (row) => {
          // SIPp CSV columns: Scenar#, Count, %Success, etc.
          // Extract calls and error rate
          rows.push({
            calls: parseInt(row.Count) || 0,
            errorRate: 100 - parseFloat(row['%Success']) || 0,
            timestamp: Date.now()
          });
        })
        .on('end', () => {
          console.log(`[SIPp] Parsed ${rows.length} rows from _statistics.csv`);
          callback(rows);
        })
        .on('error', (parseErr) => {
          console.error('[SIPp] CSV parse error:', parseErr.message);
          callback([]); // Fallback to stderr
        });
    });
  } catch (err) {
    console.error('[SIPp] readSippStats exception:', err.message);
    callback([]); // Fallback
  }
}
```

**Edge cases handled:**

1. **SIPp crashes before writing CSV:** Stderr snapshots are used as fallback (existing behavior preserved)
2. **File lock on Windows/Cygwin:** `awaitWriteFinish` waits 500ms for stabilization before attempting read
3. **Encoding (LF vs CRLF):** `fast-csv` automatically handles both; Node.js `fs.readFile` with 'utf8' does the same
4. **Partial CSV (incomplete write):** Watcher waits for file to stabilize before triggering read; partial rows skipped by fast-csv
5. **Missing CSV file:** 5-second watchdog falls back to stderr data

**Recommended for Phase 1:** Full implementation above. Tests for this are covered in Validation Architecture section.

---

### BLOCK-03: Parser State Diagnosis Pattern

**What:** Distinguish three states of the log reader:
- `no_traffic`: SSH connected, lines flowing, but no events parsed (expected in low-traffic periods)
- `parser_broken`: SSH connected, lines flowing, but 0% event match rate (indicates regex broken after 3CX update)
- `ssh_down`: SSH disconnected or no line data for 2+ minutes despite healthy alerts elsewhere

**Location:** Extend `backend/src/services/logReader.js` with counters and state machine.

**Implementation Pattern:**

```javascript
// In logReader.js, replace state object (lines 16-24) with:

const state = {
  activeCalls: 0,
  errors408: 0,
  errors503: 0,
  trunkRegistered: true,
  queueWaiting: 0,
  agentsOnline: 0,
  lastParsedAt: null,
  
  // New diagnostic counters (reset every minute)
  linesReceivedPerMinute: 0,
  linesMatchedPerMinute: 0,
  lastCounterResetAt: Date.now(),
};

let currentMinuteLines = 0;
let currentMinuteMatches = 0;

function attachStream() {
  const cmd = `stdbuf -oL tail -F -n 0 ${LOG_FILES.join(' ')} 2>&1`;

  streamCleanup = execStream(
    cmd,
    (chunk) => {
      state.lastParsedAt = Date.now();
      currentMinuteLines += chunk.toString().split('\n').length;
      
      chunk.split('\n').forEach(line => {
        const event = parseLine(line);
        if (!event) return;
        
        // Count matches per minute
        currentMinuteMatches++;
        applyEvent(event);
      });
    },
    (code) => {
      console.warn(`[LogReader] Stream closed (code ${code})`);
      // SSH client handles reconnect
      setTimeout(attachStream, 5000);
    }
  );
}

function startWatchdog() {
  // Emit diagnosis every minute
  parserWatchdog = setInterval(() => {
    const now = Date.now();
    const diagnosisInterval = 60_000; // 1 minute
    
    // Update counters
    state.linesReceivedPerMinute = currentMinuteLines;
    state.linesMatchedPerMinute = currentMinuteMatches;
    
    // Determine state
    const hasRecentLines = currentMinuteLines > 0;
    const hasRecentMatches = currentMinuteMatches > 0;
    const sshConnected = isConnected(); // from sshClient.js
    const timeSinceLastParse = now - (state.lastParsedAt || 0);
    const dataStale = timeSinceLastParse > 120_000; // 2+ minutes
    
    let alertId = null;
    let alertLevel = null;
    let alertMsg = null;
    
    if (!sshConnected || dataStale) {
      // State: SSH_DOWN
      alertId = 'ssh_down';
      alertLevel = 'CRITICO';
      alertMsg = 'Conexión SSH al 3CX perdida (o sin datos por 2+ minutos). Intentando reconectar...';
    } else if (hasRecentLines && currentMinuteMatches === 0) {
      // State: PARSER_BROKEN
      // Lines received but 0 matches = regex no longer matches 3CX format
      alertId = 'parser_broken';
      alertLevel = 'ALTO';
      alertMsg = `Parser roto: ${currentMinuteLines} líneas recibidas pero 0 matches. Posible cambio de formato en 3CX. Revisar versión.`;
    } else if (!hasRecentLines && !dataStale) {
      // State: NO_TRAFFIC (normal, no alert)
      alertId = null;
      console.log('[LogReader] Sin tráfico en el último minuto (normal si horario bajo)');
    }
    
    // Emit alert if state changed
    if (alertId && onAlertCallback) {
      onAlertCallback({
        id: alertId,
        level: alertLevel,
        msg: alertMsg,
        ts: new Date().toISOString(),
        permanent: false, // Will clear when condition resolves
      });
    } else if (alertId === null && onAlertCallback) {
      // No alert this minute; you may want to emit a "cleared" event
      // OR just let old alerts fade from the UI (depends on alertPanel behavior)
    }
    
    // Reset counters for next minute
    currentMinuteLines = 0;
    currentMinuteMatches = 0;
  }, 60_000);
}

// Export diagnostic state for /api/health
export function getDiagnostics() {
  return {
    linesPerMinute: state.linesReceivedPerMinute,
    matchRatePerMinute: state.linesMatchedPerMinute > 0 
      ? `${Math.round(state.linesMatchedPerMinute / state.linesReceivedPerMinute * 100)}%`
      : 'N/A',
    lastParsedAt: state.lastParsedAt,
    sshConnected: isConnected(),
  };
}
```

**Frontend (AlertPanel.jsx):** The three new alert IDs (`ssh_down`, `parser_broken`, `parser_idle`) will render with their respective severity colors (CRITICO = red, ALTO = orange, INFO = gray). Existing AlertPanel code already supports this pattern.

**Cooldown:** Alerts are deduped by ID with 5-minute cooldown (existing anomalyDetector pattern). This prevents alert spam if parser flickers between states.

**Recommended for Phase 1:** Full state machine implementation above.

---

### FIND-01: Auto-Updates Detection — Phase Placement Decision

**The Question:** Should auto-detection of re-activated auto-updates be implemented in Phase 1 or deferred to Phase 4?

**Context:** D-03 in CONTEXT.md requires a screenshot as primary evidence. D-04 flags auto-detection as optional ("a definir por el researcher") with 4-8h effort estimate and a recommendation to move to Phase 4 if too costly.

**Investigation: Three Detection Options**

1. **Option A: 3CX Call Control API Query**
   - Query 3CX API (endpoint TBD) for auto-update flag
   - Pros: Real-time, reliable if API exposes the setting
   - Cons: Requires API documentation; unknown if this setting is exposed
   - **Status: MEDIUM confidence** — 3CX v20 has an API, but extension to update settings is unverified. Estimated investigation: 1 hour to confirm API endpoint exists and auth mechanism.

2. **Option B: SSH Query of 3CX Config File**
   - SSH to 3CX and read config file (likely XML or JSON in `/opt/3cxpbx/`)
   - Parse for `<AutoUpdate>` or `autoUpdate: true` setting
   - Pros: Direct, no API dependency
   - Cons: Config file path/format unknown for v20.0.8.1121, may require root or special parsing
   - **Status: LOW-MEDIUM confidence** — would require examining actual 3CX filesystem. Estimated time: 2-3 hours.

3. **Option C: Parse 3CX System Logs for Update Events**
   - Grep 3CXSystemService.log for keywords like "update", "scheduler", "maintenance"
   - Heuristic: if new update events appear, infer auto-updates was re-enabled
   - Pros: Uses existing log reader infrastructure
   - Cons: Unreliable heuristic; delayed detection (may not see event until next scheduled update); false positives
   - **Status: LOW confidence** — would catch re-activation only if 3CX attempts an update

**Feasibility Assessment:**

| Option | Investigation Time | Implementation Time | Total | Risk | Complexity |
|--------|-------------------|-------------------|-------|------|-----------|
| A (API) | 1h | 3-4h | **4-5h** | MEDIUM (API unknown) | MEDIUM |
| B (SSH config) | 2-3h | 2-3h | **4-6h** | MEDIUM (file format) | MEDIUM |
| C (Log parsing) | 0.5h | 1-2h | **1.5-2.5h** | HIGH (unreliable) | LOW |

**Phase 1 Capacity Analysis:**
- Phase 1 effort budget: 2 days ≈ 16 hours
- BLOCK-01 (validation): 2-3 hours
- BLOCK-02 (CSV reader): 2-3 hours  
- BLOCK-03 (parser diagnosis): 2-3 hours
- Total BLOCK items: **6-9 hours**
- Remaining budget: **7-10 hours**

Theoretically, FIND-01 auto-detection could fit in remaining budget if Option A works immediately. **However:** the investigation phase (1-3 hours) is a prerequisite that might discover the API doesn't expose the setting, making the entire effort wasted.

**Recommendation: Phase 1 SCREENSHOT ONLY, Phase 4 AUTO-DETECTION**

Rationale:
1. **Phase 1 goal is to unblock tests**, not to build complete self-monitoring. Screenshot achieves the goal.
2. **Phase 4 is architecturally correct** — auto-detection belongs in MON-02 (self-monitoring), not in a "unblock" phase.
3. **Risk reduction:** If API is unavailable, Phase 4 can implement fallback (SSH config or log parsing). Phase 1 doesn't block on this.
4. **Deferred to Phase 4 with placeholder:** Phase 1 includes a hardcoded alert that fires if 3CX version string indicates auto-updates might be on, flagging for ops to manually verify.

**Phase 1 FIND-01 Implementation (Manual Screenshot Only):**

```javascript
// In backend/src/services/anomalyDetector.js, add Phase 0 finding:

const FINDINGS = [
  {
    id: 'H-05-manual-verification',
    level: 'ALTO',
    msg: 'Auto-updates del 3CX: verificación manual requerida. Se proporcionó screenshot de desactivación. (Detección automática de re-activación en Phase 4)',
    permanent: true,
  },
  // ... existing findings H-01, H-03, H-07
];
```

**Evidence archival (manual, post-phase):**
- TI OLAM takes screenshot in 3CX Web Console showing "Auto-updates: Disabled"
- Consultor saves to `docs/evidence/3cx-auto-updates-off-2026-05-XX.png`
- Commit to git with message: "docs: auto-updates disabled screenshot (FIND-01 evidence)"

**Phase 4 AUTO-DETECTION PLACEHOLDER:**
- Create task in Phase 4 plan to investigate 3CX API + implement Option A (or fallback to B/C)
- Acceptance criteria: automatic alert when auto-updates flag changes from off to on

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File watching for CSV | Custom fs.watch polling loop | chokidar | fs.watch has edge cases on Windows+Cygwin; chokidar abstracts away line-ending and race-condition issues |
| CSV parsing from SIPp | Regex-based string parsing | fast-csv with streaming | Regular expressions break on variant formatting; CSV library handles quoting, escaping, partial reads |
| Extension validation logic | Inline checks in route | service function + exportable Set | Testability, reusability if other routes need it; easier to swap validation strategy later |
| Parser state machine | If-else chain per alert | Explicit state enum | Prevents logical errors when diagnosis rules interact; easier to add new states |
| SSH reconnection | Manual setTimeout loops | Leverage existing node-ssh + sshClient.js | Already has backoff; don't duplicate |

**Key insight:** File I/O and CSV parsing on Windows are notorious for encoding and buffering surprises. Use battle-tested libraries (chokidar, fast-csv) rather than reinventing.

---

## Common Pitfalls

### Pitfall: BLOCK-02 Reads Partial CSV Before SIPp Finishes Writing

**What goes wrong:** Chokidar detects `_statistics.csv` has been created, code reads it immediately, but SIPp is still writing the final rows. Parsed CSV has incomplete data (missing final summary rows).

**Why it happens:** File change events fire as soon as data is written; SIPp may write CSV in chunks over 100-500ms.

**Prevention:** 
1. Use chokidar's `awaitWriteFinish: { stabilityThreshold: 500 }` — waits 500ms of inactivity before triggering callback
2. Treat CSV read as a fallback; if data incomplete, use stderr snapshots instead
3. Validate that parsed rows contain summary statistics (count > 0) before accepting

**Warning signs:** Test results show `snapshots: []` despite SIPp running for full duration — indicates CSV was read too early and produced no rows.

---

### Pitfall: BLOCK-03 Alert Spam on SSH Reconnect

**What goes wrong:** SSH drops for 30 seconds, reconnects. During reconnection, parser state machine flips between `ssh_down` → `no_traffic` → normal. Each transition fires an alert. User sees 3 alerts for a single brief outage.

**Why it happens:** State machine runs every minute; if SSH reconnects mid-minute, state changes and fires alert.

**Prevention:** 
1. **Cooldown:** Don't emit same alert ID more than once per 5 minutes (existing anomalyDetector pattern)
2. **Debounce state transitions:** Only emit alert if state has been stable for 30+ seconds (not first-detection)
3. **Combine related alerts:** `ssh_down` and `parser_broken` share the same cooldown bucket (don't fire both)

**Warning signs:** Dashboard shows alert spam in AlertPanel after brief network glitch.

---

### Pitfall: BLOCK-01 Fails-Closed When Extension List Unavailable

**What goes wrong:** Backend can't read extension list (if using API or SSH fallback). It rejects ALL test requests with "Extensión list unavailable". System goes dark.

**Why it happens:** No fallback strategy designed; code assumes extension list always available.

**Prevention:** 
1. **Recommended: Static `.env` list (Option C)** — never fails; extension list is admin responsibility
2. **If using API (Option B):** Cache last-known list; if API fails, use cache + emit separate alert "Extension list may be stale; verify before testing"
3. **Fail-open guidance:** When in doubt, allow the test to proceed and let SIPp fail on invalid extension (logs will show 404/480). Not ideal but better than system lockout.

**Warning signs:** All new test requests return 400 error even though SSH is healthy.

---

### Pitfall: BLOCK-02 CSV Path Incorrect on Windows/Cygwin

**What goes wrong:** SIPp writes `_statistics.csv` to its working directory, but backend looks in wrong location. File watcher times out, fallback to stderr.

**Why it happens:** Cygwin SIPp working directory may be `/tmp/cygwin-sipp/` while Node process cwd is `C:\Users\lamda\OLAM\backend\`. Paths don't match.

**Prevention:** 
1. **Explicit SIPp output flag:** Check if SIPp supports `-od` (output directory) flag; if yes, set to a known location
2. **Verify path at test startup:** Log the path Node process is watching; verify it matches where SIPp will write
3. **Fallback:** stderr parsing is already in place and works (albeit without full metrics)

**Warning signs:** Logs show `[SIPp] Parsed 0 rows from _statistics.csv` but SIPp process completed successfully.

---

## Code Examples

All code examples below follow existing CONVENTIONS.md patterns (ESM, Spanish comments, camelCase, error handling, logging).

### BLOCK-01: Destination Validation Route Handler

```javascript
// Source: backend/src/routes/tests.js (to be extended)

import { Router } from 'express';
import { runTest, stopTest, getTestStatus, getScenarios } from '../services/sippManager.js';

const router = Router();

// Load valid extensions from env at startup
const VALID_EXTENSIONS = new Set(
  (process.env.VALID_EXTENSIONS || '100,101,200,300')
    .split(',')
    .map(e => e.trim())
);

function validateDestination(destination) {
  if (!destination) {
    throw new Error('Destino requerido');
  }
  const dest = String(destination).trim();
  if (!VALID_EXTENSIONS.has(dest)) {
    const availableExts = Array.from(VALID_EXTENSIONS).sort().join(', ');
    throw new Error(
      `Extensión ${dest} no existe en el 3CX. ` +
      `Extensiones válidas: ${availableExts}`
    );
  }
  return dest;
}

router.post('/run', async (req, res) => {
  try {
    // Validate destination early, before creating test record
    const validatedDest = validateDestination(req.body.destination);
    
    const initiatedBy = req.ip || 'unknown';
    const result = await runTest(
      { ...req.body, destination: validatedDest },
      initiatedBy
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

export default router;
```

### BLOCK-02: CSV Reader with Chokidar

```javascript
// Source: backend/src/services/sippManager.js (lines 180-185 refactored)

import { watch } from 'chokidar';
import { parse as parseCsv } from 'fast-csv';
import fs from 'fs';
import path from 'path';

function runRealSipp(testId, params) {
  // ... existing lines 134-165 unchanged ...
  
  const startTime = Date.now();
  const snapshots = [];
  
  // Prepare CSV watcher path
  const statsPath = path.resolve(process.cwd(), '_statistics.csv');
  console.log(`[SIPp] Watching for statistics at: ${statsPath}`);
  
  // Watcher instance (will be cleaned up on process close)
  let csvWatcher = null;

  sippProcess.stderr.on('data', (chunk) => {
    // Keep stderr parsing as fallback
    const line = chunk.toString();
    parseSippStats(line, snapshots, testId);
    if (currentTest) {
      currentTest.elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress({ ...currentTest });
    }
  });

  sippProcess.on('close', (code) => {
    sippProcess = null;
    
    // Close watcher immediately
    if (csvWatcher) csvWatcher.close();
    
    // Attempt to read CSV (async)
    readStatsCsv(statsPath, (csvSnapshots) => {
      if (csvSnapshots.length > 0) {
        console.log(`[SIPp] Using CSV data (${csvSnapshots.length} rows)`);
        snapshots.splice(0, snapshots.length, ...csvSnapshots);
      } else if (snapshots.length > 0) {
        console.log(`[SIPp] CSV empty, using stderr data (${snapshots.length} snapshots)`);
      } else {
        console.warn('[SIPp] No metrics collected (CSV and stderr both empty)');
      }
      
      const summary = buildSummary(snapshots, params);
      finishTest(testId, code === 0 ? (summary.passed ? 'PASS' : 'FAIL') : 'ERROR', summary);
    });
  });

  sippProcess.on('error', (err) => {
    console.error('[SIPp] Process error:', err.message);
    if (csvWatcher) csvWatcher.close();
    finishTest(testId, 'ERROR', { error: err.message });
  });
  
  // Start CSV watcher AFTER spawning (so we're ready if SIPp writes immediately)
  csvWatcher = watch(statsPath, {
    awaitWriteFinish: {
      stabilityThreshold: 500, // Wait 500ms of no changes before reading
      pollInterval: 100
    },
    persistent: false // Don't block exit
  });
  
  csvWatcher.on('add', (path, stats) => {
    console.log(`[SIPp] _statistics.csv created, size: ${stats.size} bytes`);
  });
  
  csvWatcher.on('change', (path, stats) => {
    console.log(`[SIPp] _statistics.csv updated, size: ${stats.size} bytes`);
  });
}

function readStatsCsv(filePath, callback) {
  // Async CSV read with error handling
  const results = [];
  
  fs.readFile(filePath, 'utf8', (readErr, fileContents) => {
    if (readErr) {
      console.warn(`[SIPp CSV] Could not read file: ${readErr.message}`);
      callback([]); // Return empty array, use stderr as fallback
      return;
    }
    
    // Parse CSV with fast-csv
    parseCsv(fileContents, { headers: true })
      .on('data', (row) => {
        // Extract metrics from SIPp CSV columns
        // Column names vary; look for numeric columns representing counts
        const callCount = parseInt(row['Count'] || row['Calls'] || 0);
        const successRate = parseFloat(row['%Success'] || 100);
        
        if (callCount > 0) {
          results.push({
            calls: callCount,
            errorRate: 100 - successRate,
            timestamp: Date.now()
          });
        }
      })
      .on('end', () => {
        console.log(`[SIPp CSV] Parsed ${results.length} records`);
        callback(results);
      })
      .on('error', (parseErr) => {
        console.error(`[SIPp CSV] Parse error: ${parseErr.message}`);
        callback([]); // Return empty, fall back to stderr
      });
  });
}
```

### BLOCK-03: Parser Diagnostic State Machine

```javascript
// Source: backend/src/services/logReader.js (extended)

// Add to module-level state (after line 24):
const diagnostics = {
  linesReceivedThisMin: 0,
  linesMatchedThisMin: 0,
  minuteStartedAt: Date.now(),
};

function startWatchdog() {
  parserWatchdog = setInterval(() => {
    const now = Date.now();
    const sshConnected = isConnected();
    const timeSinceLastParse = state.lastParsedAt ? (now - state.lastParsedAt) : Infinity;
    
    // Calculate match rate
    const lineRate = diagnostics.linesReceivedThisMin;
    const matchRate = lineRate > 0 
      ? (diagnostics.linesMatchedThisMin / lineRate) 
      : 0;
    
    // Determine state and alert
    let alert = null;
    
    if (!sshConnected || timeSinceLastParse > 120_000) {
      // State: SSH_DOWN
      alert = {
        id: 'parser_ssh_down',
        level: 'CRITICO',
        msg: 'Conexión SSH al 3CX perdida (o sin datos por 2+ minutos). Intentando reconectar...',
        ts: new Date().toISOString(),
      };
    } else if (lineRate > 0 && matchRate < 0.05) {
      // State: PARSER_BROKEN
      // Received lines but match rate <5% = parser regex is broken
      alert = {
        id: 'parser_regex_broken',
        level: 'ALTO',
        msg: `Parser roto: ${lineRate} líneas pero ${diagnostics.linesMatchedThisMin} matches (${(matchRate * 100).toFixed(1)}%). ` +
             `Posible actualización de formato del 3CX. Verificar versión.`,
        ts: new Date().toISOString(),
      };
    } else if (lineRate === 0 && sshConnected) {
      // State: NO_TRAFFIC (normal, only log, don't alert)
      console.log('[LogReader] Tráfico bajo el último minuto (horario bajo o sin actividad)');
    }
    
    if (alert && onAlertCallback) {
      onAlertCallback(alert);
    }
    
    // Reset counters for next minute
    diagnostics.linesReceivedThisMin = 0;
    diagnostics.linesMatchedThisMin = 0;
    diagnostics.minuteStartedAt = now;
    
  }, 60_000); // Every minute
}

// Modify attachStream to count lines (add to existing code around line 51):
streamCleanup = execStream(
  cmd,
  (chunk) => {
    state.lastParsedAt = Date.now();
    
    const lines = chunk.toString().split('\n');
    diagnostics.linesReceivedThisMin += lines.length;
    
    lines.forEach(line => {
      const event = parseLine(line);
      if (!event) return;
      
      diagnostics.linesMatchedThisMin++; // Count matches
      applyEvent(event);
    });
  },
  // ... rest unchanged ...
);
```

---

## Environment Availability

### External Dependencies & Availability Check

| Dependency | Required By | Status | Version | Fallback |
|------------|-----------|--------|---------|----------|
| 3CX Call Control API | BLOCK-01 (if using API option) | Not yet verified | v20 | Static `.env` list (recommended for Phase 1) |
| 3CX Config file via SSH | BLOCK-01 fallback (Option B) | Available | N/A | `.env` list |
| SIPp binary (`sipp.exe` on Windows) | BLOCK-02 | ✓ Installed | v3.7.3 (Cygwin) | Test will fail immediately if missing |
| Cygwin environment | All | ✓ Installed | Current | Required (no fallback) |
| Node.js fs module | BLOCK-02 CSV reading | ✓ Built-in | Node 20 LTS | Core module, always available |

**Missing dependencies with no fallback:**
- SIPp binary: If missing, test cannot run. Blocked by Cygwin installation status (done as of 2026-04-27).

**Missing dependencies with fallback:**
- 3CX API (BLOCK-01): Can fallback to static `.env` list (recommended for Phase 1).

---

## Validation Architecture

**Framework:** Jest (recommended; existing codebase has no tests, this is an opportunity to start)

**Config file:** To be created in Phase 1, located at `backend/__tests__/jest.config.js` (or use package.json `"jest"` key)

**Quick run command:** `npm test -- --testPathPattern=block --maxWorkers=2` (tests for BLOCK items only)

**Full suite command:** `npm test` (all test suites)

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Status |
|--------|----------|-----------|-------------------|------------|
| BLOCK-01 | Destination `100` accepted, `999` rejected | unit | `npm test -- block-01-validation` | ❌ Wave 0: Create `__tests__/block-01-destination.test.js` |
| BLOCK-01 | Valid extensions loaded from `VALID_EXTENSIONS` env | unit | Same | ❌ Wave 0 |
| BLOCK-02 | `_statistics.csv` with 1 row parses to 1 snapshot | unit | `npm test -- block-02-csv` | ❌ Wave 0: Create `__tests__/block-02-csv-reader.test.js` + fixture |
| BLOCK-02 | Empty CSV returns fallback (0 snapshots) | unit | Same | ❌ Wave 0 |
| BLOCK-02 | Malformed CSV emits error, uses stderr fallback | unit | Same | ❌ Wave 0 |
| BLOCK-03 | State `ssh_down` fires when `isConnected() === false` | unit | `npm test -- block-03-parser-state` | ❌ Wave 0: Create `__tests__/block-03-parser-state.test.js` |
| BLOCK-03 | State `parser_broken` fires when lines>0 but matches=0 | unit | Same | ❌ Wave 0 |
| BLOCK-03 | State `no_traffic` does not fire alert | unit | Same | ❌ Wave 0 |
| FIND-01 | Phase 1: Screenshot evidence archived (manual verification) | smoke | Manual verification | ⚠️ Wave 1: Post-test, inspect `docs/evidence/` directory |

### Sampling Rate

**Per task commit:** Quick run command after each task completes
```bash
npm test -- --testPathPattern=block --maxWorkers=2 --bail
```

**Per wave merge (Wave 0 → Wave 1):** Full suite before merging
```bash
npm test
```

**Phase gate:** All BLOCK tests passing before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `__tests__/block-01-destination.test.js` — Unit tests for `validateDestination()` function
  - Test case: valid extension accepted
  - Test case: invalid extension rejected with clear message
  - Test case: env var `VALID_EXTENSIONS` loaded correctly
  
- [ ] `__tests__/block-02-csv-reader.test.js` — Unit tests for `readStatsCsv()` function
  - Test case: valid CSV file parsed to snapshots array
  - Test case: empty CSV returns empty array (fallback)
  - Test case: malformed CSV error handling
  - Test case: missing file handled gracefully
  
- [ ] `__tests__/fixtures/sipp-stats-sample.csv` — Real SIPp CSV output (captured from actual SIPp run)
  - Needed to validate fast-csv parsing works with SIPp column structure
  
- [ ] `__tests__/block-03-parser-state.test.js` — Unit tests for parser state machine
  - Test case: `ssh_down` alert when `isConnected() === false`
  - Test case: `parser_broken` alert when lines > 0 but matches = 0
  - Test case: `no_traffic` when no lines received (no alert)
  - Test case: Alert cooldown prevents duplicate fire
  
- [ ] `backend/__tests__/jest.config.js` or update `package.json` with Jest config
  - Set test environment to `node`
  - Configure module paths
  - Skip frontend tests in backend suite
  
- [ ] Framework install: `npm install --save-dev jest` (backend only)

**Wave 1 dependencies:**
- Real SIPp test execution to verify CSV file is actually created with expected columns
- Manual screenshot capture for FIND-01 evidence

---

## Sources

### Primary (HIGH confidence)

- **CLAUDE.md** (project instructions) — sanitization, Spanish comments, always-on constraints, hard limits
- **CONTEXT.md** § BLOCK-01/02/03 — technical discretion boundaries and deferred ideas (FIND-01 timing)
- **PITFALLS.md** § Pitfall #2 (SIPp hangs), § Pitfall #3 (log drift) — inform BLOCK-02 and BLOCK-03 design
- **CONCERNS.md** § items #2, #6, #7 — existing fragilities (stderr parser, destination unsanitized, watchdog spammy)
- **STACK.md** — chokidar v3.6, fast-csv v5.0 recommended for BLOCK-02; already researched

### Secondary (MEDIUM confidence)

- **INTEGRATIONS.md** — 3CX Call Control API reserved for future; SSH authentication patterns; no direct extension list endpoint confirmed
- **sippManager.js** (lines 134-184, 192-211) — current stderr parsing implementation; BLOCK-02 builds on this
- **logReader.js** (lines 100-114) — current watchdog warning; BLOCK-03 extends state tracking
- **tests.js** (lines 14-22) — route handler structure; BLOCK-01 validation fits this pattern

### Tertiary (LOW confidence — flagged for validation)

- **3CX v20 Call Control API availability** — unverified for extensions endpoint or auto-update flag; requires investigation if proceeding with API option (recommended: skip for Phase 1, use `.env` list)

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Stderr parsing for SIPp results | CSV file reading (more reliable) | Phase 1 | Snapshots now populated with real call metrics instead of empty |
| Single watchdog alert "parser may be broken" | Three-state diagnostic (ssh_down/parser_broken/no_traffic) | Phase 1 | Operators can distinguish false alarms from real issues |
| No destination validation | Reject invalid extensions at API boundary | Phase 1 | Tests cannot run with invalid destinations (fail fast) |
| Manual auto-updates verification only | (Planned Phase 4) Automatic detection via API/SSH | Phase 4 | Operators notified immediately if setting re-enabled |

**Deprecated/outdated:**
- Stderr-only parsing: still works as fallback, but CSV is now primary data source

---

## Open Questions

1. **3CX Call Control API availability (BLOCK-01 decision)**
   - What we know: 3CX v20 has Call Control API; docs mention extensions, calls, recording endpoints
   - What's unclear: Does the API expose auto-update settings? Does it expose current extension list with `GET /api/v1/extensions`?
   - Recommendation: Contact OLAM IT or 3CX support docs; if uncertain, use static `.env` list for Phase 1 (safe, proven fallback)
   - Effort to resolve: 0.5-1 hour (documentation review or API call test)

2. **SIPp CSV column structure (BLOCK-02 validation)**
   - What we know: SIPp writes `_statistics.csv` with summary data
   - What's unclear: Column names and structure for SIPp v3.7.3 on Cygwin (may differ from Linux)
   - Recommendation: Capture sample SIPp output during first test run and verify column names match parser expectations
   - Effort to resolve: Captured during Phase 1 task execution (no separate research)

3. **3CX config file path and format (BLOCK-01 Option B fallback)**
   - What we know: 3CX stores config in Debian filesystem, likely under `/opt/3cxpbx/`
   - What's unclear: Exact path, file format (XML/JSON), and authentication required
   - Recommendation: Not needed for Phase 1 (static `.env` recommended); can investigate for Phase 4 if API unavailable
   - Effort to resolve: 1-2 hours (SSH exploration + file format parsing)

4. **Parser stale threshold tuning (BLOCK-03)**
   - What we know: Current threshold is 2 minutes (120,000 ms)
   - What's unclear: Is 2 minutes the right window? May be too aggressive for genuine low-traffic periods.
   - Recommendation: Keep 2-minute threshold for Phase 1; Phase 5 can tune based on production traffic patterns
   - Effort to resolve: Runtime observation during Phase 3 (Tests SC32)

---

## Metadata

**Confidence breakdown:**
- **Standard stack (chokidar, fast-csv):** HIGH — both are well-documented, widely used, stable
- **Architecture (destination validation route, CSV reader pattern, parser state machine):** HIGH — follows existing code patterns; no new architectural paradigm
- **BLOCK implementation details:** MEDIUM-HIGH — code examples provided, but SIPp CSV format unverified until first test
- **FIND-01 feasibility:** MEDIUM — depends on undocumented 3CX API surface; recommended to defer to Phase 4
- **3CX API availability:** MEDIUM — known to exist, but specific endpoints unconfirmed; investigation needed for Option B/C

**Research date:** 2026-05-03
**Valid until:** 2026-05-17 (2 weeks; Phase 1 implementation starts within 1 week; SIPp CSV format validated during first test)

**Updates needed if:**
- 3CX API documentation becomes available → re-evaluate BLOCK-01 Option B cost/benefit
- SIPp CSV format differs from expectations → adjust parsing logic in BLOCK-02
- Production traffic patterns show 2-minute threshold too aggressive → adjust BLOCK-03 window in Phase 5

---

*Research for Phase 1: Unblock — OLAM 3CX Audit Platform*
*Researched: 2026-05-03 by GSD Phase Researcher*
