# Deployment Target: 172.18.164.35

**Máquina Cliente OLAM — Plataforma de Auditoría 3CX**

---

## Hardware & OS

| Propiedad | Valor |
|-----------|-------|
| **IP** | 172.18.164.35 |
| **Hostname** | desktop-lmofb3b |
| **OS** | Windows 10 Pro |
| **Usuario** | lamda |
| **Permisos** | Sin admin |
| **DNS** | No disponible |
| **WSL** | No disponible |
| **SSH Server** | No (Windows nativo) |

---

## Software Instalado

| Componente | Versión | Status |
|-----------|---------|--------|
| **Node.js** | v20.18.0 LTS | ✓ Listo |
| **npm** | 10.8.2 | ✓ Listo |
| **git** | 2.51.0 | ✓ Listo |
| **PowerShell** | (Windows nativo) | ✓ Disponible |
| **node_exporter** | (N/A) | — No instalado |

---

## Código

| Propiedad | Valor |
|-----------|-------|
| **Ruta** | `C:\Users\lamda\OLAM` |
| **Estado** | Clonado ✓ |
| **Rama** | main |
| **Último commit** | 3e7132d (initial: phase 1 code snapshot 2026-05-02) |
| **Estado local** | ⚠ Cambios no comitidos (sippManager.js, sshClient.js, etc.) |
| **Cambios pendientes** | Necesita `git pull` para traer commit 21b3e02 (172.18.164.33 + 256 calls) |

---

## Conectividad

| Destino | Puerto | Status |
|---------|--------|--------|
| **172.18.164.33** (3CX nuevo) | 22 (SSH) | ✓ Alcanzable |
| **172.18.164.33** (3CX nuevo) | 5060 (SIP) | ✓ Alcanzable |
| **npm registry** | 443 (HTTPS) | (verificar) |
| **GitHub** | 443 (HTTPS) | (verificar) |

---

## Servicios a Correr

### Backend (Node.js Express + Socket.io)

```powershell
cd C:\Users\lamda\OLAM\backend
npm install
npm run dev
# Puerto: 3001 (actualmente), puede cambiar a 3000 si se configura
# Conecta a: 172.18.164.33 (3CX SSH con password Olam2026$)
```

### Frontend (React + Vite)

```powershell
cd C:\Users\lamda\OLAM\frontend
npm install
npm run dev
# Puerto: 5173
# Dev proxy a: localhost:3000
```

---

## Configuración Requerida

### Backend (.env)

```env
SSH_HOST=172.18.164.33
SSH_PORT=22
SSH_USER=root
SSH_PASSWORD=Olam2026$
SSH_KEY_PATH=./keys/3cx_rsa

LOGS_PATH=/var/lib/3cxpbx/Instance1/Data/Logs
LOG_POLL_INTERVAL=5000

PORT=3000
NODE_ENV=development

SIPP_BIN=C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe
CYGWIN_BIN_PATH=C:\Users\lamda\cygwin64\bin

SIPP_AUTH_USER=999
SIPP_AUTH_PASS=999

DB_PATH=./data/olam.db

NODE_EXPORTER_VIA_SSH=false
NODE_EXPORTER_URL=http://127.0.0.1:9100/metrics

VALID_EXTENSIONS=

JWT_SECRET=cae3ab6e3d443d245f823b41034a5f164c4ddef1dd9a08adbd26e2e018e5d08c15b698493cda54bf32bbe55cf608702c
```

---

## SIPp Setup

| Propiedad | Valor |
|-----------|-------|
| **Binario** | `C:\Users\lamda\cygwin64\home\lamda\sipp-3.7.3\sipp.exe` |
| **Cygwin** | Instalado |
| **DLL Path** | `C:\Users\lamda\cygwin64\bin` |
| **Status** | ✓ Configurado |

---

## Deployment Checklist

- [ ] Verificar `git status` y `git log` en 172.18.164.35
- [ ] Verificar conectividad a npm registry
- [ ] Verificar conectividad a GitHub
- [ ] `cd backend && npm install`
- [ ] `cd frontend && npm install`
- [ ] Crear/copiar `.env` en backend
- [ ] `npm run dev` (backend, puerto 3000)
- [ ] `npm run dev` (frontend, puerto 5173)
- [ ] Acceder a `http://localhost:5173` desde navegador
- [ ] Verificar que SSH conecta a 172.18.164.33
- [ ] Prueba smoke: iniciar test con 1 llamada

---

## Notas

- **Sin admin:** No se puede instalar servicios Windows o cambiar variables de sistema global
- **Sin DNS:** Las IPs internas deben ser numéricas (172.18.164.33, no nombres)
- **FortiClient:** Requerido para VPN a la red 172.18.x.x
- **SIPp via Cygwin:** SIPp corre en 172.18.164.35 (backend spawns), apunta a 172.18.164.33:5060
- **No node_exporter:** Métricas del host vienen solo de logs del 3CX; hostMetrics fallará gracefully

---

**Última actualización:** 2026-05-04
**Status:** Listo para setup inicial
