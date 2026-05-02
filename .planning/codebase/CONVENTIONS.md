# Coding Conventions

**Analysis Date:** 2026-05-01

## Module System

**Backend:**
- ESM (ECMAScript Modules) — `"type": "module"` in `backend/package.json`
- All imports use `import` statements, no CommonJS `require()`

**Frontend:**
- ESM via Vite bundler
- All imports use `import` statements

## Code Style

**Formatting:**
- No linter configured (no ESLint, Prettier, or Biome detected)
- **Quotes:** Double quotes `"` for strings (consistent across codebase)
- **Semicolons:** Present on all statements (not optional)
- **Indentation:** 2 spaces (JavaScript convention)
- **Arrow functions:** Preferred over function declarations for callbacks and handlers

**Example from `backend/src/server.js`:**
```javascript
import express from 'express';
const app = express();

app.use('/api/status', statusRoutes);

io.on('connection', (socket) => {
  socket.emit('metrics:update', metrics);
});
```

## Naming Patterns

**Files:**
- PascalCase for React components: `MetricCard.jsx`, `Dashboard.jsx`, `TestControl.jsx`
- camelCase for services/utilities: `sshClient.js`, `logReader.js`, `sippManager.js`
- camelCase for database modules: `schema.js`, `queries.js`
- kebab-case for route files: NOT used; services use camelCase instead (note: contradicts CLAUDE.md intent but reflects actual code)

**Functions & Methods:**
- camelCase exclusively: `startSSH()`, `execCommand()`, `parseLine()`, `handleStart()`, `applyEvent()`
- Callbacks prefixed with `on`: `onAlert`, `onProgress`, `onComplete`, `onData`, `onClose`

**Variables:**
- camelCase for all variables: `activeCalls`, `currentTest`, `testId`, `errorRate`
- `SCREAMING_SNAKE_CASE` for constants: `MOCK_MODE`, `RECONNECT_BASE_MS`, `LIMITS`, `SCENARIOS`, `MAX_HISTORY`, `COOLDOWN_MS`
- Underscore prefix for internal/private state: `streamCleanups`, `prevCpuCounters` (in service closures)

**React Components:**
- PascalCase for component names: `export default function Dashboard() { ... }`
- camelCase for props and state variables

**Types/Shapes:**
- No TypeScript — plain JavaScript objects
- Object keys use camelCase: `{ activeCalls: 18, errors408: 0, trunkRegistered: true }`
- Database columns use snake_case: `initiated_by`, `max_calls`, `started_at`, `ended_at`

## Import Organization

**Order (Backend Example from `sshClient.js`):**
1. Node.js built-ins: `import net from 'net'`
2. Third-party packages: `import { NodeSSH } from 'node-ssh'`
3. Local modules: `import { execCommand } from './db/queries.js'`

**Path Aliases:**
- None detected; all relative imports use `./` or `../` paths
- No `baseUrl` or path aliases configured in project

**Example from `frontend/src/pages/Dashboard.jsx`:**
```javascript
import { useMetrics } from '../hooks/useMetrics.js';
import { MetricCard } from '../components/MetricCard.jsx';
import { CallChart } from '../components/CallChart.jsx';
```

## Error Handling

**Async/Await Try-Catch Pattern:**
```javascript
// From backend/src/routes/tests.js
router.post('/run', async (req, res) => {
  try {
    const result = await runTest(req.body, initiatedBy);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
```

**Callback-Style Error Handling (Database):**
```javascript
// From backend/src/db/queries.js
db.run(
  `INSERT INTO tests ...`,
  [values],
  function(err) {
    if (err) reject(err);
    else resolve(this.lastID);
  }
);
```

**Promise Wrapping:**
- Database operations wrapped in `new Promise()` to convert callbacks to Promises
- SSH operations use try-catch with `async/await`

**SSH Disconnect Resilience:**
- Exponential backoff reconnection logic in `sshClient.js`: `scheduleReconnect()` with `Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS)`
- Stream cleanup callbacks tracked in array to properly tear down on reconnect
- Early returns for "not connected" state before attempting operations

**SIPp Failures:**
- Mock mode fallback: if `MOCK_MODE=true`, `runMockTest()` is called instead of `runRealSipp()`
- Hard limits enforced in `runTest()` to prevent invalid parameters reaching SIPp

**Database Errors:**
- Passed through `reject()` in Promise wrappers
- HTTP layer catches and returns 400 status with error message

## Logging

**Framework:** `console` (no logging library detected)

**Conventions:**
- Prefixed log messages with `[Component]` or `[Module]`: `[SSH]`, `[LogReader]`, `[DB]`, `[OLAM]`
- Error logs: `console.error('[Module] Description:', err.message)`
- Warning logs: `console.warn('[Module] Description')`
- Info logs: `console.log('[Module] Description')`

**Examples from `sshClient.js`:**
```javascript
console.log(`[SSH] Connected to ${process.env.SSH_HOST}`);
console.error('[SSH] Connect failed:', err.message);
console.warn('[SSH] Connection ended');
console.log(`[SSH tunnel] Forwarding 127.0.0.1:${TUNNEL_LOCAL_PORT} → 3CX:${TUNNEL_REMOTE_PORT}`);
```

**Level Convention:**
- No log levels (INFO/WARN/ERROR) implemented — implicit by console method
- No timestamp added (relies on console output capture)

## Async Patterns

**Async/Await (Preferred):**
```javascript
// From backend/src/services/sippManager.js
export async function runTest(params, initiatedBy) {
  const testId = await insertTest({ ...resolved, initiated_by: initiatedBy });
  // ...
}
```

**Promises:**
```javascript
// From backend/src/db/queries.js
return new Promise((resolve, reject) => {
  db.run(..., function(err) {
    if (err) reject(err);
    else resolve(this.lastID);
  });
});
```

**Callback Pattern (for streams):**
```javascript
// From backend/src/services/logReader.js
streamCleanup = execStream(
  cmd,
  (chunk) => { /* handle data */ },
  (code) => { /* handle close */ }
);
```

**No explicit `.then()` chains** — async/await preferred throughout

## Comments

**Language:** Spanish for user-facing messages and domain logic; English for technical infrastructure

**When to Comment:**
- Complex regex patterns get explanatory comments above: `// Formatos reales de los logs del 3CX v20:`
- Non-obvious logic in parsers: `// tail -Fq prepends "==> /path/to/file <==" when switching files`
- Workarounds and gotchas: `// 3CX logs occasionally write to stderr — treat as data`
- Command explanations: `// stdbuf -oL fuerza line-buffered (sino tail bufferiza por bloques)`

**JSDoc/TSDoc:**
- Not used in this codebase (no TypeScript, no formal documentation generation)

**Example:**
```javascript
// Detect which log file a line came from based on the tail -Fq prefix
// tail -Fq prepends "==> /path/to/file <==" when switching files
function detectFile(line) {
  // ...
}
```

## Function Design

**Size Guideline:**
- Small, focused functions (10-30 lines typical)
- Example: `detectFile()`, `parseTimestamp()`, `statusColor()` — single responsibility

**Parameters:**
- Positional arguments for required params
- Object destructuring for multiple related params: `{ max_calls, duration, ramp_rate, destination }`
- Callbacks as named parameters: `onAlert`, `onProgress`, `onComplete`

**Return Values:**
- Promises for async operations
- Plain objects for structured data: `{ status: 'ok', mock: true, ssh: false, timestamp: '...' }`
- Early returns for guard clauses (see SSH error handling)

**Example from `logParser.js`:**
```javascript
export function parseLine(rawLine) {
  const fileType = detectFile(rawLine);
  if (!fileType || !rawLine.trim()) return null;  // Early return
  // ... process line
  return { type: 'call_active', callId: inv[1], ts };  // Structured return
}
```

## Module Design

**Exports:**
- Named exports for services: `export function startSSH() { }`, `export async function runTest() { }`
- Default exports for React components: `export default function Dashboard() { }`
- Multiple named exports from service modules (no default)

**Barrel Files:**
- Not used; imports are direct from individual files

**Internal State:**
- Module-level closures for persistent state: `let ssh = null;`, `let currentTest = null;`
- Exposed only via getter functions: `export function getTestStatus()`, `export function isConnected()`

**Example from `sippManager.js`:**
```javascript
let currentTest = null;
let sippProcess  = null;

export function initSippManager({ onTestProgress, onTestComplete }) {
  onProgress = onTestProgress;
  onComplete = onTestComplete;
}

export function getTestStatus() {
  return currentTest ? { running: true, ...currentTest } : { running: false };
}

export async function runTest(params, initiatedBy) {
  if (currentTest) throw new Error('Already running');
  // ...
}
```

## React Patterns

**Components:**
- Functional components exclusively (no class components)
- Hooks-based state management: `useState`, `useEffect`, `useCallback`, `useRef`

**Custom Hooks:**
- Encapsulate reusable logic: `useMetrics()`, `useSocket()`
- Located in `frontend/src/hooks/`
- Export named functions: `export function useMetrics() { }`

**Event Handlers:**
- Named as `handleX` or `onX`: `handleStart()`, `handleMetrics()`, `handleAlert()`
- Wrapped in `useCallback()` when passed as dependencies: `const handleMetrics = useCallback((data) => { ... }, [])`

**Example from `useMetrics.js`:**
```javascript
export function useMetrics() {
  const { connected, on, off } = useSocket();
  const [metrics, setMetrics]   = useState(null);

  const handleMetrics = useCallback((data) => {
    setMetrics(data);
    setHistory(prev => [...prev].slice(-MAX_HISTORY));
  }, []);

  useEffect(() => {
    on('metrics:update', handleMetrics);
    return () => off('metrics:update', handleMetrics);
  }, [on, off, handleMetrics]);

  return { metrics, alerts, history, connected };
}
```

## Tailwind CSS

**Utility Classes:**
- Responsive prefixes: `sm:`, `lg:`
- State classes: `hover:`, `disabled:`, `focus:`
- Opacity modifiers: `bg-red-500/10`, `border-red-500/30`
- Animation: `animate-pulse`

**Pattern: Conditional Classes (Inline):**
```javascript
// From Dashboard.jsx
className={`flex items-center gap-1.5 ${connected ? 'text-green-400' : 'text-red-500'}`}
```

**Pattern: Theme Colors:**
- Primary: `sky-*` (blue)
- Error/Critical: `red-*`
- Warning: `yellow-*` / `orange-*`
- Neutral: `slate-*`
- Success: `green-*`

**No Custom CSS Files:**
- All styling via Tailwind utilities
- Postscss config present for Tailwind preprocessing

## Environment Variables

**Naming Convention:**
- SCREAMING_SNAKE_CASE: `SSH_HOST`, `SSH_USER`, `MOCK_MODE`, `NODE_EXPORTER_URL`
- Dot-separated compound names: `NODE_EXPORTER_VIA_SSH`, `NODE_EXPORTER_TUNNEL_PORT`

**Access Pattern:**
- Read via `process.env.KEY` with fallback: `process.env.MOCK_MODE === 'true'`, `parseInt(process.env.PORT || '3000')`
- Loaded via `dotenv` in `backend/src/server.js`: `import 'dotenv/config'`

**Example:**
```javascript
const MOCK = process.env.MOCK_MODE === 'true';
const NODE_EXPORTER_URL = process.env.NODE_EXPORTER_URL || 'http://172.18.164.28:9100/metrics';
const PORT = parseInt(process.env.PORT || '3000');
```

## Key Architectural Patterns

**Service Locator / Module State:**
- Each service (SSH, Logs, Metrics, SIPp) maintains private state in closure
- Exports only pure functions and getter functions
- Initialization called once at startup: `startSSH()`, `initSippManager()`

**Observer Pattern (WebSocket):**
- Backend emits events via Socket.IO: `io.emit('metrics:update', metrics)`, `io.emit('alert:new', alert)`
- Frontend subscribes via custom hook: `useSocket()` with `on()` / `off()` methods

**Lock Pattern (SIPp):**
- Single test execution enforcement: check `currentTest !== null` before `runTest()`

**Mock Mode:**
- Controlled by `MOCK_MODE` environment variable
- Early returns in all external-facing operations
- Separate mock data generators for realistic simulation

---

*Convention analysis: 2026-05-01*
