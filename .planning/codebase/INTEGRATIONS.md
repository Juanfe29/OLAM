# External Integrations

**Analysis Date:** 2026-05-01

## APIs & External Services

**3CX PBX Server (172.18.164.28):**
- SSH connection for log tailing and metrics collection
  - Location: `backend/src/services/sshClient.js`
  - Auth: RSA private key (`SSH_KEY_PATH=./keys/3cx_rsa`)
  - Tunnel support: Optional SSH port forwarding for node_exporter if firewall blocks direct access

**SIP Trunking (Tigo UNE):**
- Carrier SIP trunk endpoint: `sip:172.17.179.166:5060` (UDP, no TLS)
- Monitored via 3CX logs and node_exporter metrics
- Error tracking: 408 (Request Timeout), 503 (Service Unavailable)
- Status monitored in: `backend/src/services/logReader.js` and `backend/src/services/anomalyDetector.js`

**3CX Call Control API:**
- Currently reserved for future integration (documented in CLAUDE.md)
- Intended as secondary validation for active call count

## Data Storage

**Databases:**
- **SQLite** (local file-based)
  - Location: `backend/data/olam.db`
  - Connection: Direct file via sqlite3 npm package
  - Configuration: `backend/src/db/schema.js`
  - Tables:
    - `tests` — Test metadata, parameters, results (id, initiated_by, scenario, max_calls, duration, ramp_rate, destination, started_at, ended_at, result, summary)
    - `metrics_snapshots` — Periodic snapshots during test execution (test_id, timestamp, data JSON)
  - Pragmas: WAL mode enabled, foreign keys enforced

**File Storage:**
- Local filesystem only: SQLite database + SSH keys directory (`backend/keys/`)

**Caching:**
- In-memory: Current metrics snapshot (`backend/src/services/metricsCollector.js`)
- No Redis or external cache layer

## Authentication & Identity

**SSH Authentication:**
- Type: RSA private key authentication
- Key location: `backend/keys/3cx_rsa` (must be provisioned manually)
- User: `root` (configurable via `SSH_USER` env var)
- Host: `172.18.164.28:22` (configurable via `SSH_HOST` and `SSH_PORT`)

**SIPp Digest Authentication:**
- Extension number and password for SIP digest auth (407 response handling)
- Environment vars: `SIPP_AUTH_USER`, `SIPP_AUTH_PASS`
- Implemented in: `backend/src/services/sippManager.js` (lines 151–155)
- Wired since: 2026-04-27 (Cygwin SIPp Phase 5)

**Frontend Auth:**
- No authentication implemented yet (todo: JWT integration, `JWT_SECRET` env var reserved)

## Monitoring & Observability

**Metrics Collection:**
- **Prometheus text format** via node_exporter on 3CX host
  - Endpoint: `http://172.18.164.28:9100/metrics`
  - Fallback via SSH tunnel: `NODE_EXPORTER_VIA_SSH=true`, `NODE_EXPORTER_TUNNEL_PORT=9100`
  - Parser: `backend/src/services/metricsCollector.js` (lines 113–148)
  - Metrics extracted:
    - CPU: `node_cpu_seconds_total` (calculated as percentage from delta)
    - RAM: `node_memory_MemTotal_bytes`, `node_memory_MemAvailable_bytes`
    - Disk: `node_filesystem_*_bytes` (root mountpoint)
    - Network: `node_network_receive_bytes_total`, `node_network_transmit_bytes_total` (physical interfaces only)
    - Load average: `node_load1`, `node_load5`, `node_load15`

**Log Parsing:**
- Real-time log tailing via SSH
  - Location: `backend/src/services/logReader.js`
  - Command: `stdbuf -oL tail -F -n 0 [5 log files]`
  - Logs parsed:
    - `/var/lib/3cxpbx/Instance1/Data/Logs/3CXCallFlow.log` — Call lifecycle (INVITE, BYE, failures)
    - `/var/lib/3cxpbx/Instance1/Data/Logs/3CXGatewayService.log` — SIP trunk status, 408/503 errors
    - `/var/lib/3cxpbx/Instance1/Data/Logs/3CXQueueManager.log` — Queue depth, agent status
    - `/var/lib/3cxpbx/Instance1/Data/Logs/3cxSystemService.log` — System-level errors
    - `/var/lib/3cxpbx/Instance1/Data/Logs/3CXIVR.log` — IVR behavior
  - Parser: `backend/src/services/logParser.js` (regex-based format detection)
  - Watchdog: Alerts if no log data for 2+ minutes (parser staleness detection)

**Error Tracking:**
- Slack webhook reserved (env var `SLACK_WEBHOOK_URL`, not yet wired)
- Built-in anomaly detection: `backend/src/services/anomalyDetector.js`
  - Rules trigger on: high error rate, near capacity, latency, CPU/RAM, MOS degradation
  - Cooldown: 5 minutes per rule to prevent alert spam

**Logs:**
- Application logs to stdout/stderr (console.log/console.error)
- SQLite audit log: test execution metadata (initiator IP, parameters, results)

## CI/CD & Deployment

**Hosting:**
- Development: Local (Windows 10 laptop, 172.18.164.35)
- Target deployment: Windows 10 host 172.18.164.35 via Cygwin

**Execution Environment:**
- SIPp runs on deployment host (172.18.164.35 Cygwin), NOT on 3CX
- Binary location configurable via `SIPP_BIN` env var (defaults to `sipp.exe` on Windows, `sipp` on Linux)
- SIPp invoked via: `backend/src/services/sippManager.js` using Node.js `child_process.spawn()`

**CI Pipeline:**
- None currently (manual dev workflow: `npm run dev`)
- No automated testing, linting, or builds

## Environment Configuration

**Required env vars:**
- `SSH_HOST` — 3CX host IP (default: 172.18.164.28)
- `SSH_PORT` — SSH port (default: 22)
- `SSH_USER` — SSH username (default: root)
- `SSH_KEY_PATH` — Path to private key (required, no default)
- `LOGS_PATH` — Remote log directory (default: /var/lib/3cxpbx/Instance1/Data/Logs)
- `LOG_POLL_INTERVAL` — Metrics polling interval in ms (default: 5000)
- `NODE_EXPORTER_URL` — Prometheus endpoint (default: http://172.18.164.28:9100/metrics)
- `PORT` — Backend port (default: 3000, overridden to 3001 in .env.example)
- `MOCK_MODE` — true/false for demo vs production (default: true)
- `DB_PATH` — SQLite database path (default: ./data/olam.db)
- `SIPP_BIN` — Override SIPp binary path (empty = auto-detect per OS)
- `SIPP_AUTH_USER` — SIP extension for digest auth (e.g., "999", empty = no auth)
- `SIPP_AUTH_PASS` — SIP password for digest auth

**Optional env vars:**
- `SLACK_WEBHOOK_URL` — Slack integration (reserved, not implemented)
- `JWT_SECRET` — JWT signing key for future auth (reserved)
- `NODE_EXPORTER_VIA_SSH` — true to tunnel Prometheus through SSH
- `NODE_EXPORTER_TUNNEL_PORT` — Local port for SSH tunnel (default: 9100)

**Secrets location:**
- SSH private key: `backend/keys/3cx_rsa` (NOT in git, must be provisioned)
- Environment secrets: `.env` file (NOT in git, see `.env.example`)

## Webhooks & Callbacks

**Incoming:**
- None currently implemented

**Outgoing:**
- Slack webhook reserved (env var `SLACK_WEBHOOK_URL`, not yet wired)
- WebSocket real-time events:
  - `metrics:update` — Metrics broadcast every 5 seconds
  - `alert:new` — New anomaly detected
  - `test:progress` — SIPp test progress update
  - `test:complete` — Test finished with summary

## Real-time Communication

**WebSocket (Socket.io v4.7.2):**
- Server: `backend/src/server.js` (io initialization)
- Client: Frontend connects via `socket.io-client`
- Events:
  - `connection` — New client connects, receives current metrics and active alerts
  - `metrics:update` — 5-second push of host/calls/quality/trunk/queue metrics
  - `alert:new` — Alert emitted when anomaly rule fires
  - `test:progress` — During SIPp execution: elapsed time, active calls, error rate
  - `test:complete` — Test finished event with final summary
  - `alerts:current` — Initial alert list on connect

## Data Flows

**Passive Mode (Always-On):**
1. SSH connection maintains persistent session to 3CX
2. Log reader streams 5 log files in parallel via `tail -F`
3. Log parser extracts events (calls, errors, trunk state, queue depth)
4. Metrics collector polls node_exporter every 5 seconds
5. Anomaly detector evaluates rules against metrics
6. WebSocket broadcasts metrics and alerts to all connected clients
7. SQLite stores only test execution history, not every metric event

**Active Mode (SIPp Test):**
1. Frontend submits test parameters (calls, duration, ramp rate, destination)
2. Backend validates against hard limits (max 200 calls, max 20 ramp, max 8h duration)
3. SIPp spawned as child process with validated arguments
4. SIPp stats parsed from stderr and injected into mock metrics
5. Every 1 second, test progress emitted to all clients
6. Metrics snapshots persisted to SQLite every 30 seconds (6 snapshots/min)
7. On test completion or stop, final summary built and stored

---

*Integration audit: 2026-05-01*
