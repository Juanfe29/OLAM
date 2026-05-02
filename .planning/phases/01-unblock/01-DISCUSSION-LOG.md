# Phase 1: Unblock - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-02
**Phase:** 01-unblock
**Areas discussed:** FIND-01 (auto-updates 3CX)

---

## Gray area selection

| Option | Description | Selected |
|---|---|---|
| Validación extensión (BLOCK-01) | Cómo valida el backend que la ext de destino existe en el 3CX (config estática vs 3CX API vs cache híbrido) + cómo se ve el rechazo en el frontend | |
| Parsing `_statistics.csv` (BLOCK-02) | Timing y mecanismo (chokidar al fin del proceso vs polling vs read síncrono post-SIPp) + manejo de fallo si SIPp crashea sin escribir CSV | |
| Diagnóstico parser (BLOCK-03) | Cómo distinguir 3 estados (sin tráfico real / parser roto / SSH caído) en código y presentación en AlertPanel | |
| **FIND-01 auto-updates 3CX** | Procedimiento operacional para desactivar auto-updates en 3CX Web Console + verificación + dónde queda documentado | ✓ |

**User's choice:** FIND-01 only — los 3 BLOCK quedaron a discreción de Claude/researcher/planner por confianza en best practices documentadas en SUMMARY.md y STACK.md.

---

## FIND-01 — Quién ejecuta

| Option | Description | Selected |
|---|---|---|
| Yo (consultor) — ahora | Yo entro al panel 3CX hoy con las creds del HANDOFF y lo desactivo; documento screenshot como evidencia | |
| **TI OLAM — coordinado** | TI OLAM lo hace (es su sistema), nosotros le pasamos el procedimiento exacto y verificamos después | ✓ |
| Conjunto | Yo guio remoto (RDP o pantalla compartida) mientras TI OLAM hace el cambio en sus credenciales | |

**User's choice:** TI OLAM — coordinado.
**Notas:** captura clara: ownership del 3CX queda con OLAM, evita problemas de auditoría interna por accesos cruzados, refuerza handoff al final del milestone. Consultor disponible para guiar pero no toca credenciales.

---

## FIND-01 — Verificación

| Option | Description | Selected |
|---|---|---|
| Screenshot al hacer el cambio | Una sola captura del panel mostrando 'Auto-updates: disabled' — evidencia estática | |
| Screenshot + re-check semanal | Screenshot inicial + revisión cada lunes durante el milestone para confirmar que sigue desactivado | |
| **Screenshot + alerta automática si reactiva** | Plataforma chequea periódicamente vía 3CX API o logs si auto-updates volvió a estar activo — más trabajo de implementación | ✓ |

**User's choice:** Screenshot + alerta automática si reactiva.
**Notas:** Claude flaggeó el costo (4-8h de implementación, conceptualmente self-monitoring tipo Phase 4). El planner decide si implementar en Phase 1 o mover a Phase 4 con placeholder. Decisión del usuario respetada en CONTEXT.md como D-04 con la nota.

---

## FIND-01 — Documentación

| Option | Description | Selected |
|---|---|---|
| **Solo en RUNBOOK-OLAM.md (Phase 6)** | Diferir el doc al runbook formal de la Phase 6 — menos trabajo ahora, riesgo de olvido | ✓ |
| Doc mínimo ahora + integrar en Phase 6 | `docs/3CX-AUTO-UPDATES-OFF.md` con pasos + screenshot ahora, después se mergea al runbook | |
| Issue/ticket OLAM sólo | Tracking en el sistema de tickets de OLAM, sin doc en el repo | |

**User's choice:** Solo en RUNBOOK-OLAM.md (Phase 6).
**Notas:** Phase 1 no genera doc separado. Solo screenshot archivado en `docs/evidence/`. El procedimiento detallado entra en OPS-02 cuando se escriba el runbook.

---

## Closing — More questions or ready

| Option | Description | Selected |
|---|---|---|
| **Listo para CONTEXT** | Los 3 BLOCK items quedan a discreción mía/researcher; FIND-01 ya está claro. Escribir el CONTEXT y avanzar | ✓ |
| Discutir un BLOCK | Quiero opinar sobre cómo se valida la extensión, o cómo se parsea el CSV, o cómo se diagnostica el parser — abrir uno de los 3 | |

**User's choice:** Listo para CONTEXT.

---

## Claude's Discretion

Áreas explícitamente delegadas al researcher / planner por el usuario:
- BLOCK-01: método de validación de extensión (config / API / cache) + UI del rechazo
- BLOCK-02: mecanismo de lectura del `_statistics.csv` + manejo de error si SIPp crashea
- BLOCK-03: heurística para distinguir 3 estados del parser + presentación visual

Áreas implícitamente discrecionales (siguiendo CONVENTIONS.md y STACK.md sin re-confirmar):
- Estructura interna de refactor de `sippManager.js`
- Library choices (chokidar, fast-csv ya recomendados en STACK.md)
- Tailwind styling de mensajes nuevos
- Si BLOCK-03 necesita componente nuevo o solo extensión de AlertPanel

## Deferred Ideas

- Auto-detección automática de re-activación de auto-updates 3CX (sub-tarea de D-04): planner evalúa si va en Phase 1 o se mueve a Phase 4 (MON-02). No se descarta — posiblemente solo se difiere.
- Doc separado `docs/3CX-AUTO-UPDATES-OFF.md`: descartado, va al runbook Phase 6.
- Decisiones técnicas internas (validación extensión approach, CSV reader timing, etc.): no vuelven a usuario, las cierra el planner.
