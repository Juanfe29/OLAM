# Roadmap: OLAM 3CX Audit Platform — v1.0

## Overview

Este milestone convierte una plataforma funcional-pero-frágil en un sistema de auditoría completo, fiable y operable por TI OLAM. El recorrido tiene siete fases: primero se desbloquean los tests reales (los smoke tests fallan hoy), luego se mitigan los hallazgos del 3CX que no requieren licencia, luego se corre la batería SC32, luego se endurece la plataforma con self-monitoring y métricas reales, luego se entrega a TI OLAM con runbook y dry-run, y por último —cuando llegue la licencia SC192— se corren los tests de capacidad completos. Las fases SC192 están separadas porque dependen de un desbloqueador externo fuera del control del equipo.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Unblock** - Reparar smoke test + desactivar auto-updates del 3CX para poder correr tests reales
- [ ] **Phase 2: Findings** - Mitigar H-07 (firewall) y diagnosticar H-03 (tcpdump 1h hacia Tigo)
- [ ] **Phase 3: Tests SC32** - Correr y persistir la batería completa dentro del tier actual (smoke → light → medium-cap → soak-light)
- [ ] **Phase 4: Self-Monitoring** - Health endpoint granular, watchdog activo, logs propios con rotación, NSSM auto-restart
- [ ] **Phase 5: Instrumentation** - PDD real desde logs, MOS/jitter honesto, scenarios XML SIPp, channelsTotal desde config
- [ ] **Phase 6: Handoff** - Repo git clonado en .35, runbook operativo en español, dry-run con TI OLAM firmado
- [ ] **Phase 7: Tests SC192** - Peak/stress/soak con licencia trial SC192 (BLOQUEADO — esperando licencia externa)

## Phase Details

### Phase 1: Unblock
**Goal**: Los tests reales del 3CX funcionan y auto-updates está desactivado para que no rompa el parser
**Depends on**: Nothing (first phase)
**Requirements**: BLOCK-01, BLOCK-02, BLOCK-03, FIND-01
**Risk**: LOW — cambios locales al backend y configuración del 3CX, no tocan el pipeline SSH→dashboard
**UI changes**: yes
**Effort**: 2 days
**Success Criteria** (what must be TRUE):
  1. El smoke test (1 call, 30s) corre limpio contra el 3CX real y aparece en `GET /api/history` con `result: PASS` y `snapshots` no vacíos
  2. El backend rechaza `POST /api/tests/run` con error claro y legible si la extensión destino no existe en el 3CX, sin crear testId
  3. El warning "No log data for 2+ minutes" en el dashboard distingue visiblemente entre "sin tráfico real" vs "parser roto / SSH caído", con mensaje específico para cada caso
  4. El panel Web Console del 3CX muestra auto-updates desactivado; ningún update automático puede ocurrir sin intervención manual durante el assessment
**Plans**: TBD
**UI hint**: yes

### Phase 2: Findings
**Goal**: Los hallazgos H-07 y H-03 tienen mitigación aplicada y evidencia técnica archivada
**Depends on**: Phase 1
**Requirements**: FIND-02, FIND-03
**Risk**: MEDIUM — FIND-02 requiere coordinación con el equipo de redes de OLAM para cambios de firewall; FIND-03 requiere ventana de horario pico y acceso SSH al 3CX para tcpdump
**UI changes**: no
**Effort**: 2 days
**Success Criteria** (what must be TRUE):
  1. El firewall upstream OLAM tiene una regla activa que permite entrada a `5060/UDP` solo desde las IPs de los SBC de Tigo; tráfico externo al puerto ya no llega al 3CX
  2. Existe un archivo de captura pcap de 1 hora durante horario pico (`tigo-sip-<fecha>.pcap`), correlacionado con timestamps de errores 408 visibles en `3CXGatewayService.log`, en una carpeta de evidencia accesible para la mesa técnica con Tigo
  3. Hay un traceroute documentado al SBC de Tigo (`172.17.179.166`) con los hops y latencias capturadas, como parte del mismo paquete de evidencia H-03
**Plans**: TBD

### Phase 3: Tests SC32
**Goal**: La batería completa de tests dentro del tier SC32 corre limpio y queda persistida como evidencia en SQLite
**Depends on**: Phase 1
**Requirements**: TEST-01, TEST-02, TEST-03
**Risk**: MEDIUM — el soak-light de 4h es territorio sin datos previos; el backend podría tener fugas de memoria o el parser podría perder heartbeat en ejecuciones largas
**UI changes**: no
**Effort**: 3 days (soak-light necesita ventana de 4h + monitoreo)
**Success Criteria** (what must be TRUE):
  1. Smoke (1 call), light (10 calls) y medium-cap (30 calls) aparecen en `/api/history` con `result: PASS`, snapshots no vacíos, y métricas reales (PDD, ASR, conteo de errores)
  2. El soak-light (20 calls × 4h) completa sin que el backend crashee, sin que el LogReader pierda heartbeat del parser, y sin degradación visible en la cantidad de llamadas activas a lo largo de la prueba
  3. Ningún test SC32 genera rechazos o errors 480/486/503 atribuibles al tier (se mantiene bajo 32 calls concurrentes)
**Plans**: TBD

### Phase 4: Self-Monitoring
**Goal**: La plataforma se monitorea a sí misma, sobrevive crashes, y no llena el disco con logs propios
**Depends on**: Phase 3
**Requirements**: MON-01, MON-02, MON-03, MON-04
**Risk**: MEDIUM — NSSM (MON-03) en Windows sin admin tiene pasos de instalación per-user que necesitan validación; MON-04 (winston) requiere eliminar todos los `console.log` del código de producción sin romper nada
**UI changes**: yes
**Effort**: 3 days
**Success Criteria** (what must be TRUE):
  1. `GET /api/health` devuelve un objeto con campos granulares: `ssh.connected`, `ssh.lastReceivedAt`, `parser.matchRatePerMinute`, `tunnel.up`, `db.queryLatencyMs`, `mock.mode` — un operador puede diagnosticar el estado sin entrar al servidor
  2. Cuando el SSH al 3CX cae o el parser no recibe líneas por X minutos configurables, el AlertPanel del dashboard muestra una alerta persistente activa hasta que la actividad vuelva (no solo un console.warn)
  3. Si el proceso backend crashea en `.35`, NSSM lo levanta automáticamente con throttle de restart; el crash queda registrado en los logs propios del backend
  4. Los logs propios del backend van a archivo con rotación diaria y retention de 7 días; no hay `console.log` directo en código de producción
**Plans**: TBD
**UI hint**: yes

### Phase 5: Instrumentation
**Goal**: Las métricas que hoy mienten (PDD=0, MOS=0, channelsTotal=30 hardcoded) muestran valores reales o están marcadas honestamente como no instrumentadas
**Depends on**: Phase 4
**Requirements**: METRIC-01, METRIC-02, METRIC-03, METRIC-04
**Risk**: HIGH — METRIC-02 (MOS/jitter desde RTCP) es técnicamente incierto en Cygwin; el plan B (marcar `not_instrumented`) está documentado pero requiere decisión durante planning. METRIC-01 (PDD desde logs) necesita muestras reales del 3CX para construir regex confiable.
**UI changes**: yes
**Effort**: 4 days
**Success Criteria** (what must be TRUE):
  1. El KPI `pddToCarrier` muestra valores mayores a 0 en producción durante llamadas reales, calculados desde la correlación INVITE→200 OK en `3CXGatewayService.log`; el dashboard muestra p50 y p95
  2. Los KPIs `mos`, `jitter_p95`, `packetLoss` muestran valores reales desde RTCP **o** el dashboard los etiqueta explícitamente como `No disponible — RTCP no instrumentado` en lugar de mostrar `0` falso
  3. Los escenarios SIPp para >50 calls usan archivos XML versionados en `backend/sipp-scenarios/` que existen en git y pasan validación con `xml2js` antes de invocar SIPp
  4. El KPI `channelsTotal` lee el número contractual desde `.env` (`TRUNK_CHANNELS_TOTAL`) en lugar del hardcode `30`; el valor correcto aparece en el dashboard y en los cálculos de headroom
**Plans**: TBD
**UI hint**: yes

### Phase 6: Handoff
**Goal**: TI OLAM puede operar la plataforma de forma autónoma con un runbook probado y un repo limpio
**Depends on**: Phase 5
**Requirements**: OPS-01, OPS-02, OPS-03
**Risk**: LOW — el handoff es operativo, no técnico; el riesgo principal es que el dry-run revele gaps en el runbook que requieran iteración
**UI changes**: no
**Effort**: 2 days
**Success Criteria** (what must be TRUE):
  1. `C:\Users\lamda\OLAM\` en `.35` es un repositorio `.git` clonado del remote; `git status` muestra clean al cierre del milestone; `git pull` funciona como mecanismo de update
  2. `docs/RUNBOOK-OLAM.md` existe en español orientado a TI OLAM (no a desarrolladores), cubre arranque desde cero, SSH caído, correr/detener test, interpretar las 7 alertas de anomalía, revisar logs, aplicar updates con `git pull`, y escalación
  3. Un operador de TI OLAM ejecutó el runbook paso a paso en un dry-run; las dudas surgidas están resueltas en el documento final; queda firmado el handoff por correo o ticket confirmando que asumen operación
**Plans**: TBD

### Phase 7: Tests SC192
**Goal**: Peak, stress y soak con licencia SC192 corren en ventana de mantenimiento y dejan evidencia clara de viabilidad del upgrade
**Depends on**: Phase 6
**Requirements**: TEST-04, TEST-05
**Risk**: HIGH (externo) — bloqueado por llegada de licencia trial SC192 desde OLAM comercial; timing fuera del control del equipo plataforma. Riesgo técnico ALTO: peak de 180 calls es territorio sin datos previos, afecta tráfico real si corre fuera de ventana
**UI changes**: no
**Effort**: 2 days (excluye tiempo de espera de licencia)
**External blocker**: Licencia trial SC192 debe estar activada en el 3CX antes de iniciar esta fase. Coordinar ventana de mantenimiento con OLAM.
**Success Criteria** (what must be TRUE):
  1. Peak (180 calls × 300s) corre en ventana de mantenimiento coordinada y queda en `/api/history` con `result: PASS` o `FAIL` claro, con snapshots de métricas reales durante el test
  2. Stress (220 calls × 180s) y soak-full (125 calls × 14400s) corren post-peak con captura tcpdump simultánea archivada, correlacionable por testId
  3. El dashboard muestra en tiempo real el comportamiento del 3CX bajo 180+ calls: CPU, RAM, llamadas activas, tasa de error, PDD — sin que el backend de monitoreo colapse durante la prueba
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7
Phase 7 additionally requires external license — may be deferred indefinitely if license is delayed.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Unblock | 0/TBD | Not started | - |
| 2. Findings | 0/TBD | Not started | - |
| 3. Tests SC32 | 0/TBD | Not started | - |
| 4. Self-Monitoring | 0/TBD | Not started | - |
| 5. Instrumentation | 0/TBD | Not started | - |
| 6. Handoff | 0/TBD | Not started | - |
| 7. Tests SC192 | 0/TBD | Blocked (licencia SC192) | - |
