# OLAM 3CX Audit Platform — Estado del Proyecto

> Última revisión: 2026-04-23
> Revisado por: Claude Code (análisis automático de codebase)

---

## Contexto

Plataforma web que audita en tiempo real un servidor 3CX v20 corriendo en producción para OLAM Inversiones. Opera en dos modos:

- **Modo pasivo:** Se conecta al 3CX por SSH, parsea logs en tiempo real, detecta anomalías y las muestra en un dashboard.
- **Modo activo:** Ejecuta SIPp para generar carga sintética controlada y mide cómo responde el sistema.

**Servidor auditado:** `172.18.164.28` — 3CX v20 Update 8 Build 1121, licencia SC32, troncal SIP Tigo UNE.

---

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js 20, Express, Socket.io, node-ssh, better-sqlite3 |
| Frontend | React 18, Vite, Tailwind CSS, Recharts, Socket.io-client |
| Persistencia | SQLite (historial de pruebas + snapshots) |
| Métricas host | Prometheus node_exporter en el servidor 3CX |
| Pruebas de carga | SIPp v3.7.7 en el host del backend |

---

## Cómo correr el proyecto

```bash
# Backend (puerto 3000)
cd backend
cp .env.example .env    # ajustar variables si es necesario
npm install
npm run dev

# Frontend (puerto 5173)
cd frontend
npm install
npm run dev
```

**Por defecto corre en modo mock** (`MOCK_MODE=true`). Para conectar al 3CX real ver sección de configuración más abajo.

---

## Estado actual de funcionalidades

### Completamente implementado ✅

#### Backend

| Módulo | Archivo | Descripción |
|---|---|---|
| SSH persistente | `src/services/sshClient.js` | Conexión SSH con reconexión exponencial (2s → 30s). Stream-based, no polling. |
| Lector de logs | `src/services/logReader.js` | `tail -Fq` sobre los 5 logs del 3CX. Watchdog: alerta si no hay datos en 2 min. |
| Parser de logs | `src/services/logParser.js` | Regex por tipo de log: CallFlow, GatewayService, QueueManager, SystemService, IVR. |
| Mock mode | `src/services/metricsCollector.js` | Simulación probabilística completa. Distribuciones realistas, bursts de errores, jitter. |
| Recolector de métricas | `src/services/metricsCollector.js` | Dual-path: Prometheus node_exporter (real) o mock. CPU, RAM, disco, red, llamadas, MOS. |
| Detector de anomalías | `src/services/anomalyDetector.js` | 4 alertas permanentes (Fase 0) + 8 reglas dinámicas con cooldown de 5 min. |
| SIPp Manager | `src/services/sippManager.js` | Lock de prueba única, 6 escenarios predefinidos, límites duros, persistencia en DB. |
| API REST | `src/routes/` | Todos los endpoints del spec: `/api/status`, `/api/tests/*`, `/api/history`, `/api/health`. |
| WebSocket events | `src/server.js` | `metrics:update`, `alert:new`, `test:progress`, `test:complete`, `trunk:status`. |
| Base de datos | `src/db/` | SQLite con WAL. Tablas: `tests` + `metrics_snapshots`. Queries con prepared statements. |

#### Frontend

| Pantalla / Componente | Archivo | Descripción |
|---|---|---|
| Dashboard | `src/pages/Dashboard.jsx` | 10 KPIs con color, gráfica 30 min, estado troncal, panel de alertas, indicador SSH. |
| Tests | `src/pages/Tests.jsx` | Presets + sliders, progreso en tiempo real, gráfica live de métricas durante la prueba. |
| Historial | `src/pages/History.jsx` | Tabla paginada, modal de detalle, exportar JSON. |
| MetricCard | `src/components/MetricCard.jsx` | KPI con umbral ok/warn, color dinámico. |
| CallChart | `src/components/CallChart.jsx` | LineChart Recharts, referencia en el tier (32), 30-min rolling. |
| AlertPanel | `src/components/AlertPanel.jsx` | Alertas ordenadas por severidad (CRÍTICO → BAJO). |
| TrunkStatus | `src/components/TrunkStatus.jsx` | Registro Tigo UNE, % canales, conteo 408/503. |
| TestControl | `src/components/TestControl.jsx` | Sliders, presets, advertencia de licencia SC32, start/stop. |
| useSocket | `src/hooks/useSocket.js` | Singleton WebSocket con reference counting y reconexión. |
| useMetrics | `src/hooks/useMetrics.js` | Historial rolling (360 snapshots = 30 min), dedup de alertas. |

---

### Parcialmente implementado ⚠️

| Funcionalidad | Problema | Impacto |
|---|---|---|
| **Parseo de stats SIPp** | Solo captura conteo total de llamadas con un regex básico. Sin PDD, ASR, MOS reales del output de SIPp. | Las métricas de calidad en pruebas activas son mock aunque SIPp esté corriendo real. |
| **Manejo de node_exporter caído** | Si node_exporter no responde, todas las métricas del host retornan 0 en silencio, sin error visible. | El equipo no puede distinguir entre "servidor con 0% CPU" y "servidor no responde". |
| **Métricas de disco de grabaciones** | El campo de disco de grabaciones en metricsCollector nunca se popula. Siempre retorna 0. | Partición crítica nunca monitoreada. |
| **Resolución de alertas** | Alertas se eliminan inmediatamente cuando la condición se limpia. Sin estado "resuelto". | No hay historial de cuándo se resolvió un problema. |
| **Sanitización del destino SIPp** | El campo `destination` (extensión o cola) se pasa al comando SIPp sin escapar metacaracteres de shell. | Riesgo teórico de inyección de comandos desde el frontend. |

---

### No implementado ❌

| Funcionalidad | Especificado en CLAUDE.md | Notas |
|---|---|---|
| **3CX Call Control API** | Sí | El conteo de llamadas activas viene solo de logs. La API del 3CX es la fuente de verdad y debería validar el estado real. Sin esto, bajo carga alta los logs pueden laggar. |
| **Slack webhook** | Sí | `SLACK_WEBHOOK_URL` declarado en `.env.example` pero nunca leído ni usado. |
| **Autenticación JWT** | Sí | `JWT_SECRET` declarado, todos los endpoints son públicos. |
| **Exportar historial a PDF** | Sí | Solo exporta JSON. |
| **Filtros en historial** | Sí | Solo paginación. Sin filtro por fecha, escenario o resultado. |
| **Tareas programadas (node-cron)** | Implícito | Paquete instalado pero nunca usado. Chequeos periódicos de salud de troncal, etc. |
| **Notificaciones de browser** | No | Alertas solo en UI. Sin Web Notifications API ni sonidos. |
| **Docker** | No | Sin Dockerfile ni docker-compose. |
| **Logging estructurado** | No | Sin Winston/Pino. Logs a stdout con `console.log`. |

---

## Para conectar al 3CX real

Estos son los pasos concretos en orden:

### 1. Colocar la clave SSH

```bash
# Copiar la clave privada al directorio de keys
cp /ruta/a/tu/clave backend/keys/3cx_rsa

# Restringir permisos (obligatorio para SSH)
chmod 600 backend/keys/3cx_rsa
```

### 2. Activar modo real en `.env`

```env
MOCK_MODE=false
SSH_HOST=172.18.164.28
SSH_PORT=22
SSH_USER=root
SSH_KEY_PATH=./keys/3cx_rsa
NODE_EXPORTER_URL=http://172.18.164.28:9100/metrics
```

### 3. Verificar node_exporter en el servidor 3CX

```bash
# Desde el backend o cualquier máquina con acceso:
curl http://172.18.164.28:9100/metrics | head -20
```

Si no responde, las métricas de CPU, RAM, disco y red retornarán 0 en silencio. node_exporter debe estar corriendo como servicio en el servidor 3CX.

### 4. Reiniciar el backend

```bash
cd backend && npm run dev
```

El indicador SSH en el Dashboard debe ponerse verde. Si queda rojo, revisar logs del backend: la causa más común es permisos de la clave o IP/puerto incorrectos.

---

## Alertas Fase 0 (siempre activas)

Estas 4 alertas están hardcodeadas y se muestran desde el primer arranque, independientemente de si hay conexión SSH:

| ID | Severidad | Descripción |
|---|---|---|
| H-01 | CRÍTICO | Licencia SC32 insuficiente — objetivo SC192. Pruebas por encima de 32 concurrentes serán rechazadas. |
| H-07 | CRÍTICO | SIP sin TLS en IP pública `181.63.161.242`. Riesgo de toll fraud y escucha pasiva. |
| H-03 | ALTO | Errores 408 en troncal Tigo UNE (`sip:172.17.179.166:5060`). Ya falla con 32 canales. |
| H-05 | ALTO | Auto-updates habilitado en 3CX. Riesgo de reinicio en horario productivo. |

---

## KPIs y umbrales

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
| Service Level | ≥ 80/20 | 70–80% | < 70% |
| Abandonment rate | < 5% | 5–10% | > 10% |

---

## Escenarios SIPp predefinidos

| Escenario | Llamadas | Duración | Rampa | Uso |
|---|---|---|---|---|
| `smoke` | 1 | 30s | 1/s | Verificar conectividad básica |
| `light` | 10 | 60s | 2/s | Carga mínima |
| `medium` | 50 | 120s | 5/s | Carga moderada |
| `peak` | 180 | 300s | 10/s | Pico objetivo |
| `stress` | 220 | 180s | 15/s | Más allá del límite |
| `soak` | 125 | 4h | 5/s | Estabilidad sostenida |

> **Nota:** Con licencia SC32 actual, cualquier prueba por encima de 32 llamadas simultáneas será rechazada por el 3CX. Los escenarios `medium`, `peak`, `stress` y `soak` solo serán útiles tras el upgrade de licencia.

---

## Estructura de directorios

```
olam-audit/
├── backend/
│   ├── .env                     ← config activa (no commitear con secrets)
│   ├── .env.example             ← plantilla
│   ├── keys/
│   │   └── 3cx_rsa              ← clave SSH (NO commitear)
│   ├── data/
│   │   └── olam.db              ← SQLite (generado automáticamente)
│   └── src/
│       ├── server.js
│       ├── routes/              ← status.js, tests.js, history.js
│       ├── services/            ← sshClient, logReader, logParser, sippManager,
│       │                           metricsCollector, anomalyDetector
│       └── db/                  ← schema.js, queries.js
└── frontend/
    └── src/
        ├── pages/               ← Dashboard.jsx, Tests.jsx, History.jsx
        ├── components/          ← MetricCard, CallChart, AlertPanel,
        │                           TrunkStatus, TestControl, StatusBadge
        └── hooks/               ← useSocket.js, useMetrics.js
```

---

## Prioridades de desarrollo recomendadas

### Bloqueante para producción real
1. **Colocar clave SSH + desactivar mock** — sin esto no hay datos reales
2. **Verificar node_exporter** en el servidor 3CX y hacer visible el error cuando cae
3. **Sanitizar el campo `destination`** antes de pasarlo al comando SIPp

### Alta prioridad
4. **Implementar 3CX Call Control API** — validación de llamadas activas más confiable que logs
5. **Mejorar parseo de output real de SIPp** — capturar PDD, ASR, MOS del proceso
6. **Implementar Slack webhooks** — alertas fuera del dashboard

### Media prioridad
7. **JWT en endpoints REST** — actualmente todos los endpoints son públicos
8. **Estado "resuelto" para alertas** — mejor trazabilidad
9. **Exportar a PDF** — requerido para reportes de assessment
10. **Filtros en historial** — buscar por fecha, escenario, resultado
