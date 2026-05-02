# Phase 1: Unblock - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 entrega cuatro cambios mínimos que destapan la batería de tests reales del milestone:

1. **BLOCK-01:** El backend valida que la extensión destino del SIPp test exista en el 3CX antes de invocar SIPp; rechazo claro si no existe, sin crear `testId`.
2. **BLOCK-02:** El SIPp Manager calcula el resumen del test leyendo el `_statistics.csv` final que escribe SIPp en lugar de parsear stderr en vivo. Los `snapshots` dejan de venir vacíos.
3. **BLOCK-03:** El warning del LogReader "No log data for 2+ minutes" distingue entre "sin tráfico real" / "parser roto" / "SSH caído", con mensaje específico para cada caso en `AlertPanel`.
4. **FIND-01:** El 3CX queda en updates manuales — auto-updates desactivado en Web Console.

**No entran en este fase:** mejorar instrumentación de métricas (Phase 5), runbook formal (Phase 6), self-monitoring del backend (Phase 4). Solo lo mínimo para que un smoke test corra clean y el assessment pueda avanzar sin riesgo de drift de logs por update sorpresa.

</domain>

<decisions>
## Implementation Decisions

### FIND-01 — Desactivación auto-updates 3CX

- **D-01:** **Ejecutor: TI OLAM (coordinado).** El cambio en el 3CX Web Console lo hace TI OLAM con sus propias credenciales, no el consultor. Razón: es el sistema de OLAM, refuerza ownership, evita problemas de auditoría interna por accesos cruzados. El consultor pasa el procedimiento exacto y verifica después.

- **D-02:** **Modalidad: guía remota.** El consultor está disponible (RDP / pantalla compartida / videollamada) durante la ventana en que TI OLAM hace el cambio, para resolver dudas del paso a paso al instante.

- **D-03:** **Verificación primaria: screenshot.** Una captura del panel 3CX mostrando "Auto-updates: disabled" se archiva en una carpeta del repo (sugerencia: `docs/evidence/3cx-auto-updates-off-2026-05-XX.png`) como evidencia estática del estado al cierre de Phase 1.

- **D-04:** **Verificación continua: alerta automática si se reactiva.** La plataforma debe detectar si auto-updates vuelve a estar activo en el 3CX (por reset del firmware, restore de backup, intervención manual) y levantar alerta visible en `AlertPanel`. Mecanismo a definir por el researcher: opciones a investigar son (a) query a 3CX Call Control API si expone el flag, (b) lectura del archivo de configuración del 3CX vía SSH, (c) parseo de logs buscando eventos del scheduler de updates.

  **⚠️ Flag al planner:** el costo estimado de implementar esta detección automática es 4-8h. Es conceptualmente self-monitoring (similar a Phase 4 MON-02). El planner debe evaluar si implementarlo en Phase 1 (cumple D-04 ahora) o moverlo a Phase 4 con un placeholder/recordatorio operativo en Phase 1. Decisión del planner basada en complejidad real una vez investigada la opción técnica.

- **D-05:** **Documentación: diferida a Phase 6 (RUNBOOK-OLAM.md).** No se crea un doc separado en Phase 1 para esto. El procedimiento exacto (pasos en Web Console, cómo verificar, cómo revertir si urge) entra al runbook formal en OPS-02. En Phase 1 solo queda el screenshot archivado + la alerta automática (cuando se implemente).

### BLOCK-01, BLOCK-02, BLOCK-03 — Discreción del researcher / planner

El usuario delegó las decisiones técnicas de los tres BLOCK a Claude. El researcher debe investigar y el planner debe especificar concretamente el approach para cada uno, considerando:

- **BLOCK-01 (validación de extensión):** decidir entre lista estática en `.env`, query runtime a 3CX Call Control API, o cache híbrido refrescado on-demand. Considerar: latencia (no bloquear `POST /api/tests/run` >500ms), comportamiento si la API 3CX cae (fail-open o fail-closed?), formato del error en frontend (modal con extensiones disponibles vs solo mensaje).

- **BLOCK-02 (parser CSV):** decidir entre `chokidar` (watch del archivo + leer al final), polling con `fs.stat`, o lectura síncrona post-`SIPp` exit. Considerar: archivos parciales durante test (SIPp escribe línea a línea), fallo si SIPp crashea sin escribir CSV (fallback a stderr current behavior?), encoding (Cygwin escribe LF? CRLF?). STACK.md ya recomienda `chokidar v3.6 + fast-csv v5.0`.

- **BLOCK-03 (diagnóstico parser):** decidir heurística para distinguir 3 estados — "sin tráfico real", "parser roto/regex no matchea", "SSH caído". Considerar: contar líneas recibidas vs líneas matcheadas (ratio), correlacionar con `ssh.connected`, cooldown para evitar flapping. UI: mensajes específicos en `AlertPanel` según estado, idealmente con severidad diferente (sin tráfico = INFO, parser roto = ALTO, SSH caído = CRÍTICO).

### Claude's Discretion

Todo lo siguiente queda a discreción del researcher/planner sin necesidad de re-confirmar con el usuario:
- Estructura interna de `sippManager.js` (refactor del módulo OK si mejora testabilidad)
- Qué library agregar al `package.json` (siguiendo recomendaciones de STACK.md: chokidar, fast-csv)
- Patrones de error handling (siguiendo CONVENTIONS.md existentes)
- UI styling de mensajes nuevos en `TestControl` y `AlertPanel` (siguiendo Tailwind classes existentes)
- Si BLOCK-03 necesita un nuevo componente o solo extender `AlertPanel`

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap y requirements
- [.planning/ROADMAP.md](../../ROADMAP.md) §"Phase 1: Unblock" — goal, success criteria (4 items), risk LOW, UI changes yes
- [.planning/REQUIREMENTS.md](../../REQUIREMENTS.md) §Block — BLOCK-01, BLOCK-02, BLOCK-03 detalle completo
- [.planning/REQUIREMENTS.md](../../REQUIREMENTS.md) §Find — FIND-01 detalle completo
- [.planning/PROJECT.md](../../PROJECT.md) — constraints (sanitización total, español, no romper always-on), Key Decisions (Cygwin para SIPp es operativo, mock mode preservado)

### Codebase context relevante
- [.planning/codebase/STRUCTURE.md](../../codebase/STRUCTURE.md) — dónde viven los archivos backend/frontend que toca esta fase
- [.planning/codebase/CONVENTIONS.md](../../codebase/CONVENTIONS.md) — patrones existentes (ESM, error handling, Spanish comments, React hooks-only)
- [.planning/codebase/CONCERNS.md](../../codebase/CONCERNS.md) §item #2 (sippManager parsea stderr) — esto es exactamente lo que BLOCK-02 resuelve
- [.planning/codebase/CONCERNS.md](../../codebase/CONCERNS.md) §item #6 (destination no sanitizado) — relevante para BLOCK-01
- [.planning/codebase/CONCERNS.md](../../codebase/CONCERNS.md) §item #7 (LogReader watchdog spammy) — relevante para BLOCK-03

### Research
- [.planning/research/STACK.md](../../research/STACK.md) — chokidar v3.6 + fast-csv v5.0 recomendados para BLOCK-02
- [.planning/research/PITFALLS.md](../../research/PITFALLS.md) §Pitfall #2 (SIPp se cuelga con destino inválido) — diseño de BLOCK-01 debe incluir watchdog del proceso SIPp
- [.planning/research/PITFALLS.md](../../research/PITFALLS.md) §Pitfall #3 (log format drift) — refuerza FIND-01 como prioridad del milestone
- [.planning/research/SUMMARY.md](../../research/SUMMARY.md) §"Phase 1: Unblock real tests" — rationale completo de la fase

### Documentación operacional
- [docs/HANDOFF-2026-04-27.md](../../../docs/HANDOFF-2026-04-27.md) — credenciales 3CX Web Console (`https://regis2026.3cx.co/#/login`) para que TI OLAM acceda
- [docs/STATUS-2026-04-30.md](../../../docs/STATUS-2026-04-30.md) §"Pendientes inmediatos" — referencia histórica del smoke FAIL del 25/04 que motivó BLOCK-02

### Origen de las reglas operativas
- [CLAUDE.md](../../../CLAUDE.md) §"Reglas de implementación" — sanitización total de inputs (clave para BLOCK-01), parser con fallback (relevante para BLOCK-03)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`backend/src/routes/tests.js`** — punto de entrada de `POST /api/tests/run`. BLOCK-01 inserta validación de destino antes de llamar a `sippManager.runTest`. Mantener el shape del response actual (`{ ok, error }`).
- **`backend/src/services/sippManager.js`** — el módulo a refactorizar para BLOCK-02. La función `buildSummary` actual parsea stderr; reemplazarla por un reader del `_statistics.csv` que SIPp escribe en su working directory. Conservar la firma pública del módulo para no romper callers.
- **`backend/src/services/logReader.js`** — contiene el watchdog que hoy emite `console.warn` ruidoso. Para BLOCK-03 hay que extenderlo con tracking de líneas recibidas vs matcheadas (no solo "vacío vs no vacío") y correlación con estado de SSH.
- **`frontend/src/components/AlertPanel.jsx`** — ya renderiza alertas con severidad. BLOCK-03 envía 3 alertas posibles distintas (INFO/ALTO/CRÍTICO) — extender el rendering, no crear componente nuevo.
- **`frontend/src/components/TestControl.jsx`** — formulario que dispara `POST /api/tests/run`. Para BLOCK-01: cuando el backend rechaza por extensión inválida, mostrar mensaje claro inline en el formulario (no toast efímero). Considerar mostrar lista de extensiones válidas si es disponible vía API.
- **`backend/src/db/queries.js`** — schema existente para audit log. Si BLOCK-01 quiere registrar intentos rechazados también, agregar columna o tabla nueva (decisión del planner).

### Established Patterns
- **ES Modules** en backend (no CJS); `import { ... } from '...'` con extensiones `.js` explícitas.
- **Sanitización en routes/, lógica en services/** — no validar en services/ lo que ya validó la route.
- **Error responses uniformes:** `{ ok: false, error: "mensaje en español" }` con HTTP 400 para errors de cliente.
- **WebSocket events** para updates en tiempo real desde backend a frontend; REST endpoints solo para snapshots o acciones explícitas.
- **`hooks/useSocket.js` y `hooks/useMetrics.js`** ya manejan estado del frontend. Si BLOCK-03 cambia el shape de las alertas, propagar a través de `useMetrics`.

### Integration Points
- **`POST /api/tests/run` → BLOCK-01:** insertar validación antes de invocar SIPp. Si invalid, retornar 400 antes de crear `testId` en SQLite.
- **`sippManager.runTest` → BLOCK-02:** al final de cada test, en lugar de leer stderr stream, esperar el archivo `_statistics.csv` (chokidar watcher + fast-csv parser).
- **`logReader.js → AlertPanel`:** BLOCK-03 emite alertas a través del bus existente WebSocket → `useMetrics` → `AlertPanel`. Estructura sugerida: agregar `level: 'parser_silence' | 'parser_broken' | 'ssh_down'` al objeto alerta.
- **3CX Web Console (externo) → docs/evidence/:** screenshot post-FIND-01 archivado en repo, no requiere código de plataforma.

</code_context>

<specifics>
## Specific Ideas

- **Screenshot como evidencia estática:** TI OLAM saca la captura, la comparte (correo / Slack OLAM / drive), el consultor la archiva en `docs/evidence/3cx-auto-updates-off-YYYY-MM-DD.png`. El nombre con fecha sirve para auditoría.
- **Modalidad TI OLAM coordinada:** el consultor no entra al panel 3CX en este flujo. Si TI OLAM se atasca, el consultor explica vía RDP/pantalla compartida pero no toca las credenciales.
- **3CX panel URL:** `https://regis2026.3cx.co/#/login` — TI OLAM ya tiene acceso (creds en HANDOFF-2026-04-27.md según contexto del proyecto).
- **Plan B si la detección automática (D-04) resulta inviable en Phase 1:** documentar el riesgo en `STATE.md` Blockers/Concerns y mover la detección a MON-02 (Phase 4). El screenshot inicial sigue cumpliendo verificación primaria.

</specifics>

<deferred>
## Deferred Ideas

- **Auto-detección automática de auto-updates re-activado (sub-tarea de D-04):** si el planner determina que es >6h de trabajo, mover a Phase 4 (MON-02 área) y dejar Phase 1 con solo screenshot + entry en STATE.md como riesgo conocido durante el milestone. No descartar — solo posiblemente diferir.
- **Doc separado del procedimiento 3CX (`docs/3CX-AUTO-UPDATES-OFF.md`):** considerado y descartado por usuario. La doc va al runbook formal en Phase 6 (OPS-02). Si surge necesidad antes (otro consultor entra al proyecto), reconsiderar.
- **Validación de extensión 3CX-API-driven con cache que se refresca cada N minutos** vs **lista estática `.env`:** decisión técnica del researcher en plan-phase. No vuelve a usuario.
- **Componente nuevo de error en TestControl (modal vs inline)** vs **reusar mensaje inline existente:** decisión técnica del researcher en plan-phase.

### Reviewed Todos (not folded)

None — `gsd-tools todo match-phase 1` devolvió 0 matches.

</deferred>

---

*Phase: 01-unblock*
*Context gathered: 2026-05-02*
