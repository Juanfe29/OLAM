# Handoff — Sesión 2026-05-05 (PM)

**Continuación del [HANDOFF-2026-05-05.md](./HANDOFF-2026-05-05.md).** Esta sesión PM resolvió el bloqueante de credenciales y descubrió que el techo real **no es del SC256, sino de la extensión personal usada como destino**.

**Estado al cierre:** SIPp pasa tests exitosamente contra el `.33` con tráfico IP-based via SIP Trunk dedicado. **Test 10 calls = PASS (10/10 successful)**. Test 220 calls saturó a 11 concurrent porque la extensión 1910 es single-line. Para validar SC256 real falta crear un destino multi-canal.

---

## TL;DR

1. **Hallazgo del bloqueante 403:** los INVITEs de SIPp eran tratados como `Unidentified Incoming Call` por el 3CX porque `172.18.164.35` no estaba registrada como fuente SIP conocida.
2. **Solución implementada:** crear un **SIP Trunk** "OLAM SIPp Tester" en el `.33` con autenticación IP-based apuntando a `172.18.164.35`.
3. **Resultado:** las llamadas pasan limpias — `INVITE → 100 → 180 → 200 → ACK → BYE → 200`.
4. **Test 10 calls = PASS:** 10/10 successful, 0 failed, peak 10 concurrent.
5. **Test 220 calls = ERROR útil:** 20/220 successful, peak 11 concurrent. **El techo NO es del 3CX SC256 — es de la extensión 1910** que saturó con `600 Busy Everywhere - All lines busy`.
6. **Próximo paso:** crear un destino multi-canal (cola/ring group/IVR drop) para medir el techo real del SC256.

---

## Lo que se hizo en esta sesión

### 1. Acceso al Admin del `.33` por IP directa

Validamos que **`https://172.18.164.33:5001` SÍ abre el Admin Console del `.33` desde `.35`**, distinto del que sirve `regist2026.3cx.co` (que va al `.28`).

| URL | Server | License |
|-----|--------|---------|
| `https://regist2026.3cx.co` | `.28` (DNS redirect) | SC32 (32 calls) |
| `https://172.18.164.33:5001` | `.33` directo | **SC256 (256 calls)** |

El dashboard del `.33` confirmó:
- Type: **Professional Annual 256 Simultaneous Calls**
- Expires: **Mar 1, 2027**
- 3CX FQDN: `regist2026.3cx.co` (con "t")
- User/Ext: 341/2048
- Trunks: ❌ (Tigo UNE rojo, igual que en `.28`)

### 2. Generación de credenciales SIP en `.33`

Generadas via Users → 1910 → IP Phone → "Configure a Phone" → "I will configure the phone myself":

```
Authentication ID:      Cnzj6lYTS0
Authentication password: vttG5j37hn
Registrar Hostname:     regist2026.3cx.co (con "t" — confirma que es del .33)
```

**No se llegaron a usar** — fueron descartadas al cambiar a IP-based via SIP Trunk (siguiente paso). Quedan en el .env comentadas para referencia futura.

### 3. Diagnóstico del 403 Invalid credentials

Aplicamos cambios incrementales y miramos el Event Log del `.33`. El mensaje clave:

> **"Unidentified Incoming Call. Review INVITE and adjust source identification"**

Eso confirmó que el 3CX no estaba reconociendo los INVITEs de SIPp como provenientes de la extensión 1910 — los trataba como llamadas anonymous inbound. Por seguridad anti-fraude, los rechazaba con `403 Invalid credentials` aunque las credenciales fueran correctas.

**Causa raíz:** el `IP Phone` de una extensión espera que el dispositivo se registre vía SIP `REGISTER` antes de poder enviar `INVITEs`. SIPp no se registra — solo manda INVITEs. Por eso el 3CX trata cada INVITE como llamada anónima.

### 4. Solución: SIP Trunk dedicado para SIPp

En el Admin del `.33` → Voice & Chat → Add Trunk → "Generic SIP Trunk (IP Based)":

| Campo | Valor |
|-------|-------|
| Name | `OLAM SIPp Tester` |
| Default route | User → 1910 Admin lamda |
| Main Trunk Number | `5001` |
| **Type of authentication** | **Do not require - IP based** |
| **Registrar/Server** | **`172.18.164.35`** |
| Port | 5060 |

**Eso le dice al 3CX:** "tráfico SIP desde 172.18.164.35:5060 es legítimo de un trunk, sin necesidad de auth. Ruteá las llamadas según el Default Route".

El `Outbound Rule` que ofrece crear automáticamente tras el trunk **se descartó** (back arrow) — no lo necesitamos y crearía conflicto con el routing existente.

### 5. Limpieza del flow de auth

Como el trunk autentica por IP, las credenciales SIP digest ya no son necesarias. En el `.env` de `.35`:

```env
#SIPP_AUTH_USER=Cnzj6lYTS0
#SIPP_AUTH_PASS=vttG5j37hn
```

Comentadas con `#`. El `sippManager.js` detecta su ausencia y usa `-sn uac` (built-in sin auth) en vez del scenario XML. Comando resultante:

```
sipp.exe 172.18.164.33:5060 -sn uac -s 1910 -m 10 -r 2 -d 60000 -t u1 -recv_timeout 15000 -trace_err -trace_stat -nostdin
```

Sin `-sf`, sin `-au`, sin `-ap`. Limpio.

### 6. Desactivación de "Block remote non-tunnel connections"

Adicionalmente, en la pestaña Options de la extensión 1910 desactivamos:

```
☐ Block remote non-tunnel connections (Insecure!)
```

(Estaba ✅ por default). Esta opción es de seguridad para producción pero impide tests automatizados con SIPp puro UDP.

**Para el reporte:** restablecer en producción cuando los tests terminen, salvo que se mantenga la extensión 1910 dedicada solo para load testing.

---

## Resultados de los tests

### Test 59 — 10 calls — ✅ PASS

```
0 :      INVITE ---------->         10        0         0
1 :         100 <----------          6        0         0         0
2 :         180 <----------         10        0         0         0
4 :         200 <---------- E-RTD1  10        0         0         0
5 :         ACK ---------->         10        0
6 :       Pause [     1:00]         10                            0
7 :         BYE ---------->         10        0         0
8 :         200 <----------         10        0         0         0
```

**Resumen:**
- Total calls: 10
- Successful: **10**
- Failed: **0**
- Peak concurrent: **10**
- Call rate: 0.15 cps
- Result: **PASS**

CSV parseado correctamente. End-to-end SIP signaling validado con un destino single-line.

### Test 60 — 220 calls — ❌ ERROR (pero útil)

```
0 :      INVITE ---------->        220        0         0
1 :         100 <----------         11        0         0       193
2 :         180 <----------         20        0         0         7
4 :         200 <---------- E-RTD1  20        0         0         0
5 :         ACK ---------->         20        0
6 :       Pause [     1:00]         20                            0
7 :         BYE ---------->         20        0         0
8 :         200 <----------         20        0         0         0
```

**Respuesta del 3CX:**
```
SIP/2.0 600 Busy Everywhere
Warning: 499 regist2026.3cx.co "All lines busy"
```

**Resumen:**
- Total calls: 220
- Successful: **20** (las primeras que entraron antes de saturar 1910)
- Failed: **200** con `600 Busy Everywhere`
- Peak concurrent: **11** (NO 220)
- Call rate: 1.75 cps
- Result: ERROR

---

## Hallazgo crítico para el reporte

**El techo medido NO es del 3CX SC256, sino de la extensión 1910 (single-line user extension).**

Una extensión personal típicamente acepta:
- 1 llamada a la vez por defecto
- Hasta ~10 con "Call Waiting / Multiple Calls" habilitado

Las llamadas 12+ → `600 Busy Everywhere - All lines busy`. Las 20 que aparecen como successful no fueron concurrent — son acumulativas durante los 125s del test (entre el ramp y la pause de 60s, algunas llamadas se desocuparon dejando hueco para que entraran nuevas).

**Esto significa que aún NO sabemos cuántas concurrent reales soporta el SC256.** Para medirlo, el destino tiene que ser multi-canal.

---

## Lo que falta para validar el SC256 real

### Opción A — Crear una Queue (recomendada)

En el Admin del `.33`:
1. **Call Handling** (menú lateral) → **Add Queue**
2. Number: e.g. `9000`
3. Asignar **muchas extensiones como agentes** (los Agente 1-256 que vimos en Users)
4. Polling Strategy: Ring All / Round Robin
5. Save

Después en `.env` o desde el dashboard, cambiar `destination` de `1910` a `9000`.

Una queue puede aceptar muchas llamadas concurrent porque las distribuye entre los agentes.

### Opción B — Ring Group

Más simple que queue. Ring Groups en 3CX → Add Ring Group con muchas extensiones. Limitación: si todas las extensiones del ring group están ocupadas, satura igual.

### Opción C — IVR de drop

Crear un IVR con un menú breve que **descarta la llamada** después del mensaje. Cada llamada se contesta y termina rápido, alta concurrencia teórica. Útil específicamente para load testing.

### Opción D — Ajustar 1910 para más simultáneas

Pesado y artificial. La extensión 1910 puede aumentar `Multiple Calls per Line` pero el límite teórico de una user-extension es bajo (típicamente ≤16).

---

## Cambios de archivos en esta sesión

### Modificados (solo en .35, NO commiteados)

- `backend/.env` — credenciales SIP digest comentadas con `#`. Las credenciales `Cnzj6lYTS0`/`vttG5j37hn` quedaron documentadas en este handoff por si se vuelven a usar.

### Configuración del 3CX (no es archivo, queda en el server `.33`)

- **Nuevo SIP Trunk:** "OLAM SIPp Tester" — Generic SIP Trunk IP Based, apunta a `172.18.164.35:5060`
- **Extensión 1910 → Options:** "Block remote non-tunnel connections" desactivado

### Sin cambios al código

El `sippManager.js` y `uac_auth.xml` no se modificaron en esta sesión PM. Los cambios anteriores (auth scenario + scenario auto-switch según presencia de credenciales) siguen siendo correctos. Cuando hay credenciales en `.env` se usa scenario XML; cuando no, `-sn uac` built-in.

---

## Para el próximo dev — primer paso

1. **Crear destino multi-canal** en el `.33` (recomendado: Queue 9000 con muchos agentes).
2. **Cambiar destino del test** desde el dashboard de `.35` (campo "Destination") a `9000`.
3. **Correr tests progresivos** con el nuevo destino:

| Test | Calls | Ramp | Esperado |
|------|-------|------|----------|
| 1 | 30 | 5 | PASS — supera el límite SC32 del .28, valida que el SC256 está activo |
| 2 | 50 | 5 | PASS |
| 3 | 100 | 10 | PASS |
| 4 | 180 | 10 | PASS — peak operativo objetivo del cliente OLAM |
| 5 | 256 | 15 | Acá medimos el techo real del SC256 |
| 6 | 300 | 20 | Debería fallar — sobre licencia. Confirma rejection con `503` o similar |

4. **Mientras corren, capturar:**
   - Métricas del host del `.33` (CPU/RAM via SSH/node_exporter)
   - Logs del 3CX vía SSH (con log level subido a Info para ver llamadas individuales)
   - Output completo de SIPp (CSV + errors.log)
   - Active Calls en el dashboard del 3CX

5. **Al terminar, restablecer las opciones de seguridad** en el 3CX:
   - "Block remote non-tunnel connections" en 1910 → ON
   - Considerar borrar el SIP Trunk "OLAM SIPp Tester" o dejarlo solo para tests futuros
   - Limpiar la blacklist de IPs si quedó algo del .35

---

## Datos importantes consolidados (al cierre PM)

### Servers

| IP | Rol | Acceso Admin | Licencia | Estado |
|----|-----|--------------|----------|--------|
| `172.18.164.28` | 3CX prod (viejo) | `https://regist2026.3cx.co` (DNS) | SC32 | OK |
| `172.18.164.33` | 3CX trial (target) | `https://172.18.164.33:5001` (IP directa) | **SC256** | ✅ Funcional con SIPp via trunk |
| `172.18.164.35` | Win10 cliente OLAM | RDP | — | ✅ OLAM corriendo |

### Configuración persistente en `.33`

- **SIP Trunk OLAM SIPp Tester:** Apunta a `172.18.164.35:5060` con IP-based auth → permite que SIPp envíe INVITEs sin auth digest
- **Extensión 1910 → Options:** "Block remote non-tunnel connections" OFF
- **Extensión 1910 → IP Phone:** Configurado con Generic IP Phone (Auth ID `Cnzj6lYTS0`, Password `vttG5j37hn`) — actualmente sin uso pero queda en el server

### Credenciales (no se commitean al repo, solo en `.env` de `.35`)

```env
SSH_HOST=172.18.164.33
SSH_USER=root
SSH_PASSWORD=Olam2026$

# Comentadas — auth IP-based via trunk
#SIPP_AUTH_USER=Cnzj6lYTS0
#SIPP_AUTH_PASS=vttG5j37hn
```

### Web logins

- 3CX `.33`: `https://172.18.164.33:5001` — `1910` / `Lamda2026$04` (System Owner)
- 3CX `.28`: `https://regist2026.3cx.co` — `1910` / `Lamda2026$04` (mismo user en ambos servers)

---

## Hallazgos consolidados para el reporte del assessment

| # | Hallazgo | Evidencia | Severidad para reporte |
|---|----------|-----------|------------------------|
| H-08 | Anti-fraude del 3CX activo (blacklist por 403 repetidos) | IP `.35` blacklisteada después de tests fallidos; Jose la liberó manualmente | ✅ Positivo (security) |
| H-09 | Web login password ≠ SIP authentication password | `Lamda2026$04` autentica web pero el SIP usa otro password generado al provisionar IP Phone | Informativo |
| H-10 | Servers `.28` y `.33` son independientes (no cluster) | Credenciales del .28 no autentican en .33 | Informativo (afecta operación) |
| H-11 | Logs del 3CX en log level "Warning" — sin trazabilidad de llamadas | No hay líneas de INVITE en logs; el dashboard de OLAM no puede mostrar calls activas | Sugerencia: subir a Info durante audits |
| H-12 | Files de output de SIPp en directorio del scenario | Workaround funciona, pero archivos quedan mezclados con scenarios | TODO menor |
| **H-13** | **3CX requiere IP source identification para tests SIP** | **`Unidentified Incoming Call` rechazado con 403; resuelto con SIP Trunk IP-based dedicado** | ✅ **Positivo (anti-fraud SIP), cumple con buena práctica** |
| **H-14** | **Extensión personal saturó a ~11 concurrent (no SC256)** | **Test 220 calls → peak 11 → 600 Busy Everywhere "All lines busy"** | ⚠️ **Sin destino multi-canal no se mide el SC256 real** |
| H-15 | Trunk Tigo UNE rojo en `.33` (igual que en `.28`) | Dashboards de ambos servers muestran trunk down | ⚠️ Coherente con H-03 del CLAUDE.md |

---

## Plataforma OLAM — estado funcional al cierre

| Componente | Estado | Notas |
|-----------|--------|-------|
| Backend (Node.js + nodemon) | ✅ OK | Puerto 3001, conecta SSH al .33 |
| Frontend (Vite) | ✅ OK | Puerto 5173, dashboard accesible |
| SQLite (test history) | ✅ OK | Tests 41-60 registrados |
| SIPp Cygwin | ✅ OK | Bin en `cygwin64\home\lamda\sipp-3.7.3\` |
| Dashboard métricas host | ✅ OK | CPU/RAM via node_exporter local |
| Dashboard métricas 3CX (calls activas) | ⚠️ Vacío | Log level Warning en `.33` (sin INVITEs en logs) |
| SIP signaling tests | ✅ OK | Trunk IP-based funcional |
| Tests progresivos | ⏳ Bloqueado por destino single-line | Falta crear queue/IVR multi-canal |

**El producto OLAM Audit funciona end-to-end.** El bloqueo restante es de configuración del 3CX (crear destino multi-canal), no de la plataforma.
