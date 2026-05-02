---
phase: 1
slug: unblock
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-02
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Detail completo en `01-RESEARCH.md` §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest (a instalar en Wave 0 — el codebase no tiene tests automatizados todavía, solo Postman) |
| **Config file** | `backend/jest.config.js` (a crear en Wave 0) |
| **Quick run command** | `cd backend && npm test -- --testPathPattern='unblock'` |
| **Full suite command** | `cd backend && npm test` |
| **Estimated runtime** | ~10 segundos (suite mínima Phase 1) |

---

## Sampling Rate

- **After every task commit:** Run `cd backend && npm test -- --testPathPattern='unblock'`
- **After every plan wave:** Run `cd backend && npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 segundos

---

## Per-Task Verification Map

> Filled by planner. Each task gets a row mapping it to a test command + REQ-ID. Marked Wave 0 (W0) where the test framework or fixtures don't exist yet.

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|---|---|
| 1-00-01 | 00 | 0 | infra | infra | `cd backend && npx jest --version` | ❌ W0 | ⬜ pending |
| 1-00-02 | 00 | 0 | infra | infra | `test -f backend/jest.config.js` | ❌ W0 | ⬜ pending |
| 1-00-03 | 00 | 0 | infra | fixtures | `test -f backend/__tests__/fixtures/sipp_statistics_smoke.csv` | ❌ W0 | ⬜ pending |
| 1-XX-01 | XX | 1+ | BLOCK-01 | unit | `npx jest backend/__tests__/destinationValidator.test.js` | ❌ W0 | ⬜ pending |
| 1-XX-02 | XX | 1+ | BLOCK-02 | unit | `npx jest backend/__tests__/sippStatisticsReader.test.js` | ❌ W0 | ⬜ pending |
| 1-XX-03 | XX | 1+ | BLOCK-03 | unit | `npx jest backend/__tests__/parserStateDetector.test.js` | ❌ W0 | ⬜ pending |
| 1-XX-04 | XX | 1+ | BLOCK-01 | integration | `npx jest backend/__tests__/integration/testsRoute.test.js` | ❌ W0 | ⬜ pending |
| 1-XX-05 | XX | 1+ | FIND-01 | manual | (screenshot evidence in `docs/evidence/`) | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

> Planner debe rellenar las task IDs reales (1-01-01, 1-02-03, etc.) cuando defina los plans.

---

## Wave 0 Requirements

Tests no existen hoy. Wave 0 instala framework + fixtures antes de cualquier código de producto.

- [ ] `backend/package.json` — agregar `jest`, `@types/jest` (opcional), `supertest` como devDependencies
- [ ] `backend/jest.config.js` — config básica (testEnvironment: node, ESM transform si necesario)
- [ ] `backend/__tests__/fixtures/sipp_statistics_smoke.csv` — fixture válido del output de SIPp para 1 call (sample real o construido per RESEARCH.md §BLOCK-02)
- [ ] `backend/__tests__/fixtures/sipp_statistics_partial.csv` — fixture parcial (SIPp escribiendo en medio del test) para validar lectura tolerante
- [ ] `backend/__tests__/fixtures/3cx_logs/` — sample lines de los 5 logs del 3CX (CallFlow/Gateway/Queue/System/IVR) para tests del parser
- [ ] `backend/__tests__/helpers/mockSshClient.js` — mock del NodeSSH para tests sin red

*Si Wave 0 falla, Phase 1 entera queda bloqueada — los tests son la única forma de probar BLOCK-02 y BLOCK-03 sin SIPp real.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|---|---|---|---|
| Auto-updates 3CX desactivado | FIND-01 | Cambio en sistema externo (Web Console 3CX) — no automatizable desde código de plataforma | TI OLAM saca screenshot del panel 3CX mostrando "Auto-updates: disabled". Archivar en `docs/evidence/3cx-auto-updates-off-2026-05-XX.png`. |
| Smoke test corre clean contra 3CX real | BLOCK-01/02 (criterio agregado #1) | Requiere VPN OLAM activa, SSH al 3CX vivo, y la extensión válida de OLAM-01 confirmada — no se puede CI-ear | Tras ejecutar Wave 1 completa: `curl -X POST http://localhost:3000/api/tests/run -d '{"scenario":"smoke","destination":"<ext-valida>"}' && sleep 35 && curl http://localhost:3000/api/history?limit=1`. Verificar `result: PASS` y `snapshots` no vacíos. |
| AlertPanel diferencia visualmente 3 estados | BLOCK-03 (criterio #3) | Requiere observar el dashboard en navegador con tres condiciones simuladas | (a) Detener SSH al 3CX → ver alerta CRÍTICO "SSH caído". (b) Restaurar SSH y dejar el 3CX en idle nocturno → ver INFO "Sin tráfico real". (c) Modificar regex del parser para no matchear y reiniciar → ver ALTO "Parser roto". |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (jest setup + fixtures + mocks)
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter (planner sets this when all tasks have automated/manual entry)

**Approval:** pending — planner confirma cuando rellene la per-task verification map con IDs reales.
