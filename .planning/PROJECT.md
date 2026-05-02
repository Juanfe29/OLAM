# OLAM 3CX Audit Platform

## What This Is

Plataforma web que audita en tiempo real un servidor 3CX v20 corriendo en producción para OLAM Inversiones (contact center con tráfico generado por Wise CX sobre la troncal SIP Tigo UNE). Opera en dos modos: **pasivo** (always-on, lee logs del 3CX vía SSH y muestra métricas en un dashboard sin interrumpir operación) y **activo** (genera carga sintética con SIPp para medir el techo del sistema). Su misión es responder con evidencia técnica si el 3CX puede escalar de la licencia actual SC32 (32 llamadas) a SC192 (180) y dejar la plataforma operable por el equipo de TI de OLAM al cierre del assessment.

## Core Value

**El dashboard en vivo + historial SQLite ES la evidencia del assessment.** No se entrega informe ejecutivo ni CSVs sueltos — la plataforma corriendo en `172.18.164.35` con métricas reales del 3CX y resultados de tests SIPp persistidos es el deliverable consultable. Si todo lo demás falla, esto debe seguir vivo y accesible.

## Requirements

### Validated

<!-- Existentes y operativos al 2026-05-02 según codebase map. Lockeados, mover a Out of Scope si se invalidan. -->

- ✓ **Backend Express + Socket.io** corriendo always-on con SSH persistente al 3CX `172.18.164.28` — existing
- ✓ **Frontend React + Vite + Tailwind** con dashboard de 14 KPIs en tiempo real (puerto 5173) — existing
- ✓ **Lector de logs** (`tail -Fq` streaming sobre los 5 archivos del 3CX, no polling) — existing
- ✓ **Parser de logs → métricas** con regex específicas por tipo (CallFlow, Gateway, Queue, System, IVR) — existing
- ✓ **Detector de anomalías** con 7 reglas de severidad (crítico → bajo) — existing
- ✓ **4 hallazgos Fase 0** detectados y mostrados desde día cero (H-01 SC32, H-07 SIP sin TLS, H-03 errores 408 Tigo, H-05 auto-updates) — existing
- ✓ **SIPp v3.7.3** compilado en Cygwin sobre `172.18.164.35`, invocable por backend con parámetros sanitizados — existing (Fases 1-5)
- ✓ **Digest auth SIP** vía `SIPP_AUTH_USER`/`SIPP_AUTH_PASS` (commit `ac11d81`) — existing
- ✓ **Persistencia SQLite** para audit log de tests + historial — existing
- ✓ **Túnel SSH a node_exporter** del 3CX (`127.0.0.1:9100`) cuando el firewall upstream bloquea acceso directo — existing
- ✓ **Hard limits** en backend: 200 calls / 20 ramp / 8h / lock para tests concurrentes — existing
- ✓ **REST API + WebSocket** (11 endpoints, 5 eventos) validados con colección Postman — existing

### Active

<!-- Este milestone v1.0. Hipótesis hasta shipped + validated. -->

**Bloqueadores que tapan tests reales (corto plazo):**
- [ ] **OLAM-01:** Validar extensión válida en el 3CX para usar como destino de SIPp (probable que `100` no exista) — bloquea primer smoke real
- [ ] **OLAM-02:** Diagnosticar smoke test FAIL del 25/04 (sippManager parsea stderr y devuelve `snapshots: []`) — leer `_statistics.csv` final en lugar de stderr
- [ ] **OLAM-03:** Investigar warning del parser "No log data for 2+ minutes" observado al arranque

**Mitigación de hallazgos no-licencia:**
- [ ] **OLAM-04:** Cierre H-05 — cambiar 3CX a updates manuales (config en Web Console)
- [ ] **OLAM-05:** Mitigación H-07 — restringir 5060/UDP por origen IP en firewall upstream (TLS migration queda para milestone futuro)
- [ ] **OLAM-06:** Diagnóstico H-03 — `tcpdump` 1h en horario pico capturando SIP/UDP hacia `172.17.179.166`, correlacionar timestamps de errores 408, traceroute al SBC de Tigo

**Tests SIPp dentro de SC32 (no requieren upgrade):**
- [ ] **OLAM-07:** Smoke (1 call) → light (10) → medium-cap (30) corriendo y persistiendo en SQLite
- [ ] **OLAM-08:** Soak-light (4h a 20 calls) para validar estabilidad sostenida y detectar fugas

**Tests SIPp con SC192 (cuando llegue licencia trial):**
- [ ] **OLAM-09:** Peak (180 calls) en ventana de mantenimiento coordinada
- [ ] **OLAM-10:** Stress (220 calls) para encontrar punto de saturación
- [ ] **OLAM-11:** Soak (14400s a 125 calls) para estabilidad extendida

**Instrumentación faltante de la plataforma:**
- [ ] **OLAM-12:** Implementar PDD al carrier real desde logs (hoy `pddToCarrier: 0` en producción)
- [ ] **OLAM-13:** Implementar MOS / jitter / packet loss desde RTCP reports del 3CX
- [ ] **OLAM-14:** Scenario XML SIPp custom para tests >50 calls (mejor escalabilidad que el smoke loop actual)
- [ ] **OLAM-15:** Confirmar `channelsTotal` contractual de Tigo y eliminar hardcode 30 en `metricsCollector.js`

**Self-monitoring de la plataforma:**
- [ ] **OLAM-16:** `/api/health` expandido con estado granular (SSH, parser, túnel, DB, último log recibido)
- [ ] **OLAM-17:** Watchdog del parser activo — alerta interna persistente cuando no hay líneas X minutos
- [ ] **OLAM-18:** Auto-restart on crash (Windows Service o `node-windows` en `.35`)
- [ ] **OLAM-19:** Logs propios del backend con rotación (winston/pino + retention)

**Operabilidad / handoff a TI OLAM:**
- [ ] **OLAM-20:** Convertir el repo en `.35` a `.git` clonado del remote (cierra riesgo de drift por copia manual `\\tsclient\`)
- [ ] **OLAM-21:** Runbook operativo: cómo levantar la plataforma, qué hacer si SSH cae, cómo correr/detener un test, cómo interpretar alertas, cómo rotar logs
- [ ] **OLAM-22:** Sesión de handoff a TI OLAM con dry-run de los procedimientos del runbook

### Out of Scope

<!-- Boundaries explícitos con razón para evitar re-adición silenciosa. -->

- **RBAC / auth multi-usuario** — la plataforma vive en red interna OLAM (`172.18.164.0/24`) con superficie de ataque baja; agregar auth añade complejidad operativa sin reducir riesgo material en este milestone
- **Alertas externas Slack/email/webhook** — el motor de anomalías ya empuja alertas al dashboard vía WebSocket; el envío externo se difiere a milestone futuro si TI OLAM lo pide post-handoff
- **Informe ejecutivo del assessment** — el deliverable es la plataforma viva y su historial SQLite consultable; el reporte ejecutivo lo redacta OLAM o un consultor adyacente con esos datos
- **Exportar CSVs / capturas SIP a carpeta de evidencia** — la dashboard + SQLite cumplen el rol de evidencia; las capturas `tcpdump` puntuales para diagnóstico de H-03 sí se hacen, pero no se versionan como artifacts del milestone
- **Migración SIP/UDP → SIP/TLS** — H-07 se mitiga por filtro de firewall en este milestone; la migración a TLS requiere coordinación con Tigo (TLS-side) y ventana mayor — milestone futuro
- **Soporte continuo post-handoff** — al cierre del milestone TI OLAM opera la plataforma autónomo; mejoras/fixes posteriores son engagement separado

## Context

**Servidor auditado:** Debian 12 + 3CX v20 Update 8 Build 1121 en `172.18.164.28`. Licencia actual SC32, objetivo SC192. Troncal SIP Tigo UNE en `sip:172.17.179.166:5060`. IP pública `181.63.161.242`.

**Host de la plataforma:** Win10 cliente OLAM en `172.18.164.35` (usuario `lamda`), accesible vía RDP. Sin permisos de admin, sin DNS público, sin WSL. Por eso SIPp corre vía Cygwin (instalación per-user) en lugar de Linux nativo. El repo en `.35` hoy NO es un `.git` repo — los archivos se copiaron manualmente desde `\\tsclient\` lo que introduce riesgo de drift.

**Conectividad:** El backend usa SSH key-based passwordless al 3CX. node_exporter en el 3CX se accede vía túnel SSH (`forwardOut`) porque el firewall upstream bloquea `:9100` desde la VPN. Operador (Maximiliano Pulido) accede a la red OLAM vía Forticlient VPN.

**Trabajo previo (5 sesiones, 24/04 → 02/05/2026):**
- Sesión 1 (24/04): bootstrap del backend + frontend en mock mode
- Sesión 2 (25-27/04): deploy a `.35`, switch a PRODUCTION mode, SSH al 3CX funcional
- Sesión 3 (27/04): plan e instalación de Cygwin + compilación SIPp (Fases 1-5 del plan Cygwin)
- Sesión 4 (27/04): wire-up SIPp al backend (commit `4efd49b`) + digest auth (commit `ac11d81`)
- Sesión 5 (01/05): generación de informe parcial para OLAM, captura con datos reales, mapping del codebase a `.planning/codebase/`

**Hallazgos activos del 3CX al inicio del milestone:**
- **H-01 CRÍTICO:** Licencia SC32 insuficiente (objetivo SC192) — bloquea OLAM-09/10/11 hasta upgrade
- **H-07 CRÍTICO:** SIP/UDP `:5060` expuesto sin TLS en IP pública — mitigación parcial vía firewall en OLAM-05
- **H-03 ALTO:** Errores 408 detectados en troncal Tigo UNE con tráfico actual — diagnóstico en OLAM-06
- **H-05 ALTO:** Auto-updates del 3CX habilitado (riesgo de reinicio en horario productivo + ruptura del parser de logs) — cierre en OLAM-04

**Concerns conocidos del codebase** (referencia: `.planning/codebase/CONCERNS.md`): repo no-`.git` en `.35`, smoke FAIL por parser de stderr, encoding UTF-8→Latin-1 en alertas, `disk.recordings` siempre 0, `destination` no sanitizado en SIPp Manager, watchdog spammy del LogReader, PDD/MOS/jitter al carrier no instrumentados, `channelsTotal` hardcoded a 30, sin tests automatizados (solo Postman), sin auth.

## Constraints

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

## Key Decisions

| Decisión | Rationale | Outcome |
|---|---|---|
| Híbrido evidencia + operable, sin informe ejecutivo | El cliente prefiere consumir el dashboard vivo + historial SQLite que un PDF; el informe lo redacta OLAM con esos datos | — Pending |
| Self-monitoring sin RBAC en este milestone | Red interna baja superficie; auth añade fricción operativa que TI OLAM no necesita en v1.0 | — Pending |
| Mitigación H-07 por firewall, TLS deferido | TLS exige coordinación con Tigo y ventana mayor; el filtro por origen IP cierra el riesgo de toll fraud externo y se hace en 1h | — Pending |
| Dashboard como evidencia viva en lugar de exportar a archivos | Reduce duplicación de fuentes de verdad; OLAM consulta el mismo lugar que el operador | — Pending |
| Repo `.35` se vuelve `.git` clonado del remote | Cierra el riesgo de drift por copia manual y habilita updates por `git pull` durante operación | — Pending |
| Cygwin per-user para SIPp | Única opción viable en `.35` (sin admin, sin WSL); ya validado en commits del 27/04 | ✓ Good — operativo desde Fase 5 |
| node_exporter via túnel SSH en lugar de exposición directa | Firewall upstream bloquea `:9100`; pedirles que abran lleva semanas y agrega vector de ataque | ✓ Good — operativo |
| Mock mode preservado en codebase | Permite desarrollo sin VPN OLAM y testing del frontend sin tocar 3CX | ✓ Good — usado en sesiones de desarrollo |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-02 after initialization*
