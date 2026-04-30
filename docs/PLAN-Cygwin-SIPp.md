# Plan — SIPp vía Cygwin en `172.18.164.35`

> Plan de acción para destrabe del modo activo del audit. Decidido el 2026-04-27. Listo para ejecutar en próxima sesión.
>
> **Estado: ejecutado el 2026-04-27. Fases 1-5 completadas. Próximo paso: Fase 6 (digest auth) — ver final del documento.**

---

## Decisión

Se descartaron WSL (sin admin), binarios SIPp Windows (no oficiales, riesgo) y Node UAC custom (reinventa la rueda + reporte más débil).

**Camino elegido:** instalar **Cygwin per-user** en `172.18.164.35`, compilar **SIPp desde source** dentro de Cygwin. Resultado: `sipp.exe` real corriendo desde el host del backend, sin admin, sin tocar el 3CX.

**Por qué este camino y no Node UAC:**
- "Tests con SIPp v3.x" en el reporte de assessment es defensa inmediata; "custom Node UAC" requiere justificar.
- SIPp soporta RTP / MOS aproximado / escenarios pre-built — Node UAC no.
- Una vez resuelto, sirve para futuros assessments. Node UAC sería código que mantenemos eternamente.

**Trade-off aceptado:** ~500MB de footprint en `172.18.164.35` y compilación que puede fallar con deps de Cygwin (mitigable con flags y fallback a Node UAC si hace falta).

---

## Pre-requisitos para arrancar

Validar al inicio de la sesión:

- [ ] VPN Fortinet conectada (ver IP asignada con `ipconfig` o `Test-NetConnection 172.18.164.28 -Port 22`)
- [ ] RDP a `172.18.164.35` con drive redirection habilitado (la opción ya está guardada en mstsc — si no, ver `HANDOFF-2026-04-25.md` sección "RDP setup")
- [ ] Backend corriendo en `172.18.164.35:3000` (validar con `Invoke-RestMethod http://127.0.0.1:3000/api/health`)
- [ ] Acceso a internet en MI laptop (no en el RDP — el RDP no tiene DNS)

---

## Fase 1 — Preparación en mi laptop (~1h)

### 1.1 Bajar Cygwin offline installer + paquetes

```powershell
# En mi laptop
$dir = "C:\Users\Maximiliano Pulido\cygwin-bundle"
New-Item -Path $dir -ItemType Directory -Force | Out-Null
$ProgressPreference = 'SilentlyContinue'

# Installer base
Invoke-WebRequest "https://www.cygwin.com/setup-x86_64.exe" -OutFile "$dir\setup-x86_64.exe"

# Pre-descargar paquetes (correr esto en mi laptop con internet)
& "$dir\setup-x86_64.exe" `
  --download `
  --no-shortcuts `
  --no-startmenu `
  --no-desktop `
  --no-admin `
  --quiet-mode `
  --site http://mirrors.kernel.org/sourceware/cygwin/ `
  --root "$dir\cygwin-fake-root" `
  --local-package-dir "$dir\packages" `
  --packages "bash,coreutils,gawk,gcc-core,gcc-g++,make,cmake,libpcap-devel,openssl-devel,ncurses-devel,git,wget,which"
```

> **Nota:** el flag `--download` solo descarga, no instala. Usamos un `--root` fake porque el flag es requerido aunque no se vaya a instalar nada.

### 1.2 Bajar el source code de SIPp

```powershell
# Tarball oficial de SIPp v3.7.3 (estable conocida)
Invoke-WebRequest "https://github.com/SIPp/sipp/archive/refs/tags/v3.7.3.tar.gz" -OutFile "$dir\sipp-3.7.3.tar.gz"
```

### 1.3 Empaquetar todo en un zip para transferir

```powershell
# Sin Compress-Archive (problema de path length conocido) — usar 7-Zip si está, o robocopy directo después
$zipDst = "C:\Users\Maximiliano Pulido\cygwin-bundle.zip"
Compress-Archive -Path "$dir\*" -DestinationPath $zipDst -Force
"Bundle: $zipDst — $([math]::Round((Get-Item $zipDst).Length / 1MB, 1)) MB"
```

> **Si el zip pesa >500MB**, mejor usar robocopy directo en Fase 2 (ver alternativa).

---

## Fase 2 — Transferencia al RDP (~15 min)

Adentro de la PowerShell del RDP en `172.18.164.35`:

### 2.1 Verificar drive redirection

```powershell
Test-Path "\\tsclient\C\Users\Maximiliano Pulido\cygwin-bundle.zip"
```

Si `False`, reconectar RDP con "Unidades" tildado en opciones → ver `HANDOFF-2026-04-25.md`.

### 2.2 Copiar el bundle (zip) o robocopy directo (sin zip)

**Opción A — vía zip (más rápido si robocopy es lento sobre el share):**
```powershell
$src = "\\tsclient\C\Users\Maximiliano Pulido\cygwin-bundle.zip"
$dst = "C:\Users\lamda\Downloads"
Copy-Item $src $dst -Force
Expand-Archive "$dst\cygwin-bundle.zip" -DestinationPath "C:\Users\lamda\cygwin-bundle" -Force
```

**Opción B — robocopy directo (evita problemas de paths largos en zip):**
```powershell
robocopy "\\tsclient\C\Users\Maximiliano Pulido\cygwin-bundle" "C:\Users\lamda\cygwin-bundle" /E /R:1 /W:1 /MT:8 /NFL /NDL /NP /NJH | Out-Null
```

### 2.3 Verificar contenido

```powershell
Get-ChildItem "C:\Users\lamda\cygwin-bundle" | Format-Table Name, @{N='MB';E={[math]::Round($_.Length/1MB, 1)}}
# Debe mostrar setup-x86_64.exe, packages\, sipp-3.7.3.tar.gz
```

---

## Fase 3 — Instalar Cygwin + compilar SIPp (~1h, mayor riesgo)

### 3.1 Instalar Cygwin per-user (sin admin)

```powershell
$bundle = "C:\Users\lamda\cygwin-bundle"
$cygRoot = "C:\Users\lamda\cygwin64"

& "$bundle\setup-x86_64.exe" `
  --no-shortcuts `
  --no-startmenu `
  --no-desktop `
  --no-admin `
  --quiet-mode `
  --site http://mirrors.kernel.org/sourceware/cygwin/ `
  --local-package-dir "$bundle\packages" `
  --root $cygRoot `
  --local-install `
  --packages "bash,coreutils,gawk,gcc-core,gcc-g++,make,cmake,libpcap-devel,openssl-devel,ncurses-devel,git,wget,which"
```

> **Si pide admin (UAC popup):** revisar que `--no-admin` esté en la línea. Algunas builds de Cygwin requieren admin igual — en ese caso, fallback a Node UAC.

### 3.2 Verificar Cygwin instalado

```powershell
& "C:\Users\lamda\cygwin64\bin\bash.exe" -lc "gcc --version && cmake --version && which make"
```

Debe mostrar versiones de gcc, cmake, y path de make.

### 3.3 Extraer y compilar SIPp

```powershell
# Copiar tarball al home de Cygwin
Copy-Item "$bundle\sipp-3.7.3.tar.gz" "$cygRoot\home\lamda\"

# Compilar dentro de Cygwin
& "$cygRoot\bin\bash.exe" -lc @"
cd ~
tar xzf sipp-3.7.3.tar.gz
cd sipp-3.7.3
cmake -DUSE_GSL=0 -DUSE_PCAP=0 -DUSE_SSL=0 -DUSE_SCTP=0 .
make -j2
./sipp -v
"@
```

> **Flags de compilación elegidas** para evitar deps que no compilan limpio en Cygwin:
> - `USE_GSL=0` — GNU Scientific Library, no la necesitamos para SIP básico.
> - `USE_PCAP=0` — packet capture, no la necesitamos (no vamos a hacer pcap injection).
> - `USE_SSL=0` — TLS, el 3CX usa UDP plano por ahora (ver hallazgo H-07 de Fase 0).
> - `USE_SCTP=0` — protocolo SCTP, no aplica.

### 3.4 Resultado esperado

`./sipp -v` debe mostrar algo como:
```
SIPp v3.7.3, version 20...
```

El binario queda en: `C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe`

### 3.5 Validar invocación desde Windows nativo (no desde Cygwin shell)

```powershell
$sippBin = "C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe"
$cygwinBin = "C:\Users\lamda\cygwin64\bin"
$env:Path = "$cygwinBin;$env:Path"
& $sippBin -v
```

> **Importante:** SIPp compilado en Cygwin requiere que `cygwin64\bin\` esté en el PATH para encontrar las DLLs (`cygwin1.dll`, etc). Sin eso, `sipp.exe` falla con "no se encuentra cygwin1.dll".

---

## Fase 4 — Wire up al backend (~30 min)

### 4.1 Persistir Cygwin en el PATH del usuario

```powershell
$cygwinBin = "C:\Users\lamda\cygwin64\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$cygwinBin*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$cygwinBin", "User")
}
```

### 4.2 Configurar el backend para usar el SIPp de Cygwin

Crear/editar `backend/.env` agregando:

```env
SIPP_BIN=C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe
```

### 4.3 Modificar `backend/src/services/sippManager.js` para usar `SIPP_BIN`

Cambiar [sippManager.js:136](../backend/src/services/sippManager.js#L136) de:
```js
const sippBin = os.platform() === 'win32' ? 'sipp.exe' : 'sipp';
```

A:
```js
const sippBin = process.env.SIPP_BIN || (os.platform() === 'win32' ? 'sipp.exe' : 'sipp');
```

### 4.4 Restart backend

En el RDP:
```powershell
# Matar backend actual (Ctrl+C en su terminal — recordar la lección de zombies)
cd C:\Users\lamda\OLAM\backend
npm start
```

---

## Fase 5 — Validación end-to-end (~30 min)

### 5.1 Smoke test desde Postman

Importar (si no está) `postman/OLAM-Audit.postman_collection.json` adentro del RDP. Ejecutar:

```
POST http://127.0.0.1:3000/api/tests/run
Body: {"scenario": "smoke"}
```

Esperado: `{ ok: true, testId: N, scenario: "smoke", max_calls: 1, ... }`

### 5.2 Monitorear en vivo el 3CX

En PARALELO, abrir SSH al 3CX y mirar logs + tcpdump:

```bash
ssh root@172.18.164.28 "tcpdump -i any -n 'src host 172.18.164.35 and udp port 5060' -c 10"
```

Esperado: capturar SYN/INVITE viniendo desde `172.18.164.35` cuando se ejecuta el smoke. **Eso prueba que es real, no mock.**

### 5.3 Verificar en el dashboard

Refrescar `http://localhost:5173` durante la prueba. La gráfica de "Llamadas activas" debe mostrar el spike de 1 llamada. El parser debe detectar el INVITE (eventos en logs).

### 5.4 Validar contra mock para contraste

Apagar backend, cambiar `MOCK_MODE=true`, restart. Repetir smoke. Esta vez el tcpdump del 3CX **NO debería ver tráfico** desde `172.18.164.35`. Eso prueba el contraste real vs ficción.

---

## Riesgos y fallbacks

### Riesgo 1: Cygwin requiere admin a pesar de `--no-admin`

**Probabilidad:** baja (Cygwin per-user es pattern soportado).
**Mitigación:** intentar con flag `--non-interactive` adicional. Si igual pide UAC, escalar al admin de OLAM con request: *"Necesitamos instalar Cygwin per-user en `C:\Users\lamda\cygwin64\` — no toca el sistema, ¿podés autorizar el UAC del setup una sola vez?"*.

### Riesgo 2: Compilación de SIPp falla por deps faltantes

**Probabilidad:** media (Cygwin a veces tiene versiones de libs raras).
**Mitigación:** ya pre-deshabilitamos PCAP/SSL/SCTP/GSL con flags. Si compila y falta alguna lib core, agregar al paquete Cygwin (`zlib-devel`, `libev-devel`, etc).
**Fallback duro:** si después de 1h de tunear no compila → cortar pérdidas, pasar a Node UAC.

### Riesgo 3: SIPp compilado funciona en Cygwin shell pero no desde Windows nativo

**Probabilidad:** baja (con `cygwin1.dll` en PATH funciona).
**Mitigación:** confirmar PATH user incluye `cygwin64\bin`. Si igual falla, usar invocación vía bash:
```js
spawn("C:\\Users\\lamda\\cygwin64\\bin\\bash.exe", ["-lc", "sipp args..."])
```

### Riesgo 4: Antivirus de OLAM bloquea Cygwin install

**Probabilidad:** media en entornos corporativos.
**Mitigación:** documentar inmediatamente para coordinar exclusión con admin.

### Riesgo 5: Performance pobre de SIPp sobre Cygwin

**Probabilidad:** media para >50 calls/s.
**Aceptable hasta:** light/medium tier (50 calls). Para peak (180) puede saturar el emulador POSIX.
**Mitigación:** documentar como limitación del entorno actual; load tests serios siguen requiriendo host Linux dedicado.

---

## Tiempo total estimado

| Fase | Tiempo | Riesgo |
|---|---|---|
| 1. Preparación en laptop | 1h | Bajo |
| 2. Transferencia al RDP | 15min | Bajo |
| 3. Install + compile | 1h | **Alto** |
| 4. Wire up backend | 30min | Bajo |
| 5. Validación end-to-end | 30min | Bajo |
| **Total** | **~3-4h** | |

---

## Estado de archivos al fin de esta sesión (2026-04-27)

- ✅ Backend corriendo en `172.18.164.35:3000` (modo PRODUCTION, datos reales)
- ✅ Frontend corriendo en `172.18.164.35:5173`
- ✅ SSH passwordless al 3CX desde el RDP
- ✅ `node_exporter` activo en el 3CX, accesible vía LAN directa (sin tunnel)
- ✅ Parser de logs funcionando (errors408/503 contables, troncal Tigo UNE registrada)
- ❌ Cygwin no instalado (próxima sesión)
- ❌ SIPp no compilado (próxima sesión)

Credenciales de github corporativo borradas del Credential Manager. Push a github personal pendiente (ver `HANDOFF-2026-04-27.md` sección "Migración a GitHub personal").

---

## Para arrancar la próxima sesión

1. **Leer este archivo + `HANDOFF-2026-04-27.md`**.
2. **Verificar pre-requisitos** del top de este doc.
3. **Ejecutar Fase 1** desde mi laptop.
4. **Avanzar fases 2-5 con pausa al fin de cada una** para validar antes de seguir.
5. **Fallback**: si Fase 3.3 (compile) consume más de 1h sin éxito, **abandonar Cygwin y arrancar Node UAC** (plan alternativo, ver `HANDOFF-2026-04-27.md`).

---

## Refs

- HANDOFF anterior: [HANDOFF-2026-04-27.md](./HANDOFF-2026-04-27.md)
- Handoff de la ejecución de este plan: [HANDOFF-2026-04-27-cygwin.md](./HANDOFF-2026-04-27-cygwin.md)
- Setup completo del deployment: [HANDOFF-2026-04-25.md](./HANDOFF-2026-04-25.md) sección "Sesión 2"
- Spec del SIPp Manager actual: [backend/src/services/sippManager.js](../backend/src/services/sippManager.js)
- Cygwin docs offline install: https://cygwin.com/faq.html#faq.setup.cli
- SIPp build docs: https://sipp.readthedocs.io/en/latest/installation.html

---

## Ejecución — 2026-04-27

### Resultados por fase

| Fase | Estado | Tiempo real | Notas |
|---|---|---|---|
| 1. Bundle laptop | ✅ | ~10 min | 183 MB final (zip con NoCompression). 154 paquetes Cygwin + sipp source |
| 2. Transfer al RDP | ✅ | ~30s | drive redirection (Copy-Item directo, 24.5s) |
| 3. Install + compile | ✅ | ~25 min | 1.5 GB instalados; compilación tomó 8-10 min |
| 3.5. sipp desde Windows nativo | ✅ | 1 min | Confirmado: con `cygwin64\bin` en PATH funciona; sin él falla con `0xC0000135` |
| 4. Wire up backend | ✅ | 5 min | `SIPP_BIN` env var, edit en sippManager.js:136 |
| 5. Smoke end-to-end | ⚠️ | 5 min | Stack OK; el 3CX devuelve **407 Proxy Authentication Required** porque escenario `-sn uac` no maneja digest auth |

### Desviaciones del plan original

**Paquetes Cygwin renombrados.** El plan listaba `libpcap-devel`, `ncurses-devel`, `openssl-devel` — esos nombres no existen en Cygwin moderno (2026). Solución:
- `libpcap-devel`, `openssl-devel` → eliminados (compilamos con `USE_PCAP=0` y `USE_SSL=0` igualmente, no hacían falta).
- `ncurses-devel` → renombrado a `libncurses-devel` (sí necesario para la UI interactiva de SIPp).

**Bug del tarball auto-generado de GitHub.** El tarball que bajamos de `https://github.com/SIPp/sipp/archive/refs/tags/v3.7.3.tar.gz` es el "source archive" auto-generado, **no la release oficial**. SIPp incluye un `include/version.h` "stub" que aborta la compilación con un `#error` para forzar usar la release oficial o git clone. Workaround aplicado: sobreescribir `include/version.h` antes de make con:

```c
#ifndef VERSION_H
#define VERSION_H
#define SIPP_VERSION "v3.7.3"
#endif
```

Para futuras instalaciones: bajar la release oficial desde [github.com/SIPp/sipp/releases](https://github.com/SIPp/sipp/releases) en lugar del tag tarball auto-generado.

**Heredoc PowerShell rompió 2 veces.** Pasar bash scripts vía `@'...'@` al usuario para pegar en su PS terminó colgando la sesión las dos veces porque el `'@` debe estar en columna 0 sin indentación. Solución: armar el script con array de strings + `[System.IO.File]::WriteAllText` y después invocar `bash.exe -lc "bash ~/build.sh"`.

### Estado del deploy en `172.18.164.35` post-ejecución

```
Cygwin root:    C:\Users\lamda\cygwin64\          (1.5 GB)
SIPp binary:    C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe
PATH user:     +C:\Users\lamda\cygwin64\bin       (necesario para cygwin1.dll)
backend\.env:  +SIPP_BIN=C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe
backend status: PRODUCTION MODE :3000, SSH conectado al 3CX, MOCK_MODE=false
```

Bundle `cygwin-bundle.zip` (183 MB) queda en mi laptop por si necesitamos reinstalar.

---

## Fase 6 — Digest auth para que la 407 deje de bloquear

### El hallazgo

El smoke test (`scenario=smoke`, 1 call al ext 100 del 3CX) salta `ERROR` porque el 3CX devuelve:

```
SIP/2.0 407 Proxy Authentication Required
Proxy-Authenticate: Digest nonce="...",algorithm=MD5,realm="3CXPhoneSystem"
```

El escenario default `-sn uac` de SIPp envía el INVITE pero no maneja la 407 challenge — aborta y sale con exit 1. Esto **no es un bug del wire-up Cygwin**; es comportamiento esperado del 3CX, que requiere autenticación digest a cualquier extensión.

### Tres opciones para resolver

**Opción A — Flags `-au`/`-ap` con creds de una extensión real (recomendada para PoC)**

SIPp soporta digest auth nativo cuando le pasás:
```
-au <username> -ap <password>
```

Cambios necesarios:
- `backend/.env`: agregar `SIPP_AUTH_USER` y `SIPP_AUTH_PASS`.
- `backend/src/services/sippManager.js`: si esos vars existen, append `-au $SIPP_AUTH_USER -ap $SIPP_AUTH_PASS` al array de args.
- En el 3CX: crear (o reusar) una extensión de prueba — sugerido `999` con password fuerte, solo para tests del audit.

Pros: cambio chico, escenario UAC default sigue válido.
Contras: creds en .env (rotar cuando termine el assessment).

**Opción B — Scenario XML custom que maneje 407 (mejor para load tests)**

Crear `backend/sipp_scenarios/uac_auth.xml` con un flow que:
1. Envía INVITE
2. Recibe 407 con `optional="true"`
3. Re-envía INVITE con `[authentication]` header
4. Espera 100/180/200 OK normalmente

Pasar `-sf sipp_scenarios/uac_auth.xml` en lugar de `-sn uac`.

Pros: portable, mejor para tests grandes (180+ calls), no depende de flags hardcoded.
Contras: hay que escribir y testear el XML; agregar logic en sippManager para decidir entre `-sn` vs `-sf`.

**Opción C — Configurar trunk anonymous en el 3CX**

Configurar en el 3CX un "anonymous SIP trunk" que acepte llamadas desde `172.18.164.35` sin auth.

Pros: cero cambio en sipp/backend.
Contras: agujero de seguridad en producción; queda como configuración del 3CX que hay que recordar revertir; no representa cómo llamarían los clientes reales (Wise CX usa la troncal Tigo UNE con auth).

### Plan de ataque sugerido

1. **Empezar por A** — más rápido para destrabar el smoke test y validar que sí podemos generar tráfico autenticado contra el 3CX.
2. **Migrar a B** antes de tests serios (peak/soak con 50+ calls). Si vamos a generar 180 llamadas concurrentes, el XML custom escala mejor.
3. **No hacer C** salvo que el cliente lo pida y entienda el riesgo.

### Pre-requisitos para Fase 6

- [ ] Confirmar con OLAM una extensión de test (sugerido `999`) y obtener su password.
- [ ] Validar que esa extensión tiene permiso para llamar a otras extensiones del 3CX (no solo recibir).
- [ ] Decidir A vs B con el usuario antes de empezar.
