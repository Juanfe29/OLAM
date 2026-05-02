# Architecture

**Analysis Date:** 2026-05-01

## Pattern Overview

**Overall:** Service-oriented, event-driven real-time monitoring platform with bi-directional WebSocket streaming and pluggable load-testing orchestration.

**Key Characteristics:**
- Single-process Express backend handles HTTP REST routes, WebSocket events, and SSH-based log streaming concurrently
- Frontend connects via Socket.io for push-based metrics and alerts (no polling)
- SSH persistent connection with exponential backoff reconnection strategy
- Mock mode supports full end-to-end testing without 3CX server connection
- SIPp test execution with hard-enforced parameter limits to prevent abuse

## Layers

**Presentation (Frontend):**
- Purpose: Real-time UI dashboard for live metrics, alerting, and test orchestration
- Location: `frontend/src/`
- Contains: React pages, components, hooks, styling (Tailwind CSS)
- Depends on: Socket.io-client, Axios, Recharts charting, React Router
- Used by: End-users viewing dashboard and controlling tests

**HTTP API Layer (Backend):**
- Purpose: REST endpoints for status retrieval, test control, and history
- Location: `backend/src/routes/` (status.js, tests.js, history.js)
- Contains: Express Router handlers that delegate to services
- Depends on: Service layer (metricsCollector, sippManager, anomalyDetector)
- Used by: Frontend via REST, external tools via Postman

**Service Layer (Backend):**
- Purpose: Core business logic organized into single-responsibility modules
- Location: `backend/src/services/`
- Contains: SSH client, log reader/parser, metrics collection, anomaly detection, SIPp orchestration
- Depends on: Database, external APIs (node_exporter, 3CX Call Control API), SSH tunneling
- Used by: Routes, server.js initialization, each other via imports

**Data Layer (Backend):**
- Purpose: SQLite persistence for test history and metrics snapshots
- Location: `backend/src/db/`
- Contains: Schema definition, query helpers
- Depends on: sqlite3 driver, fs for directory creation
- Used by: sippManager to log test runs, metricsCollector to archive snapshots

**WebSocket Event Bus:**
- Purpose: Real-time broadcasting of metrics and alerts to connected clients
- Location: `backend/src/server.js` (Socket.io instantiation and event emission)
- Contains: io.emit() calls that broadcast server state changes
- Event types: `metrics:update`, `alert:new`, `alerts:current`, `test:progress`, `test:complete`, `trunk:status`

## Data Flow

**Live Monitoring (Passive Mode):**

1. SSH client connects to 172.18.164.28 (3CX server) with exponential backoff reconnect
2. Log reader streams output of `tail -F -n 0 /var/lib/3cxpbx/Instance1/Data/Logs/*.log` via SSH exec
3. Log parser identifies file type (CallFlow, Gateway, Queue, System, IVR) and extracts structured events (call_active, error_408, trunk_registered, etc.)
4. Log reader applies events to in-memory state (activeCalls counter, errors408 per hour, etc.)
5. Metrics collector polls node_exporter at 172.18.164.28:9100 every 5 seconds to fetch CPU, RAM, disk, network metrics
6. Metrics collector combines log state + host metrics + 3CX Call Control API data into normalized shape
7. Anomaly detector evaluates all metrics against hardcoded rules (cpu > 80%, activeCalls === 0, error_rate > 20%, etc.)
8. Rules that fire trigger alerts; deduplication via 5-minute cooldown per rule ID
9. Server emits `metrics:update` event to all connected WebSocket clients every ~5 seconds
10. Frontend receives metrics, updates local state, renders dashboard
11. Frontend also receives `alert:new` events and prepends to alert list

**State Management:**
- In-memory: Metrics snapshots, current test status, active alerts (transient during session)
- Persistent: Test history + snapshots in SQLite (survives backend restart)
- Shared: `useMetrics()` hook maintains rolling window of last 30 minutes of metrics for charting

**Load Testing (Active Mode):**

1. Frontend (Tests page) sends POST `/api/tests/run` with params (max_calls, duration, ramp_rate, destination)
2. sippManager validates and clamps params to hard limits (max 200 calls, 20 calls/sec, 8 hours)
3. Test record inserted into SQLite tests table with initiating IP, timestamp, scenario, parameters
4. In mock mode: metricsCollector enters "test override" state; mock metrics gradually ramp up active calls to target, then sustain
5. In real mode: SIPp spawned as child process with dynamically generated SIP scenario (INVITE-to-destination, call hold, BYE)
6. sippManager polls child process stdout for progress (calls connected, calls failed, call rate)
7. Progress emitted to frontend via `test:progress` WebSocket event every ~500ms
8. When duration elapsed or stop requested: SIPp killed, test record finalized with result (PASS/FAIL), metrics snapshots written to SQLite
9. Frontend receives `test:complete` event with summary (ASR, MOS, error rate aggregates)
10. Metrics continue updating in background; anomalies during test are captured in normal alert flow

## Key Abstractions

**SSHClient (sshClient.js):**
- Purpose: Singleton SSH connection manager with auto-reconnect and optional port forwarding
- Pattern: Single persistent connection; stream-based (no polling); backoff reconnect on disconnection
- Critical Features:
  - `execStream(cmd, onData, onClose)` returns cleanup function to cancel stream
  - SSH tunnel forwarding for node_exporter when firewall blocks direct :9100 access
  - Graceful error handling; reconnectAttempts tracked separately from connection attempts

**LogReader (logReader.js):**
- Purpose: Tail 5 log files from 3CX, parse lines, maintain in-memory counter state
- Pattern: Stream consumer; applies parser output to ephemeral state object
- Watchdog: Alert if no log data seen for 2+ minutes (parser may be broken due to 3CX version update)
- Examples: Maintains activeCalls count, errors408/503 per hour, trunk registration state

**LogParser (logParser.js):**
- Purpose: Regex-based line parser supporting 5 distinct 3CX log formats
- Pattern: Stateless function; detectFile() tracks which log file current line came from via tail's file headers
- Defensive: Patterns check for SIP status codes in context (not just numbers); handles both YYYY/MM/DD and DD/MM/YYYY timestamps

**MetricsCollector (metricsCollector.js):**
- Purpose: Aggregate metrics from multiple sources (logs, node_exporter, 3CX API) into unified shape every 5s
- Pattern: Polls on interval; combines real data with fallback mock data; CPU delta calculated from cumulative counters
- Mock Data: Probabilistic jitter and load-based drift ensure realistic distributions, not flat values
- Shape: Normalizes host (cpu, ram, loadAvg, disk, network), calls (active, tier, pdd_p95, asr, errorRate), quality (mos, jitter, packetLoss), trunk (registered, channelsUsed, errors408/503), queue (waiting, agentsOnline, serviceLevel, abandonment)

**AnomalyDetector (anomalyDetector.js):**
- Purpose: Evaluate hardcoded rules against live metrics; emit deduplicated alerts
- Pattern: Stateful rule evaluator; tracks lastFiredAt per rule ID; cooldown prevents spam
- Phase 0 Findings: 4 permanent hardware findings (SC32 license insufficient, SIP without TLS, 408 errors on trunk, auto-updates enabled) loaded at boot
- Examples: "activeCalls === 0 for 30s", "errorRate > 20%", "cpu > 80%", "near_capacity checks active > tier * 0.9"

**SIPpManager (sippManager.js):**
- Purpose: Orchestrate load test lifecycle; spawn SIPp process, stream progress, finalize results
- Pattern: Lock-based (only one test at a time); parameters validated and clamped before execution; test ID auto-incremented
- Scenarios: Predefined presets (smoke 1 call 30s, light 10 calls 60s, medium 50 calls 120s, peak 180 calls 300s, stress 220 calls 180s, soak 125 calls 4h)
- Mock vs Real: Mock test simulates metrics ramp; real test spawns SIPp executable with dynamically generated scenario file

## Entry Points

**Backend (server.js):**
- Location: `backend/src/server.js`
- Triggers: `npm run dev` via nodemon
- Responsibilities:
  1. Initialize database schema
  2. Start SSH connection (with mock bypass)
  3. Attach log reader and stream to logs
  4. Start anomaly detector (pre-load Phase 0 findings)
  5. Start metrics collector (poll interval)
  6. Initialize SIPp manager with callbacks
  7. Register HTTP routes (/api/status, /api/tests, /api/history)
  8. Set up Socket.io listener for new connections (emit current metrics + alerts on connect)
  9. Listen on port 3000 (or env PORT)

**Frontend (main.jsx → App.jsx):**
- Location: `frontend/src/main.jsx` (entry), `frontend/src/App.jsx` (router root)
- Triggers: `npm run dev` via Vite on port 5173
- Responsibilities:
  1. Render React.StrictMode wrapper
  2. Mount router with 3 pages: Dashboard, Tests, History
  3. Top nav with OLAM branding and page links
  4. Each page hooks useMetrics() to connect WebSocket and retrieve metrics

**Dashboard Page (pages/Dashboard.jsx):**
- Renders 10 KPI cards organized by section (Host, Calls, Quality, Queue)
- Renders CallChart component with 30-minute history (via Recharts LineChart)
- Renders TrunkStatus component showing Tigo UNE registration, channels, errors
- Renders AlertPanel component sorted by severity

**Tests Page (pages/Tests.jsx):**
- Left side: TestControl component (preset buttons, sliders, destination input, start/stop buttons)
- Right side: Live progress bar, active calls / error rate / objective display during test
- Below: LineChart showing test:progress events in real-time

**History Page (pages/History.jsx):**
- Table of all past tests (fetched from GET /api/history)
- Columns: Date, Scenario, Calls, Duration, ASR, MOS, Result (PASS/FAIL/STOPPED)
- Click row for detail view

## Error Handling

**Strategy:** Layered error handling with specific fallback behaviors per layer.

**SSH Errors:**
- Connection failure → scheduled reconnect with exponential backoff (2s → 30s max)
- Execstream error → logged, cleanup pushed to cleanup stack, stream will re-attach on next interval
- Tunnel failure → logged, tunnel server set to null, TCP clients will see immediate disconnect

**Log Parser Errors:**
- Unparseable lines → skipped (null return), no error logged (logs are noisy)
- Watchdog monitors 2+ minute parse gap → alert raised ("parser may be broken")
- fileType detection failure → line skipped

**Metrics Collection Errors:**
- node_exporter timeout (4s) → fallback hostMetrics to zeroes, continue
- Prometheus parse failure → hostMetrics zeroes but real data from logs still used
- 3CX API error → logged, metrics use fallback values

**Anomaly Rules:**
- Rule match failure (undefined value) → rule not fired, no crash
- Alert generation → de-duplicated via lastFiredAt cooldown
- Rule mismatch on next cycle → alert auto-resolved (removed from activeAlerts)

**Test Execution:**
- SIPp spawn failure → error caught, test record finalized as FAILED
- Test parameter validation → clamp to limits before sending to SIPp (no invalid command line)
- WebSocket disconnect during test → test continues, progress buffered in memory, frontend reconnects to receive summary

## Cross-Cutting Concerns

**Logging:**
- Console.log() prefixed with service name in brackets: `[SSH]`, `[LogReader]`, `[Metrics]`, `[SIPp]`
- Errors logged to stderr via console.error()
- No log rotation or persistent log file (logs only to terminal/docker stdout)

**Validation:**
- SSH credentials validated on connect (error caught, reconnect scheduled)
- Test parameters validated and clamped to hard limits in sippManager.runTest() before DB insert
- All user-provided params sanitized: destination input is validated as regex `[0-9a-zA-Z*#]+` before passing to SIPp
- No shell injection risk: SIPp params constructed as array passed to spawn(), not shell string

**Authentication:**
- No API key or JWT enforcement (open dashboard, assumes network boundary trust)
- SSH private key loaded from env.SSH_KEY_PATH, never embedded or logged
- Test audit trail: initiatedBy (IP) and timestamp recorded in DB for each test

**Telemetry & Observability:**
- Real-time metrics exposed via REST (GET /api/status) and WebSocket
- Test history queryable via REST (GET /api/history/:id)
- Metrics snapshots archived to SQLite for post-test analysis
- No external observability platform (Datadog, New Relic); self-contained

**State Initialization:**
- Mock mode: All metrics synthetic, no SSH needed, frontend shows "MOCK MODE" badge
- Production mode: SSH connect on boot with 10s timeout; if fails, reconnect scheduled but dashboard still loads (shows "SSH disconnected")
- Database: Created on first run, persists across restarts
- Alerts: Phase 0 findings pre-loaded at boot, override any state

---

*Architecture analysis: 2026-05-01*
