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
# Backend (puerto 3001, arranca con MOCK_MODE=true por defecto)
cd backend
cp .env.example .env
npm install
npm run dev        # nodemon src/server.js

# Frontend (puerto 5173)
cd frontend
npm install
npm run dev        # vite
npm run build      # vite build (producción)
```

Para conectar al 3CX real: poner `MOCK_MODE=false` en `.env`, agregar la clave SSH en `backend/keys/3cx_rsa`, reiniciar backend.

---

## Stack

**Backend:** Node.js 20 LTS, Express 4, Socket.io 4, node-ssh 13, sqlite3 5, node-cron 3, axios, fast-csv 5, chokidar 5

**Frontend:** React 18, React Router 6, Vite, Tailwind CSS 3, Recharts 2, Socket.io-client 4

**En el servidor 3CX (instalado por separado):** node_exporter, sngrep, SIPp v3.7.7, tcpdump

---

## Arquitectura

```
Frontend (5173) ──WebSocket + REST──► Backend (3001)
                                          ├── sshClient.js           → conexión SSH persistente, backoff exponencial
                                          ├── logReader.js           → tail -Fq sobre 5 logs, watchdog de staleness
                                          ├── logParser.js           → parsea líneas de log a métricas
                                          ├── sippManager.js         → orquesta pruebas individuales y battery tests
                                          ├── sippStatisticsReader.js→ lee _statistics.csv de SIPp en tiempo real
                                          ├── metricsCollector.js    → node_exporter (Prometheus) + estado de logs
                                          ├── anomalyDetector.js     → evalúa reglas, cooldown 5 min por regla
                                          ├── destinationValidator.js→ allowlist de extensiones válidas (BLOCK-01)
                                          ├── healthChecker.js       → salud de SSH/logs/exporter/SIPp cada 30s
                                          └── SQLite                 → tests + metrics_snapshots
```

---

## Reglas de implementación

**SSH persistente, no polling.** Una sola conexión SSH con `execStream` + `tail -Fq`. Si cae, reconectar con backoff exponencial (base 2s, máx 30s).

**SIPp corre en el backend, no en el 3CX.** Correr SIPp en el 3CX invalida todas las métricas.

**Modo mock completo.** Con `MOCK_MODE=true`, el backend simula todos los datos sin SSH. Distribuciones probabilísticas realistas, no valores fijos.

**Solo una prueba a la vez.** Lock en sippManager. Si hay una prueba corriendo, rechaza iniciar otra con error claro.

**Límites duros en backend.** Máx 256 llamadas, máx 20 llamadas/seg de rampa, máx 8 horas. Rechaza antes de ejecutar SIPp.

**Sanitización total de inputs.** Nada del frontend llega directo a un comando de shell. Parámetros de SIPp construidos en backend con valores validados.

**BLOCK-01 — Validación de destino.** Antes de lanzar SIPp, `destinationValidator.js` verifica que la extensión esté en el allowlist de `VALID_EXTENSIONS`. Falla cerrado: si la variable está vacía en producción, el destino debe ser dígitos válidos.

**BLOCK-02 — CSV como fuente de verdad.** El resultado de una prueba se determina desde `_statistics.csv` de SIPp (leído por `sippStatisticsReader.js`). Sólo si el CSV no existe se cae al parseo de stderr. Nunca invertir esta prioridad.

**BLOCK-03 — Watchdog del parser.** Si el parser de logs no extrae datos en 2 minutos, se levanta una alerta de parser roto (el formato puede cambiar con updates de 3CX).

**Audit log.** Cada prueba se guarda en SQLite: IP del iniciador, parámetros, duración, resultado y snapshot de métricas.

**SQLite para persistencia, memoria para tiempo real.** No guardar en SQLite cada evento WebSocket — guardar en memoria durante la prueba y persistir el resumen al finalizar.

---

## REST API

```
GET  /api/status                → métricas en vivo (shape: {host, calls, quality, trunk, queue})
GET  /api/status/trunk          → estado troncal Tigo UNE
GET  /api/status/host           → CPU / RAM / disco / red (node_exporter)
GET  /api/health                → estado SSH, DB, SIPp, modo

POST /api/tests/run             → iniciar prueba individual SIPp
POST /api/tests/stop            → detener prueba individual
GET  /api/tests/status          → estado de la prueba actual
GET  /api/tests/scenarios       → lista de escenarios predefinidos
GET  /api/tests/destinations    → extensiones válidas (de VALID_EXTENSIONS)

POST /api/tests/run-battery     → iniciar battery test (5 niveles secuenciales)
POST /api/tests/stop-battery    → abortar battery test
GET  /api/tests/battery-status  → progreso del battery test en curso

GET  /api/history               → historial de pruebas (paginado, default 50, máx 200)
GET  /api/history/:id           → detalle de una prueba con snapshots
```

## WebSocket events

```
metrics:update    → métricas en tiempo real (broadcast cada 2-5s)
alert:new         → nueva anomalía detectada
alerts:current    → alertas activas al conectarse (emisión inicial)
test:progress     → progreso de prueba individual (elapsed, activeCalls, errorRate)
test:complete     → prueba finalizada + resumen
battery:progress  → progreso del nivel actual de battery test
battery:complete  → battery test finalizado + reporte de todos los niveles
trunk:status      → cambio de estado de troncal
```

---

## Base de datos (SQLite, WAL mode)

```sql
-- Pruebas individuales y sus resultados
tests (
  id INTEGER PRIMARY KEY,
  initiated_by TEXT,          -- IP del cliente
  scenario TEXT,
  max_calls INTEGER,
  duration INTEGER,           -- segundos
  ramp_rate INTEGER,
  destination TEXT,
  started_at TEXT,
  ended_at TEXT,
  result TEXT,                -- PASS | FAIL | ERROR | STOPPED
  summary TEXT                -- JSON: {avgCalls, maxCalls, avgErrorRate, peakReached, passed, failReason, sipErrors, source}
)

-- Snapshots de métricas durante una prueba
metrics_snapshots (
  id INTEGER PRIMARY KEY,
  test_id INTEGER REFERENCES tests(id),
  timestamp TEXT,
  data TEXT                   -- JSON con shape completo de métricas
)
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

**Tier de licencia** configurado en `LICENSE_TIER` (default 256). El porcentaje de uso se calcula contra este valor.

**Métricas de troncal Tigo UNE:** registro (OPTIONS ping), canales en uso vs `TRUNK_CHANNELS_TOTAL` (default 256), ASR por troncal, PDD al carrier, errores 408/503 por hora.

**Métricas del host (node_exporter):** CPU por núcleo, RAM (total/usada/swap), disco, red (bytes/errores/drops por interfaz), load average 1/5/15.

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
  max:    { calls: 256, duration: 120,   ramp: 20, name: 'Max load'    },
}
```

**Battery test** — secuencia fija de 5 niveles: light → medium → peak → stress → max, todos con duración de 89s. El único parámetro configurable es el destino. Si un nivel termina con ERROR (no FAIL), el battery test se aborta.

**Criterio de PASS:** pico alcanzado ≥ 90% de `max_calls` Y tasa de error promedio < 5%.

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

Cooldown de 5 minutos por regla para evitar spam. Los hallazgos de Fase 0 (H-01, H-03, H-05, H-07) son permanentes y se emiten siempre desde el arranque.

---

## Hallazgos activos (Fase 0)

Mostrar como alertas en el dashboard desde el primer arranque, sin importar si hay SSH activo:

- **CRÍTICO — H-01:** Licencia SC32 insuficiente (objetivo SC192). Cualquier prueba por encima de 32 concurrentes va a ser rechazada hasta el upgrade.
- **CRÍTICO — H-07:** SIP sin TLS en IP pública 181.63.161.242. Riesgo de toll fraud y escucha pasiva.
- **ALTO — H-03:** Errores 408 en troncal Tigo UNE (sip:172.17.179.166:5060). Ya hay problemas con 32 canales; a 180 se amplifica.
- **ALTO — H-05:** Auto-updates habilitado. Riesgo de reinicio en horario productivo y rotura del parser de logs.

---

## Dashboard — pantallas

**Dashboard** — métricas en vivo: 10 KPIs con valor/color/tendencia, gráfica últimos 30 min (180 puntos @ 5s), estado troncal, panel de alertas, indicador SSH.

**Tests** — dos modos: prueba individual (sliders + presets + selector de destino) y battery test (5 niveles, solo configurar destino). Progreso en tiempo real con gráfica de llamadas/error rate (máx 600 puntos).

**History** — tabla paginada de pruebas pasadas. Detalle completo al hacer clic. Exportar prueba individual como JSON.

---

## Variables de entorno

```env
# SSH al 3CX
SSH_HOST=172.18.164.28
SSH_PORT=22
SSH_USER=root
SSH_KEY_PATH=./keys/3cx_rsa
# SSH_PASSWORD=               # alternativa a key file

LOGS_PATH=/var/lib/3cxpbx/Instance1/Data/Logs
NODE_EXPORTER_URL=http://172.18.164.28:9100/metrics
NODE_EXPORTER_VIA_SSH=false   # true = túnel SSH si :9100 está bloqueado

PORT=3001
NODE_ENV=development
MOCK_MODE=true

DB_PATH=./data/olam.db

# Capacidad (afecta umbrales y alertas)
LICENSE_TIER=256
TRUNK_CHANNELS_TOTAL=256

# SIPp
SIPP_BIN=                     # ruta al binario (override para Windows/Cygwin)
CYGWIN_BIN_PATH=              # dir bin de Cygwin para DLLs en Windows
VALID_EXTENSIONS=             # extensiones permitidas, comma-separated (vacío = dev mode)
SIPP_AUTH_USER=               # usuario para autenticación digest (407)
SIPP_AUTH_PASS=               # contraseña para autenticación digest
SIPP_CALLER_ID=               # CallerID para escenarios IP trunk
SIPP_UAS_ENABLED=false        # habilitar segunda instancia SIPp como UAS (B2BUA)
SIPP_UAS_PORT=5070

SLACK_WEBHOOK_URL=
JWT_SECRET=cambiar_en_produccion
```

---

## Notas de plataforma

**Windows / Cygwin:** Si el backend corre en Windows, SIPp requiere Cygwin. Configurar `SIPP_BIN` con la ruta al ejecutable y `CYGWIN_BIN_PATH` para que sippManager encuentre las DLLs necesarias.

**SSH key auth vs password:** Si `SSH_KEY_PATH` apunta a un archivo existente se usa autenticación por clave. Si no, se usa `SSH_PASSWORD`. La clave privada va en `backend/keys/` (excluido de git por `.gitignore`).

**SIPp UAS mode:** Cuando `SIPP_UAS_ENABLED=true`, sippManager lanza una segunda instancia de SIPp escuchando en `SIPP_UAS_PORT` como receptor (B2BUA). Útil para pruebas de carga realistas donde el 3CX necesita un destino real que responda.
