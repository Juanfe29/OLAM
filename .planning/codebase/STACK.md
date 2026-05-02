# Technology Stack

**Analysis Date:** 2026-05-01

## Languages

**Primary:**
- JavaScript (Node.js) — Backend services, CLI, server logic
- JSX — React frontend components and pages

**Secondary:**
- Bash — SSH commands executed on remote 3CX host (log tailing with `tail -F`, `stdbuf`)

## Runtime

**Environment:**
- Node.js 20 LTS (specified in project context)

**Package Manager:**
- npm (verified in package.json scripts)
- Lockfile: Not present in repository (lockfile ignored or missing)

## Frameworks

**Core Backend:**
- Express.js v4.18.2 — HTTP server, REST API routing
- Socket.io v4.7.2 — Real-time WebSocket communication (metrics updates, test progress, alerts)

**Frontend:**
- React v18.2.0 — UI framework
- Vite v5.2.0 — Build tool and dev server (port 5173)
- React Router DOM v6.22.3 — Client-side routing

**Styling & UI:**
- Tailwind CSS v3.4.3 — Utility-first CSS framework
- PostCSS v8.4.38 — CSS processing
- Autoprefixer v10.4.19 — CSS vendor prefixing
- Recharts v2.12.2 — React charts library for metrics visualization

**Testing/Dev:**
- Nodemon v3.1.0 — Auto-restart backend on file changes
- TypeScript definitions: `@types/react` v18.2.66, `@types/react-dom` v18.2.22

## Key Dependencies

**Critical:**
- node-ssh v13.1.0 — SSH client for persistent connection to 3CX host (172.18.164.28)
- sqlite3 v5.1.7 — Local SQLite database for test history and metrics snapshots
- node-cron v3.0.3 — Scheduler (currently not actively used in visible code, reserved for future periodic tasks)
- axios v1.6.7 — HTTP client for node_exporter Prometheus endpoint and future API calls
- socket.io-client v4.7.2 — Frontend WebSocket client

**Infrastructure:**
- cors v2.8.5 — CORS middleware for Express
- dotenv v16.4.5 — Environment variable loading from `.env` file

## Configuration

**Environment:**
- Configuration via `.env` file at backend root
- Supports two modes: `MOCK_MODE=true` (simulated data) and `MOCK_MODE=false` (production, requires SSH key)
- Critical env vars: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY_PATH`, `LOGS_PATH`, `NODE_EXPORTER_URL`, `PORT`, `MOCK_MODE`, `DB_PATH`, `SIPP_BIN`, `SIPP_AUTH_USER`, `SIPP_AUTH_PASS`
- Optional: `SLACK_WEBHOOK_URL` (not yet wired), `JWT_SECRET` (reserved for future auth)

**Build:**
- Backend: `npm run dev` (via nodemon) or `npm start` (direct Node.js)
- Frontend: Vite config at `frontend/vite.config.js` with React plugin, dev proxy to backend at `http://localhost:3000`

## Platform Requirements

**Development:**
- Node.js 20 LTS
- npm
- SSH client libraries (Node-SSH provides)
- SQLite support (sqlite3 npm package)

**Production (Deployment Target):**
- Windows 10 host (172.18.164.35) via Cygwin
- SIPp v3.7.7 binary (via Cygwin) for synthetic load generation
- 3CX v20 Update 8 Build 1121 (target: 172.18.164.28, Debian 12)
- node_exporter running on 3CX host (port 9100) for Prometheus metrics
- SSH private key (`3cx_rsa`) for root authentication to 3CX

## External Tool Dependencies

**Required on 3CX host (172.18.164.28):**
- node_exporter — Metrics export in Prometheus text format
- SIP server (3CX internal)
- tcpdump (reserved for future packet capture)
- sngrep (reserved for future SIP message analysis)

**Required on deployment host (172.18.164.35):**
- SIPp v3.7.7 (via Cygwin) — Synthetic SIP call generator
- Cygwin environment (for Windows compatibility)

## Networking & Connectivity

**Backend → 3CX PBX:**
- SSH tunnel: `172.18.164.28:22` (root, key-based auth)
- Prometheus metrics: `http://172.18.164.28:9100/metrics` (via SSH tunnel optional if firewall blocks)
- SIP signaling: Backend runs SIPp to target `172.18.164.28:5060`

**Frontend → Backend:**
- Dev proxy (Vite): `/api/*` and `/socket.io` to `http://localhost:3000`
- WebSocket upgrade for real-time updates

**3CX → Upstream SIP Trunk:**
- Tigo UNE trunk: `sip:172.17.179.166:5060` (UDP, no TLS — security risk noted in anomaly detector)

---

*Stack analysis: 2026-05-01*
