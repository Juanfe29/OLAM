# Handoff — Sesión 2026-05-02 (PM)

**Continuación del [HANDOFF-2026-05-02.md](./HANDOFF-2026-05-02.md).** Foco: completar pasos A→E del HANDOFF anterior, cazar bugs emergentes en el deploy real, validar smoke + light tests contra el 3CX.

**Estado al cierre:** GSD Phase 1 efectivamente cerrada. Plataforma corriendo en `.35` con tests reales contra `172.18.164.28` produciendo evidencia con CSV parseado correctamente.

---

## TL;DR

1. Pasos A→E del HANDOFF anterior: ✅ todos cerrados.
2. 5 bugs nuevos descubiertos en el deploy real, todos corregidos en el commit de esta sesión.
3. Tests reales aprobados: smoke (1 call), light (10 calls concurrent), BLOCK-01 negativo (rejection 999).
4. Pendiente: BLOCK-03 `ssh_down` (diferida — se puede simular sin tocar `.28`), FIND-01 (coordinación TI OLAM, async).

---

## Lo que se hizo en esta sesión

### Deploy a `.35` por RDP folder redirection (no por bundle base64)

El path del bundle base64 del HANDOFF anterior **no se usó**. Lo reemplazamos por **RDP folder redirection** que sí funciona en este cliente Mac (Microsoft Remote Desktop):

1. App de RDP → Edit connection → **Folders** tab → ✅ Redirect folders → agregar `/Users/juanfelipe/Documents/ISOMORPH AI/OLAM` → reconnect.
2. En `.35`, la carpeta aparece como `\\tsclient\OLAM\...`.
3. Para sincronizar `node_modules` (4000+ archivos), `Copy-Item` no es fiable en árboles profundos. Usar **`robocopy`**:
   ```powershell
   robocopy "\\tsclient\OLAM\backend\node_modules" "C:\Users\lamda\OLAM\backend\node_modules" /E /MT:8 /NFL /NDL
   ```

### Bugs descubiertos y corregidos

#### 1. SIPp Cygwin requiere PATH con `cygwin64\bin`
**Síntoma:** `runRealSipp` spawneaba `sipp.exe`, exit code 0 silencioso, CSV nunca aparecía. Snapshots vacíos → FAIL falso.
**Root cause:** `child_process.spawn` hereda PATH del backend (Windows nativo), NO del shell de Cygwin. `sipp.exe` necesita `cygwin1.dll` que vive en `cygwin64\bin\`.
**Fix:** nueva env var `CYGWIN_BIN_PATH`, prepended al PATH del proceso hijo. Sin ella, sipp arranca y muere antes de escribir nada. ([sippManager.js:178-181](../backend/src/services/sippManager.js#L178-L181))

```env
CYGWIN_BIN_PATH=C:\Users\lamda\cygwin64\bin
SIPP_BIN=C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe
```

#### 2. SIPp 3.7.3 (Cygwin) no usa el sufijo `_statistics.csv`
**Síntoma:** después del fix de PATH, SIPp corría OK, exit 0, pero el reader seguía cayendo al fallback de stderr (`csvMissing: true`).
**Root cause:** La doc de SIPp 3.7+ promete `<scenario>_<pid>_<timestamp>_statistics.csv`. La build de Cygwin observada en `.35` escribe `<scenario>_<pid>_.csv` (ej. `uac_1402_.csv`).
**Fix:** filtro relajado a `*.csv` en `findStatisticsFile` y `waitForStatisticsFile`. El cwd es dedicado por test (`os.tmpdir()/olam-sipp-{ts}`), no hay riesgo de pisar otro archivo. ([sippStatisticsReader.js:42, 80](../backend/src/services/sippStatisticsReader.js))

#### 3. `peakReached` mal calculado por snapshots sparse en tests cortos
**Síntoma:** smoke (1 call, 30s) reportaba `Max concurrent: 0` aunque la llamada se completó OK. `peakReached: false` → test marcado FAIL aunque `successful=1`.
**Root cause:** SIPp escribe stats periódicamente al CSV. Con 1 llamada de 30s, los 3 snapshots caen entre rows con `CurrentCall=0`. La métrica de pico transient se pierde.
**Fix:** `peakReached` ahora basado en `total` (`TotalCallCreated` cumulativo) en vez de `maxConcurrent` (`CurrentCall` peak). El light test (10 calls) confirmó que con tests más largos/grandes el peak SÍ se captura — el problema era específico de cargas cortas. ([sippManager.js:265-272](../backend/src/services/sippManager.js#L265-L272))

#### 4. Frontend mostraba campos legacy del summary
**Síntoma:** Test 26 PASS, pero History detail mostraba `Max calls: 0` y `Avg calls: —`.
**Root cause:** `History.jsx` y `Tests.jsx` tenían hardcoded los campos legacy (`maxCalls`, `avgCalls`). El summary CSV usa `totalCalls`, `successful`, `failed`, `callRate`, etc.
**Fix:** branch en UI por `summary.source === 'csv'`. Cuando viene del CSV se muestran los campos nuevos; sino caen al formato legacy (backward-compat con tests viejos pre-fix guardados en SQLite). ([History.jsx:140-160](../frontend/src/pages/History.jsx#L140-L160), [Tests.jsx:111-127](../frontend/src/pages/Tests.jsx#L111-L127))

#### 5. Vite proxy apuntaba al puerto incorrecto
**Síntoma:** Frontend cargaba la UI pero `/api` y `/socket.io` daban ECONNREFUSED.
**Root cause:** `vite.config.js` tenía hardcoded `localhost:3000`, pero `.env` define `PORT=3001`.
**Fix:** cambio a `localhost:3001`. ([vite.config.js:9-11](../frontend/vite.config.js#L9-L11))

### Logging extra en runtime

Para futuros diagnósticos, `runRealSipp` ahora loggea durante la ejecución:
- stderr filtrado por keywords de error (`error|fatal|cannot|unable|undefined symbol|.dll|terminat`)
- stdout completo (línea por línea)
- exit `code` + `signal` en el `close` handler
- contenido del `cwd` post-mortem (lista de archivos generados)
- `csvSummary` parseado y `summary` final (JSON inline)

Útiles cuando algo se cuelga o falla silencioso. Costo de ruido aceptable durante Phase 1; pueden moverse a debug level más adelante si molesta.

### Tests reales contra 3CX (extensión 1910)

| Test | Result | Evidencia |
|---|---|---|
| Destino `999` (rejection) | 400 + mensaje | `"Extensión 999 no está en la lista de destinos válidos del 3CX. Configurar VALID_EXTENSIONS en .env. Extensiones permitidas: 1910."` |
| Smoke (1 call, 30s, ramp 1) | PASS | `totalCalls=1, successful=1, source=csv` |
| Light (10 calls, 60s, ramp 2/s) | PASS | `totalCalls=10, successful=10, **maxConcurrent=10**, callRate=0.15 cps, errorRate=0%, peakReached=true` |

**El light test es la primera evidencia de la plataforma soportando carga concurrente sostenida con 100% ASR.** Línea base inicial para E·04 (informe ejecutivo de la propuesta comercial).

---

## Pendientes para próxima sesión

### A. BLOCK-03 `ssh_down` — validar sin tocar `.28`

El HANDOFF anterior proponía `iptables -A INPUT -p tcp --dport 22 -s 172.18.164.35 -j DROP` en producción. Mejor alternativa: simular el corte localmente sin tocar el 3CX.

Opciones (cualquiera sirve):

1. Cambiar `.env` `SSH_HOST=10.0.0.1` (IP unreachable) y reiniciar backend. SSH falla, después de 30-60s aparece alerta CRITICO `ssh_down` en dashboard. Revertir → alerta se limpia.
2. Bloquear puerto 22 outbound en Windows Firewall del `.35` por 60s.
3. Forzar `ssh.dispose()` desde una ruta admin temporal (requiere agregar endpoint).

La opción 1 es la más limpia y reversible. **Esperado:** alerta CRITICO aparece en `<60s` y desaparece al restaurar.

### B. FIND-01 — coordinación TI OLAM (async, no bloqueante)

Sin cambios respecto al HANDOFF anterior:

1. Mail/llamada con TI OLAM para coordinar ventana ~5 min.
2. Disable auto-updates en consola 3CX → screenshot.
3. Archivar en `docs/evidence/3cx-auto-updates-off-2026-05-XX.png` (crear el dir si no existe).
4. Commit del evidence.

**No bloquea la redacción de los documentos comerciales** (E·01..E·05). Lo único que cambia es si en E·04 podemos decir "auto-updates desactivado, evidencia archivada" o "pendiente de coordinar".

### C. Custom 25 calls — empujar al techo SC32

Con licencia actual (SC32) podemos llegar hasta ~25-28 simultáneas sin que el 3CX rechace. Próximo test sugerido:

```
custom: { calls: 25, duration: 90, ramp: 5, destination: '1910' }
```

Eso da el segundo data point de carga real, útil para E·04. Después de eso, **bloqueador externo: trial SC192** para llegar a 50/180/220.

### D. Bloqueadores externos a comunicar a OLAM

1. **Activar trial SC192** — sin esto no podemos validar el objetivo de 180 simultáneas de la propuesta.
2. **Coordinar ventana de mantenimiento** para tests >50 calls (regla heredada de CLAUDE.md).
3. **Confirmar credenciales adicionales** — hoy solo extensión 1910 está allowlistada en `VALID_EXTENSIONS` y validada con digest auth (`SIPP_AUTH_USER=1910`).
4. **FIND-01 (auto-updates)** — ver punto B arriba.

### E. Métricas placeholder en producción (documentar en E·05)

En `MOCK_MODE=false`, estos campos van hardcoded a 0 / valores fijos en `metricsCollector.js`:
- `pdd`, `asr`, `mos`, `jitterMs`, `packetLoss` → placeholders, requieren integración con 3CX Call Control API.
- `queue.waiting`, `agentsOnline`, `serviceLevel`, `abandonment` → requieren parser dedicado de `3CXQueueManager.log`.

Mapean a Phase 5 del ROADMAP GSD (KPIs completos). Documentar como gap conocido en E·05 de la propuesta.

---

## Estado del repo

- Branch `main` al día con `origin/main` después del push.
- `node_modules/` y `.env` NO commiteados (gitignore correcto).
- Nuevo entry en `.gitignore`: `*.tar.gz` / `*.bundle` / `olam-bundle*` para evitar que se filtren artifacts de transferencia.

---

## Refs cruzadas

- Handoff anterior: [HANDOFF-2026-05-02.md](./HANDOFF-2026-05-02.md)
- Propuesta comercial: PDF entregado por el usuario (fases comerciales 0/1 mapean a GSD phases 0/1+5 internas).
- ROADMAP GSD: [.planning/ROADMAP.md](../.planning/ROADMAP.md)
- Decisiones técnicas Phase 1: [.planning/phases/01-unblock/01-CONTEXT.md](../.planning/phases/01-unblock/01-CONTEXT.md)

---

*Handoff escrito: 2026-05-02 al cierre de la sesión PM.*
*Próxima sesión: arrancar por §"Pendientes para próxima sesión" → A (validar `ssh_down` con `SSH_HOST` mock).*
