# Feature Landscape: OLAM 3CX Assessment Platform

**Domain:** PBX capacity assessment + load testing platform with real-time monitoring and self-operations

**Researched:** 2026-05-01

**Data Sources:** Codebase analysis (ARCHITECTURE.md, TESTING.md, CONCERNS.md, INTEGRATIONS.md), PROJECT.md requirements, CLAUDE.md constraints, SIPp v3.7.3 capabilities, Node.js production best practices for Windows operations

---

## Table Stakes

Features users expect when commissioning a "PBX assessment platform" proof-of-concept. Missing = assessment is incomplete or unusable.

| Feature | Why Expected | Complexity | Status | OLAM-ID | Notes |
|---------|--------------|-----------|--------|---------|-------|
| **Real-time dashboard with live metrics** | Users need to SEE the 3CX health while tests run — fundamental value prop | Low | ✓ Built | — | 10 KPI cards + charts, WebSocket push every 5s |
| **Streaming log data from 3CX via SSH** | Cannot assess without seeing actual call flows, errors, capacity consumption | Med | ✓ Built | — | `tail -F` on 5 log files, persistent SSH connection |
| **Active call count tracking** | Core KPI: how many concurrent calls are the system supporting right now? | Low | ✓ Built | — | Parsed from CallFlow logs + validated vs 3CX API |
| **Test scenario presets (smoke/light/medium/peak/soak)** | Testers need defined, repeatable scenarios to isolate problems | Low | ✓ Built | — | 6 presets hardcoded; custom via sliders |
| **SIPp load test execution** | Cannot assess capacity without synthetic call load — this IS the assessment | High | ✓ Built (Phases 1-5) | — | Cygwin + digest auth wired; OLAM-02 (smoke fail) blocks real tests |
| **Test result persistence** | Must prove what was tested: parameters, duration, calls, errors, when, by whom | Low | ✓ Built | — | SQLite audit log + metrics snapshots |
| **Anomaly detection alerting** | Cannot spot problems manually — platform must flag critical conditions | Med | ✓ Built | — | 7 rules + 4 Phase-0 findings; WebSocket push |
| **Phase-0 findings visible at startup** | Must communicate known blockers (SC32 license, SIP/UDP insecurity, 408 errors, auto-updates risk) from day zero | Low | ✓ Built | — | H-01, H-03, H-05, H-07 pre-loaded as critical alerts |
| **Trunk status indicator (SIP registration, channels, errors)** | Must know: is the carrier link healthy? How many channels in use? | Med | ✓ Built | — | Tigo UNE endpoint monitoring; 408/503 error tracking |
| **Evidence-grade audit trail** | For compliance + blame assignment: who ran which test, when, with what params, result | Low | ✓ Built | — | SQLite: `initiatedBy` (IP), `timestamp`, scenario, parameters, result |
| **Health check endpoint** | Ops must be able to verify backend is alive and connected to 3CX without human interpretation | Low | ✓ Built | — | `GET /api/health` with SSH/DB/SIPp status flags |
| **History query by test ID** | Consultants + ops must review past test results for root cause analysis | Low | ✓ Built | — | `GET /api/history/:id` with full snapshots |
| **Graceful mock mode** | Development, QA, and demo CANNOT require VPN access to real 3CX; must work offline | Med | ✓ Built | — | Probabilistic metrics drift; `MOCK_MODE=true` env var |
| **Parametrized test control via UI** | Testers need to customize load: calls, duration, ramp rate | Low | ✓ Built | — | Sliders + preset buttons; validated in backend |
| **Live test progress display** | Running a 4-hour soak without visibility = blind testing; must show progress | Low | ✓ Built | — | WebSocket `test:progress` events every ~500ms |
| **Error rate calculation** | KPI: are calls being rejected/dropped at this load level? | Low | ✓ Built | — | Parsed from logs; reflects real 3CX SIP failures |
| **Hard parameter limits enforced in backend** | Cannot accidentally test at 300 calls when SC32 license caps at 32; must be backend-enforced | Low | ✓ Built | — | max 200 calls / 20 ramp/s / 8h; validate + clamp before spawn SIPp |
| **Single test lock (no concurrent tests)** | Running two tests simultaneously corrupts metrics and makes results uninterpretable | Low | ✓ Built | — | Lock on `sippManager.currentTest`; reject with 400 |
| **Web UI accessible from internal OLAM network** | Assessor must be able to view/control platform from their workstation (172.18.164.0/24) | Low | ✓ Built | — | React frontend on port 5173; Express backend on 3000 |

---

## Differentiators

Features that set this platform apart from generic SIPp + manual scripting. Not required for v1.0 assessment, but add operational value and reduce friction for the ops team post-handoff.

| Feature | Value Proposition | Complexity | Status | OLAM-ID | Notes |
|---------|-------------------|-----------|--------|---------|-------|
| **PDD (Post Dial Delay) to carrier** | KPI: how long does it take to reach the SIP trunk? Reveals carrier-side latency issues | Med | ✗ Partial | OLAM-12 | Logs don't expose timing; requires API or RTCP parsing. Mock: working. Real: hardcoded to 0. |
| **MOS (Mean Opinion Score) + jitter + packet loss** | Voice quality metrics; without these, cannot detect audio problems (only call rejection problems) | High | ✗ Partial | OLAM-13 | Requires RTCP packet parsing or 3CX API. Mock: working. Real: hardcoded to 0. Placeholder status |
| **Custom SIPp XML scenarios** | For >50 call tests, the smoke test loop is too slow; custom XML allows compact test definitions | Med | ✗ Unstarted | OLAM-14 | Would improve test scalability. Not blocking v1.0 if peak tests work with presets. |
| **Queue depth + agent availability tracking** | For contact center ops: are calls stacking? How many agents idle? Early signal of degradation | Low | ✓ Built (partial) | — | Queue logs parsed; `queue.waiting`, `queue.agentsOnline` collected. Service level + abandonment: TO DO |
| **Live Prometheus metrics endpoint** | Ops/monitoring teams can plug in their own dashboards (Grafana, etc.) without API remake | Med | ✗ Unstarted | — | Not prioritized in v1.0. Node.js + Prometheus exporter bridge. |
| **Test parameter suggestion** | "Based on current load, recommend smoke/light/medium/peak" — helps ops choose safe test levels | Low | ✗ Unstarted | — | Intelligence layer on top of metrics. Nice-to-have for guided troubleshooting. |
| **Reattach call scenario** | Tests what happens when a call is reattached (transferred agent → IVR → agent). Rarer than UAC but reveals queue routing issues | Med | ✗ Unstarted | — | SIPp capability exists; not yet mapped to preset. |
| **Call hold + resume scenario** | Tests PBX behavior when callers are placed on hold (reveals hold/unhold codec issues, timeout bugs) | Med | ✗ Unstarted | — | SIPp REFER (transfer) / INFO (DTMF) support. Not in presets. |
| **Inbound trunk load testing** | Currently tests outbound (calling INTO the 3CX). Inbound (from carriers) would validate trunk bidirectionally | High | ✗ Out of Scope (Cygwin limitation) | — | Would require SIPp to listen on port, accept calls from Tigo UNE. Firewall/carrier coordination required. Complex for Windows client host. |
| **Downloadable test evidence PDFs** | Ops can email a "3CX Assessment Report" to stakeholders without needing platform access | Low | ✗ Out of Scope | — | Deliverable is the platform + SQLite history, not PDFs. OLAM redacts the report separately. |
| **Scheduled/automated recurring tests** | "Run soak test every Sunday midnight" — catches degradation trends over time | Med | ✗ Out of Scope (v1.0) | — | Cron job wrapper possible post-handoff; not in milestone scope. |
| **Slack/email alert integration** | Ops notified of critical anomalies without checking dashboard every 5 minutes | Low | ✗ Out of Scope | — | Project explicitly defers external webhook integration to post-handoff. Internal alerts sufficient for v1.0. |
| **Codec quality testing (G.711 vs G.729 vs Opus)** | Validates voice quality under different compression. Reveals if OLAM's carrier is forcing lower codec | High | ✗ Out of Scope | — | Requires RTCP packet inspection + codec detection. Not in SIPp preset scenarios. Future research. |
| **Firewall + NAT traversal testing** | "Can calls work if customer moves PBX behind NAT?" — critical for disaster recovery scenarios | High | ✗ Out of Scope | — | Requires SIPp to act as external caller (needs external IP/listener). Host 172.18.164.35 is internal-only. |
| **TLS/SRTP security upgrade validation** | Verify that TLS-enabled SIP works after migration from UDP. H-07 mitigation requires this | Med | ✗ Deferred (future milestone) | — | Mitigation in v1.0 is firewall filter only. TLS upgrade = separate engagement + Tigo coordination. |
| **Graceful shutdown of backend** | Ops can `Ctrl+C` without losing active alert state or test-in-progress metadata | Low | ✓ Built | — | SQLite persists; on restart, history is recoverable. Signal handlers clean up SSH. |
| **Service level + abandonment rate tracking** | KPI: % of calls answered within 20s, % of callers who hung up waiting | Med | ✗ Partial | — | Parsing exists for `/queue` logs. Calculation TO DO. |
| **Per-extension performance reporting** | "Which extension is most stressed? Which has highest error rate?" — helps identify bottleneck agents | Med | ✗ Out of Scope | — | Privacy concern for ops staff (call-by-call tracking). Feature creep. Defer. |
| **Multi-tenant support** | "Run this platform for 5 different 3CX servers" — scales assessment to franchises/chains | High | ✗ Out of Scope | — | Architecture assumes single 3CX. Would require refactor. Out of scope. |

---

## Anti-Features

Features explicitly NOT to build — clarifies scope boundaries and prevents scope creep.

| Anti-Feature | Why Avoid | What to Do Instead |
|---|---|---|
| **RBAC / multi-user authentication** | Network is internal (172.18.164.0/24) with low attack surface. Adding JWT + role matrix adds operational complexity ops team doesn't need in v1.0. Sessions, password rotation, audit becomes burden. | Trust network boundary. If future, add in post-handoff engagement. |
| **Executive PDF/PowerPoint reports** | Report authoring is OLAM's job, not the platform's. They have the context for recommendations. We deliver platform + data. | Provide SQLite export tools if needed; OLAM uses their template. |
| **Slack/email/PagerDuty alerts** | Defers to post-handoff. v1.0 delivers WebSocket alerts to dashboard only. If ops wants external notifications, they can set up their own monitoring bridge. | Internal alerts sufficient. Webhook integration is a future engagement. |
| **Call recording capture/playback** | Out of scope; 3CX already records. Platform is diagnostics, not archival. | Use 3CX Call Control API or CDR system for call evidence. |
| **SIP protocol analysis (Wireshark-like)** | tcpdump captures for H-03 diagnosis happen, but UI packet inspection = scope explosion. | For specific diagnosis (H-03), 1-off tcpdump is manual + documented as "if issue persists". |
| **RCS/SMS traffic testing** | 3CX supports RCS in some versions; not in scope. Assessment is voice only. | If OLAM adds RCS later, it's separate assessment. |
| **Disaster recovery / failover testing** | Would require secondary 3CX instance. Out of scope for single-server assessment. | Document as potential future service engagement. |
| **Cost optimization reporting** | "Upgrade to SC192 costs X; downgrade to SC64 costs Y; break-even in Z months" — business logic, not technical. | OLAM owns business case; platform provides capacity numbers. |
| **Integration with 3CX Call Control API** | Reserved for future; log parsing is sufficient for v1.0. Adds HTTP auth complexity and ties assessment to API schema version. | Logs are stable; API can be added when needed. |
| **Mobile app** | Not in milestone. Web UI is sufficient for internal network access. | Revisit post-handoff if ops requests it. |
| **Self-updating platform** | No auto-deployment. Changes happen via git pull by ops. Avoids uncontrolled updates during assessment window. | Git repo on host; manual pull when ops ready. |
| **Upgrade assistant** | "3CX v21 is available; should you upgrade?" — too much domain knowledge. | OLAM owns upgrade strategy. Platform just reports current version. |
| **Auto-remediation** | E.g., "error rate > 20%, auto-restart 3CX" — too risky in production contact center. | Alerts only. Ops decides action. |

---

## Feature Dependencies

```
Passive monitoring (SSH + logs)
  ├─ Real-time dashboard
  │  ├─ Trunk status (depends on log parsing)
  │  └─ Alert panel (depends on anomaly detection)
  ├─ Anomaly detector (needs metrics to evaluate rules)
  └─ Phase-0 findings (hardcoded, no dependencies)

Active testing (SIPp)
  ├─ Test control UI (depends on backend validation)
  ├─ SIPp execution (depends on Cygwin + binary availability)
  ├─ Test progress tracking (depends on SIPp stdout parsing)
  └─ Test result persistence (depends on SQLite + snapshot collection)

Health + operability
  ├─ Health check endpoint (depends on SSH, DB, SIPp manager state)
  └─ Audit trail (depends on SQLite + IP logging)
```

---

## MVP Recommendation

Prioritize to unblock tests + handoff readiness:

**Must-have for v1.0:**
1. Smoke test (1 call, 30s) executes and records result — **OLAM-02 fix required first** (parse `_statistics.csv` instead of stderr)
2. Light test (10 calls, 60s) executes, shows progress, persists result — validates test infrastructure works
3. Medium test (30 calls, 60s) within SC32 license — validates 3x concurrency + error detection
4. Soak-light test (20 calls, 4h) — validates stability (memory leaks, handle exhaustion)
5. Health check + SSH connection status visible on dashboard — ops knows system is alive
6. Audit trail queryable — "who ran test #42, when, with what params?"

**Should-have for v1.0 (removes friction post-handoff):**
7. `/api/health` expanded with granular status (OLAM-16) — ops can quickly diagnose why platform is unhealthy
8. Runbook document (OLAM-21) — step-by-step: how to start platform, run test, interpret alerts, restart
9. Repo converted to `.git` clone on `.35` (OLAM-20) — ops can `git pull` to get updates instead of copying files

**Defer post-license-upgrade (OLAM-09/10/11):**
- Peak test (180 calls) — requires SC192 license trial
- Stress test (220 calls) — requires SC192 license trial
- Production soak (125 calls, 14h) — requires off-hours window coordination

**Defer post-handoff (nice-to-have, not blocking):**
- PDD to carrier (OLAM-12) — requires API integration or RTCP parsing; mock works now
- MOS/jitter (OLAM-13) — requires RTCP; can add later
- Custom SIPp XML (OLAM-14) — presets sufficient for SC32/SC192 validation

---

## Feature Coverage by User Role

### Consultant (Maximiliano / assessment lead)
- Dashboard: view live KPIs, spot problems
- Tests: run preset scenarios, customize parameters
- History: review past test results, export for analysis
- Alerts: see what broke and when

### TI OLAM (Windows ops team, mid-skill, post-handoff)
- Dashboard: daily monitoring (CPU, calls, errors)
- Tests: ability to re-run tests if 3CX is modified/upgraded
- Alerts: know what needs investigation
- Health: verify backend is running
- Runbook: how to restart platform, interpret common errors

### OLAM Finance/Management (one-time sign-off)
- History: proof of what was tested and results
- Alerts: evidence of blockers (SC32 limit, 408 errors, auto-updates)
- Dashboard snapshot: "here's the current state of our 3CX"

---

## Complexity Assessment by Feature

| Tier | Complexity | Examples | Time | Risk |
|------|-----------|----------|------|------|
| **Trivial** (< 2h) | No new services, low coupling | Status endpoint, preset buttons, CSS tweaks | <2h | Very low |
| **Low** (2–8h) | One service, well-defined, tested | Health check expansion, parameter validation, documentation | 4–6h | Low |
| **Medium** (8–24h) | Multi-service, integration points, edge cases | Soak test stability, parser stale diagnosis, log rotation | 12–18h | Medium |
| **High** (24–72h) | Complex state machine, external dependencies, testing | PDD measurement (requires API/RTCP), custom SIPp XML compiler, Prometheus metrics | 48h+ | High |
| **Massive** (72h+) | Architectural refactor, new tech, security | Multi-tenant support, TLS migration, auth layer, Wireshark-like UI | >72h | Very high |

---

## Platform vs. User Responsibility Boundary

| Aspect | Platform | User (OLAM Ops) |
|--------|----------|---|
| **Test execution** | Platform runs SIPp, streams progress, persists results | Chooses scenario, coordinates timing, interprets results |
| **3CX configuration** | Platform reads logs/API | Platform doesn't modify 3CX; OLAM's ops team modifies (e.g., disable auto-updates) |
| **Carrier coordination** | Platform monitors Tigo UNE errors (408, 503) | OLAM escalates to Tigo if trunk issues found |
| **Network access** | Platform handles SSH tunnel, node_exporter polling | Ops team ensures network routes, firewall rules |
| **Platform operation** | Graceful shutdown, error logging, health checks | Ops team starts backend, monitors it, restarts if needed |
| **Evidence** | Platform stores metrics + test results in SQLite | OLAM authors business case + recommendations from evidence |
| **Security** | Platform sanitizes inputs, no shell injection | Ops team manages SSH key, deploys in secure location |

---

## Sources & Justification

**PBX Assessment Industry Standard Practice:**
- Capacity testing requires minimum: UAC (basic call), bulk load (ramp), sustained load (soak)
- Evidence must include: call counts, error rates, latency, resource usage (CPU, RAM, network)
- Operational tools must include: health checks, audit trails, easy test re-execution
- Security: minimize external integrations; internal alerts sufficient for MVP

**SIPp Capabilities (v3.7.3 Cygwin):**
- Supports: preset scenarios (UAC, bulk, hold, transfer), digest auth (407), custom XML, statistics CSV export
- Does NOT support: RTCP parsing, codec quality measurement, inbound listeners (firewall constraints)
- Typical capacity tests: smoke (1–5 calls), light (10–20), medium (30–50), peak (100–200+), soak (4h–24h @ 30–50% load)

**Node.js Production Best Practices (Windows):**
- Self-monitoring: health endpoint, watchdog process, graceful shutdown
- Logging: structured logs with rotation (Winston/Pino if added), not spammy console output
- Data persistence: SQLite for single-host audit logs, no external DB needed at v1.0 scale

**OLAM Project Constraints:**
- Network: internal only (172.18.164.0/24), low attack surface → no auth required v1.0
- Host: Win10 without admin (172.18.164.35) → SIPp via Cygwin, no WSL, no Docker
- Operability: single Windows ops team of mid-skill → platform must be simple, runbook-driven
- Time: post-license-wait milestone → features prioritized by impact to SC192 validation

---

*Feature analysis: 2026-05-01*
