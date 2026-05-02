# Stack Research

**Domain:** PBX assessment platform extension — additions to existing Node.js+React app for PDD/RTCP measurement, custom SIPp scenarios, Windows self-monitoring, and ops handoff.
**Researched:** 2026-05-02
**Confidence:** MEDIUM-HIGH

> **Note:** This document scopes the **net-new libraries** needed for the post-SC192-wait milestone. The existing stack (Node 20, Express 4.18, Socket.io 4.7, React 18, Vite 5, SQLite, node-ssh, axios) is already locked-in per [`.planning/codebase/STACK.md`](../codebase/STACK.md) and **must not be replaced** in this milestone. Recommendations below are additive only.

---

## Recommended Stack (additions to existing app)

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|---|---|---|---|
| **NSSM** (Non-Sucking Service Manager) | 2.24+ | Wraps the Node backend as a Windows Service for auto-restart on crash | Works on Win10 without admin elevation when installed per-user; superior to `node-windows` (requires admin) and `forever`/`pm2` (Windows support is buggy and dropped). Single binary, drop-in install. |
| **winston** | 3.13+ | Structured logging with rotation | Mature, ~200M dl/year, supports daily rotation, JSON output for grep, multiple transports. Battle-tested on Windows. |
| **winston-daily-rotate-file** | 5.0+ | Companion transport for daily/size-based log rotation | Standard pairing with winston. Solves OLAM-19 (log rotation gap). |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---|---|---|---|
| **better-sqlite3** | 11.x | (Already in stack) — used to persist platform health events alongside test history | Reuse existing DB to write to a new `health_events` table; avoid introducing a second persistence layer for OLAM-16/17. |
| **node-ssh** | 13.x | (Already in stack) — open second SSH connection to 3CX for ad-hoc commands | Per ARCHITECTURE.md research: keep primary SSH for log streaming, open a 2nd connection for `tcpdump`/`sngrep`/RTCP capture and metric polling. Same library, separate `NodeSSH` instance. |
| **chokidar** | 3.6+ | Watch SIPp `_statistics.csv` file once test ends | Solves OLAM-02 (read final CSV instead of stderr). Cross-platform path handling, low overhead. |
| **fast-csv** | 5.0+ | Parse SIPp `_statistics.csv` output | Standard CSV parser, streaming support, robust against partial files (which SIPp produces during test). Alternative to `csv-parse`. |
| **xml2js** | 0.6+ | Parse custom SIPp XML scenarios for validation before invocation | Scenario files (`backend/sipp-scenarios/*.xml`) need a syntax check before launch to fail fast, not after 30s of failed test. Lightweight, no native deps. |

### Development Tools

| Tool | Purpose | Notes |
|---|---|---|
| **NSSM CLI** | Install/manage Windows Service | Install via `nssm.exe install OlamBackend "C:\Program Files\nodejs\node.exe" "C:\Users\lamda\OLAM\backend\src\server.js"`. Logs to `Application Data\nssm-OlamBackend.log`. Run as user `lamda`, not Local System. |
| **Cygwin tcpdump** | Packet capture for H-03 Tigo diagnosis | Already covered by Cygwin install; verify the `tcpdump` package is selected during Cygwin setup or install via apt-cyg. |
| **Cygwin sngrep** | SIP-aware capture and replay | Already documented in CLAUDE.md as "instalado por separado". Optional — pcap from tcpdump is enough if sngrep adds friction. |

## Installation

```bash
# Backend additions
cd backend
npm install winston winston-daily-rotate-file chokidar fast-csv xml2js

# NSSM (Windows host .35 only — non-admin install)
# Download nssm.exe to C:\Users\lamda\nssm\
# Add C:\Users\lamda\nssm to user PATH
# (No npm package — pure binary)

# 3CX side (Debian) — already installed for tcpdump/sngrep, verify only:
ssh root@172.18.164.28 'which tcpdump sngrep'
```

## Alternatives Considered

| Recomendado | Alternativa | Cuándo usar la alternativa |
|---|---|---|
| **NSSM** for Windows Service | **node-windows** | If admin rights become available — `node-windows` integrates with `npm` and reads scripts. Until then, requires admin to install. |
| **NSSM** | **PM2** | If the platform ever moves off Windows. PM2 ecosystem on Windows is unreliable (process group handling, log paths). |
| **NSSM** | **WinSW** | Older XML-config Windows service wrapper. Use only if NSSM bundle conflicts with corporate AV. |
| **NSSM** | **Task Scheduler + batch** | Lowest-friction option, no external binaries, native to Windows. Trade-off: no health checks, no clean stop signal — OK as a fallback if NSSM gets blocked by IT. |
| **winston** | **pino** | Pino is faster but its Windows ecosystem (esp. log rotation) lags winston. Choose pino only if backend hits log throughput >5k lines/s — OLAM is far below that. |
| **fast-csv** | **csv-parse** | csv-parse from `@csv/parse` is also solid; slightly more features. fast-csv wins on streaming-from-incomplete-file behavior, which matches SIPp's mid-test CSV writes. |
| **2nd SSH connection** | **Reuse single SSH for stream + commands** | Single connection saves a tunnel but creates head-of-line blocking — `tail -F` blocks `tcpdump` start. Per ARCHITECTURE.md research: hard rule, don't reuse. |
| **Custom SIPp XML** | **Programmatic SIPp arg construction (current uac loop)** | Current approach is fine for ≤50 calls. Above that, ramp pacing in CLI args is brittle. Migrate to XML when first peak/stress test is scheduled. |
| **chokidar for CSV watch** | **fs.watch** native | fs.watch is unreliable on Windows for files written from Cygwin (line-buffer flush mismatches). chokidar normalizes that. |

## What NOT to Use

| Evitar | Por qué | Usar en su lugar |
|---|---|---|
| **node-windows** (in this milestone) | Requires admin to install the Windows Service component. OLAM host `lamda` has no admin per project constraints | NSSM |
| **forever** | Last meaningful release 2018; abandoned, broken IPC handling on Windows | NSSM (for Windows Service) or `nodemon` (for dev only) |
| **pm2** for production on this host | Windows port has known issues with `pm2 startup`, log path handling, and process group cleanup. Reports of orphaned processes | NSSM |
| **fluent-logger / fluentd / Logstash** for log shipping | Out of scope for this milestone (Out-of-scope: external alerts/integrations). Adds infra dependency | winston with file transport, leave shipping for future milestone |
| **node-rdkafka / pino-elasticsearch** | Same — over-engineered for a single-host Windows service that ops will read manually | winston file logs |
| **express-rate-limit** for backend hardening | Out of scope — RBAC/auth excluded explicitly in PROJECT.md | (skip) |
| **tail-stream / watch-stream** wrappers around fs.watch | Brittle on Windows, especially with Cygwin-written files | chokidar |
| **node-pcap / pcap2** | Native compilation required, tied to libpcap version, doesn't work on Win10 without admin/libpcap deps. Plus we capture on the **3CX Debian host**, not on `.35` | Run `tcpdump` over SSH on the 3CX, copy pcap back to `.35` for analysis |
| **3CX Web API for PDD** | The 3CX Call Control API is best-effort and doesn't expose PDD; reverse-engineering it for this is fragile | Parse `3CXGatewayService.log` for `INVITE → 18x/200 OK` time delta — the source of truth |

## Stack Patterns by Variant

**If `lamda` user gets admin rights at any point:**
- Switch from NSSM to `node-windows` for tighter `npm` integration
- Reason: install via `npm run install-service`, easier handoff to ops with Node-only mental model

**If H-07 mitigation pivots from firewall filter to SIP/TLS migration:**
- Add **`tls`** module usage in any future SIP-aware service (not in scope for this milestone)
- Plus a separate cert management lib like **`acme-client`** if certs from Let's Encrypt — but unlikely given 3CX certificate model

**If the volume of platform self-events grows:**
- Consider moving health events from `better-sqlite3` to a dedicated `events.log` rotated by winston
- Below ~10k events/day, SQLite is simpler

**If RTCP capture from `tcpdump` proves unreliable on production traffic:**
- Fall back to **3CX Call Quality Report** API (per Call Control API docs) — coarser data but always available
- Stub MOS/jitter as "unavailable" rather than zero per Pitfall #7 in PITFALLS.md

## Version Compatibility

| Package A | Compatible con | Notas |
|---|---|---|
| `winston@3.13` | `winston-daily-rotate-file@5.0+` | Locked pairing; older v4 of rotate-file works only with winston@2 |
| `chokidar@3.6` | Node 20 LTS | v4 introduced breaking changes; stick to v3.6 hasta migración de Node |
| `better-sqlite3@11` | Node 20 LTS | Already in stack; ABI matches Node 20 prebuilt binaries on Windows |
| `node-ssh@13` | Node 20 LTS | Already in stack; supports `forwardOut` used by current SSH tunnel |
| NSSM 2.24 | Win10 | Per-user install; `nssm install` no requiere admin si el servicio corre como user account |

## Sources

- [`.planning/codebase/STACK.md`](../codebase/STACK.md) — existing stack baseline (HIGH confidence — read directly)
- [`.planning/codebase/INTEGRATIONS.md`](../codebase/INTEGRATIONS.md) — integraciones actuales (3CX, node_exporter, Tigo, SIPp/Cygwin)
- [`.planning/research/ARCHITECTURE.md`](./ARCHITECTURE.md) — recomendación NSSM, separación de SSH connections (HIGH confidence)
- [`.planning/research/PITFALLS.md`](./PITFALLS.md) — pitfall #4 (Windows crash loops), pitfall #7 (PDD/MOS hardcoded 0) inform stack choices
- npm registry — current versions of winston, chokidar, fast-csv, xml2js verified at time of research
- NSSM official site (nssm.cc) — non-admin install pattern verified

**Confidence calibration:**
- HIGH: NSSM choice over alternatives (multiple sources confirm Windows behavior)
- HIGH: winston for logs (industry standard, no real competitor for this volume + Windows)
- MEDIUM: chokidar over fs.watch — Windows + Cygwin interaction is the kind of edge case where empirical testing during execution may reveal surprises
- MEDIUM: 2nd SSH connection vs. multiplexing — the architecture researcher recommended it; needs real load to validate
- LOW: 3CX log format stability for PDD parsing — auto-update can break parsers (per CONCERNS.md and Pitfall #3); mitigation is part of OLAM-12 phase

---
*Stack research for: PBX assessment platform extension on Win10 + Cygwin*
*Researched: 2026-05-02 (synthesized from existing codebase docs + architecture/pitfalls research, after primary stack researcher returned BLOCKED)*
