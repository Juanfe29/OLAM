# Domain Pitfalls — OLAM 3CX Load Testing + Windows Self-Monitoring

**Domain:** Production PBX load testing (SIPp) + 3CX metrics extraction + Windows self-monitoring + ops handoff
**Researched:** 2026-05-02
**Context:** Auditing 3CX v20 in production (Debian 12 + Tigo SIP trunk) from Windows 10 host via Cygwin SIPp + always-on SSH monitoring

---

## Critical Pitfalls

### Pitfall 1: SIPp Test During Business Hours Without Rate Governor

**What goes wrong:**
Initiating a ramped SIPp test (e.g., 50 calls over 10 seconds) during customer contact center operation causes real customer calls to be rejected, dropped, or queued indefinitely. The test consumes SIP slots or media capacity that real traffic needs.

**Why it happens:**
- SIPp targets the 3CX with real SIP requests, competing for the same port, license tier, and RTP streams
- Default SIPp ramp rates (10–20 calls/sec) are aggressive and don't account for ongoing production traffic
- No pre-flight check validates remaining headroom before test starts
- Runbook/ops procedures unclear on "safe windows" (off-hours, low-traffic hours, maintenance windows)

**Consequences:**
- Customer-facing calls drop or fail. Contact center SLA breach.
- Real call timestamps get mixed with SIPp call timestamps in logs, making forensics ambiguous.
- OLAM loses trust in the monitoring platform if it degrades production.
- Tigo carrier may rate-limit or block the customer due to spike in SIP traffic (false DOS appearance).

**Detection (warning signs):**
- Dashboard shows `activeCalls` spike from production baseline (e.g., 5–10) to test target (e.g., 50) in seconds
- Real call failure rate jumps when test starts (ASR drops, call rejections increase)
- Logs show SIPp INVITE timestamps mixed with real call events
- Ops team calls: "Why are customer calls failing?"

**Prevention:**
1. **Pre-flight traffic check** (OLAM-24): Endpoint `/api/tests/validate` queries 3CX for last-5-minute traffic baseline (activeCalls, errorRate, ASR). Reject test if baseline > 60% of available headroom.
   ```javascript
   // Example: SC32 = 32 slots, baseline = 8 calls, test requests 50 calls
   // headroom = 32 - 8 = 24 available
   // test would use 50, exceeds headroom → reject with message:
   // "Insufficient headroom. Production has 8 active calls. 
   //  Test needs 50 but only 24 are available. 
   //  Run off-hours or reduce test to 20 calls."
   ```

2. **Ramp rate limiter** — enforce max 2 calls/sec by default, max 5 calls/sec in maintenance window only.
   ```javascript
   const maxRampPerSecond = isMaintenanceWindow() ? 5 : 2;
   const rampRate = Math.min(params.ramp_rate, maxRampPerSecond);
   ```

3. **Pre-test confirmation modal** (frontend) showing:
   - Current production load
   - Test parameters
   - Estimated impact (e.g., "Will use 50 of 32 available slots")
   - Operator must explicitly confirm "I understand this will disrupt production"

4. **Hard block outside maintenance window** for tests > 30 calls:
   ```javascript
   if (params.max_calls > 30 && !isMaintenanceWindow()) {
     throw new Error('Tests > 30 calls only allowed 22:00–06:00 Monday–Friday. Contact ops.');
   }
   ```

5. **Runbook section:** "Test Scheduling"
   - Define OLAM contact center's actual off-hours (e.g., 19:00–08:00 Bogotá time)
   - Require test-initiator (Maximiliano) to coordinate with ops lead 24h in advance for peak tests
   - Document slack channel for test announcements

**Phase/requirement mapping:**
- OLAM-21 (Runbook operativo): Include "Safe Testing Windows" section
- OLAM-22 (Handoff session): Dry-run tests during low-traffic hour, show pre-flight check + confirmation modal

---

### Pitfall 2: SIPp Scenario Hangs on Carrier Timeouts — No Graceful Shutdown

**What goes wrong:**
SIPp test initiates with destination extension `100`, sends INVITE to 3CX. If extension `100` doesn't exist or rejects all calls, SIPp waits indefinitely for BYE or timeout, consuming memory and file descriptors. Test runs for full duration even though no calls succeeded.

**Why it happens:**
- Destination not validated before test starts (CONCERNS.md line 72)
- SIPp `-d` (duration) is long, and `uac` scenario expects proper SIP termination (BYE)
- If 3CX rejects with 480 (Temporarily Unavailable) or 486 (Busy), SIPp may retry or hang
- No per-call timeout in SIPp scenario file — calls hang until overall test duration expires
- stderr output unreliable for detecting stuck calls (CONCERNS.md line 15)

**Consequences:**
- Test "completes" but `snapshots: []` (no data collected, call failure goes unnoticed)
- Memory/file descriptor leak if test repeats (backend holds stale SIPp process resources)
- Backend becomes unresponsive waiting for SIPp to finish
- Ops must manually SSH to Windows host and kill SIPp process (`taskkill /IM sipp.exe`)

**Detection:**
- Test status shows `activeCalls: 0` but `running: true` for entire duration (e.g., 5 minutes with no calls)
- SIPp process uses growing memory but generates no logs (lines 171–177 in sippManager.js never fire)
- Browser dev tools show WebSocket silent (no `test:progress` events)
- ps aux on Windows shows `sipp.exe` zombie or hung process

**Prevention:**
1. **Validate destination before test** (OLAM-01, active blocker):
   ```javascript
   // Query 3CX API or extension config for valid extensions
   async function validateDestination(dest) {
     const validExts = await fetch3CXExtensions(); // from API or config file
     if (!validExts.includes(dest)) {
       throw new Error(`Extensión ${dest} no existe en el 3CX. Extensiones válidas: ${validExts.join(', ')}`);
     }
   }
   
   // Then in runTest():
   await validateDestination(resolved.destination);
   ```
   Store valid extensions in env var or SQLite config table.

2. **Add per-call timeout to SIPp scenario XML** (OLAM-14):
   - Build custom `.xml` scenario file (instead of `-sn uac`) with explicit call timeout
   - Example: each call waits max 10 seconds for 200 OK, then sends BYE and moves to next call
   - SIPp default scenario may wait indefinitely — custom scenario enforces boundaries

3. **Monitor SIPp stderr for "No active calls" or call failure patterns**:
   ```javascript
   let silentCount = 0; // tracks iterations with no progress
   sippProcess.stderr.on('data', (chunk) => {
     const line = chunk.toString();
     parseSippStats(line, snapshots, testId);
     if (snapshots.length === 0) silentCount++;
     if (silentCount > 10) { // ~30 seconds of no calls
       console.error('[SIPp] No calls initiated. Destination likely invalid.');
       sippProcess.kill('SIGKILL');
       finishTest(testId, 'ERROR', { error: 'No calls initiated. Check destination.' });
     }
   });
   ```

4. **Watchdog timer** on test completion:
   ```javascript
   const SIPP_MAX_WALL_TIME = (params.duration * 1000) + 30000; // duration + 30s grace
   const testWatchdog = setTimeout(() => {
     if (currentTest && currentTest.status === 'running') {
       console.error(`[SIPp] Watchdog: test exceeded ${SIPP_MAX_WALL_TIME}ms, force-killing`);
       sippProcess?.kill('SIGKILL');
       finishTest(testId, 'ERROR', { error: 'SIPp did not exit within expected time' });
     }
   }, SIPP_MAX_WALL_TIME);
   ```

5. **Read `_statistics.csv` instead of stderr** (OLAM-02, active blocker):
   - After `sippProcess.on('close')` fires, SIPp writes final stats to `_statistics.xml` and `_statistics.csv` in the SIPp working directory
   - Parse CSV for authoritative call counts, response codes, and success metrics
   ```javascript
   sippProcess.on('close', (code) => {
     const statsPath = path.join(process.cwd(), '_statistics.csv');
     const csv = fs.readFileSync(statsPath, 'utf8');
     const stats = parseStatsCSV(csv); // extract calls, success rate, failures
     const summary = buildSummary([...snapshots, stats], params);
     finishTest(testId, code === 0 ? (summary.passed ? 'PASS' : 'FAIL') : 'ERROR', summary);
   });
   ```

**Phase/requirement mapping:**
- OLAM-01: Validation of destination extension (blocker for first real test)
- OLAM-02: Parse `_statistics.csv` instead of stderr (blocker for reliable smoke)
- OLAM-14: Custom SIPp scenario XML with per-call timeouts
- OLAM-24: Backend watchdog for stuck tests

---

### Pitfall 3: Log Format Drift After 3CX Auto-Update — Parser Silent Failure

**What goes wrong:**
3CX receives auto-update (H-05 finding: auto-updates enabled) and changes log format. Log lines no longer match regex patterns in `logParser.js`. Parser silently returns `null` for every line, metrics go to zero, but system doesn't alert. Dashboard shows stale metrics while real 3CX state degrades.

**Why it happens:**
- Parser regex patterns (logParser.js lines 32–66) tuned only to 3CX v20 Update 8 Build 1121
- No version detection at startup to confirm log format compatibility
- Patterns are brittle: timestamp format, field separators, keyword casing can change
- 2-minute stale warning fires (logReader.js line 103) but is ambiguous — could be low traffic, could be broken parser
- No per-log-type counters to detect which parser regex broke

**Consequences:**
- Dashboard metrics frozen at last-good values while real system is down
- No anomalies detected (CPU spikes, error rate changes, call drops)
- Silent data loss until operator manually checks and realizes "all metrics are 1 hour old"
- By then, production outage may have been in progress for 45 minutes undetected

**Detection:**
- `/api/status` returns metrics with `ts: <1 hour ago>` (stale timestamp)
- Dashboard chart line flat for 30+ minutes despite real activity (no new data points)
- No alert fired even if 3CX is actually down (parser blocked, so alerts can't fire)
- SIPp test runs but shows `activeCalls: 0` (test is running but metrics don't capture it)

**Prevention:**
1. **Disable 3CX auto-updates immediately** (OLAM-04, active requirement):
   - SSH to 3CX, edit 3CX web console settings: Maintenance → Auto-update → Disabled
   - Do this before any real tests, prevents surprise format breakage during assessment
   - Document in runbook that manual updates require coordination (off-hours window)

2. **Version detection at backend startup** (OLAM-25):
   ```javascript
   // On boot, SSH to 3CX and run: cat /opt/3cxpbx/System/InstallLog.txt | grep Version
   // Extract "3CX v20 Update 8 Build 1121"
   // Compare to known-good PARSER_VERSION = '20.0.8.1121'
   // If mismatch, log CRITICAL alert, disable log streaming, emit to dashboard
   
   async function validateParserVersion() {
     const versionCommand = "cat /opt/3cxpbx/System/InstallLog.txt | grep 'Version' | tail -1";
     const version = await sshClient.execCommand(versionCommand);
     if (!version.includes('Update 8 Build 1121')) {
       console.error(`[Parser] 3CX version mismatch: got "${version}". Parser tuned for Update 8.`);
       emitAlert({
         id: 'parser_version_mismatch',
         level: 'CRITICO',
         msg: `Versión 3CX desconocida: ${version}. El parser puede estar roto.`
       });
       return false;
     }
     return true;
   }
   ```

3. **Per-log-type match counters** (OLAM-26):
   ```javascript
   const logMetrics = {
     CallFlow: { lines: 0, matches: 0 },
     GatewayService: { lines: 0, matches: 0 },
     QueueManager: { lines: 0, matches: 0 },
     SystemService: { lines: 0, matches: 0 },
     IVR: { lines: 0, matches: 0 },
   };
   
   export function parseLine(rawLine) {
     const fileType = detectFile(rawLine);
     if (fileType && rawLine.trim()) {
       logMetrics[fileType].lines++;
       const event = parseLogType(rawLine, fileType);
       if (event) logMetrics[fileType].matches++;
       return event;
     }
     return null;
   }
   
   // Expose match ratio via /api/health
   // if any log has match ratio < 5% over last 5 min, emit alert
   ```

4. **Fallback lenient parser** for unknown formats (OLAM-27):
   ```javascript
   // If strict regex fails and we're in unknown-version mode:
   // Extract only universally-stable patterns:
   // - Timestamp (any ISO or pipe-separated)
   // - Call ID (hex string, often present)
   // - Keywords like "error", "INVITE", "BYE"
   // Returns minimal events but keeps system operational
   ```

5. **Test fixture library** (OLAM-28):
   - Maintain in git: `__tests__/fixtures/3cx-logs-v20-u8-b1121.json`
   - Real log lines captured from customer's system
   - Each regex pattern has 5+ test cases
   - CI runs parser against fixture on every commit
   - If fixture parsing drops below 95%, CI fails

6. **Runbook note:** Before any major 3CX maintenance/update
   - Coordinate with ops 1 week in advance
   - Notify Maximiliano so parser can be re-tuned post-update if needed
   - Capture pre/post-update logs for regression testing

**Phase/requirement mapping:**
- OLAM-04: Disable auto-updates (active blocker)
- OLAM-25: Version detection at startup
- OLAM-26: Per-log-type match counters
- OLAM-28: Test fixtures for parser regression

---

### Pitfall 4: Windows Backend Crash Loop — Process Fails, Auto-Restart Thrashes

**What goes wrong:**
Backend crashes (DB locked, SSH key missing, port already bound). Auto-restart mechanism (PM2 or node-windows) immediately respawns process. If root cause isn't fixed, process crashes again 5 seconds later. This repeats hundreds of times per minute, consuming CPU, filling logs, and preventing any manual intervention.

**Why it happens:**
- Database file (`olam.db`) locked by previous instance didn't exit cleanly
- SSH key (`backend/keys/3cx_rsa`) missing or unreadable from perms (inherited user issue)
- Port 3000 already bound by orphan SIPp or stale Node process
- Auto-restart configured with no exponential backoff (e.g., PM2 default is aggressive)
- Crash logs not persisted or rotated, disk fills
- No guard against restart thrashing (e.g., circuit breaker: "5 crashes in 30s → stay dead")

**Consequences:**
- Dashboard unreachable for 10+ minutes during crash loop
- Backend logs filled with thousands of identical error entries per second
- Windows event log polluted, sysadmin confused
- Ops team must SSH to 172.18.164.35, manually kill `node.exe`, investigate root cause
- Trust erodes: "Platform is unstable"

**Detection:**
- `/api/health` returns 503 or connection refused
- Dashboard shows "disconnected" with reconnect spinner
- Windows Task Manager shows `node.exe` repeatedly appearing/disappearing in process list
- Event Viewer shows hundreds of "Application Error" entries in 60 seconds
- `backend.log` file grows 100s of MB in minutes

**Prevention:**
1. **Manual deployment, no auto-restart for now** (conservative, OLAM-29):
   - Document in runbook: "Backend runs as interactive console window, not background service"
   - Ops staff must manually restart after investigating crash
   - Prevents "silent thrashing" issue — human sees crash immediately
   - Rationale: v1.0 stability is unknown; aggressive restart would hide systemic issues
   - Trade-off: downtime is more visible, but safer during assessment phase

2. **If auto-restart is required**, implement robust strategy (OLAM-30):
   ```javascript
   // circuit-breaker.js
   const CircuitBreaker = {
     crashes: [],
     breaker: 'closed', // closed → half-open → open
   
     recordCrash(timestamp = Date.now()) {
       this.crashes.push(timestamp);
       // Keep only last 60 seconds of crashes
       this.crashes = this.crashes.filter(t => timestamp - t < 60000);
   
       // If 5+ crashes in last 30 seconds, trip breaker
       const recentCrashes = this.crashes.filter(t => timestamp - t < 30000);
       if (recentCrashes.length >= 5) {
         this.breaker = 'open';
         emitAlert({
           level: 'CRITICO',
           msg: '5+ crashes in 30s. Breaker open. Manual intervention required.'
         });
         // Signal systemd/PM2 to NOT restart
         process.exit(2); // non-zero but distinct from normal error
       }
     }
   };
   
   process.on('uncaughtException', (err) => {
     CircuitBreaker.recordCrash();
     // ... log error ...
     process.exit(1);
   });
   ```
   PM2/systemd configured: exit code 2 = don't restart.

3. **Startup health checks before binding port** (OLAM-31):
   ```javascript
   async function startupChecks() {
     // 1. DB accessible
     try {
       const result = db.prepare('SELECT 1').get();
       console.log('[Boot] ✓ Database connected');
     } catch (err) {
       console.error('[Boot] ✗ Database locked or missing:', err.message);
       process.exit(1);
     }
   
     // 2. SSH key exists and readable
     const keyPath = process.env.SSH_KEY_PATH || './keys/3cx_rsa';
     if (!fs.existsSync(keyPath)) {
       console.error(`[Boot] ✗ SSH key not found: ${keyPath}`);
       process.exit(1);
     }
     if ((fs.statSync(keyPath).mode & 0o077) !== 0) {
       console.error(`[Boot] ✗ SSH key has weak perms (should be 600): ${keyPath}`);
       process.exit(1);
     }
   
     // 3. Port available
     const isPortAvailable = await checkPortAvailable(process.env.PORT || 3000);
     if (!isPortAvailable) {
       console.error('[Boot] ✗ Port already in use. Kill stale process first.');
       process.exit(1);
     }
   }
   
   // Call before app.listen()
   await startupChecks();
   ```

4. **Log rotation and retention** (OLAM-19, active requirement):
   ```javascript
   // Use winston or pino with daily rotation
   const logger = pino(pinoPretty(), {
     transport: {
       target: 'pino/file',
       options: {
         destination: './logs/backend.log',
         mkdir: true,
       },
     },
     formatters: {
       level: (label) => ({ level: label.toUpperCase() }),
     },
   });
   
   // Separate rotate config: keep 7 days of logs, max 500MB
   // Prevents disk fill-up from crash spam
   ```

5. **Manual startup script for Windows** (OLAM-21):
   ```batch
   @echo off
   cd C:\Users\lamda\OLAM\backend
   
   REM Check if node.exe is already running
   tasklist /FI "IMAGENAME eq node.exe" 2>NUL | find /I /N "node.exe">NUL
   if "%ERRORLEVEL%"=="0" (
       echo Error: Backend already running. Kill it first: taskkill /IM node.exe /F
       exit /b 1
   )
   
   REM Load env
   setlocal enabledelayedexpansion
   for /f "tokens=*" %%i in (.env) do (
       set "%%i"
   )
   
   REM Start
   echo [%date% %time%] Starting backend...
   node src/server.js
   ```
   Ops staff double-clicks this, sees logs in console, can Ctrl+C to stop.

**Phase/requirement mapping:**
- OLAM-18: Auto-restart on crash (deferred to post-v1.0 or implemented with circuit breaker)
- OLAM-19: Log rotation (active requirement for any long-running service)
- OLAM-29: Conservative approach for v1.0 (manual restart)
- OLAM-21: Windows startup runbook

---

### Pitfall 5: Tigo SIP Trunk 408 Errors Misdiagnosed as PBX Problem

**What goes wrong:**
H-03 finding: "Errores 408 en troncal Tigo UNE". Operator assumes 3CX is rejecting requests, increases logging verbosity, adds more concurrent tests. But root cause is actually Tigo's SBC (Session Border Controller) timing out SIP INVITEs in-flight due to:
- Asymmetric routing (packets take different paths back, arrive late)
- Packet loss on the carrier link (retransmissions exceed Tigo timeout)
- Tigo SBC CPU or connection saturation (rate-limiting customer)
- Firewall in between dropping SIP re-INVITEs (stateless, doesn't track dialogs)

Diagnostic efforts waste days; real issue remains unfixed.

**Why it happens:**
- 408 errors appear in 3CX logs, pointing a finger at the PBX
- OLAM's metrics calculate error rate as `errors408 / totalCalls`, looks like PBX problem
- No attempt to capture pcap during the error window
- No comparison with Tigo's side (carrier doesn't share live logs)
- Assumption: if 3CX logs it, 3CX caused it

**Consequences:**
- OLAM recommends 3CX hardware upgrade, PBX rebuild, or codec changes
- Work is done, 408 errors persist (root cause was carrier, not PBX)
- Credibility damage: "The audit platform recommended the wrong fix"
- Real problem continues degrading customer's call quality

**Detection:**
- Dashboard shows `trunk.errors408 > 5 per hour` consistently
- Alert fires: "Más de 5 errores 408 en la última hora"
- Operator correlates with SIPp test → assumes SIPp is overloading Tigo
- But 408 errors present even without SIPp (low-traffic hours show 2–3 per hour baseline)

**Prevention:**
1. **H-03 diagnostic protocol** (OLAM-06, active requirement):
   - **Never assume 408 is 3CX's fault.** 408 is always on the SIP path, could be anywhere.
   - Capture simultaneous pcap + logs during a 1-hour window of high 408 rate:
     ```bash
     # SSH to 3CX
     sudo tcpdump -i eth0 'udp port 5060' -w /tmp/tigo-sip.pcap &
     tail -F /var/lib/3cxpbx/Instance1/Data/Logs/3CXGatewayService.log | grep 408 &
     
     # Wait 60 minutes in business hours
     # Kill both
     # Download pcap: scp 172.18.164.28:/tmp/tigo-sip.pcap ./
     ```

   - **Analyze pcap** with `sngrep` (pre-installed on 3CX):
     ```bash
     sngrep -r tigo-sip.pcap
     ```
     Look for:
     - INVITE sent from 3CX → 172.17.179.166
     - Wait time before 408 response (should be <30s typically)
     - Is 408 from Tigo SBC or from 3CX itself (check source IP)?
     - Count retransmissions (if client sends INVITE 3x before 408, network is lossy)

   - **Compare 3CX timestamps vs pcap timestamps:**
     - 3CX log says "408 received 14:23:45.123"
     - pcap shows SIP frame with 408 at 14:23:45.125
     - If gap > 100ms, there's transport delay, possibly asymmetric routing

   - **Correlate with traceroute jitter** (OLAM-07):
     ```bash
     # From 172.18.164.35 (Windows client):
     tracert -w 1000 172.17.179.166
     # Look for hops with loss or high latency (>100ms)
     ```

   - **Call Tigo support with evidence:**
     - "During 14:00–15:00 on 2026-04-30, I captured 47 SIP 408 timeouts."
     - "INVITE to sip:172.17.179.166:5060 waits 25+ seconds for response."
     - "Pcap shows SBC responds after 25s, exceeding standard 32s timeout."
     - "Traceroute shows hop 7 (Tigo AS) has 15% packet loss."
     - Tigo: "Your circuit is congested. Upgrade from 30 channels to 50, or reduce codec bitrate."

2. **Dashboard annotation for H-03** (OLAM-32):
   Instead of just "Errores 408 detectados", show:
   ```
   ⚠️ ALTO: Errores 408 en troncal Tigo UNE

   Los errores 408 pueden originarse en:
   1. 3CX PBX — rechazando requests (revisar logs 3CX)
   2. Red/firewall — packets perdidos (revisar pcap)
   3. SBC Tigo — timeout por congestión (contactar Tigo)

   Próximos pasos: Ejecutar OLAM-06 diagnostic protocol (pcap + traceroute)

   [Capturar pcap ahora] [Ver reportes previos]
   ```

3. **Baseline 408 rate in metrics** (OLAM-33):
   Track rolling 24-hour average of 408s (when SIPp not running):
   ```javascript
   // In metricsCollector:
   const baseline408 = averageOf408sLastWeekNoTests();
   
   // In metric output:
   trunk: {
     errors408: 12,  // last hour
     errors408Baseline: 5,  // normal day average
     errors408Delta: 7,  // 7 above baseline
     interpretation: 'Above baseline, investigate'
   }
   ```

4. **SIPp + pcap simultaneity** (OLAM-34):
   When running a peak test, automatically:
   ```javascript
   // Before runTest() launches SIPp:
   await sshClient.startCommand(`tcpdump -i eth0 'udp port 5060' -w /tmp/sipp-test-${testId}.pcap`);
   // After test completes:
   await sshClient.exec(`kill %tcpdump`);
   await sshClient.getFile(`/tmp/sipp-test-${testId}.pcap`, `./artifacts/test-${testId}.pcap`);
   // Store in SQLite reference: test record includes pcap file
   ```

5. **Runbook section: "Diagnosing 408 Errors"** (OLAM-21):
   ```markdown
   ## Diagnóstico de errores 408 (Request Timeout)

   **Por qué ocurren:**
   - 3CX PBX está rechazando el INVITE (timeout esperando respuesta del destino)
   - Tigo SBC está rechazando el INVITE (Tigo congestionado, routing lento)
   - Firewall/red pierde packets, causa retrasos (>32 segundos)

   **No asumir que 3CX es el culpable.** Los 408 suceden EN la red, no necesariamente EN el PBX.

   **Pasos:**
   1. Capturar pcap durante 1 hora en horario pico (OLAM-06)
   2. Analizar con sngrep: ¿es 408 de Tigo SBC o de otro lado?
   3. Traceroute a 172.17.179.166 desde el cliente Windows, revisar jitter
   4. Contactar a Tigo con evidencia: pcap + logs + traceroute
   5. Tigo te dirá si la ruta está congestionada, si hay retrasos, etc.

   **En paralelo:**
   - NO aumentar concurrencia de SIPp hasta entender 408
   - NO cambiar codecs sin evidencia
   - SÍ implementar retry logic con backoff (próximas fases)
   ```

**Phase/requirement mapping:**
- OLAM-06: H-03 diagnostic protocol (active requirement, blocker for understanding carrier health)
- OLAM-07: Traceroute + jitter analysis
- OLAM-32: Dashboard H-03 annotation with interpretation guide
- OLAM-33: Baseline 408 rate tracking
- OLAM-34: Automatic pcap during SIPp tests
- OLAM-21: Runbook "Diagnosing 408 Errors" section

---

## Moderate Pitfalls

### Pitfall 6: SSH Connection Drops Silently — LogReader Stalls

**What goes wrong:**
SSH connection to 3CX (`tail -Fq` on log files) is interrupted (network glitch, firewall timeout, 3CX reboot). Connection silently closes. LogReader doesn't notice immediately. For 2+ minutes, no new log data arrives. Warning fires: "No log data for 2+ minutes — parser may be broken" (logReader.js line 103). But root cause is network, not parser.

**Why it happens:**
- `execStream()` with `tail -Fq` doesn't send TCP keepalives by default
- Idle connections (low-traffic periods) timeout at firewall (e.g., Linux iptables, Cisco ASA)
- SSH library doesn't distinguish "network error" from "no data"
- Reconnect logic may fail (auth issue, stale socket, race condition)

**Consequences:**
- Metrics stale for 2–5 minutes until operator notices
- Alert is confusing: "parser may be broken" when actually network failed
- Operator wastes time checking regex patterns instead of network
- If 3CX has actual outage during this gap, incident goes undetected

**Detection:**
- WebSocket receives no `metrics:update` for 2+ minutes
- Backend logs show "[LogReader] No log data for 2+ minutes"
- But SSH connection is actually broken, no reconnect happened
- Running `ssh 172.18.164.28 tail -F /var/lib/3cxpbx/Instance1/Data/Logs/3CXCallFlow.log` manually works fine

**Prevention:**
1. **TCP keepalives on SSH connection** (OLAM-35):
   ```javascript
   const sshOptions = {
     host: process.env.SSH_HOST,
     port: process.env.SSH_PORT,
     username: process.env.SSH_USER,
     privateKey: fs.readFileSync(process.env.SSH_KEY_PATH),
     tryKeyboard: false,
     readyTimeout: 30000,
     // Enable TCP keepalives
     sock: require('net').createConnection({
       host: process.env.SSH_HOST,
       port: process.env.SSH_PORT,
       keepAlive: true,
       keepAliveDelay: 30000, // send keepalive every 30 seconds
     }),
   };
   ```

2. **Separate SSH connection health check** (OLAM-36):
   ```javascript
   setInterval(async () => {
     try {
       await sshClient.execCommand('echo "SSH alive"');
       lastSSHCheck = Date.now();
     } catch (err) {
       console.error('[SSH] Health check failed:', err.message);
       // Trigger reconnect
       await reconnectSSH();
     }
   }, 60000); // every 60 seconds
   ```

3. **Distinguish "no data" from "connection down"** (OLAM-26):
   ```javascript
   let lastLogBytes = 0;
   setInterval(() => {
     if (logBytesReceived === lastLogBytes && lastSSHCheck < Date.now() - 120000) {
       // No new bytes AND SSH check failed
       emitAlert({
         id: 'ssh_down',
         level: 'ALTO',
         msg: 'Conexión SSH a 3CX perdida. Intentando reconectar...'
       });
     } else if (logBytesReceived === lastLogBytes) {
       // No new bytes but SSH is healthy
       // Low-traffic period or all log files quiescent (normal)
       console.log('[LogReader] Idle (SSH healthy, no new events)');
     }
     lastLogBytes = logBytesReceived;
   }, 120000);
   ```

4. **Auto-reconnect with exponential backoff** (OLAM-37):
   ```javascript
   async function attachStream() {
     let retries = 0;
     const maxRetries = 5;
     const baseDelay = 5000;
   
     while (retries < maxRetries) {
       try {
         // Reopen stream
         const stream = await sshClient.execStream('stdbuf -oL tail -Fq /var/lib/3cxpbx/Instance1/Data/Logs/*', {...});
         stream.on('data', onLogData);
         return; // success
       } catch (err) {
         retries++;
         const delay = baseDelay * Math.pow(2, retries);
         console.warn(`[LogReader] Reconnect attempt ${retries} failed. Retrying in ${delay}ms...`);
         await new Promise(resolve => setTimeout(resolve, delay));
       }
     }
   
     // All retries failed
     emitAlert({
       id: 'ssh_unreachable',
       level: 'CRITICO',
       msg: '3CX no alcanzable por SSH después de 5 intentos. Contactar ops.'
     });
   }
   ```

**Phase/requirement mapping:**
- OLAM-16: Enhanced `/api/health` with granular state (SSH, parser, tunnel, DB)
- OLAM-35: TCP keepalives on SSH
- OLAM-36: SSH health check every 60 seconds
- OLAM-37: Auto-reconnect with exponential backoff

---

### Pitfall 7: PDD/MOS/Jitter Zero in Production — Metrics Incomplete

**What goes wrong:**
Dashboard shows `trunk.pddToCarrier: 0`, `quality.mos: 0`, `quality.jitter: 0` for all calls. Operator thinks 3CX has perfect quality (PDD is zero!) and can't detect real voice degradation issues. During high-load test, packets drop, jitter spikes to 50ms, but dashboard shows green because metrics aren't instrumented.

**Why it happens:**
- PDD to carrier requires parsing SIP timing from logs (INVITE timestamp → 200 OK timestamp)
- 3CX CallFlow.log doesn't explicitly log "INVITE sent at XXX" and "200 OK received at YYY"
- MOS / jitter / packet loss require RTCP reports from RTP stream
- RTCP not parsed (metricsCollector.js lines 220–225 hardcoded to 0)
- No integration with 3CX Call Control API's QoS endpoints (if exposed)

**Consequences:**
- Operator can't see call quality degradation in real-time
- SIPp peak test may show calls "succeeding" but actually degraded quality (no MOS metric to catch it)
- "180 calls at MOS 3.5 is unacceptable" can't be measured, so the finding is incomplete
- Assessment outcome: "We ran the load test, calls didn't drop, so 180 calls is OK" — but actually quality was terrible

**Detection:**
- KPI cards for PDD/MOS/jitter show zero or "N/A"
- Real calls may have quality issues (user reports echo, lag) but metrics don't reflect it
- SIPp test with high concurrency shows errorRate: 0 but real users report problems

**Prevention:**
1. **Mark metrics as "Not Yet Implemented"** (OLAM-38):
   ```javascript
   // In metricsCollector output, instead of hardcoding 0:
   trunk: {
     pddToCarrier: {
       value: null,
       status: 'not_instrumented',
       reason: 'Requires SIP timing correlation from logs (future phase)'
     }
   },
   quality: {
     mos: {
       value: null,
       status: 'not_instrumented',
       reason: 'Requires RTCP packet capture and analysis'
     },
     jitter: { /* same */ },
     packetLoss: { /* same */ }
   }
   
   // Dashboard renders "Not Available" instead of 0
   // Prevents misinterpretation
   ```

2. **PDD from logs** (OLAM-12, active requirement):
   - Implement post-test analysis:
   ```javascript
   // After test completes, grep CallFlow.log for SIP timing:
   // "INVITE to 100 at 14:23:45.123"
   // "200 OK received at 14:23:47.456"
   // PDD = 47.456 - 45.123 = 2.333 seconds
   
   // Store in test summary:
   {
     testId: 42,
     scenario: 'medium',
     pddToCarrier_p50: 1.2,
     pddToCarrier_p95: 3.4,
     pddToCarrier_max: 5.1
   }
   ```

3. **RTCP capture** (OLAM-13, active requirement):
   - During SIPp test, run tcpdump to capture RTCP packets
   - Parse RTCP reports for jitter, packet loss, MOS (if extended RTCP)
   ```javascript
   // Before test:
   await sshClient.startCommand(`tcpdump -i eth0 'udp port 16384:32768' -w /tmp/rtcp-${testId}.pcap`);
   // After test:
   const rtcpData = parseRTCPPcap(`/tmp/rtcp-${testId}.pcap`);
   // Extract: jitter_p95, packet_loss_pct
   ```

4. **3CX Call Control API integration** (OLAM-39):
   ```javascript
   // If 3CX exposes QoS API:
   // POST /v1/calls/{id}/quality → returns { mos, jitter, loss }
   // Or CDR query: SELECT mos FROM call_records WHERE callid = X
   ```

**Phase/requirement mapping:**
- OLAM-12: PDD to carrier from log timing (active)
- OLAM-13: MOS / jitter / packet loss from RTCP (active)
- OLAM-38: Mark unimplemented metrics clearly

---

### Pitfall 8: Destination Validation Missing — SIPp Calls Invalid Extension

**What goes wrong:**
Operator runs SIPp test with destination `999`, which doesn't exist in 3CX. SIPp sends INVITE to extension 999, 3CX rejects with 404 Not Found, all 180 calls fail with 100% error rate. Test "completes" but is invalid because the destination doesn't exist. Time and data wasted.

**Why it happens:**
- No validation of destination extension before test starts (CONCERNS.md line 72)
- Frontend sends `{ destination: '999' }` directly to backend
- Backend accepts without checking 3CX extension list
- SIPp runs anyway, generates failures that are assumed to be "load test failures" when actually "destination doesn't exist"

**Consequences:**
- Test results misleading: "180 calls with 100% error rate" vs "destination doesn't exist"
- Operator can't distinguish "load broke this extension" from "extension never worked"
- Time wasted. Operator must manually investigate, find invalid dest, re-run test.
- In production ops handoff, this confusion becomes a problem

**Detection:**
- Test summary shows `errorRate: 100%`, `snapshot.calls: 0`
- SIPp logs show "404 Not Found" responses
- Operator realizes "oops, 999 is not in the system"

**Prevention:**
1. **Validate destination at /api/tests/run** (OLAM-01, blocker):
   ```javascript
   // Fetch valid extensions from 3CX
   const validExtensions = await fetch3CXExtensions();
   
   if (!validExtensions.includes(params.destination)) {
     throw new Error(
       `Extensión ${params.destination} no existe. ` +
       `Extensiones válidas: ${validExtensions.join(', ')}`
     );
   }
   ```

2. **Fetch extensions from env config or API**:
   - Option A: `VALID_EXTENSIONS=100,101,102,200,300` in .env
   - Option B: Query 3CX API at startup:
     ```javascript
     async function fetchValidExtensions() {
       // 3CX Call Control API: GET /api/v1/extensions
       const response = await axios.get(`https://${process.env.SSH_HOST}:5000/api/v1/extensions`, {
         headers: { Authorization: `Bearer ${API_TOKEN}` }
       });
       return response.data.map(ext => ext.number);
     }
     ```

3. **Cache in SQLite** for quick lookup:
   ```javascript
   db.prepare(`CREATE TABLE IF NOT EXISTS extensions (
     id INTEGER PRIMARY KEY,
     number TEXT UNIQUE,
     type TEXT,
     name TEXT,
     fetched_at DATETIME
   )`).run();
   
   // Update cache every 1 hour or on manual refresh
   async function syncExtensions() {
     const exts = await fetchValidExtensions();
     db.prepare('DELETE FROM extensions').run();
     for (const ext of exts) {
       db.prepare('INSERT INTO extensions (number, type, name) VALUES (?, ?, ?)')
         .run(ext.number, ext.type, ext.name);
     }
   }
   ```

4. **UI dropdown for destination** (frontend OLAM-40):
   ```jsx
   // Instead of free-text input:
   <select name="destination" required>
     {validExtensions.map(ext => (
       <option key={ext} value={ext}>{ext} - {extNames[ext]}</option>
     ))}
   </select>
   ```
   No user can accidentally type invalid extension.

**Phase/requirement mapping:**
- OLAM-01: Destination validation (blocker for first smoke test)
- OLAM-40: UI dropdown for valid extensions only

---

## Minor Pitfalls

### Pitfall 9: Encoding Corruption in Alert Messages

**What goes wrong:**
Alert messages with Spanish accented characters display garbled: "Troncal Tigo UNE desregistrada" renders as "Troncal Tigo UNE desregistrada" (mojibake).

**Root cause:** UTF-8 ↔ Latin-1 encoding mismatch between SSH stream and JavaScript string handling.

**Prevention:**
- Force UTF-8 locale on Debian: `LC_ALL=C.UTF-8` in sshClient bash shell
- Explicitly `.toString('utf8')` on all SSH chunks (logReader.js line 53)
- Frontend: verify `<meta charset="utf-8">` in HTML head

---

### Pitfall 10: Disk Recordings Usage Always Zero

**What goes wrong:**
Dashboard metric `host.disk.recordings` always shows 0 even when 3CX stores recordings.

**Root cause:** No separate mount for `/var/lib/3cxpbx/Instance1/Recordings` on customer's system (CONCERNS.md line 263).

**Prevention:**
- Query whether customer has dedicated recordings volume; if not, report `host.disk.recordings: null` with note "Recordings on main disk"
- Document in deployment guide that separate mount improves monitoring

---

### Pitfall 11: No Tests Automated — Regression Risk

**What goes wrong:**
Parser regex changes silently break against real 3CX logs. Changes to anomaly detection rules don't get validated. No CI/CD catch.

**Prevention (OLAM-28):**
- Create `__tests__/` with Jest + real log fixtures from customer system
- Test parser against 50+ real 3CX lines per log type
- Test anomaly rules with synthetic metrics at thresholds
- CI runs on every commit before merge

---

### Pitfall 12: Alert Deduplication Lost on Restart

**What goes wrong:**
Backend restarts. In-memory `lastFiredAt` Map clears. Same alert fires immediately for condition still present, causing alert spam.

**Prevention (OLAM-41):**
- Persist `lastFiredAt` to SQLite, load on startup
- Gc old entries > 24h old

---

### Pitfall 13: Mock Mode Data Too Optimistic

**What goes wrong:**
Frontend developers test against smooth, perfect metrics that never show critical failures. Real production issues (license exhaustion, trunk down) aren't exercised.

**Prevention (OLAM-27):**
- Add scenario-based mock generators: `buildMockMetrics({ scenario: 'license_hit' })`
- Include scenarios: license_exhausted, trunk_down, cpu_saturated, disk_full, parser_broken
- Frontend QA tests against all scenarios

---

## Summary Table: Pitfall Prevention by Phase

| Pitfall | Prevention | Phase | Requirement | Blocker |
|---------|-----------|-------|-------------|---------|
| Test during business hours | Pre-flight headroom check + ramp limiter + confirmation modal | Design | OLAM-24 | No |
| SIPp hangs on invalid dest | Destination validation + CSV stats parsing + watchdog | Build | OLAM-01, OLAM-02 | YES |
| Parser format drift | Version detection + fallback parser + test fixtures | Build | OLAM-04, OLAM-25, OLAM-28 | YES |
| Backend crash loop | Circuit breaker + health checks + log rotation | Build | OLAM-29, OLAM-19, OLAM-31 | No |
| 408 misdiagnosis | Pcap capture + diagnostic protocol + dashboard annotation | Ops | OLAM-06, OLAM-32, OLAM-34 | No |
| SSH silent drop | Keepalives + health check + auto-reconnect | Build | OLAM-35, OLAM-36, OLAM-37 | No |
| PDD/MOS zero | Mark "not instrumented" + implement post-test PDD + RTCP capture | Build | OLAM-12, OLAM-13, OLAM-38 | No |
| Invalid destination | Dropdown UI + extension cache | Build | OLAM-01, OLAM-40 | YES |
| Encoding corruption | UTF-8 locale + explicit toString | Build | — | No |
| Disk recordings always 0 | Query mount, report null if missing | Build | — | No |
| No automated tests | Jest + fixtures + CI check | QA | OLAM-28 | No |
| Alert spam on restart | Persist dedup state to DB | Build | OLAM-41 | No |
| Overly optimistic mock | Scenario-based generators | Dev | OLAM-27 | No |

---

## Context-Specific Notes

**Windows 10 host (172.18.164.35):** No admin, no WSL, no DNS. Implications:
- Can't install Windows Service easily → manual startup script
- Can't use PowerShell advanced features → batch file for startup
- SIPp via Cygwin only option (already validated)
- SSH key management delicate (perms, ownership, accessible to user `lamda`)

**Cygwin SIPp:** Already running but watch for:
- Path separators in scenario files (backslash vs forward slash)
- Locale/encoding differences (DOS vs POSIX)
- File locking if scenario file changes during test

**Tigo SIP trunk:** Carrier is external dependency, difficult to debug from inside. Pcap + traceroute are your only tools.

**Always-on monitoring:** Background SSH connection must be resilient or dashboard goes dark. Prioritize SSH health, log rotation, auto-reconnect.

**Ops handoff:** Non-developers will run this. Runbooks must be step-by-step with decision trees, not prose.

---

## Sources

**Known Fragilities (from codebase CONCERNS.md, SESSION 2026-05-01):**
- Smoke test failure due to stderr parsing (OLAM-02 blocker)
- Log parser stale warning ambiguous (OLAM-03)
- Destination not validated (OLAM-01 blocker)
- Hard limits enforced but not input-validated
- CORS open, no auth, SSH key unencrypted
- Log format brittle to 3CX version changes
- PDD/MOS/jitter hardcoded to 0 in production
- Database error handling inconsistent

**Project Context (from PROJECT.md):**
- 3CX v20 Update 8 Build 1121 with auto-updates enabled (H-05)
- Tigo UNE SIP trunk with 408 errors present at baseline (H-03)
- SIPp v3.7.3 on Cygwin per-user (already installed)
- SSH via key-based auth to 172.18.164.28 root
- node_exporter via SSH tunnel due to firewall

**SIP/VoIP Industry Pitfalls (Training Data):**
- Concurrency testing against production PBX requires rate governance or customer impact
- SIP timeout errors (408, 503) originate at many points in the call path, not just the PBX
- Log parsing for QoS metrics (PDD, MOS, jitter) is non-trivial; RTCP required for voice quality
- Windows service/auto-restart patterns prone to crash loops without circuit breaker

**Node.js Windows Deployment (Training Data):**
- PM2 on Windows works but less mature than Linux
- node-windows requires admin install
- Manual startup script safest for prototype phase
- Log rotation critical to prevent disk fills

This document evolves as blockers resolve and new pitfalls emerge from testing.
