# Codebase Structure

**Analysis Date:** 2026-05-01

## Directory Layout

```
olam-audit/
├── backend/
│   ├── src/
│   │   ├── server.js                 # Express app + Socket.io init + boot sequence
│   │   ├── routes/
│   │   │   ├── status.js             # GET /api/status, /api/status/trunk, /api/status/host
│   │   │   ├── tests.js              # POST /api/tests/run, /stop; GET /scenarios, /status
│   │   │   └── history.js            # GET /api/history, /api/history/:id
│   │   ├── services/
│   │   │   ├── sshClient.js          # Persistent SSH with reconnect + tunnel
│   │   │   ├── logReader.js          # tail -F pipe from SSH, state updates
│   │   │   ├── logParser.js          # Regex-based line parser for 5 log types
│   │   │   ├── metricsCollector.js   # Poll node_exporter, combine, emit every 5s
│   │   │   ├── anomalyDetector.js    # Rule engine, deduplicated alerts
│   │   │   └── sippManager.js        # Spawn/control SIPp, track test lifecycle
│   │   └── db/
│   │       ├── schema.js             # SQLite init, tables (tests, metrics_snapshots)
│   │       └── queries.js            # INSERT/SELECT helpers
│   ├── data/                         # SQLite database (created on first run)
│   ├── keys/                         # SSH private key directory (.gitkeep, 3cx_rsa added by user)
│   ├── package.json                  # Dependencies: express, socket.io, node-ssh, sqlite3, axios, etc.
│   ├── .env.example                  # Template env vars (SSH_HOST, MOCK_MODE, NODE_EXPORTER_URL, etc.)
│   └── node_modules/                 # npm dependencies
│
├── frontend/
│   ├── src/
│   │   ├── main.jsx                  # React entry point
│   │   ├── App.jsx                   # Router root, top nav with links to 3 pages
│   │   ├── index.css                 # Global Tailwind imports
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx         # Live metrics, KPI cards, charts, alerts
│   │   │   ├── Tests.jsx             # Test control (presets, sliders) + live progress + charts
│   │   │   └── History.jsx           # Table of past tests (fetched from /api/history)
│   │   ├── components/
│   │   │   ├── MetricCard.jsx        # Single KPI card with color-coded value + unit
│   │   │   ├── StatusBadge.jsx       # Helper: statusColor(), statusBg(), LevelBadge
│   │   │   ├── CallChart.jsx         # Recharts LineChart showing active calls history (30 min)
│   │   │   ├── TrunkStatus.jsx       # Tigo UNE registration, channels, errors, channel usage bar
│   │   │   ├── TestControl.jsx       # Preset buttons, sliders, destination input, start/stop
│   │   │   └── AlertPanel.jsx        # Scrollable alert list, sorted by severity (CRITICO/ALTO/MEDIO/BAJO)
│   │   └── hooks/
│   │       ├── useSocket.js          # Singleton Socket.io client with ref counting
│   │       └── useMetrics.js         # WebSocket event listeners (metrics:update, alert:new, alerts:current)
│   ├── package.json                  # Dependencies: react, vite, tailwindcss, socket.io-client, recharts, axios
│   ├── vite.config.js                # Vite dev server proxy to backend:3000
│   ├── tailwind.config.js            # Tailwind customizations (colors, fonts)
│   ├── postcss.config.js             # PostCSS + Tailwind plugin
│   ├── index.html                    # Root HTML template
│   └── node_modules/                 # npm dependencies
│
├── docs/
│   ├── STATUS-2026-04-30.md          # Phase/milestone status log
│   └── PLAN-Cygwin-SIPp.md           # SIPp installation plan for Windows host
│
└── postman/                          # Postman collection (for manual API testing)
    └── OLAM.postman_collection.json
```

## Directory Purposes

**backend/src/:**
- Purpose: All Node.js backend application code (Express app, services, routes, DB)
- Structure: Separation of concerns — routes delegate to services; services handle business logic; db layer handles persistence

**backend/src/routes/:**
- Purpose: HTTP REST endpoint handlers
- Pattern: Express Router modules; each file exports a router with specific endpoints
- Convention: Filenames match API path (status.js → /api/status, tests.js → /api/tests, history.js → /api/history)

**backend/src/services/:**
- Purpose: Core business logic modules (SSH, log parsing, metrics, anomaly detection, test orchestration)
- Pattern: Single-responsibility modules; export public functions and callbacks; maintain internal state via closures
- Initialization: Each service is started by server.js during boot (startSSH(), startLogReader(), startMetricsCollection(), startAnomalyDetector(), initSippManager())

**backend/src/db/:**
- Purpose: Database layer (SQLite schema and query helpers)
- Pattern: schema.js creates tables on init; queries.js wraps SQL statements (to be extended with INSERT/SELECT/UPDATE helpers)

**backend/data/:**
- Purpose: SQLite database file location
- Generated: On first run by schema.js
- Contains: tests table (test runs), metrics_snapshots table (metrics history per test)

**backend/keys/:**
- Purpose: SSH private key storage
- Security: Never committed; .gitkeep placeholder only; user adds 3cx_rsa before running
- Ownership: Backend loads from SSH_KEY_PATH env var

**frontend/src/pages/:**
- Purpose: Full-page React components (routes are defined in App.jsx)
- Pattern: Each page is a function component that uses hooks and renders sections
- Examples: Dashboard aggregates KPIs and charts; Tests manages test control + live progress; History fetches and tabulates past tests

**frontend/src/components/:**
- Purpose: Reusable UI components (cards, badges, charts, panels)
- Pattern: Function components with props; no internal routing or global state (state lifted to pages or hooks)
- Examples: MetricCard is data-driven (value, unit, ok/warn thresholds); StatusBadge exports helper functions for color logic

**frontend/src/hooks/:**
- Purpose: Custom React hooks for stateful logic (WebSocket, metrics)
- Pattern: useSocket() creates shared Socket.io connection; useMetrics() consumes WebSocket events into local state
- Singleton: Socket.io client is shared across all components via ref counting to prevent duplicate connections

## Key File Locations

**Entry Points:**
- `backend/src/server.js` — Boots Express, initializes services, listens on PORT
- `frontend/src/main.jsx` — ReactDOM.createRoot mount point
- `frontend/src/App.jsx` — Router root with BrowserRouter and 3-page Routes

**Configuration:**
- `backend/.env.example` — Template for SSH_HOST, SSH_USER, SSH_KEY_PATH, MOCK_MODE, LOGS_PATH, NODE_EXPORTER_URL, PORT, DB_PATH, etc.
- `frontend/vite.config.js` — Dev server port 5173, proxy to backend:3000 for /api and /socket.io
- `backend/package.json` — Dependencies and scripts (npm run dev, npm start)

**Core Logic:**
- `backend/src/services/sshClient.js` — SSH connection management, exec streaming, tunnel forwarding
- `backend/src/services/logParser.js` — Regex patterns for parsing 5 different 3CX log file formats
- `backend/src/services/anomalyDetector.js` — Rule definitions, alert deduplication, Phase 0 findings
- `backend/src/services/sippManager.js` — SIPp scenario building, process control, test lifecycle

**Testing & Validation:**
- `frontend/src/components/TestControl.jsx` — Test parameter input (sliders, presets, validation warnings)
- `backend/src/services/sippManager.js` — Parameter clamping to hard limits

**Metrics & Status:**
- `backend/src/routes/status.js` — GET /api/status (full metrics), /status/trunk, /status/host
- `backend/src/services/metricsCollector.js` — Combines host metrics (CPU, RAM, disk, network) with log state
- `frontend/src/components/MetricCard.jsx` — Visual display with color-coded thresholds

## Naming Conventions

**Files:**
- Backend services: camelCase with .js extension (`sshClient.js`, `logParser.js`, `sippManager.js`)
- Backend routes: kebab-case with .js extension (`status.js`, `tests.js`, `history.js`)
- Frontend pages: PascalCase with .jsx extension (`Dashboard.jsx`, `Tests.jsx`, `History.jsx`)
- Frontend components: PascalCase with .jsx extension (`MetricCard.jsx`, `AlertPanel.jsx`, `TestControl.jsx`)
- Frontend hooks: camelCase with usePrefix and .js extension (`useSocket.js`, `useMetrics.js`)

**Directories:**
- Backend layer directories: plural nouns (`routes/`, `services/`, `db/`)
- Frontend layer directories: plural nouns (`pages/`, `components/`, `hooks/`)

**Functions & Exports:**
- Express Router modules: Export default router instance
- Service modules: Export named functions (startSSH, parseLine, runTest, etc.) and one default init function
- React components: Export named function component
- Utility functions: Export named function (statusColor, statusBg, etc.)

**Variables:**
- Constants: UPPER_SNAKE_CASE (MOCK_MODE, LOGS_PATH, LIMITS, SCENARIOS, LOG_TYPES)
- State (React): camelCase (metrics, alerts, testStatus, activeAlerts)
- Internal module state: camelCase (currentTest, sippProcess, currentMetrics, connected)

**Types & Objects:**
- Metrics object shape: Nested namespaces (host.cpu, calls.active, quality.mos, trunk.registered, queue.waiting)
- Alert object: { id, level, msg, ts, permanent }
- Test object: { id, scenario, max_calls, duration, ramp_rate, destination, started_at, result }
- Rule object: { id, level, msg, check(metrics, prevMetrics) }

## Where to Add New Code

**New REST Endpoint:**
1. Create route handler in `backend/src/routes/` or add to existing file
2. Define service function in `backend/src/services/` if logic is needed
3. Register route in `backend/src/server.js` with app.use('/api/path', routeModule)
4. Frontend: Fetch via Axios in component or hook (example: `axios.get('/api/new-endpoint')`)

**New Service/Feature:**
1. Create module in `backend/src/services/serviceName.js`
2. Export public functions and init function (called from server.js)
3. If persisting: add table to `backend/src/db/schema.js` and query helpers to `backend/src/db/queries.js`
4. If emitting real-time updates: call io.emit() from server.js callback
5. Frontend: Add WebSocket listener in `useMetrics()` hook or specific page

**New Dashboard Page:**
1. Create `frontend/src/pages/PageName.jsx` as function component
2. Add route to App.jsx: `<Route path="/page-path" element={<PageName />} />`
3. Add nav entry to NAV array in App.jsx
4. Use `useMetrics()` hook for real-time data if dashboard
5. Create reusable components in `frontend/src/components/` if needed

**New UI Component:**
1. Create `frontend/src/components/ComponentName.jsx`
2. Accept data as props (no internal API calls)
3. Use Tailwind CSS for styling (global classes from index.css)
4. Export named function component
5. Import and use in pages or other components

**Utilities (Helper Functions):**
- Shared helpers (StatusBadge.jsx exports statusColor, statusBg)
- Located where they're most used; split to separate file if used by 3+ components
- Example: `frontend/src/utils/metrics.js` for metric formatting helpers

## Special Directories

**backend/data/:**
- Purpose: SQLite database directory
- Generated: Yes (created by mkdirSync in schema.js if missing)
- Committed: No (data files are .gitignored)
- Ownership: Backend process writes tests table and metrics_snapshots

**backend/keys/:**
- Purpose: SSH private keys
- Generated: No (user-managed)
- Committed: No (.gitignore excludes *.pem, 3cx_rsa, etc.)
- Security: Store 3cx_rsa here with restricted permissions (chmod 600)

**frontend/node_modules/:**
- Purpose: npm dependencies
- Generated: Yes (npm install)
- Committed: No (.gitignore)

**backend/node_modules/:**
- Purpose: npm dependencies
- Generated: Yes (npm install)
- Committed: No (.gitignore)

**docs/:**
- Purpose: Project documentation and planning (STATUS, PLAN, CLAUDE.md, MEMORY.md)
- Committed: Yes
- Examples: PLAN-Cygwin-SIPp.md (SIPp installation guide), STATUS-*.md (milestone status)

**postman/:**
- Purpose: Postman API collection for manual testing
- Format: JSON export from Postman GUI
- Useful for: Testing /api endpoints without frontend

---

*Structure analysis: 2026-05-01*
