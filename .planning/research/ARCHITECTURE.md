# Architecture Patterns for OLAM Extension Phase

**Domain:** PBX real-time monitoring platform with advanced metrics + self-monitoring on Windows

**Researched:** 2026-05-01

**Confidence:** HIGH (based on existing codebase patterns + industry norms for Node.js + Windows production systems)

---

## Recommended Architecture

The existing OLAM backend follows a **service-oriented, event-driven pattern** with a single Express process managing SSH persistence, log streaming, metrics aggregation, anomaly detection, and test orchestration.

The extension phase (OLAM-12 through OLAM-19) should **extend existing services rather than introduce new silos**. Below is the component structure that minimizes risk to the always-on passive monitoring capability.

```
Backend Process (single, always-on)
│
├─── Layer: Entry Point
│    └─ server.js (boot sequence unchanged)
│       ├─ Initializes existing services (SSH, LogReader, MetricsCollector, etc.)
│       └─ Initializes new services (PDDCalculator, RTCPCollector, HealthWatchdog)
│
├─── Layer: Data Acquisition
│    ├─ sshClient.js (EXTEND — add 2nd connection for metrics/commands)
│    ├─ logReader.js (EXTEND — add per-file tracking + parser watchdog)
│    ├─ logParser.js (EXTEND — add PDD extraction from Gateway logs)
│    ├─ [NEW] rtcpCollector.js (RTCP packet capture via SSH tunnel)
│    └─ [NEW] healthWatchdog.js (backend self-monitoring)
│
├─── Layer: Metric Aggregation & Processing
│    ├─ metricsCollector.js (EXTEND — incorporate PDD and RTCP into shape)
│    ├─ [NEW] pddCalculator.js (dedicated PDD computation from log events)
│    └─ [NEW] rtcpMetricsExtractor.js (parse RTCP into quality KPIs)
│
├─── Layer: Persistence & History
│    ├─ db/schema.js (EXTEND — add tables: pdd_events, rtcp_samples, health_log)
│    └─ db/queries.js (EXTEND — add insert/select for new tables)
│
├─── Layer: Orchestration & Alerting
│    ├─ anomalyDetector.js (existing unchanged)
│    └─ sippManager.js (EXTEND — reference custom scenario files)
│
└─── Layer: Presentation
     └─ routes/status.js, tests.js, history.js (EXTEND endpoints for new metrics)

External (versioned in repo, not code):
└─── backend/sipp-scenarios/ (NEW — custom XML scenario files)
```

---

## Component Boundaries

### 1. SSH Client Layer (EXTEND existing)

**Current:** Single persistent SSH connection handles logs + node_exporter tunnel.

**Extension:**
- Open 2nd SSH connection (dedicated to metrics polling + ad-hoc commands)
- Keep 1st connection exclusively for log streaming (`tail -F` on 5 files)
- Reason: Prevents log stream stalls when fetching RTCP or other metrics

**New Methods in sshClient.js:**
- `openMetricsConnection()` — parallel connection for node_exporter, RTCP commands
- `executeCommand(cmd, timeout)` — one-off commands via metrics connection

**Risk Mitigation:**
- Maintains existing exponential backoff + reconnect per connection
- If metrics connection fails, falls back to primary (graceful degradation)
- Log streaming never blocks on metrics ops

**File Location:** `backend/src/services/sshClient.js`

---

### 2. Log Parser (EXTEND existing)

**Current:** Parses 5 log file types; extracts call state, errors, trunk events.

**Extension:** Add PDD extraction from SIP timing data.

**New Pattern Recognition:**
- 3CXGatewayService.log contains INVITE→200 OK pairs with timestamps
- PDD = (200 OK timestamp) - (INVITE sent timestamp)
- Pattern: Look for entries like `[12:34:56.123] INVITE to sip:172.17.179.166` and `[12:34:57.456] SIP/2.0 200 OK`
- Emit `pdd_event` with: `{ callId, timestampInvite, timestamp200OK, pddMs, carrierLatency }`

**New Return Type from parseLine():**
- Existing: `{ type: 'call_active', ...}`
- New: `{ type: 'pdd_event', callId, pddMs, fromCallFlow: false }`

**Why Here vs New Service:**
- Already processes every Gateway log line
- No new SSH stream needed
- Stateless extraction (events emitted, not accumulated)

**Risk:** Parser becomes more complex; offset handled by fallback to 0 if pattern not found.

**File Location:** `backend/src/services/logParser.js`

---

### 3. PDD Calculator Service (NEW)

**Responsibility:** Consume PDD events from parser, aggregate into KPIs.

**Pattern:** Sliding window aggregator (sister to anomalyDetector's stateful rule engine).

**Inputs:**
- `pdd_event` objects from logParser (PDD per call)

**Outputs:**
- `trunk.pddToCarrier_p50` — median PDD to carrier (ms)
- `trunk.pddToCarrier_p95` — 95th percentile
- `trunk.pddToCarrier_max` — maximum observed

**State:**
- In-memory window: last 300 PDDs (5-minute rolling window)
- SQLite: persist aggregates every 5 minutes

**Integration:**
- logReader.js calls `pddCalculator.onParsedEvent(event)` when PDD event arrives
- metricsCollector.js calls `pddCalculator.getMetrics()` during 5-second poll
- Format: `{ p50: 45, p95: 125, max: 340 }` (units: milliseconds)

**Why Separate:**
- Calculation logic distinct from parsing
- Can be tested independently
- Can be replaced or enhanced (e.g., carrier-specific thresholds)

**File Location:** `backend/src/services/pddCalculator.js`

---

### 4. RTCP Collector Service (NEW)

**Responsibility:** Capture RTCP packets from RTP streams, extract quality metrics.

**Inputs:**
- SSH commands via sshClient metrics connection

**Pattern:** Periodic tcpdump capture (no persistent listener; polling-based).

**Approach:**
1. Every 30 seconds, spawn `tcpdump` via SSH for 5-second capture window
2. Filter: `udp port 5004` (RTP) and `udp port 5005` (RTCP)
3. Write to temporary file on 3CX, transfer via SFTP to backend
4. Parse with custom RTCP parser (RFC 3550)
5. Extract: jitter, packet loss, MOS estimate (from RTCP XR if available)

**Alternative (Simpler):**
- Use SIPp's built-in RTP proxy (if load test active) to capture RTCP
- Only collect during SIPp tests, not in production monitoring

**Implementation Order:**
1. Phase 1: Stub returns mock RTCP metrics (0 jitter, 0 loss, 4.0 MOS)
2. Phase 2: Integrate tcpdump + RFC 3550 parser (requires libpcap bindings)
3. Phase 3: Fetch RTCP from 3CX Call Control API CDR if available

**Why Separate Service:**
- Heavy dependencies (libpcap, tcpdump)
- Polling model (not event-driven like parser)
- Can be disabled without breaking passive mode

**State:**
- In-memory cache: last 100 RTCP samples
- SQLite: persist quality metrics every 5 minutes

**File Location:** `backend/src/services/rtcpCollector.js`

---

### 5. RTCP Metrics Extractor (NEW)

**Responsibility:** Consume RTCP packets, compute quality KPIs.

**Inputs:**
- Raw RTCP blocks from rtcpCollector

**Outputs:**
- `quality.mos` — mean opinion score (estimated or from XR)
- `quality.jitter_p95` — 95th percentile jitter (ms)
- `quality.packetLoss` — fraction of packets lost (%)

**Pattern:** Stateless transformer (RFC 3550 parsing + MOS estimation).

**Integration:**
- rtcpCollector.js calls `rtcpMetricsExtractor.parseRTCP(packet)` → event
- metricsCollector.js calls `rtcpMetricsExtractor.getMetrics()` during 5-second poll
- Format: `{ mos: 4.2, jitter: 12, packetLoss: 0.3 }`

**Why Separate from Collector:**
- Collector handles I/O (tcpdump, SFTP, buffering)
- Extractor handles math (percentiles, MOS formula)
- Allows RTCP parsing to be unit-tested without SSH

**File Location:** `backend/src/services/rtcpMetricsExtractor.js`

---

### 6. Health Watchdog Service (NEW)

**Responsibility:** Self-monitor the backend process; raise internal alerts if critical functions stall.

**Metrics to Watch:**
- SSH connection state (✓ connected / ✗ disconnected, reconnect attempts)
- Last log line received (age in seconds)
- Metrics collector poll latency (max 10s warning)
- Parser regex match rate (% of lines parsed vs total)
- SQLite write latency (max 1s warning)
- Memory usage (% of available)

**Pattern:** Periodic health check (5-second interval, same as metrics collector).

**Outputs:**
- Internal `health_status` object: `{ ssh: 'connected', lastLogAge: 3.2, parserMatchRate: 98.5, dbLatency: 0.15 }`
- WebSocket event `health:update` sent to frontend every 5s
- SQLite log: store health snapshots hourly

**Integration:**
- server.js initializes `healthWatchdog.start()`
- healthWatchdog subscribes to logReader + metricsCollector + sshClient state changes
- Emits `io.emit('health:update', status)` alongside metrics
- Front-end Dashboard shows health panel (SSH indicator, last log timestamp, parser health)

**Why Separate:**
- Observability for the platform itself (not the 3CX)
- Can be extended with alerts to ops (e.g., "parser stale 5+ minutes")
- Persistent health history aids debugging post-incident

**File Location:** `backend/src/services/healthWatchdog.js`

---

### 7. SIPp Scenario File Repository (NEW)

**Responsibility:** Version custom SIP scenario XML files for load tests.

**Pattern:** Filesystem-based; no code generation.

**Structure:**
```
backend/sipp-scenarios/
├── README.md                         # How to add scenarios
├── smoke.xml                         # 1 call
├── light.xml                         # 10 calls
├── medium.xml                        # 50 calls
├── peak.xml                          # 180 calls
├── stress.xml                        # 220 calls
└── soak.xml                          # 125 calls x 4 hours
```

**Benefit:**
- Scenarios are data, not code (easier to tune, share, version)
- sippManager.js reads from disk: `readFileSync('./sipp-scenarios/peak.xml')`
- Can be generated by separate tool or maintained manually

**When to Use:**
- Tests ≤10 calls: inline scenario (current approach via `-s` flag)
- Tests >10 calls: XML file for better call handling (call state machine, hold/release patterns)

**Why Separate Location:**
- Keeps code and config distinct
- Versioned in git, not hardcoded in JS
- TI OLAM can edit without touching backend code

**File Location:** `backend/sipp-scenarios/`

---

## Data Flow Direction

### Passive Mode (Always-On)

```
┌─────────────────────────────────────────────────────────────────┐
│  SSH Connection (Primary — log streaming, persistent)            │
│  ↓                                                                │
│  tail -F /var/lib/3cxpbx/Instance1/Data/Logs/*.log               │
│  ├─ 3CXCallFlow.log     (call state)                             │
│ ├─ 3CXGateway.log       (SIP signaling + PDD)                    │
│ ├─ 3CXQueue.log         (queue events)                           │
│ ├─ 3CXSystem.log        (health)                                 │
│ └─ 3CXIVR.log           (IVR events)                             │
│  ↓                                                                │
│  logReader.js (stream consumer)                                  │
│  ├─ applies line-by-line to parser                              │
│ └─ tracks lastParsedAt + lineCount for health watch             │
│  ↓                                                                │
│  logParser.js (stateless regex-based)                           │
│  ├─ detectFile() → identifies log type                          │
│ ├─ parseLine() → { type: 'call_active', id, duration } etc.   │
│ ├─ NEW: also emits → { type: 'pdd_event', callId, pddMs }     │
│ └─ null for unparseable lines (silently skipped)               │
│  ├─ logReader.apply()                                           │
│  │  ├─ update in-memory state (activeCalls, errors408, etc.)   │
│  │  └─ pddCalculator.onParsedEvent(event)                      │
│  │                                                               │
│  └─ [PARALLEL] SSH Connection (Secondary — metrics polling)    │
│     ├─ every 5s: GET http://127.0.0.1:9100/metrics (node_exporter) │
│     ├─ every 30s: tcpdump RTP/RTCP capture                      │
│     └─ on-demand: /3CX/api/* (call state validation)            │
│        ↓                                                         │
│        metricsCollector.js (5-second poll cycle)                │
│        ├─ getHostMetrics() — CPU, RAM, disk, network from node_exporter │
│        ├─ getCallMetrics() — active, tier, errors from logReader state │
│        ├─ pddCalculator.getMetrics() — p50, p95, max PDD       │
│        ├─ rtcpMetricsExtractor.getMetrics() — jitter, loss, MOS │
│        └─ normalize → metrics shape                             │
│           ↓                                                      │
│           anomalyDetector.js (rule engine)                      │
│           ├─ evaluate 8 rules + 4 Phase 0 permanent findings   │
│           ├─ deduplicate via 5-min cooldown per rule ID        │
│           └─ fire alert if match                                │
│              ↓                                                   │
│              server.js (event loop)                             │
│              ├─ io.emit('metrics:update', metrics)             │
│              ├─ io.emit('alert:new', alert)                    │
│              └─ WebSocket broadcast to all connected clients   │
│                 ↓                                                │
│                 Frontend (React)                                │
│                 ├─ Dashboard renders 10 KPI cards + history    │
│                 ├─ Alerts sorted by severity                    │
│                 └─ Graphs update every 5s in real-time         │
│                                                                  │
│  healthWatchdog.js (self-monitoring)                            │
│  ├─ listens to all above layers                                 │
│  ├─ tracks SSH age, log freshness, parser health               │
│  └─ emits io.emit('health:update', status)                    │
│                                                                  │
│  SQLite (persistence)                                           │
│  ├─ tests table ← test records from sippManager                │
│  ├─ metrics_snapshots ← aggregated metrics every 5min          │
│  ├─ pdd_events ← PDD calculations every 5min                   │
│  ├─ rtcp_samples ← quality metrics every 5min                  │
│  └─ health_log ← watchdog snapshots hourly                     │
└─────────────────────────────────────────────────────────────────┘
```

**Key Characteristics:**
- **Non-blocking:** Each layer consumes from previous, emits downstream
- **Graceful Degradation:** If RTCP collection fails, jitter/loss show "N/A"; core monitoring continues
- **Single Process:** No multiprocessing overhead on Windows (Node.js event loop handles concurrency)
- **Persistent State:** Only in-memory during live cycle; snapshots persisted to SQLite

---

### Active Mode (SIPp Load Test)

```
Frontend (Tests page)
│
└─ POST /api/tests/run { max_calls, duration, ramp_rate, destination }
   ↓
   sippManager.js (lock-based, one test at a time)
   ├─ validate + clamp params to hard limits
   ├─ look up or generate SIPp scenario
   │  ├─ if ≤10 calls: use inline scenario (current `-s` syntax)
   │  └─ if >10 calls: read from backend/sipp-scenarios/peak.xml
   ├─ INSERT test record to SQLite (id, scenario, params, started_at, status='RUNNING')
   ├─ spawn SIPp as child process with scenario + auth creds
   │  └─ backend/sipp-scenarios/[scenario].xml passed as `-f` argument
   │
   └─ [PARALLEL] Monitoring during test
      ├─ logReader continues streaming (tests don't interrupt passive mode)
      ├─ metricsCollector continues 5s polls (shows baseline metrics alongside test)
      ├─ anomalyDetector continues rule evaluation (alerts during test visible)
      ├─ sippManager polls SIPp stdout every 500ms for progress
      │  ├─ parses: `[timestamp] calls=123, success=98%, errors=2`
      │  └─ emits io.emit('test:progress', { calls, errorRate, duration })
      └─ SIPp child process runs for specified duration, then exits
         ↓
         sippManager reads _statistics.csv from SIPp output dir
         ├─ extract final call counts, ASR, error breakdown
         ├─ UPDATE test record: result, asr, mos, snapshots[], summary
         └─ io.emit('test:complete', { result, asr, errorRate, snapshots })

[After Test]
│
└─ GET /api/history/:testId
   ↓
   db/queries.js
   ├─ SELECT test, metrics_snapshots where test_id = testId
   └─ Frontend renders test detail (parameters, live metrics during test, final verdict)
```

**Key Points:**
- Tests run in child process (does not block passive monitoring)
- Metrics continue updating (shows how 3CX reacted to load)
- Alerts fire during test (visible in real-time on Dashboard)
- Test record + snapshots persisted (audit trail + evidence)

---

## Build Order Recommendation

**Goal:** Minimize risk to always-on capability; get early validation of critical paths.

### Phase 0 (Already Done)
- ✓ Backend SSH + logReader + logParser + metricsCollector + anomalyDetector
- ✓ Frontend Dashboard + Tests + History pages
- ✓ SIPp wired up with digest auth
- ✓ SQLite persistence

### Phase 1 (Foundation — Week 1)
**Tasks:** Set up infrastructure for new services without changing existing behavior.

1. **OLAM-16a: Extend sshClient.js for 2nd connection**
   - Add `openMetricsConnection()` method
   - Implement separate reconnect logic (independent of primary)
   - Test: Verify both connections stay alive independently
   - Risk: LOW (additive, non-breaking)

2. **OLAM-16b: Create healthWatchdog.js scaffold**
   - Define health_status shape
   - Implement state subscribers (listen to logReader, metricsCollector, sshClient)
   - Emit `health:update` event every 5s (stubbed values initially)
   - Add to frontend Dashboard as read-only health panel
   - Risk: LOW (new UI panel, non-blocking)

3. **DB Schema Extension (schema.js)**
   - Add tables: `pdd_events`, `rtcp_samples`, `health_log`
   - Run migrations (or delete and recreate on next startup)
   - Risk: LOW (backward compatible; old data ignored)

**Validation Gate:** Backend still boots, passive monitoring still works, no new metrics yet.

---

### Phase 2 (PDD Extraction — Week 2)
**Tasks:** Instrument PDD calculation from existing Gateway logs.

1. **OLAM-12a: Extend logParser.js for PDD events**
   - Add regex to extract INVITE→200 OK pairs from 3CXGatewayService.log
   - Emit `{ type: 'pdd_event', callId, pddMs }` from parseLine()
   - Handle missing timestamps gracefully (skip if incomplete)
   - Risk: MEDIUM (regex complexity; requires testing against real logs)

   **Validation:**
   - Capture 1 hour real logs from 3CX
   - Verify regex matches expected INVITE/200 OK lines
   - Unit test: `logParser.parseLine(realLogLine)` returns expected PDD

2. **OLAM-12b: Create pddCalculator.js**
   - Consume PDD events from logReader
   - Maintain sliding window (last 300 PDDs)
   - Compute p50, p95, max
   - Expose `getMetrics()` for metricsCollector
   - Risk: LOW (pure aggregation math)

3. **OLAM-12c: Extend metricsCollector.js**
   - Call `pddCalculator.getMetrics()` during 5s poll
   - Merge into metrics shape: `metrics.trunk.pddToCarrier_p50`, `_p95`, `_max`
   - Risk: LOW (additive to metrics shape)

4. **Frontend: Update MetricCard.js + Dashboard.jsx**
   - Show PDD KPIs in Trunk section
   - Add thresholds: OK <100ms, Warning 100-200ms, Critical >200ms
   - Risk: LOW (new KPI cards, non-breaking)

**Validation Gate:** Dashboard shows realistic PDD values (50-150ms typical for Tigo). SIPp tests show rising PDD under load. Alerts fire if PDD >200ms.

---

### Phase 3 (RTCP Setup — Week 3)
**Tasks:** Lay groundwork for quality metrics; initially stub.

1. **OLAM-13a: Create rtcpCollector.js (stub version)**
   - Define polling interval (30s capture window)
   - Skeleton for tcpdump command construction
   - Return mock RTCP metrics initially (0 jitter, 4.0 MOS, 0 loss)
   - Risk: LOW (stub; no real capture yet)

2. **OLAM-13b: Create rtcpMetricsExtractor.js**
   - Parsing logic for RFC 3550 (RTCP format)
   - Jitter calculation from timestamps
   - MOS estimation formula (e.g., ITU-T G.107)
   - Expose `getMetrics()` for metricsCollector
   - Risk: MEDIUM (math-heavy; RFC comprehension needed)

3. **OLAM-13c: Extend metricsCollector.js**
   - Call `rtcpMetricsExtractor.getMetrics()` during 5s poll
   - Merge: `metrics.quality.mos`, `metrics.quality.jitter_p95`, `metrics.quality.packetLoss`
   - Risk: LOW (additive)

4. **Frontend: Update Dashboard.jsx**
   - Add Quality section with MOS, jitter, packet loss cards
   - Show "N/A — RTCP not yet instrumented" placeholder message
   - Risk: LOW (new section, stub data)

**Validation Gate:** Dashboard shows Quality section. Real SIPp tests show non-zero MOS/jitter (mock values). Ready for Phase 4.

---

### Phase 4 (Real RTCP Capture — Week 4)
**Tasks:** Implement tcpdump-based RTCP collection.

1. **OLAM-13d: Implement rtcpCollector.js (real version)**
   - Use 2nd SSH connection to run `tcpdump` on 3CX
   - Filter: `-i any -A udp dst port 5005 -w /tmp/rtcp_capture.pcap`
   - Spawn 5-second window every 30 seconds
   - Transfer PCAP via SFTP to backend
   - Parse with libpcap binding (e.g., `pcap` npm module)
   - Risk: HIGH (depends on libpcap availability, SFTP permissions, performance)

   **Mitigation:** If tcpdump fails, gracefully fall back to mock. Alert ops: "RTCP collection unavailable."

2. **Testing:**
   - Capture real RTCP from SIPp test
   - Verify PCAP parsing extracts jitter, loss, SSRC
   - Validate MOS estimate against manual calculation

**Validation Gate:** Real SIPp test shows MOS 4.2, jitter 15ms, loss 0.2%. Values correlate with call quality observations.

---

### Phase 5 (Self-Monitoring — Week 5)
**Tasks:** Complete healthWatchdog; add operational visibility.

1. **OLAM-16c: Fully implement healthWatchdog.js**
   - Granular state tracking: SSH age, log freshness, parser match rate, DB latency
   - Alert thresholds:
     - SSH disconnected → critical alert (visible on Dashboard)
     - Log age >5 min → warning (parser likely broken)
     - Parser match rate <80% → warning (format may have changed)
     - DB latency >2s → warning (disk I/O issue)
   - Hourly snapshot to health_log table
   - Risk: LOW (purely observational; no changes to monitoring flow)

2. **Frontend: Expand health panel**
   - Show SSH status (green/red indicator)
   - Last log timestamp (relative, e.g., "3 seconds ago")
   - Parser health % (match rate)
   - Click-through to detailed health history
   - Risk: LOW (new UI, read-only)

3. **OLAM-17: Watchdog alerts in anomalyDetector.js**
   - Add 3 new rules:
     - `parser_stale`: health.lastLogAge > 300s
     - `parser_broken`: health.parserMatchRate < 0.8
     - `ssh_disconnected`: health.sshConnected === false
   - Emit alerts at CRÍTICO/ALTO level
   - Risk: MEDIUM (adds complexity to anomaly detector)

**Validation Gate:** Backend crash/restart visible as SSH disconnect alert. Log stream lag visible as stale warning. Operators have clear visibility.

---

### Phase 6 (SIPp Scenarios — Week 6)
**Tasks:** Version custom SIPp XML for larger tests.

1. **OLAM-14: Create backend/sipp-scenarios/ directory**
   - Generate or write manually: smoke.xml, light.xml, ..., soak.xml
   - Each contains full SIP INVITE → HOLD → BYE sequence
   - Parameterize: `#DESTINATION#`, `#CALLS#`, `#DURATION#` (substituted at runtime)
   - Risk: MEDIUM (SIPp XML syntax; requires validation)

2. **Extend sippManager.js**
   - Read scenario from disk if >`10 calls
   - `readFileSync(`./sipp-scenarios/${scenarioName}.xml`)` → substitute params
   - Write to temp file, pass `-f` to SIPp
   - Risk: LOW (straightforward file I/O)

3. **Testing:**
   - Run peak test (180 calls) with XML scenario
   - Verify call ramp, hold, release patterns match specification
   - Monitor: no unexpected SIP errors, call duration stable
   - Risk: MEDIUM (requires live 3CX; can only test with license upgrade)

**Validation Gate:** Peak test runs to completion with expected call counts. No sudden drops or errors.

---

### Phase 7 (Auto-Restart — Week 7)
**Tasks:** Ensure backend survives crashes; restores SSH session.

1. **OLAM-18a: Graceful shutdown on Windows**
   - Catch `SIGTERM`, `SIGINT` (from service manager)
   - Close SSH connections cleanly
   - Finalize in-progress test to SQLite
   - Emit WebSocket disconnect to frontend
   - Risk: MEDIUM (Windows-specific signal handling; needs testing)

2. **OLAM-18b: Auto-restart on crash**
   - Use `node-windows` (npm package for Win services)
   - Register backend as Windows Service
   - Configure auto-restart on crash (wait 10s before restarting)
   - Risk: HIGH (service manager interaction; requires admin or per-user approach)

   **Mitigation:** For non-admin user (lamda), use `nssm` (Non-Sucking Service Manager) or PM2 instead.

3. **OLAM-18c: Session restoration**
   - On startup, check for incomplete test in SQLite (status='RUNNING', no end_at)
   - Mark as `FAILED` with reason "backend restarted"
   - Log event: "Backend recovered from crash at HH:MM"
   - Risk: LOW (data integrity; need transaction support)

**Validation Gate:** Kill backend process; verify auto-restart within 15s. Incomplete test marked FAILED in history.

---

### Phase 8 (Logging & Audit — Week 8)
**Tasks:** Professional logging for production operations.

1. **OLAM-19a: Structured logging (winston or pino)**
   - Replace console.log/error with logger.info/error
   - Add context: service name, operation, duration, result
   - Log levels: DEBUG, INFO, WARN, ERROR
   - Example: `logger.info({ service: 'logParser', event: 'pdd_extracted', callId, pddMs, duration: '45ms' })`
   - Risk: LOW (library-based; non-breaking)

2. **OLAM-19b: Log rotation**
   - Write to `backend/logs/` directory
   - Rotate daily + compress old files
   - Retain 7 days of logs
   - Risk: LOW (standard practice; library handles it)

3. **OLAM-19c: Audit log (already partially done)**
   - Audit table already exists; enhance with granularity
   - Log: SSH connect/disconnect, test start/stop, parser state changes, alerts fired
   - Risk: LOW (extension of existing audit_log)

**Validation Gate:** Logs show clear timeline of events. Ops team can debug issues post-incident.

---

## Integration Points with Existing Layers

### SSH Stream (sshClient.js)

**Current:**
- 1 persistent connection
- Handles: log streaming (`tail -F`) + node_exporter tunnel (port forwarding)
- Reconnect logic built-in

**Extension:**
- Add 2nd connection (metricsConnection)
- Both connections share same reconnect backoff strategy
- Primary used exclusively for logs; secondary for metrics/commands
- If primary dies, logs lag but metrics continue; if secondary dies, quality metrics go stale but passive mode unaffected

**No Breaking Changes:**
- Existing `execStream()` call unchanged
- New methods: `openMetricsConnection()`, `execCommand()`
- Both connections use same credential set (SSH_USER, SSH_KEY_PATH)

---

### Log Parser (logParser.js)

**Current:**
- Stateless regex-based parser
- 5 log types (CallFlow, Gateway, Queue, System, IVR)
- Returns: { type, ...eventData } or null

**Extension:**
- Add 6th pattern for PDD extraction (Gateway logs only)
- parseLine() may return multiple event types from single line (rare but possible)
- Change return to: `[{ type: 'call_active', ... }, { type: 'pdd_event', ... }]`
- Or: emit PDD as separate event downstream

**No Breaking Changes:**
- Existing return type (single object or null) compatible with array of objects (iterate)
- logReader.js iterates over returned events (change from `if (event)` to `if (event.length)`)

---

### Metrics Collector (metricsCollector.js)

**Current:**
- Polls every 5 seconds
- Aggregates: host metrics (node_exporter) + call metrics (logReader state) + 3CX API
- Emits WebSocket `metrics:update`

**Extension:**
- Poll `pddCalculator.getMetrics()` and `rtcpExtractor.getMetrics()` during same cycle
- Merge results into metrics shape before WebSocket emit
- If either returns null (not ready), skip that field (backward compatible)

**No Breaking Changes:**
- Metrics shape is nested object; new fields additive
- Frontend ignores unknown fields
- Thresholds for new fields added separately in anomalyDetector

---

### Anomaly Detector (anomalyDetector.js)

**Current:**
- 8 rules + 4 Phase 0 permanent findings
- Evaluates every 5s against metrics object
- Deduplicates via lastFiredAt cooldown (5 min)

**Extension:**
- Add 3 new rules for health watchdog (parser_stale, parser_broken, ssh_disconnected)
- Existing rules can check new metrics (PDD, MOS) if desired
- Example: `check: (m) => m.trunk.pddToCarrier_p95 > 200` (new rule for carrier latency)

**No Breaking Changes:**
- Rule array is additive
- Existing rules unaffected
- New rules can be gated by feature flag (e.g., `if (RTCP_ENABLED)`)

---

### SQLite Persistence (db/)

**Current:**
- 2 tables: tests, metrics_snapshots
- Queried via REST endpoints (/api/history)

**Extension:**
- Add 3 tables: pdd_events, rtcp_samples, health_log
- Keep existing tables; migration not needed (backward compatible)
- New tables fed from new services; existing code ignores them

**No Breaking Changes:**
- Existing schemas locked; new tables created separately
- Query helpers (queries.js) extended with new functions
- Schema init is idempotent

---

### Frontend (React)

**Current:**
- Dashboard: 10 KPI cards (host, calls, quality, queue, trunk)
- Tests: control + progress
- History: test table

**Extension:**
- Dashboard: add PDD KPIs (p50, p95, max) in Trunk section
- Dashboard: add Quality KPIs (MOS, jitter, packet loss) in Quality section (initially stubbed)
- Dashboard: add Health panel (SSH status, log freshness, parser health)
- History: detail view shows full metrics snapshots + RTCP samples

**No Breaking Changes:**
- Existing KPI cards unchanged
- New sections added below existing sections
- useMetrics() hook extended to consume new WebSocket events (pdd:update, rtcp:update, health:update)

---

## Risk Minimization Strategy

### Keep Always-On Passive Mode Stable

**Constraint:** The dashboard and SSH stream must remain operational at all times. Test failures are acceptable; loss of passive monitoring is not.

**Strategy:**
1. **Isolate new services:** New services (pddCalculator, rtcpCollector, healthWatchdog) do not block core pipeline.
2. **Graceful fallback:** If PDD extraction fails (regex no match), metric shows 0; passive mode continues.
3. **Separate SSH connection:** RTCP/metrics collection on 2nd connection; if it dies, logs still stream on primary.
4. **No daemon dependencies:** No background workers, child processes, or external daemons outside the main Node process.
5. **Stub early:** Implement new services as stubs first (return 0 or mock data); real logic added incrementally.

### Build Order Minimizes Coupling

**Week 1-2:** Only extends existing services (logParser, sshClient); no new functionality visible yet. Risk: LOW.

**Week 3-5:** New services are passive observers (healthWatchdog) or pure aggregators (pddCalculator). No changes to core flow. Risk: LOW.

**Week 6-8:** Operational enhancements (auto-restart, logging) and optional features (RTCP, scenarios). Can be deferred if blocked. Risk: MEDIUM.

---

## Implementation Checklist for Each Phase

### Phase 1: SSH + Health Watchdog Foundation

- [ ] sshClient.js: add `openMetricsConnection()` method with independent reconnect
- [ ] healthWatchdog.js: scaffold with state subscribers + event emitter
- [ ] server.js: initialize healthWatchdog on boot
- [ ] db/schema.js: add health_log table
- [ ] Frontend Dashboard.jsx: add health panel component (read-only)
- [ ] Test: both SSH connections stay alive independently for 5 minutes

### Phase 2: PDD Extraction

- [ ] logParser.js: add INVITE→200 OK regex pattern for Gateway logs
- [ ] logParser test: capture real log lines from 3CX, verify regex matches
- [ ] pddCalculator.js: aggregate PDD events into p50/p95/max sliding window
- [ ] metricsCollector.js: call pddCalculator.getMetrics() during poll
- [ ] db/schema.js: add pdd_events table
- [ ] Frontend: add PDD KPI cards in Trunk section
- [ ] Test: run light load test, verify PDD values rise with call volume

### Phase 3: RTCP Scaffolding

- [ ] rtcpCollector.js: stub version returns mock data
- [ ] rtcpMetricsExtractor.js: parsing logic + MOS formula
- [ ] metricsCollector.js: call rtcpExtractor.getMetrics()
- [ ] db/schema.js: add rtcp_samples table
- [ ] Frontend: add Quality section with MOS, jitter, packet loss cards (show "N/A")
- [ ] Test: Dashboard loads without errors; Quality section visible

### Phase 4: Real RTCP Capture (deferred if blocked by tcpdump/libpcap)

- [ ] rtcpCollector.js: implement tcpdump + PCAP parsing
- [ ] Test: SIPp test + tcpdump capture + MOS calculation
- [ ] Verify: real MOS values correlate with call quality observations

### Phase 5: Health Monitoring

- [ ] healthWatchdog.js: full implementation with granular state tracking
- [ ] anomalyDetector.js: add 3 new rules (parser_stale, parser_broken, ssh_disconnected)
- [ ] Frontend: health panel click-through to history view
- [ ] Test: kill SSH connection, verify parser_stale alert within 5 minutes

### Phase 6: SIPp Scenarios

- [ ] Create backend/sipp-scenarios/ with XML files for smoke, light, medium, peak, stress, soak
- [ ] sippManager.js: extend to read scenario from disk if >10 calls
- [ ] Test: run peak test (180 calls) with XML scenario + license upgrade

### Phase 7: Auto-Restart (Windows Service)

- [ ] Choose implementation: node-windows or nssm (per-user service)
- [ ] Register backend as service
- [ ] Implement graceful shutdown + session restoration
- [ ] Test: simulate crash, verify auto-restart + incomplete test marked FAILED

### Phase 8: Logging + Audit

- [ ] Add winston or pino logger
- [ ] Replace console.log/error with structured logging
- [ ] Implement log rotation (7-day retention)
- [ ] Extend audit_log table with granular events
- [ ] Test: verify logs rotate daily + old logs compress

---

## Summary

| Dimension | Recommendation |
|-----------|---|
| **New Services** | 3 total (pddCalculator, rtcpCollector, healthWatchdog); all passive/additive |
| **Extend Existing** | logParser (PDD regex), sshClient (2nd connection), metricsCollector (aggregate new metrics), anomalyDetector (add health rules) |
| **Versioned Config** | backend/sipp-scenarios/ directory (XML files, not code) |
| **Data Direction** | Push-based (events flow downstream); no polling loops introduced |
| **Build Order** | Foundation (weeks 1-2) → Metrics (weeks 3-4) → Operations (weeks 5-8); always-on stable first |
| **Risk Profile** | Low for weeks 1-3 (additive); Medium for weeks 4-8 (operational dependencies) |
| **Windows Constraints** | 2nd SSH connection handles metrics isolation; auto-restart via nssm or node-windows; no WSL/multiprocessing needed |

---

**Architecture analysis: 2026-05-01**
