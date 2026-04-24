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
