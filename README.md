# OLAM 3CX Audit Platform

Plataforma de auditoría en tiempo real para el servidor 3CX v20 de OLAM Inversiones. Monitorea un contact center productivo con tráfico real de Wise CX a través de la troncal SIP Tigo UNE.

## Qué hace

**Modo pasivo (siempre activo):** Se conecta al servidor 3CX por SSH, lee los logs en tiempo real, extrae métricas, detecta anomalías y las muestra en un dashboard live.

**Modo activo (manual):** Ejecuta pruebas de carga SIPp contra el 3CX para medir capacidad real bajo carga sintética controlada — necesario antes de escalar de SC32 a SC192.

---

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js 20, Express, Socket.io, node-ssh, better-sqlite3 |
| Frontend | React 18, Vite, Tailwind CSS, Recharts |
| Persistencia | SQLite |
| Métricas host | Prometheus node_exporter (en el servidor 3CX) |
| Pruebas de carga | SIPp v3.7.7 (en el host del backend) |

---

## Inicio rápido

### Requisitos

- Node.js 20+
- npm

### Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

El backend corre en `http://localhost:3000`.

Por defecto arranca en **modo mock** (`MOCK_MODE=true`) — todos los datos son simulados, no se necesita SSH ni acceso al servidor.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

El frontend corre en `http://localhost:5173`.

---

## Conectar al 3CX real

### 1. Colocar la clave SSH

```bash
cp /ruta/a/tu/clave backend/keys/3cx_rsa
chmod 600 backend/keys/3cx_rsa
```

### 2. Activar modo real en `.env`

```env
MOCK_MODE=false
SSH_HOST=172.18.164.28
SSH_USER=root
SSH_KEY_PATH=./keys/3cx_rsa
NODE_EXPORTER_URL=http://172.18.164.28:9100/metrics
```

### 3. Verificar node_exporter en el servidor

```bash
curl http://172.18.164.28:9100/metrics | head -5
```

Si no responde, las métricas de CPU/RAM/disco retornarán 0. node_exporter debe estar corriendo como servicio en el servidor 3CX.

### 4. Reiniciar el backend

El indicador SSH en el dashboard debe ponerse verde.

---

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `SSH_HOST` | `172.18.164.28` | IP del servidor 3CX |
| `SSH_PORT` | `22` | Puerto SSH |
| `SSH_USER` | `root` | Usuario SSH |
| `SSH_KEY_PATH` | `./keys/3cx_rsa` | Ruta a la clave privada SSH |
| `NODE_EXPORTER_URL` | `http://172.18.164.28:9100/metrics` | Endpoint Prometheus del host |
| `MOCK_MODE` | `true` | `true` = datos simulados, `false` = SSH real |
| `PORT` | `3000` | Puerto del backend |
| `DB_PATH` | `./data/olam.db` | Ruta de la base de datos SQLite |
| `SLACK_WEBHOOK_URL` | — | Webhook para alertas en Slack (opcional) |

---

## API REST

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del backend (SSH, DB, SIPp, modo) |
| GET | `/api/status` | Métricas en vivo |
| GET | `/api/status/trunk` | Estado troncal Tigo UNE |
| GET | `/api/status/host` | CPU / RAM / disco / red |
| GET | `/api/tests/scenarios` | Escenarios SIPp predefinidos |
| GET | `/api/tests/status` | Estado de la prueba en curso |
| POST | `/api/tests/run` | Iniciar prueba SIPp |
| POST | `/api/tests/stop` | Detener prueba |
| GET | `/api/history` | Historial de pruebas |
| GET | `/api/history/:id` | Detalle de una prueba |

## WebSocket events

| Evento | Descripción |
|---|---|
| `metrics:update` | Métricas en tiempo real (cada 5s) |
| `alert:new` | Nueva anomalía detectada |
| `alerts:current` | Estado actual de todas las alertas |
| `test:progress` | Progreso de prueba SIPp en curso |
| `test:complete` | Prueba finalizada + resumen |

---

## Escenarios SIPp predefinidos

| Escenario | Llamadas | Duración | Rampa | Uso |
|---|---|---|---|---|
| `smoke` | 1 | 30s | 1/s | Conectividad básica |
| `light` | 10 | 60s | 2/s | Carga mínima |
| `medium` | 50 | 120s | 5/s | Carga moderada |
| `peak` | 180 | 300s | 10/s | Pico objetivo SC192 |
| `stress` | 220 | 180s | 15/s | Más allá del límite |
| `soak` | 125 | 4h | 5/s | Estabilidad sostenida |

> Con la licencia SC32 actual, pruebas por encima de 32 llamadas simultáneas serán rechazadas por el 3CX. Los escenarios `medium`, `peak`, `stress` y `soak` son funcionales tras el upgrade de licencia.

---

## Alertas permanentes (Fase 0)

Estas alertas están activas desde el primer arranque:

| ID | Severidad | Descripción |
|---|---|---|
| H-01 | CRÍTICO | Licencia SC32 insuficiente — objetivo SC192 |
| H-07 | CRÍTICO | SIP sin TLS en IP pública `181.63.161.242` |
| H-03 | ALTO | Errores 408 en troncal Tigo UNE |
| H-05 | ALTO | Auto-updates habilitado en 3CX |

---

## KPIs monitoreados

| KPI | OK | Warning | Crítico |
|---|---|---|---|
| CPU % | < 60% | 60–80% | > 80% |
| RAM % | < 70% | 70–85% | > 85% |
| Llamadas concurrentes | ≤ tier | 90–100% tier | rechazos |
| PDD p95 | < 2s | 2–4s | > 4s |
| ASR inbound | > 98% | 95–98% | < 95% |
| MOS promedio | ≥ 4.0 | 3.6–4.0 | < 3.6 |
| Jitter p95 | < 20ms | 20–30ms | > 30ms |
| Packet loss | < 0.5% | 0.5–1% | > 1% |

---

## Estructura del proyecto

```
olam-audit/
├── backend/
│   ├── .env.example
│   ├── keys/              ← SSH key va aquí (no incluida en repo)
│   └── src/
│       ├── server.js
│       ├── routes/        ← status.js, tests.js, history.js
│       ├── services/      ← sshClient, logReader, logParser,
│       │                     sippManager, metricsCollector, anomalyDetector
│       └── db/            ← schema.js, queries.js
└── frontend/
    └── src/
        ├── pages/         ← Dashboard.jsx, Tests.jsx, History.jsx
        ├── components/    ← MetricCard, CallChart, AlertPanel,
        │                     TrunkStatus, TestControl, StatusBadge
        └── hooks/         ← useSocket.js, useMetrics.js
```

---

## Estado del proyecto

Ver [PROJECT_STATUS.md](PROJECT_STATUS.md) para un análisis detallado de funcionalidades implementadas, parciales y pendientes.

---

## Seguridad

- La clave SSH (`backend/keys/*_rsa`) está en `.gitignore` — nunca se sube al repo
- El archivo `.env` está en `.gitignore` — nunca se sube al repo
- Todos los parámetros de SIPp son validados y construidos en el backend antes de ejecutar
- Los endpoints REST actualmente no tienen autenticación — pendiente implementar JWT
