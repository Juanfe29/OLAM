# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Qué estamos construyendo

Una plataforma web que audita en tiempo real un servidor 3CX v20 corriendo en producción. El cliente es OLAM Inversiones, que opera un contact center con tráfico real generado por Wise CX a través de la troncal SIP Tigo UNE.

El problema concreto: el servidor 3CX tiene hoy una licencia de 32 llamadas simultáneas y necesita escalar a 180. Antes de hacerlo, necesitamos saber si la infraestructura actual lo soporta, dónde están los límites, y qué falla primero bajo carga.

Dos modos de operación:

**Modo pasivo** — corre siempre en segundo plano. Se conecta al servidor 3CX por SSH, lee sus logs en tiempo real, extrae métricas, detecta anomalías y las muestra en un dashboard. No interrumpe la operación.

**Modo activo** — se activa manualmente. Ejecuta SIPp para generar llamadas sintéticas controladas hacia el 3CX, mide cómo responde el sistema bajo esa carga y guarda los resultados como evidencia del assessment.

---

## El servidor auditado

```
IP:           172.18.164.28
OS:           Debian 12 (Bookworm)
PBX:          3CX v20 Update 8 Build 1121
Licencia:     SC32 (32 llamadas — objetivo SC192)
Troncal SIP:  Tigo UNE — sip:172.17.179.166:5060
IP pública:   181.63.161.242 (estática)
Acceso:       SSH root — autenticación por clave
```

Logs a parsear:

```
/var/lib/3cxpbx/Instance1/Data/Logs/3CXCallFlow.log        → llamadas activas, duraciones, estados
/var/lib/3cxpbx/Instance1/Data/Logs/3CXGatewayService.log  → troncal SIP, errores 408/503, registración
/var/lib/3cxpbx/Instance1/Data/Logs/3CXQueueManager.log    → colas, agentes, llamadas en espera
/var/lib/3cxpbx/Instance1/Data/Logs/3cxSystemService.log   → salud del PBX, errores del sistema
/var/lib/3cxpbx/Instance1/Data/Logs/3CXIVR.log             → comportamiento del IVR
```

---

## Dev commands

```bash
# Backend (puerto 3000, arranca con MOCK_MODE=true por defecto)
cd backend
cp .env.example .env
npm install
npm run dev

# Frontend (puerto 5173)
cd frontend
npm install
npm run dev
```

Para conectar al 3CX real: poner `MOCK_MODE=false` en `.env`, agregar la clave SSH en `backend/keys/3cx_rsa`, reiniciar backend.

---

## Stack

**Backend:** Node.js 20 LTS, Express.js, Socket.io, node-ssh, better-sqlite3, node-cron, axios

**Frontend:** React 18, Vite, Tailwind CSS, Recharts, Socket.io-client, Axios

**En el servidor 3CX (instalado por separado, no parte del código):** node_exporter, sngrep, SIPp v3.7.7, tcpdump

---

## Arquitectura

```
Frontend (5173) ──WebSocket + REST──► Backend (3000)
                                          ├── sshClient.js      → conexión SSH persistente a 172.18.164.28
                                          ├── logReader.js      → tail -Fq sobre los 5 logs del 3CX
                                          ├── logParser.js      → parsea líneas de log a métricas
                                          ├── sippManager.js    → ejecuta SIPp en el host del backend
                                          ├── metricsCollector  → node_exporter + 3CX Call Control API
                                          ├── anomalyDetector   → evalúa reglas contra métricas en vivo
                                          └── SQLite            → historial de pruebas + configuración
```

---

## Reglas de implementación

**SSH persistente, no polling.** Una sola conexión SSH con `execStream` + `tail -Fq`. No abrir/cerrar por polling. Si cae, reconectar con backoff exponencial.

**SIPp corre en el backend, no en el 3CX.** El SIPp Manager ejecuta SIPp en el mismo host donde corre el backend. Correr SIPp en el 3CX invalida todas las métricas.

**Modo mock completo.** Con `MOCK_MODE=true`, el backend simula todos los datos sin SSH. Los datos mock deben tener distribuciones probabilísticas realistas, no valores fijos.

**Solo una prueba a la vez.** Lock en el SIPp Manager. Si hay una prueba corriendo, rechaza iniciar otra con error claro.

**Límites duros en backend.** Sin importar lo que mande el frontend: máx 200 llamadas, máx 20 llamadas/seg de rampa, máx 8 horas. Si los parámetros los exceden, el backend los rechaza antes de ejecutar SIPp.

**Sanitización total de inputs.** Nada del frontend llega directo a un comando de shell. Todos los parámetros de SIPp se construyen en el backend con valores validados.

**Audit log.** Cada prueba se guarda en SQLite: quién la inició (IP), cuándo, parámetros, duración, resultado.

**Parser con fallback.** Si el parser de logs no extrae datos en 2 minutos, levantar una alerta de parser roto (el formato puede cambiar con updates de 3CX).

**SQLite para persistencia, memoria para tiempo real.** No guardar en SQLite cada evento WebSocket — guardar en memoria durante la prueba y persistir el resumen al finalizar.

**3CX Call Control API como fuente secundaria.** Además de parsear logs, usar la API del 3CX para validar estado de llamadas activas. Es más confiable que los logs.

---

## REST API

```
GET  /api/status          → métricas en vivo
GET  /api/status/trunk    → estado troncal Tigo UNE
GET  /api/status/host     → CPU / RAM / disco / red
POST /api/tests/run       → iniciar prueba SIPp
POST /api/tests/stop      → detener prueba
GET  /api/tests/status    → estado de la prueba actual
GET  /api/history         → historial de pruebas
GET  /api/history/:id     → detalle de una prueba
GET  /api/health          → estado del backend (SSH, DB, SIPp, modo)
```

## WebSocket events

```
metrics:update    → métricas en tiempo real (cada 5s)
alert:new         → nueva anomalía detectada
test:progress     → progreso de SIPp en curso
test:complete     → prueba finalizada + resumen
trunk:status      → cambio de estado de troncal
```

---

## KPIs con umbrales

| KPI | OK | Warning | Fail |
|---|---|---|---|
| CPU % | < 60% | 60–80% | > 80% |
| RAM % | < 70% | 70–85% | > 85% |
| Llamadas concurrentes | ≤ tier | 90–100% tier | rechazos |
| PDD p95 | < 2s | 2–4s | > 4s |
| ASR inbound | > 98% | 95–98% | < 95% |
| MOS promedio | ≥ 4.0 | 3.6–4.0 | < 3.6 |
| Jitter p95 | < 20ms | 20–30ms | > 30ms |
| Packet loss | < 0.5% | 0.5–1% | > 1% |
| Service Level | ≥ 80/20 | 70–80% | < 70% |
| Abandonment rate | < 5% | 5–10% | > 10% |

**Métricas de troncal Tigo UNE:** registro (OPTIONS ping), canales en uso vs contratados, ASR por troncal, PDD al carrier, errores 408 y 503 por hora, MOS por troncal.

**Métricas del host (node_exporter):** CPU por núcleo, RAM (total/usada/swap), disco (SO + grabaciones por separado), red (bytes/errores/drops por interfaz), CPU+RAM del proceso 3CX, load average 1/5/15, file descriptors abiertos.

---

## Escenarios SIPp predefinidos

```js
const SCENARIOS = {
  smoke:  { calls: 1,   duration: 30,    ramp: 1,  name: 'Smoke test'  },
  light:  { calls: 10,  duration: 60,    ramp: 2,  name: 'Light load'  },
  medium: { calls: 50,  duration: 120,   ramp: 5,  name: 'Medium load' },
  peak:   { calls: 180, duration: 300,   ramp: 10, name: 'Peak load'   },
  stress: { calls: 220, duration: 180,   ramp: 15, name: 'Stress test' },
  soak:   { calls: 125, duration: 14400, ramp: 5,  name: 'Soak test'   },
}
```

Además de presets: el usuario puede configurar manualmente llamadas, duración, rampa y destino (extensión o cola).

---

## Reglas de anomalías

| Severidad | Condición | Mensaje |
|---|---|---|
| CRÍTICO | activeCalls === 0 por más de 30s | Posible caída del servicio |
| CRÍTICO | errorRate > 20% en 60s | Sistema saturado o caído |
| ALTO | activeCalls > 90% del tier | Cerca del límite de licencia |
| ALTO | sipLatency > 500ms | Degradación de señalización |
| ALTO | errors408 > 5 en la última hora | Problema con troncal Tigo UNE |
| MEDIO | errorRate > 5% en 5 min | Degradación moderada |
| BAJO | caída de llamadas > 30% en 10s | Drop masivo de llamadas |

---

## Hallazgos activos (Fase 0)

Mostrar como alertas en el dashboard desde el primer arranque, sin importar si hay SSH activo:

- **CRÍTICO — H-01:** Licencia SC32 insuficiente (objetivo SC192). Cualquier prueba por encima de 32 concurrentes va a ser rechazada hasta el upgrade.
- **CRÍTICO — H-07:** SIP sin TLS en IP pública 181.63.161.242. Riesgo de toll fraud y escucha pasiva.
- **ALTO — H-03:** Errores 408 en troncal Tigo UNE (sip:172.17.179.166:5060). Ya hay problemas con 32 canales; a 180 se amplifica.
- **ALTO — H-05:** Auto-updates habilitado. Riesgo de reinicio en horario productivo y rotura del parser de logs.

---

## Dashboard — pantallas

**Dashboard (estado en vivo)**
- 10 KPIs con valor actual, color de estado y tendencia
- Gráfica de llamadas activas últimos 30 minutos
- Estado troncal Tigo UNE con detalle de errores
- Panel de alertas activas con severidad y timestamp
- Indicador de conexión SSH (verde / rojo)

**Tests (control de pruebas)**
- Sliders: llamadas simultáneas, duración, rampa
- Botones de presets predefinidos
- Advertencia visible cuando la config supera SC32
- Botón iniciar / detener
- Progreso en tiempo real: barra, tiempo, llamadas activas, tasa de error
- Gráfica en vivo de métricas durante la prueba

**History (historial)**
- Tabla: fecha, escenario, concurrencia, duración, ASR, MOS, resultado PASS/FAIL
- Detalle completo al hacer clic
- Exportar como PDF o JSON

---

## Estructura de directorios objetivo

```
olam-audit/
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── src/
│   │   ├── server.js
│   │   ├── routes/
│   │   │   ├── status.js
│   │   │   ├── tests.js
│   │   │   └── history.js
│   │   ├── services/
│   │   │   ├── sshClient.js
│   │   │   ├── logReader.js
│   │   │   ├── logParser.js
│   │   │   ├── sippManager.js
│   │   │   ├── metricsCollector.js
│   │   │   └── anomalyDetector.js
│   │   └── db/
│   │       ├── schema.js
│   │       └── queries.js
│   └── keys/
│       └── .gitkeep
└── frontend/
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── App.jsx
        ├── pages/
        │   ├── Dashboard.jsx
        │   ├── Tests.jsx
        │   └── History.jsx
        ├── components/
        │   ├── MetricCard.jsx
        │   ├── CallChart.jsx
        │   ├── AlertPanel.jsx
        │   ├── TrunkStatus.jsx
        │   ├── TestControl.jsx
        │   └── StatusBadge.jsx
        └── hooks/
            ├── useSocket.js
            └── useMetrics.js
```

---

## Variables de entorno

```env
SSH_HOST=172.18.164.28
SSH_PORT=22
SSH_USER=root
SSH_KEY_PATH=./keys/3cx_rsa

LOGS_PATH=/var/lib/3cxpbx/Instance1/Data/Logs
LOG_POLL_INTERVAL=5000

NODE_EXPORTER_URL=http://172.18.164.28:9100/metrics

PORT=3000
NODE_ENV=development
MOCK_MODE=true

DB_PATH=./data/olam.db

SLACK_WEBHOOK_URL=
JWT_SECRET=cambiar_en_produccion
```

<!-- GSD:project-start source:PROJECT.md -->
## Project

**OLAM 3CX Audit Platform**

Plataforma web que audita en tiempo real un servidor 3CX v20 corriendo en producción para OLAM Inversiones (contact center con tráfico generado por Wise CX sobre la troncal SIP Tigo UNE). Opera en dos modos: **pasivo** (always-on, lee logs del 3CX vía SSH y muestra métricas en un dashboard sin interrumpir operación) y **activo** (genera carga sintética con SIPp para medir el techo del sistema). Su misión es responder con evidencia técnica si el 3CX puede escalar de la licencia actual SC32 (32 llamadas) a SC192 (180) y dejar la plataforma operable por el equipo de TI de OLAM al cierre del assessment.

**Core Value:** **El dashboard en vivo + historial SQLite ES la evidencia del assessment.** No se entrega informe ejecutivo ni CSVs sueltos — la plataforma corriendo en `172.18.164.35` con métricas reales del 3CX y resultados de tests SIPp persistidos es el deliverable consultable. Si todo lo demás falla, esto debe seguir vivo y accesible.

### Constraints

- **Tech stack:** Node.js 20 LTS + ESM, Express, Socket.io, better-sqlite3, React 18, Vite 5, Tailwind, Recharts. SIPp v3.7.3 sobre Cygwin per-user. No introducir TypeScript ni cambiar stack core en este milestone.
- **Plataforma host:** Windows 10 sin admin, sin DNS, sin WSL. Cualquier dependencia binaria nativa debe ser portable o instalable per-user.
- **Acceso al 3CX:** Solo via SSH key-based hacia `172.18.164.28`. No instalar agentes adicionales en el 3CX (node_exporter ya está; no agregar más).
- **Sanitización total:** Nada que venga del frontend llega directo al shell. Parámetros de SIPp se construyen en backend con valores validados (regla heredada de CLAUDE.md).
- **SIPp en host de la plataforma, no en el 3CX:** correrlo en el 3CX invalidaría las métricas (regla heredada).
- **Una sola prueba a la vez:** lock en SIPp Manager. Tests concurrentes rechazados con error claro.
- **Hard limits en backend:** máx 200 calls / 20 ramp/seg / 8h. El frontend no puede saltarlos.
- **Idioma:** comentarios y strings de UI en español (CLAUDE.md y CONVENTIONS.md lo establecen).
- **Operación contact center:** tests >50 calls solo en ventana de mantenimiento coordinada con OLAM.
- **Licencia 3CX:** OLAM-09/10/11 requieren licencia trial SC192 — bloqueador externo, fuera de control del equipo plataforma.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- JavaScript (Node.js) — Backend services, CLI, server logic
- JSX — React frontend components and pages
- Bash — SSH commands executed on remote 3CX host (log tailing with `tail -F`, `stdbuf`)
## Runtime
- Node.js 20 LTS (specified in project context)
- npm (verified in package.json scripts)
- Lockfile: Not present in repository (lockfile ignored or missing)
## Frameworks
- Express.js v4.18.2 — HTTP server, REST API routing
- Socket.io v4.7.2 — Real-time WebSocket communication (metrics updates, test progress, alerts)
- React v18.2.0 — UI framework
- Vite v5.2.0 — Build tool and dev server (port 5173)
- React Router DOM v6.22.3 — Client-side routing
- Tailwind CSS v3.4.3 — Utility-first CSS framework
- PostCSS v8.4.38 — CSS processing
- Autoprefixer v10.4.19 — CSS vendor prefixing
- Recharts v2.12.2 — React charts library for metrics visualization
- Nodemon v3.1.0 — Auto-restart backend on file changes
- TypeScript definitions: `@types/react` v18.2.66, `@types/react-dom` v18.2.22
## Key Dependencies
- node-ssh v13.1.0 — SSH client for persistent connection to 3CX host (172.18.164.28)
- sqlite3 v5.1.7 — Local SQLite database for test history and metrics snapshots
- node-cron v3.0.3 — Scheduler (currently not actively used in visible code, reserved for future periodic tasks)
- axios v1.6.7 — HTTP client for node_exporter Prometheus endpoint and future API calls
- socket.io-client v4.7.2 — Frontend WebSocket client
- cors v2.8.5 — CORS middleware for Express
- dotenv v16.4.5 — Environment variable loading from `.env` file
## Configuration
- Configuration via `.env` file at backend root
- Supports two modes: `MOCK_MODE=true` (simulated data) and `MOCK_MODE=false` (production, requires SSH key)
- Critical env vars: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY_PATH`, `LOGS_PATH`, `NODE_EXPORTER_URL`, `PORT`, `MOCK_MODE`, `DB_PATH`, `SIPP_BIN`, `SIPP_AUTH_USER`, `SIPP_AUTH_PASS`
- Optional: `SLACK_WEBHOOK_URL` (not yet wired), `JWT_SECRET` (reserved for future auth)
- Backend: `npm run dev` (via nodemon) or `npm start` (direct Node.js)
- Frontend: Vite config at `frontend/vite.config.js` with React plugin, dev proxy to backend at `http://localhost:3000`
## Platform Requirements
- Node.js 20 LTS
- npm
- SSH client libraries (Node-SSH provides)
- SQLite support (sqlite3 npm package)
- Windows 10 host (172.18.164.35) via Cygwin
- SIPp v3.7.7 binary (via Cygwin) for synthetic load generation
- 3CX v20 Update 8 Build 1121 (target: 172.18.164.28, Debian 12)
- node_exporter running on 3CX host (port 9100) for Prometheus metrics
- SSH private key (`3cx_rsa`) for root authentication to 3CX
## External Tool Dependencies
- node_exporter — Metrics export in Prometheus text format
- SIP server (3CX internal)
- tcpdump (reserved for future packet capture)
- sngrep (reserved for future SIP message analysis)
- SIPp v3.7.7 (via Cygwin) — Synthetic SIP call generator
- Cygwin environment (for Windows compatibility)
## Networking & Connectivity
- SSH tunnel: `172.18.164.28:22` (root, key-based auth)
- Prometheus metrics: `http://172.18.164.28:9100/metrics` (via SSH tunnel optional if firewall blocks)
- SIP signaling: Backend runs SIPp to target `172.18.164.28:5060`
- Dev proxy (Vite): `/api/*` and `/socket.io` to `http://localhost:3000`
- WebSocket upgrade for real-time updates
- Tigo UNE trunk: `sip:172.17.179.166:5060` (UDP, no TLS — security risk noted in anomaly detector)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Module System
- ESM (ECMAScript Modules) — `"type": "module"` in `backend/package.json`
- All imports use `import` statements, no CommonJS `require()`
- ESM via Vite bundler
- All imports use `import` statements
## Code Style
- No linter configured (no ESLint, Prettier, or Biome detected)
- **Quotes:** Double quotes `"` for strings (consistent across codebase)
- **Semicolons:** Present on all statements (not optional)
- **Indentation:** 2 spaces (JavaScript convention)
- **Arrow functions:** Preferred over function declarations for callbacks and handlers
## Naming Patterns
- PascalCase for React components: `MetricCard.jsx`, `Dashboard.jsx`, `TestControl.jsx`
- camelCase for services/utilities: `sshClient.js`, `logReader.js`, `sippManager.js`
- camelCase for database modules: `schema.js`, `queries.js`
- kebab-case for route files: NOT used; services use camelCase instead (note: contradicts CLAUDE.md intent but reflects actual code)
- camelCase exclusively: `startSSH()`, `execCommand()`, `parseLine()`, `handleStart()`, `applyEvent()`
- Callbacks prefixed with `on`: `onAlert`, `onProgress`, `onComplete`, `onData`, `onClose`
- camelCase for all variables: `activeCalls`, `currentTest`, `testId`, `errorRate`
- `SCREAMING_SNAKE_CASE` for constants: `MOCK_MODE`, `RECONNECT_BASE_MS`, `LIMITS`, `SCENARIOS`, `MAX_HISTORY`, `COOLDOWN_MS`
- Underscore prefix for internal/private state: `streamCleanups`, `prevCpuCounters` (in service closures)
- PascalCase for component names: `export default function Dashboard() { ... }`
- camelCase for props and state variables
- No TypeScript — plain JavaScript objects
- Object keys use camelCase: `{ activeCalls: 18, errors408: 0, trunkRegistered: true }`
- Database columns use snake_case: `initiated_by`, `max_calls`, `started_at`, `ended_at`
## Import Organization
- None detected; all relative imports use `./` or `../` paths
- No `baseUrl` or path aliases configured in project
## Error Handling
- Database operations wrapped in `new Promise()` to convert callbacks to Promises
- SSH operations use try-catch with `async/await`
- Exponential backoff reconnection logic in `sshClient.js`: `scheduleReconnect()` with `Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS)`
- Stream cleanup callbacks tracked in array to properly tear down on reconnect
- Early returns for "not connected" state before attempting operations
- Mock mode fallback: if `MOCK_MODE=true`, `runMockTest()` is called instead of `runRealSipp()`
- Hard limits enforced in `runTest()` to prevent invalid parameters reaching SIPp
- Passed through `reject()` in Promise wrappers
- HTTP layer catches and returns 400 status with error message
## Logging
- Prefixed log messages with `[Component]` or `[Module]`: `[SSH]`, `[LogReader]`, `[DB]`, `[OLAM]`
- Error logs: `console.error('[Module] Description:', err.message)`
- Warning logs: `console.warn('[Module] Description')`
- Info logs: `console.log('[Module] Description')`
- No log levels (INFO/WARN/ERROR) implemented — implicit by console method
- No timestamp added (relies on console output capture)
## Async Patterns
## Comments
- Complex regex patterns get explanatory comments above: `// Formatos reales de los logs del 3CX v20:`
- Non-obvious logic in parsers: `// tail -Fq prepends "==> /path/to/file <==" when switching files`
- Workarounds and gotchas: `// 3CX logs occasionally write to stderr — treat as data`
- Command explanations: `// stdbuf -oL fuerza line-buffered (sino tail bufferiza por bloques)`
- Not used in this codebase (no TypeScript, no formal documentation generation)
## Function Design
- Small, focused functions (10-30 lines typical)
- Example: `detectFile()`, `parseTimestamp()`, `statusColor()` — single responsibility
- Positional arguments for required params
- Object destructuring for multiple related params: `{ max_calls, duration, ramp_rate, destination }`
- Callbacks as named parameters: `onAlert`, `onProgress`, `onComplete`
- Promises for async operations
- Plain objects for structured data: `{ status: 'ok', mock: true, ssh: false, timestamp: '...' }`
- Early returns for guard clauses (see SSH error handling)
## Module Design
- Named exports for services: `export function startSSH() { }`, `export async function runTest() { }`
- Default exports for React components: `export default function Dashboard() { }`
- Multiple named exports from service modules (no default)
- Not used; imports are direct from individual files
- Module-level closures for persistent state: `let ssh = null;`, `let currentTest = null;`
- Exposed only via getter functions: `export function getTestStatus()`, `export function isConnected()`
## React Patterns
- Functional components exclusively (no class components)
- Hooks-based state management: `useState`, `useEffect`, `useCallback`, `useRef`
- Encapsulate reusable logic: `useMetrics()`, `useSocket()`
- Located in `frontend/src/hooks/`
- Export named functions: `export function useMetrics() { }`
- Named as `handleX` or `onX`: `handleStart()`, `handleMetrics()`, `handleAlert()`
- Wrapped in `useCallback()` when passed as dependencies: `const handleMetrics = useCallback((data) => { ... }, [])`
## Tailwind CSS
- Responsive prefixes: `sm:`, `lg:`
- State classes: `hover:`, `disabled:`, `focus:`
- Opacity modifiers: `bg-red-500/10`, `border-red-500/30`
- Animation: `animate-pulse`
- Primary: `sky-*` (blue)
- Error/Critical: `red-*`
- Warning: `yellow-*` / `orange-*`
- Neutral: `slate-*`
- Success: `green-*`
- All styling via Tailwind utilities
- Postscss config present for Tailwind preprocessing
## Environment Variables
- SCREAMING_SNAKE_CASE: `SSH_HOST`, `SSH_USER`, `MOCK_MODE`, `NODE_EXPORTER_URL`
- Dot-separated compound names: `NODE_EXPORTER_VIA_SSH`, `NODE_EXPORTER_TUNNEL_PORT`
- Read via `process.env.KEY` with fallback: `process.env.MOCK_MODE === 'true'`, `parseInt(process.env.PORT || '3000')`
- Loaded via `dotenv` in `backend/src/server.js`: `import 'dotenv/config'`
## Key Architectural Patterns
- Each service (SSH, Logs, Metrics, SIPp) maintains private state in closure
- Exports only pure functions and getter functions
- Initialization called once at startup: `startSSH()`, `initSippManager()`
- Backend emits events via Socket.IO: `io.emit('metrics:update', metrics)`, `io.emit('alert:new', alert)`
- Frontend subscribes via custom hook: `useSocket()` with `on()` / `off()` methods
- Single test execution enforcement: check `currentTest !== null` before `runTest()`
- Controlled by `MOCK_MODE` environment variable
- Early returns in all external-facing operations
- Separate mock data generators for realistic simulation
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## Pattern Overview
- Single-process Express backend handles HTTP REST routes, WebSocket events, and SSH-based log streaming concurrently
- Frontend connects via Socket.io for push-based metrics and alerts (no polling)
- SSH persistent connection with exponential backoff reconnection strategy
- Mock mode supports full end-to-end testing without 3CX server connection
- SIPp test execution with hard-enforced parameter limits to prevent abuse
## Layers
- Purpose: Real-time UI dashboard for live metrics, alerting, and test orchestration
- Location: `frontend/src/`
- Contains: React pages, components, hooks, styling (Tailwind CSS)
- Depends on: Socket.io-client, Axios, Recharts charting, React Router
- Used by: End-users viewing dashboard and controlling tests
- Purpose: REST endpoints for status retrieval, test control, and history
- Location: `backend/src/routes/` (status.js, tests.js, history.js)
- Contains: Express Router handlers that delegate to services
- Depends on: Service layer (metricsCollector, sippManager, anomalyDetector)
- Used by: Frontend via REST, external tools via Postman
- Purpose: Core business logic organized into single-responsibility modules
- Location: `backend/src/services/`
- Contains: SSH client, log reader/parser, metrics collection, anomaly detection, SIPp orchestration
- Depends on: Database, external APIs (node_exporter, 3CX Call Control API), SSH tunneling
- Used by: Routes, server.js initialization, each other via imports
- Purpose: SQLite persistence for test history and metrics snapshots
- Location: `backend/src/db/`
- Contains: Schema definition, query helpers
- Depends on: sqlite3 driver, fs for directory creation
- Used by: sippManager to log test runs, metricsCollector to archive snapshots
- Purpose: Real-time broadcasting of metrics and alerts to connected clients
- Location: `backend/src/server.js` (Socket.io instantiation and event emission)
- Contains: io.emit() calls that broadcast server state changes
- Event types: `metrics:update`, `alert:new`, `alerts:current`, `test:progress`, `test:complete`, `trunk:status`
## Data Flow
- In-memory: Metrics snapshots, current test status, active alerts (transient during session)
- Persistent: Test history + snapshots in SQLite (survives backend restart)
- Shared: `useMetrics()` hook maintains rolling window of last 30 minutes of metrics for charting
## Key Abstractions
- Purpose: Singleton SSH connection manager with auto-reconnect and optional port forwarding
- Pattern: Single persistent connection; stream-based (no polling); backoff reconnect on disconnection
- Critical Features:
- Purpose: Tail 5 log files from 3CX, parse lines, maintain in-memory counter state
- Pattern: Stream consumer; applies parser output to ephemeral state object
- Watchdog: Alert if no log data seen for 2+ minutes (parser may be broken due to 3CX version update)
- Examples: Maintains activeCalls count, errors408/503 per hour, trunk registration state
- Purpose: Regex-based line parser supporting 5 distinct 3CX log formats
- Pattern: Stateless function; detectFile() tracks which log file current line came from via tail's file headers
- Defensive: Patterns check for SIP status codes in context (not just numbers); handles both YYYY/MM/DD and DD/MM/YYYY timestamps
- Purpose: Aggregate metrics from multiple sources (logs, node_exporter, 3CX API) into unified shape every 5s
- Pattern: Polls on interval; combines real data with fallback mock data; CPU delta calculated from cumulative counters
- Mock Data: Probabilistic jitter and load-based drift ensure realistic distributions, not flat values
- Shape: Normalizes host (cpu, ram, loadAvg, disk, network), calls (active, tier, pdd_p95, asr, errorRate), quality (mos, jitter, packetLoss), trunk (registered, channelsUsed, errors408/503), queue (waiting, agentsOnline, serviceLevel, abandonment)
- Purpose: Evaluate hardcoded rules against live metrics; emit deduplicated alerts
- Pattern: Stateful rule evaluator; tracks lastFiredAt per rule ID; cooldown prevents spam
- Phase 0 Findings: 4 permanent hardware findings (SC32 license insufficient, SIP without TLS, 408 errors on trunk, auto-updates enabled) loaded at boot
- Examples: "activeCalls === 0 for 30s", "errorRate > 20%", "cpu > 80%", "near_capacity checks active > tier * 0.9"
- Purpose: Orchestrate load test lifecycle; spawn SIPp process, stream progress, finalize results
- Pattern: Lock-based (only one test at a time); parameters validated and clamped before execution; test ID auto-incremented
- Scenarios: Predefined presets (smoke 1 call 30s, light 10 calls 60s, medium 50 calls 120s, peak 180 calls 300s, stress 220 calls 180s, soak 125 calls 4h)
- Mock vs Real: Mock test simulates metrics ramp; real test spawns SIPp executable with dynamically generated scenario file
## Entry Points
- Location: `backend/src/server.js`
- Triggers: `npm run dev` via nodemon
- Responsibilities:
- Location: `frontend/src/main.jsx` (entry), `frontend/src/App.jsx` (router root)
- Triggers: `npm run dev` via Vite on port 5173
- Responsibilities:
- Renders 10 KPI cards organized by section (Host, Calls, Quality, Queue)
- Renders CallChart component with 30-minute history (via Recharts LineChart)
- Renders TrunkStatus component showing Tigo UNE registration, channels, errors
- Renders AlertPanel component sorted by severity
- Left side: TestControl component (preset buttons, sliders, destination input, start/stop buttons)
- Right side: Live progress bar, active calls / error rate / objective display during test
- Below: LineChart showing test:progress events in real-time
- Table of all past tests (fetched from GET /api/history)
- Columns: Date, Scenario, Calls, Duration, ASR, MOS, Result (PASS/FAIL/STOPPED)
- Click row for detail view
## Error Handling
- Connection failure → scheduled reconnect with exponential backoff (2s → 30s max)
- Execstream error → logged, cleanup pushed to cleanup stack, stream will re-attach on next interval
- Tunnel failure → logged, tunnel server set to null, TCP clients will see immediate disconnect
- Unparseable lines → skipped (null return), no error logged (logs are noisy)
- Watchdog monitors 2+ minute parse gap → alert raised ("parser may be broken")
- fileType detection failure → line skipped
- node_exporter timeout (4s) → fallback hostMetrics to zeroes, continue
- Prometheus parse failure → hostMetrics zeroes but real data from logs still used
- 3CX API error → logged, metrics use fallback values
- Rule match failure (undefined value) → rule not fired, no crash
- Alert generation → de-duplicated via lastFiredAt cooldown
- Rule mismatch on next cycle → alert auto-resolved (removed from activeAlerts)
- SIPp spawn failure → error caught, test record finalized as FAILED
- Test parameter validation → clamp to limits before sending to SIPp (no invalid command line)
- WebSocket disconnect during test → test continues, progress buffered in memory, frontend reconnects to receive summary
## Cross-Cutting Concerns
- Console.log() prefixed with service name in brackets: `[SSH]`, `[LogReader]`, `[Metrics]`, `[SIPp]`
- Errors logged to stderr via console.error()
- No log rotation or persistent log file (logs only to terminal/docker stdout)
- SSH credentials validated on connect (error caught, reconnect scheduled)
- Test parameters validated and clamped to hard limits in sippManager.runTest() before DB insert
- All user-provided params sanitized: destination input is validated as regex `[0-9a-zA-Z*#]+` before passing to SIPp
- No shell injection risk: SIPp params constructed as array passed to spawn(), not shell string
- No API key or JWT enforcement (open dashboard, assumes network boundary trust)
- SSH private key loaded from env.SSH_KEY_PATH, never embedded or logged
- Test audit trail: initiatedBy (IP) and timestamp recorded in DB for each test
- Real-time metrics exposed via REST (GET /api/status) and WebSocket
- Test history queryable via REST (GET /api/history/:id)
- Metrics snapshots archived to SQLite for post-test analysis
- No external observability platform (Datadog, New Relic); self-contained
- Mock mode: All metrics synthetic, no SSH needed, frontend shows "MOCK MODE" badge
- Production mode: SSH connect on boot with 10s timeout; if fails, reconnect scheduled but dashboard still loads (shows "SSH disconnected")
- Database: Created on first run, persists across restarts
- Alerts: Phase 0 findings pre-loaded at boot, override any state
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
