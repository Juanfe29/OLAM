# Project Research Summary

**Project:** OLAM 3CX Audit Platform — extension milestone (post-SC192-wait + handoff)
**Domain:** PBX assessment platform extension on Node.js + Win10/Cygwin host
**Researched:** 2026-05-02
**Confidence:** HIGH (stack, features, architecture) — MEDIUM (pitfall mitigation, RTCP feasibility)

## Executive Summary

La plataforma OLAM ya tiene la capa pasiva (always-on monitoring vía SSH al 3CX) probada y operativa. Este milestone es de **consolidación y endurecimiento**: cerrar bloqueadores que tapan los tests reales (OLAM-01/02/03), mitigar los hallazgos del 3CX que no requieren licencia (H-05/H-07/H-03), correr la batería de tests SC32, instrumentar las métricas faltantes (PDD/MOS), agregar self-monitoring del propio backend, y dejar el sistema operable por TI OLAM con runbook + repo `.git`.

El research confirma que **todas las extensiones son aditivas y no destructivas** — el path crítico de always-on (SSH stream → parser → WebSocket) no se toca. Stack adiciones (NSSM para Windows Service, winston con rotación, chokidar+fast-csv para parsear el `_statistics.csv` de SIPp, xml2js para validar scenarios) son maduras y compatibles con Win10 sin admin.

Riesgo principal: **drift de formato de logs del 3CX** si auto-updates corre durante el milestone (Pitfall #3) — mitigado en Fase 1 desactivando auto-updates (OLAM-04). Riesgo secundario: **libpcap/RTCP en Cygwin** puede ser inviable, plan de fallback es marcar MOS/jitter como `not_instrumented` en lugar de retornar `0` falso (Pitfall #7).

## Key Findings

### Recommended Stack

Las adiciones son todas librerías Node maduras + un binario portable (NSSM). Ninguna requiere admin ni cambia el stack core. Detalle completo en [STACK.md](./STACK.md).

**Core technologies:**
- **NSSM v2.24+**: wrapper de Windows Service para auto-restart on crash — funciona sin admin (instalación per-user), única opción viable en `.35` dado que `node-windows`/`pm2` requieren admin o tienen Windows port roto
- **winston v3.13 + winston-daily-rotate-file v5**: logging estructurado con rotación diaria 7-day retention — soluciona OLAM-19 y previene crash loop por disk fill
- **chokidar v3.6 + fast-csv v5**: file watcher robusto en Windows+Cygwin + parser CSV streaming — soluciona OLAM-02 (smoke FAIL por parsear stderr en lugar del `_statistics.csv` final de SIPp)

**Secondary:** xml2js (validar SIPp scenarios antes de invocar — OLAM-14), 2da conexión node-ssh (separar log streaming de comandos ad-hoc — patrón de ARCHITECTURE.md), better-sqlite3 (reusar para tablas `health_events` / `pdd_events` / `rtcp_samples`).

**Anti-stack (NO usar):** `node-windows` (requiere admin), `pm2` en Windows (port roto), `forever` (abandonado 2018), `node-pcap` (compilación nativa contra libpcap, inviable en `.35`).

### Expected Features

Detalle completo en [FEATURES.md](./FEATURES.md).

**Must have (table stakes para este milestone):**
- **OLAM-02** smoke test fix — leer `_statistics.csv` final, no parsear stderr en vivo
- **OLAM-01** validación de extensión destino — rechazar antes de invocar SIPp si la ext no existe
- **OLAM-04** desactivar auto-updates 3CX — previene drift silencioso del parser
- **OLAM-16** `/api/health` expandido — SSH age, parser state, túnel, DB, último log recibido
- **OLAM-21** runbook operativo — startup, tests, troubleshooting, restart, contactos

**Should have (diferenciadores):**
- **OLAM-12** PDD al carrier desde logs (correlación INVITE→18x/200 OK en `3CXGatewayService.log`)
- **OLAM-13** MOS/jitter/packet loss desde RTCP (riesgo: libpcap en Cygwin) — plan B: stub marcado `not_instrumented`
- **OLAM-14** scenarios XML SIPp custom — necesario solo cuando arranquen tests >50 calls

**Anti-features (Out of Scope confirmado):**
- RBAC/auth multi-usuario (red interna baja superficie)
- Alertas externas Slack/email/PagerDuty
- Generación de reporte ejecutivo PDF/PPT (lo redacta OLAM)
- Tests programados/scheduled

### Architecture Approach

La arquitectura existente (service-event-driven: SSH → LogReader → LogParser → MetricsCollector → AnomalyDetector → WebSocket bus + SQLite) se **extiende, no se duplica**. Detalle completo en [ARCHITECTURE.md](./ARCHITECTURE.md).

**Major components (extensiones aditivas):**
1. **2nd SSH connection** — para metric polling y comandos ad-hoc (`tcpdump`, `sngrep`); el primary se mantiene exclusivo para `tail -F` log streaming. Hard rule: nunca multiplexar.
2. **pddCalculator (servicio nuevo)** — agrega eventos PDD parseados por `logParser` en sliding window p50/p95/max
3. **rtcpCollector + rtcpMetricsExtractor (servicios nuevos)** — Fase 1: stub que devuelve `not_instrumented`; Fase 2 si feasible: capture pcap vía SSH al 3CX, parse RTCP offline
4. **healthWatchdog (servicio nuevo)** — auto-monitor del backend (SSH age, log freshness, parser regex match rate, DB latency); alimenta `/api/health` y `anomalyDetector`
5. **Extensiones a servicios existentes** — `logParser` agrega regex para INVITE→200 OK; `metricsCollector` polea los nuevos servicios; `anomalyDetector` agrega reglas de salud propia
6. **`backend/sipp-scenarios/` directorio versionado** — XMLs de smoke/light/medium/peak/stress/soak en lugar de generación programática

**Patrón clave:** todo servicio nuevo es **passive observer con graceful fallback** (devuelve null/0 en error). Si el `pddCalculator` rompe, el resto de KPIs siguen vivos.

### Critical Pitfalls

Top 5 con phase mapping. Detalle completo en [PITFALLS.md](./PITFALLS.md).

1. **SIPp test durante horario operativo** — corrupciones de tráfico real OLAM. Mitigación: ramp limit ≤2 calls/s default, modal de confirmación pre-launch, ventanas de mantenimiento documentadas en runbook (OLAM-21). Mapping: política operativa, no código.

2. **SIPp se cuelga con destino inválido** — test consume hasta el timeout completo sin responder. Mitigación: validar destino antes de invocar (OLAM-01), leer `_statistics.csv` no stderr (OLAM-02), watchdog del proceso SIPp con kill timeout. Mapping: **Fase 1, bloqueador**.

3. **Drift de formato de logs del 3CX tras auto-update** — el parser sigue corriendo pero ya no matchea, métricas en cero sin error visible. Mitigación: desactivar auto-updates inmediato (OLAM-04), watchdog del parser ya existe (OLAM-17 lo refina con conteo de matches por archivo), test fixtures con regression check. Mapping: **Fase 1 (OLAM-04) + Fase 3 (watchdog robusto)**.

4. **Crash loop del backend en Windows** — auto-restart agresivo + falla persistente al boot = el watchdog reinicia infinitamente y rota disk fill. Mitigación: log rotation primero (OLAM-19), health checks at boot, NSSM con throttle de restart, primero deploy sin auto-restart hasta que probemos estabilidad. Mapping: **Fase 3 (rotación, health) + Fase 5 (auto-restart con throttle)**.

5. **Misdiagnóstico de errores 408 Tigo** — el 408 aparece en log del 3CX pero el origen está aguas arriba. Mitigación: protocolo diagnóstico con `tcpdump` 1h en horario pico + traceroute al SBC + correlación de timestamps (OLAM-06), no concluir sin pcap. Mapping: **Fase 2**.

**Pitfalls moderados:** SSH silent disconnect (keepalives + auto-reconnect — ya tiene reconexión, falta keepalive explícito), PDD/MOS hardcoded a 0 confunde dashboard (marcar como `not_instrumented` mientras Fase 4 — OLAM-38), `destination` no sanitizado en SIPp Manager (heredado, OLAM-01).

## Implications for Roadmap

### Suggested phase structure (granularidad fine, secuencial)

Per `config.json` (granularity: fine, parallelization: false), 6 fases secuenciales con sub-fases por requirement:

### Fase 1: Unblock real tests (OLAM-01, 02, 03, 04)
**Rationale:** sin esto el smoke test sigue fallando y todos los demás tests están bloqueados. Es el mínimo entregable.
**Delivers:** primer smoke test exitoso registrado en SQLite, auto-updates 3CX desactivados, parser warning diagnosticado.
**Avoids:** Pitfall #2 (SIPp se cuelga), Pitfall #3 (log drift por auto-update sorpresa).

### Fase 2: Mitigación hallazgos no-licencia (OLAM-04 cierre, OLAM-05, 06, 07, 08)
**Rationale:** una vez tests funcionando, validar tier SC32 con tráfico real + diagnosticar H-03 con evidencia técnica antes de meterse a peak/stress.
**Delivers:** light/medium-cap/soak-light corridos y persistidos, captura SIP del H-03, firewall filter para H-07.
**Uses:** `tcpdump` vía SSH al 3CX, batería SIPp existente.
**Avoids:** Pitfall #5 (misdiagnóstico Tigo), Pitfall #1 (load test descontrolado).

### Fase 3: Self-monitoring de la plataforma (OLAM-16, 17, 19)
**Rationale:** antes de instrumentación nueva (PDD/RTCP que añaden complejidad), endurecer lo existente. Fase 3 es low-risk porque trabaja sobre código local del backend, no sobre el 3CX.
**Delivers:** `/api/health` granular, watchdog del parser activo con alertas, logs propios con rotación.
**Uses:** winston + winston-daily-rotate-file, 2nd SSH connection.
**Implements:** healthWatchdog service nuevo, extensión de anomalyDetector.
**Avoids:** Pitfall #4 (crash loop por disk fill).

### Fase 4: Instrumentación faltante (OLAM-12, 13, 14, 15)
**Rationale:** ya con la plataforma robusta, agregar las métricas que hoy mienten (PDD=0, MOS=0). Fase 4 es la más arriesgada técnicamente — RTCP en Cygwin es incierto.
**Delivers:** PDD real medido desde logs, MOS/jitter desde RTCP **o** marcado explícito como `not_instrumented` con plan B, scenarios SIPp XML versionados.
**Uses:** xml2js, parser regex en logParser, opcional libpcap (con fallback).
**Implements:** pddCalculator + rtcpCollector + rtcpMetricsExtractor services.
**Research flag:** ALTO — RTCP en Cygwin necesita validación técnica, plan B documentado.

### Fase 5: Operabilidad y handoff (OLAM-18, 20, 21, 22)
**Rationale:** la plataforma ya está completa funcionalmente; ahora se prepara para que TI OLAM la opere. Auto-restart va acá (no antes) porque depende de Fase 3 (logs) + Fase 4 (todos los servicios estables) para no entrar en crash loop.
**Delivers:** repo `.35` convertido a `.git` clone del remote, runbook operativo escrito + dry-run con TI OLAM, NSSM Windows Service configurado.
**Uses:** NSSM 2.24, git CLI.
**Avoids:** Pitfall #4 — auto-restart se activa **después** de validar estabilidad, no antes.

### Fase 6: Tests SC192 cuando llegue licencia (OLAM-09, 10, 11)
**Rationale:** bloqueado externamente por arrival de trial SC192. No depende de fases anteriores funcionalmente, pero opera mejor con la plataforma ya endurecida (Fases 3-5 completas) para tener self-monitoring activo durante peak/stress.
**Delivers:** peak (180 calls), stress (220), soak (4h a 125), capturas SIP correlacionadas, evidencia clara de viability SC192.
**Uses:** scenarios XML de Fase 4, modal de pre-flight + ramp limit (Pitfall #1).

### Phase Ordering Rationale

- **1 → 2:** sin tests funcionando no hay datos reales para diagnosticar H-03
- **2 → 3:** validar estabilidad SC32 antes de añadir capas nuevas; si la plataforma actual tiene un bug bajo carga, mejor descubrirlo con servicios simples
- **3 → 4:** self-monitoring activo cuando arranque la instrumentación nueva — si `pddCalculator` rompe el flujo, el watchdog lo nota
- **4 → 5:** todas las features completas antes del handoff; runbook documenta el sistema final
- **5 → 6:** auto-restart probado en operación normal antes de pruebas de pico (peor momento para que falle un Windows Service nuevo)
- **6 desacoplado:** depende de licencia externa, puede correr en paralelo con post-handoff

### Research Flags

Fases que necesitan deep research durante `/gsd:plan-phase`:

- **Fase 1:** validar formato del `_statistics.csv` de SIPp con runs en mock (variabilidad por escenario, archivos parciales) — antes de codificar el reader
- **Fase 2:** estabilidad del soak-light de 4h — sin datos previos, validar con corridas cortas (30min) primero
- **Fase 4 (PDD):** capturar logs reales del 3CX con varias llamadas test para construir regex preciso de INVITE→200 OK; reading the regex sin samples reales = brittle
- **Fase 4 (RTCP):** investigar si libpcap es instalable en Cygwin per-user; si no, plan B con 3CX Call Quality Report API
- **Fase 5:** validar NSSM install path sin admin; testear graceful shutdown con SSH abierto

Fases con patrones bien documentados (research breve OK):
- **Fase 3:** winston, health checks, schema SQLite — patrones estándar
- **Fase 5 (handoff):** runbook, git clone — prácticas establecidas

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| **Stack** | HIGH | NSSM, winston, chokidar, fast-csv son maduros y Windows-proven. Riesgo: chokidar+Cygwin sin testing previo a escala. |
| **Features** | HIGH | Scope congelado en PROJECT.md. Table stakes son bajos en complejidad (cada uno <8h). |
| **Architecture** | HIGH | Extensiones son aditivas, no rompen pipeline existente. 2nd SSH es patrón conocido. |
| **Pitfalls** | MEDIUM | Top 5 bien researched con prevention concreta. Pitfall #4 asume NSSM funcional, Pitfall #5 asume cooperación de Tigo. |
| **RTCP/MOS** | LOW-MEDIUM | libpcap en Cygwin no validado, mitigación es stub explícito. |

**Overall confidence:** HIGH para fases 1-3, 5 — MEDIUM para fase 4 (instrumentación) — alto riesgo externo en fase 6 (licencia).

### Gaps to Address

- **Verificar formato `_statistics.csv` de SIPp:** correr 5–10 escenarios mock y guardar muestras para tests; gating de Fase 1
- **Validar libpcap en Cygwin per-user:** spike técnico de 1–2 horas durante research de Fase 4; si negativo, ejecutar plan B (stub)
- **Capturar samples reales de `3CXGatewayService.log`:** correlación INVITE→200 OK necesita data del cliente; agendar window con TI OLAM antes de Fase 4
- **Confirmar timeline trial SC192 con OLAM comercial:** input externo necesario para schedule de Fase 6, sin ese dato la fase queda en TBD
- **Validar destination valido en 3CX:** OLAM-01 es bloqueador inmediato; cliente debe confirmar ext de prueba o consultar la 3CX API antes de Fase 1

## Sources

### Primary (HIGH confidence)
- `.planning/codebase/STACK.md`, `INTEGRATIONS.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONCERNS.md` — codebase ground truth (verificado leyendo código directamente)
- `.planning/PROJECT.md` — scope y constraints del milestone definidos por el cliente
- `CLAUDE.md` — spec original del proyecto

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` (researcher haiku, HIGH confidence interna) — extension patterns, NSSM justification, build order
- `.planning/research/FEATURES.md` (researcher haiku, HIGH confidence interna) — table stakes vs differentiators con mapping a OLAM-XX
- `.planning/research/PITFALLS.md` (researcher haiku, MEDIUM confidence interna) — pitfalls específicos al contexto OLAM
- `.planning/research/STACK.md` (sintetizado tras researcher BLOCKED, basado en codebase + ARCHITECTURE/PITFALLS) — recomendaciones aditivas

### Tertiary (LOW confidence — necesitan validación in-flight)
- libpcap+Cygwin compatibilidad (Fase 4)
- Format stability del `_statistics.csv` SIPp con scenarios diversos (Fase 1)
- Estabilidad soak 4h sin datos previos (Fase 2)

---
*Research completed: 2026-05-02*
*Ready for roadmap: yes*
