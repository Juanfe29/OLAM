# Requirements: OLAM 3CX Audit Platform

**Defined:** 2026-05-02
**Core Value:** El dashboard en vivo + historial SQLite ES la evidencia del assessment. Si todo lo demás falla, esto debe seguir vivo y accesible para que TI OLAM lo opere de forma autónoma post-handoff.

## v1 Requirements

Requirements para el milestone v1.0 (post-SC192-wait + handoff). Cada uno mapea a una fase del roadmap.

### Block (bloqueadores cortos — destapan tests reales)

- [ ] **BLOCK-01**: El backend valida que la extensión destino del SIPp test exista en el 3CX antes de invocar SIPp; si no existe, rechaza con error claro y testId nunca se crea
- [ ] **BLOCK-02**: El SIPp Manager calcula el resumen del test leyendo el `_statistics.csv` final que escribe SIPp, no parseando stderr en vivo; los snapshots dejan de venir vacíos
- [ ] **BLOCK-03**: El warning del LogReader "No log data for 2+ minutes" queda diagnosticado y o desaparece (causa real resuelta) o se distingue en código entre "sin tráfico real" vs "parser roto"

### Find (mitigación de hallazgos no-licencia)

- [ ] **FIND-01**: El 3CX queda en updates manuales — el panel de control 3CX muestra auto-updates desactivado, cierra hallazgo H-05
- [ ] **FIND-02**: El firewall upstream OLAM filtra entrada a `5060/UDP` por origen IP (allow-list de los SBC de Tigo); el resto del internet ya no puede tocar el puerto, mitiga H-07 hasta que se haga la migración SIP/TLS completa (que queda fuera de este milestone)
- [ ] **FIND-03**: Hay un `tcpdump` capturado del 3CX durante 1h en horario pico hacia/desde `172.17.179.166:5060`, correlacionado con timestamps de errores 408 visibles en `3CXGatewayService.log`, y un traceroute al SBC Tigo registrado — todo archivado en una carpeta de evidencia accesible para la mesa técnica con Tigo

### Test (batería SIPp)

- [ ] **TEST-01**: Smoke (1 call, 30s) corre clean contra el 3CX real, queda registrado en `/api/history` con `result: PASS` y snapshots no vacíos
- [ ] **TEST-02**: Light (10 calls, 60s) y medium-cap (30 calls, 60s) corren clean dentro del tier SC32; ambos quedan persistidos con métricas reales (PDD, ASR, conteo de errores)
- [ ] **TEST-03**: Soak-light (20 calls × 4h) corre completo sin que el backend crashee, sin que el parser pierda heartbeat, y sin que la cantidad de llamadas activas degrade
- [ ] **TEST-04**: Cuando llegue licencia trial SC192, peak (180 calls × 300s) corre en ventana de mantenimiento coordinada y queda persistido con resultado PASS o FAIL claro
- [ ] **TEST-05**: Stress (220 calls × 180s) y soak-full (125 calls × 14400s = 4h) corren post-peak, con captura SIP simultánea archivada por correlación temporal

### Metric (instrumentación faltante de la plataforma)

- [ ] **METRIC-01**: El KPI `pddToCarrier` muestra valores reales >0 en producción (no 0 hardcoded), calculados desde la correlación INVITE→18x/200 OK en `3CXGatewayService.log`, con percentiles p50/p95 expuestos vía API
- [ ] **METRIC-02**: Los KPIs `mos`, `jitter_p95`, `packetLoss` muestran valores reales desde RTCP del 3CX **o** quedan marcados explícitamente como `not_instrumented` en lugar de devolver `0` falso (plan B documentado en SUMMARY.md sección Gaps)
- [ ] **METRIC-03**: Los escenarios SIPp para >50 calls (peak/stress/soak) usan archivos XML versionados en `backend/sipp-scenarios/` en lugar del loop programático actual; cada XML pasa validación con `xml2js` antes de invocar SIPp
- [ ] **METRIC-04**: El KPI `channelsTotal` lee el número contractual de canales de Tigo desde `.env` o desde la 3CX API en lugar del hardcode `30` actual en `metricsCollector.js`

### Mon (self-monitoring del backend)

- [ ] **MON-01**: `GET /api/health` expone estado granular: `ssh.connected`, `ssh.lastReceivedAt`, `parser.matchRatePerMinute`, `tunnel.up`, `db.queryLatencyMs`, `mock.mode` — un monitor externo puede consultar y diagnosticar sin entrar al server
- [ ] **MON-02**: El watchdog del LogReader emite alerta interna persistente (no solo `console.warn`) cuando no hay líneas matcheadas por X minutos configurables; la alerta aparece en `AlertPanel` del dashboard hasta que vuelva la actividad
- [ ] **MON-03**: El backend está envuelto en NSSM como Windows Service en `.35`; si crashea, NSSM lo levanta con throttle de restart (no más de N reintentos por minuto) y registra el incidente
- [ ] **MON-04**: Los logs propios del backend (no los del 3CX) van a archivo vía `winston` con rotación diaria y retention de 7 días; `console.log` directo queda eliminado del código de producción

### Ops (operabilidad y handoff a TI OLAM)

- [ ] **OPS-01**: El directorio `C:\Users\lamda\OLAM\` en `.35` es un repo `.git` clonado desde el remote, con `git status` clean al cierre del milestone; `git pull` sirve como mecanismo oficial de update
- [ ] **OPS-02**: Existe un runbook escrito (markdown en `docs/RUNBOOK-OLAM.md` o equivalente) que cubre: arranque desde cero, qué hacer si SSH cae, cómo correr/detener un test, cómo interpretar las 7 reglas de anomalía, cómo revisar logs, cómo aplicar updates con `git pull`, escalación. El runbook está en español y orientado a TI OLAM (no a desarrolladores)
- [ ] **OPS-03**: TI OLAM hizo un dry-run del runbook con un operador siguiéndolo paso a paso, las dudas que surgieron están resueltas en el doc final, y queda firmado el handoff (correo o ticket interno OLAM) confirmando que asumen operación

## v2 Requirements

Reconocidos pero diferidos. No están en el roadmap de este milestone.

### Security / Trunk

- **SEC-V2-01**: Migración completa SIP/UDP `:5060` → SIP/TLS `:5061` en el 3CX, con coordinación end-to-end con Tigo (cierre definitivo de H-07; en v1 se mitiga por filtro de firewall únicamente)
- **SEC-V2-02**: Renovación automática de certificados (acme-client o equivalente) si la migración a TLS se hace con CAs públicas en lugar del certificado interno del 3CX

### Alerting / Integraciones externas

- **ALERT-V2-01**: Webhook Slack/Teams/email cuando salta una alerta de severidad `CRÍTICO` o `ALTO`; configurable por canal vía `.env`
- **ALERT-V2-02**: Integración con sistema de tickets de TI OLAM si tienen uno (Jira/ServiceNow/etc.) para crear ticket automático en alertas críticas

### Diagnóstico avanzado

- **DIAG-V2-01**: Captura SIP automática (`tcpdump`) durante todos los tests SIPp >medium-cap, con archivado en SQLite por testId
- **DIAG-V2-02**: Análisis automático de pcap para extraer métricas de calidad post-test sin intervención manual
- **DIAG-V2-03**: Integración con 3CX Call Quality Report API como fuente alternativa de MOS/jitter (si METRIC-02 termina marcado `not_instrumented` en v1)

### Test scenarios extendidos

- **SCEN-V2-01**: Escenarios SIPp avanzados (hold/resume, transfer, IVR DTMF, reattach) en `backend/sipp-scenarios/`
- **SCEN-V2-02**: Tests inbound (desde el carrier) — requiere coordinación con Tigo y configuración firewall adicional

### Calidad / Testing automatizado

- **QA-V2-01**: Suite Jest con fixtures de logs reales del 3CX cubriendo cada regex del parser; CI corre regression check ante cada commit
- **QA-V2-02**: Tests E2E del frontend con Playwright cubriendo los 3 flujos principales (Dashboard, Tests, History)
- **QA-V2-03**: Smoke test automático nightly contra mock mode para detectar drift del propio backend

### Soporte continuo post-handoff

- **SUPP-V2-01**: SLA y proceso documentado para fixes/upgrades por parte del equipo plataforma post-handoff (es engagement separado, no parte de este milestone)

## Out of Scope

Excluido explícitamente. Documentado para evitar scope creep.

| Feature | Razón |
|---|---|
| **RBAC / auth multi-usuario** | La plataforma vive en red interna OLAM (`172.18.164.0/24`) con superficie de ataque baja. Auth añade fricción operativa (gestión de usuarios, recuperación de contraseñas) sin reducir riesgo material en v1. Si TI OLAM lo pide post-handoff, va a v2. |
| **Informe ejecutivo PDF/PowerPoint del assessment** | El deliverable es la plataforma viva con historial consultable. El reporte ejecutivo lo redacta OLAM o un consultor adyacente con esos datos. Confirmado por el cliente como decisión clave en PROJECT.md. |
| **Exportación CSV/pcap como artefactos versionados** | Duplica la fuente de verdad. La dashboard + SQLite cumplen el rol de evidencia. Las capturas tcpdump puntuales para FIND-03 son herramienta de diagnóstico, no entregable. |
| **Generación de reporte automática a partir del historial** | Los datos están accesibles vía REST API + SQLite directo; quien necesite reporte lo arma desde ahí. Implementarlo dentro de la plataforma es scope creep hacia "producto comercial" que no se contrató. |
| **Tests programados (cron/scheduler)** | Riesgo alto de correr SIPp en horario operativo sin supervisión. Los tests requieren juicio humano (ventana, ext válida, contexto Tigo); programación automática los hace peligrosos. Anti-feature explícito en FEATURES.md. |
| **Failover / disaster recovery / HA del backend** | Single 3CX, single host de plataforma `.35`. HA exige reescribir arquitectura entera. Out of scope total. |
| **Grabación de llamadas / playback** | El 3CX hace eso nativo; la plataforma es diagnóstico, no contact center. Anti-feature. |
| **Mobile app / responsive móvil** | El operador usa la dashboard desde escritorio en `.35` o desde laptop dev. Móvil no aporta y multiplica testing. |
| **Migración SIP/UDP → SIP/TLS** | Diferido a v2 (`SEC-V2-01`). En v1 la mitigación de H-07 es filtro de firewall — más rápido de aplicar y cierra el vector de toll fraud externo sin coordinar con Tigo. |
| **Auth para el `/api/tests/run`** | Mismo razonamiento que RBAC. La red interna y el lock de prueba única son las protecciones de v1. |
| **OAuth / SSO para acceder al dashboard** | No hay caso de uso multi-usuario en v1. Anti-feature. |
| **Soporte continuo post-handoff** | Engagement separado. El milestone termina con OPS-03 firmado; mejoras o fixes posteriores son scope nuevo. |

## Traceability

A llenar por el roadmapper en el siguiente paso.

| Requirement | Phase | Status |
|---|---|---|
| BLOCK-01 | TBD | Pending |
| BLOCK-02 | TBD | Pending |
| BLOCK-03 | TBD | Pending |
| FIND-01 | TBD | Pending |
| FIND-02 | TBD | Pending |
| FIND-03 | TBD | Pending |
| TEST-01 | TBD | Pending |
| TEST-02 | TBD | Pending |
| TEST-03 | TBD | Pending |
| TEST-04 | TBD | Blocked (licencia SC192) |
| TEST-05 | TBD | Blocked (licencia SC192) |
| METRIC-01 | TBD | Pending |
| METRIC-02 | TBD | Pending |
| METRIC-03 | TBD | Pending |
| METRIC-04 | TBD | Pending |
| MON-01 | TBD | Pending |
| MON-02 | TBD | Pending |
| MON-03 | TBD | Pending |
| MON-04 | TBD | Pending |
| OPS-01 | TBD | Pending |
| OPS-02 | TBD | Pending |
| OPS-03 | TBD | Pending |

**Coverage:**
- v1 requirements: 22 total
- Mapped to phases: 0 (pending roadmap creation)
- Unmapped: 22 ⚠️ (resolved when roadmap is created)

---
*Requirements defined: 2026-05-02*
*Last updated: 2026-05-02 after initial definition*
