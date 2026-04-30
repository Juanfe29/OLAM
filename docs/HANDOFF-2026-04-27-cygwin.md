# Handoff — Sesión Cygwin/SIPp 2026-04-27 (sesión 3 del día)

> Tercera sesión del 27. Foco: ejecutar el plan `PLAN-Cygwin-SIPp.md` end-to-end. Resultado: SIPp instalado, compilado, wired-up al backend y enviando paquetes reales al 3CX. Bloqueador descubierto: 407 auth challenge.

---

## TL;DR

- ✅ **Cygwin per-user instalado** en `C:\Users\lamda\cygwin64\` (1.5 GB).
- ✅ **SIPp v3.7.3 compilado** desde source. Binario en `C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe`.
- ✅ **Backend wired-up** vía nueva env var `SIPP_BIN`. Cambio mínimo en `sippManager.js:136`.
- ✅ **Smoke test confirma stack real**: el `INVITE` llega al 3CX y este responde con `407 Proxy Authentication Required`. La autenticación es el próximo bloqueador, no el wire-up.

---

## Sesión paso a paso

### Fase 1 — Bundle en laptop dev (~10 min)

Bajado en mi laptop `C:\Users\Maximiliano Pulido\cygwin-bundle\`:
- `setup-x86_64.exe` (1.5 MB)
- `packages/` (179 MB, 154 paquetes pre-resueltos por el setup)
- `sipp-3.7.3.tar.gz` (0.88 MB)
- Empaquetado en `cygwin-bundle.zip` (183 MB) con `[System.IO.Compression.ZipFile]::CreateFromDirectory` con `NoCompression` (los paquetes ya vienen comprimidos en xz/zst).

**Desviación 1 del plan**: el plan pedía `libpcap-devel`, `ncurses-devel`, `openssl-devel`. Esos nombres no existen en Cygwin actual (2026). Quedaron fuera `libpcap-devel` y `openssl-devel` (compilamos con `USE_PCAP=0` `USE_SSL=0`); `ncurses-devel` se renombró a `libncurses-devel`.

### Fase 2 — Transfer al RDP (~30s)

Drive redirection del RDP estaba configurada pero la sesión inicial no la había habilitado. Reconectado con "Unidades" tildado en `mstsc`. Copy via `\\tsclient\C\...\cygwin-bundle.zip` → `C:\Users\lamda\Downloads\cygwin-bundle.zip` (24.5 s) → expand a `C:\Users\lamda\cygwin-bundle\`.

Validado: `setup.ini` quedó cacheado dentro de `packages/.../x86_64/setup.ini` — el bundle es self-contained, el RDP sin internet puede instalar offline.

### Fase 3 — Install + compile (~25 min)

**Install** (5 min): `setup-x86_64.exe --no-admin --quiet-mode --local-install ...` — instaló sin pedir UAC. Toolchain confirmado: gcc 13.4.0, g++ 13.4.0, cmake 4.2.1, make 4.4.1.

**Desviación 2**: el tarball `sipp-3.7.3.tar.gz` que bajé del archivo auto-generado de GitHub no incluye un `version.h` válido — viene con un stub que aborta la build con `#error "This is a stub version.h"`. Workaround aplicado: sobreescribir `include/version.h` antes del segundo intento de make:

```c
#ifndef VERSION_H
#define VERSION_H
#define SIPP_VERSION "v3.7.3"
#endif
```

Después make-j2 completó en ~8 min. `sipp -v` confirmó `SIPp v3.7.3.`.

**Lección para el futuro**: bajar la *release oficial* desde [SIPp releases](https://github.com/SIPp/sipp/releases) en vez del tag tarball auto-generado.

### Fase 3.5 — sipp.exe desde Windows nativo

Validado el dual-mode:
- Sin `cygwin64\bin` en PATH → exit `0xC0000135` (DLL_NOT_FOUND, falta `cygwin1.dll`).
- Con `cygwin64\bin` en PATH → `SIPp v3.7.3.` ok.

Persistido en user PATH del RDP vía `[Environment]::SetEnvironmentVariable("Path", ..., "User")`.

### Fase 4 — Wire up backend

**Edit en código:**
```diff
- const sippBin = os.platform() === 'win32' ? 'sipp.exe' : 'sipp';
+ const sippBin = process.env.SIPP_BIN || (os.platform() === 'win32' ? 'sipp.exe' : 'sipp');
```
Files: `backend/src/services/sippManager.js:136`, `backend/.env.example` (doc del var).

**Config en RDP:** `backend/.env` con `SIPP_BIN=C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe`.

**Restart**: backend arrancó normal, banner `[OLAM] Backend running on http://localhost:3000 [PRODUCTION MODE]` y `[SSH] Connected to 172.18.164.28`.

### Fase 5 — Smoke end-to-end

```
POST /api/tests/run  body={"scenario":"smoke"}  →  testId 5, max_calls 1, 30s, ext 100
```

Backend logueó la invocación correctamente:
```
[SIPp] C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe 172.18.164.28:5060 -sn uac -s 100 -m 1 -r 1 -d 30000 -trace_err -trace_stat -nostdin
[SIPp] Test 5 finished: ERROR
```

Diagnóstico corriendo `sipp` manualmente con los mismos args mostró:
```
Aborting call on unexpected message ... while expecting '180' (index 2),
received 'SIP/2.0 407 Proxy Authentication Required
Proxy-Authenticate: Digest nonce="...",algorithm=MD5,realm="3CXPhoneSystem"
```

**Conclusión**: el wire-up Cygwin está perfecto. El 3CX exige digest auth, y `-sn uac` no maneja 407 challenges. **Lo siguiente es Fase 6.**

---

## Fase 6 — Digest auth (próxima sesión)

Tres opciones documentadas en [PLAN-Cygwin-SIPp.md](./PLAN-Cygwin-SIPp.md#fase-6--digest-auth-para-que-la-407-deje-de-bloquear). Recomendado:

1. **Empezar por opción A** (`-au`/`-ap`): cambio chico en sippManager.js, dos env vars nuevas. Permite destrabar el smoke. Requiere creds de una extensión del 3CX (sugerido pedirle a OLAM una ext `999` dedicada para tests).
2. **Migrar a opción B** (XML custom) antes de cualquier load test serio (peak: 180 calls, soak: 4hs).
3. **Evitar opción C** (anonymous trunk en 3CX) — agujero de seguridad innecesario.

### Pre-requisitos antes de empezar Fase 6

- [ ] Pedir a OLAM/sysadmin del 3CX: extensión de test + password.
- [ ] Confirmar permiso de esa ext para llamar a otras extensiones internas.
- [ ] Decidir A vs B con el usuario.

---

## Estado de archivos al fin de esta sesión

### En el repo (commited en este push)

- `backend/src/services/sippManager.js` — soporte para env var `SIPP_BIN`.
- `backend/.env.example` — doc del nuevo `SIPP_BIN`.
- `docs/PLAN-Cygwin-SIPp.md` — actualizado con sección "Ejecución" y Fase 6.
- `docs/HANDOFF-2026-04-27.md` — handoff de la sesión 2 (deploy + git migration).
- `docs/HANDOFF-2026-04-27-cygwin.md` — este documento.

### En el RDP (no en el repo)

- `C:\Users\lamda\cygwin64\` — install Cygwin (1.5 GB).
- `C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe` — binario SIPp.
- `C:\Users\lamda\OLAM\backend\.env` — copia local con `SIPP_BIN` agregado.
- User PATH actualizado para incluir `C:\Users\lamda\cygwin64\bin`.

### En mi laptop (no en el repo)

- `C:\Users\Maximiliano Pulido\cygwin-bundle\` (~180 MB) y `cygwin-bundle.zip` (183 MB) — bundle de instalación. Útil si hay que reinstalar Cygwin en otra máquina sin internet.

---

## Cuidados al cerrar sesión

Mismo procedimiento del handoff anterior:
1. **Antes de cerrar el RDP**, Ctrl+C en la terminal del backend (`npm start`).
2. Cerrar la ventana RDP con la **X**, NO con "Cerrar sesión" (procesos zombies).
3. Para retomar:
   ```powershell
   Get-Process node -ErrorAction SilentlyContinue   # chequeo zombies
   cd C:\Users\lamda\OLAM\backend; npm start
   ```

---

## Ref

- Plan ejecutado: [PLAN-Cygwin-SIPp.md](./PLAN-Cygwin-SIPp.md)
- Handoff anterior del mismo día (sesión 2 — deploy operativo): [HANDOFF-2026-04-27.md](./HANDOFF-2026-04-27.md)
- Setup completo del deployment: [HANDOFF-2026-04-25.md](./HANDOFF-2026-04-25.md)
- SIPp authentication docs: https://sipp.readthedocs.io/en/latest/scenarios.html#authentication
