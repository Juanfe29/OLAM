# Testing Patterns

**Analysis Date:** 2026-05-01

## Testing Approach

**Current State:** No automated unit or integration tests in the codebase. Testing is manual.

**Primary Testing Method:** Postman API collection — `postman/OLAM-Audit.postman_collection.json`

**Secondary Testing Method:** Manual browser testing of frontend pages and WebSocket real-time updates

## Test Suite Overview

### Postman Collection

**File:** `postman/OLAM-Audit.postman_collection.json`

**Environment:** `postman/OLAM-Audit.postman_environment.json`

**Purpose:** API smoke tests and manual endpoint verification

**Coverage:**
- `/api/health` — Backend sanity check (status 200, mock flag, SSH flag, timestamp format)
- `/api/status` — Live metrics endpoint validation
- `/api/status/trunk` — Trunk state endpoint
- `/api/status/host` — Host metrics endpoint
- `/api/tests/scenarios` — Available SIPp scenarios
- `/api/tests/run` — Test creation with lock enforcement
- `/api/tests/stop` — Test termination
- `/api/tests/status` — Current test progress
- `/api/history` — Test history listing
- `/api/history/:id` — Individual test details

**Recommended Test Flow:**
```
1. Health check
2. Status endpoints (validate metrics exist)
3. List scenarios
4. Run smoke test (1 call, 30s)
5. Verify lock (attempt run again → 400 error expected)
6. Stop test
7. Fetch history
8. View detailed test results
```

**Automated Assertions (Postman Tests Tab):**

Example from collection:
```javascript
pm.test('Status 200', () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test('status === ok', () => pm.expect(body.status).to.eql('ok'));
pm.test('mock flag is boolean', () => pm.expect(body.mock).to.be.a('boolean'));
pm.test('timestamp ISO', () => pm.expect(body.timestamp).to.match(/^\d{4}-\d{2}-\d{2}T/));
```

**Variable Management:**
- `baseUrl` — defaults to `http://localhost:3000`
- `testId` — auto-captured from `POST /api/tests/run` response for use in history endpoints

**Note on License SC32:**
- Postman collection documents that real 3CX with SC32 license will reject calls above 32 concurrent
- Backend enforces hard limits (200 max calls, 20 rampa max, 8h max duration) regardless
- Mock mode (`MOCK_MODE=true`) bypasses all licensing checks

## Frontend Testing

**Current:** Manual browser-based smoke testing

**No Automated Tests:**
- No Cypress, Playwright, or Vitest for E2E or component testing
- Vite configured but only for development/production builds

**Manual Test Checklist (Implied by UI):**
1. Dashboard loads and receives live metrics via WebSocket
2. Connection status indicator (green when WS connected)
3. All KPI cards display correct values and color-coded thresholds
4. Charts render historical data (30-minute rolling window)
5. Alert panel shows active anomalies
6. Trunk status panel updates in real time
7. Tests page: preset buttons apply correct parameter sets
8. Tests page: sliders adjust values within min/max bounds
9. License warning appears when calls > 32
10. Test control sends POST to `/api/tests/run` with correct params
11. Progress bar and active call count update during test
12. Stop button sends POST to `/api/tests/stop`
13. History page lists completed tests with results
14. Clicking a test row shows detailed snapshots

## Backend Testing

**No Unit Tests:**
- No Jest, Vitest, or Mocha configuration
- No `*.test.js` or `*.spec.js` files

**Component-Level Manual Testing (via Postman):**

**SSH Connection Module (`backend/src/services/sshClient.js`):**
- Set `MOCK_MODE=false` in `.env`
- Place SSH private key at `backend/keys/3cx_rsa`
- Start backend: `npm run dev`
- Check logs for `[SSH] Connected to [host]`
- Verify reconnect logic: kill SSH, watch logs for exponential backoff

**Log Parser (`backend/src/services/logParser.js`):**
- Feed real log lines via `tail -F` to `execStream()`
- Verify parsed events populate metrics (via GET `/api/status`)
- Monitor `[LogReader]` logs for stale data alerts

**Anomaly Detector (`backend/src/services/anomalyDetector.js`):**
- Manually trigger conditions (e.g., force `m.calls.active === 0` in mock)
- Check WebSocket for `alert:new` event with correct `id`, `level`, `msg`
- Verify cooldown: same rule doesn't fire twice in 5 minutes

**SIPp Manager (`backend/src/services/sippManager.js`):**
- **Lock Test:** Start one test, immediately start another → expect 400 "Ya hay una prueba en curso"
- **Hard Limits:** Set `max_calls: 300` → backend enforces 200 max
- **Mock Mode:** Set `MOCK_MODE=true` → observe realistic call progression (18 → 30 calls)
- **Real Mode:** SIPp spawned as subprocess with digest auth on 172.18.164.35

**Database (`backend/src/db/`):**
- Schema auto-migrates on init: `CREATE TABLE IF NOT EXISTS`
- Foreign keys enabled: `PRAGMA foreign_keys = ON`
- WAL mode for concurrent write safety: `PRAGMA journal_mode = WAL`
- Query test via history endpoints: `/api/history` returns recent tests, `/api/history/:id` includes snapshots

## WebSocket Testing

**Manual Real-Time Testing:**
1. Open browser DevTools → Console
2. Connect to backend (dashboard auto-connects)
3. Type in console:
   ```javascript
   const socket = io('http://localhost:3000');
   socket.on('metrics:update', (m) => console.log('Metrics:', m));
   socket.on('alert:new', (a) => console.log('Alert:', a));
   socket.on('test:progress', (p) => console.log('Progress:', p));
   ```
4. Verify events flow every 5 seconds (`metrics:update`), on anomalies (`alert:new`), during tests (`test:progress`)

## Missing Test Coverage

### High Priority Gaps:

**Unit Tests:**
- No tests for logParser regex patterns (risk: format change after 3CX update breaks parser)
- No tests for anomaly rule evaluation logic
- No tests for metric aggregation (CPU, RAM, load avg calculations)

**Integration Tests:**
- SSH reconnection flow not tested (only manual kill SSH)
- Log streaming with concurrent metrics collection not tested
- Database transactions under concurrent test writes not tested
- WebSocket broadcast reliability during network churn not tested

**E2E Tests:**
- Full test lifecycle (start → progress → stop → history view) not tested
- Frontend validation (license warning, slider bounds) not tested
- Error path handling (SSH down, SIPp crash, parser stale) not tested

### Moderate Priority Gaps:

**Error Scenarios:**
- Malformed environment variables (missing SSH_KEY_PATH, wrong NODE_EXPORTER_URL)
- Database corruption or locked file
- WebSocket reconnection under packet loss
- SIPp process killed externally during test

**Performance:**
- Metrics collector under 60+ metrics/second load
- Dashboard with 1000+ historical points in memory
- Log parser on high-volume tail output (>10MB/s)

### Recommendation for Future:

Introduce **Jest** or **Vitest** for unit tests of:
1. `parseLine()` with 20+ representative log formats
2. Anomaly `evaluate()` with boundary conditions
3. Status color/background functions
4. Database query error handling

Introduce **Playwright** for E2E tests of core flows:
1. Dashboard → Tests → Run smoke → History
2. License warning appearance and validation
3. WebSocket reconnection (simulate network flakiness)

## Test Data & Fixtures

**Mock Data Generation:**

`backend/src/services/metricsCollector.js` contains `buildMockMetrics()` with realistic probabilistic drift:

```javascript
function buildMockMetrics(testOverride = null) {
  mockState.tick++;
  
  // Gradually drift active calls
  mockState.activeCalls = clamp(
    mockState.activeCalls + jitter(1.5),
    testOverride ? testOverride.targetCalls * 0.85 : 8,
    testOverride ? testOverride.targetCalls * 1.05 : 30,
  );
  
  // Simulate occasional 408 burst
  if (Math.random() < 0.05) mockState.errors408++;
  
  // ... CPU/RAM drift based on call ratio
}
```

**Fixture Location:** No explicit fixtures; mock data is procedurally generated per request

**Database Snapshots:**
- Each completed test stores hourly or final `metrics_snapshots` rows
- Used for historical playback and trend analysis
- Not used for test fixtures (data is live during tests)

## Running Tests

### Backend via Postman

```bash
# Terminal 1: Start backend in mock mode
cd backend
cp .env.example .env
# Ensure MOCK_MODE=true in .env
npm install
npm run dev

# Terminal 2: Import and run Postman collection
# In Postman app:
# - Import OLAM-Audit.postman_collection.json
# - Import OLAM-Audit.postman_environment.json
# - Click "Runner" → Select collection → Run
```

### Frontend Manual Smoke Test

```bash
# Terminal 1: Backend running (see above)

# Terminal 2: Start frontend dev server
cd frontend
npm install
npm run dev
# Opens http://localhost:5173

# Terminal 3: Manual testing
# - Click through pages: Dashboard → Tests → History
# - Observe real-time metric updates
# - Click preset buttons, slide values
# - Run a smoke test: Start → Stop → Check History
```

### Real 3CX Connection

```bash
# Edit backend/.env:
MOCK_MODE=false
SSH_HOST=172.18.164.28
SSH_PORT=22
SSH_USER=root
SSH_KEY_PATH=./keys/3cx_rsa

# Place private key:
mkdir -p backend/keys
cp /path/to/3cx_rsa backend/keys/

# Restart backend:
cd backend
npm run dev

# Watch logs for [SSH] Connected message
# Use Postman to run tests against real 3CX
```

## Known Test Limitations

**No Snapshot Testing:**
- Metric shapes not compared across runs (no regression detection)
- Alert payloads not validated against schema

**No Contract Testing:**
- Frontend/backend API contract not formally defined
- Breaking changes not detected pre-deployment

**No Load Testing:**
- Backend metrics collection under 100+ concurrent socket.io clients not tested
- Database query performance under 10,000+ snapshots not measured

**No Chaos Engineering:**
- Network latency injection (e2e-proxy) not set up
- SSH disconnection simulation not automated
- Clock skew scenarios not tested

## Test Configuration Files

**Backend:**
- `backend/package.json` — no test script, no Jest/Mocha config
- `backend/.env.example` — contains MOCK_MODE and test environment variables

**Frontend:**
- `frontend/package.json` — no test script
- `frontend/vite.config.js` — build config only, no test runner

---

*Testing analysis: 2026-05-01*
