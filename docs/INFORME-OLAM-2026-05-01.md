# Informe de avance — Plataforma de Auditoría 3CX OLAM

**Fecha:** 2026-05-01
**Cliente:** OLAM Inversiones
**Servidor auditado:** 3CX v20 Update 8 — `172.18.164.28`
**Objetivo del proyecto:** validar si la infraestructura actual del 3CX puede escalar de 32 a 180 llamadas simultáneas (upgrade de licencia SC32 → SC192) y dejar evidencia técnica del comportamiento bajo carga real y sintética.

---

## 1. Resumen ejecutivo

La plataforma de auditoría está **operativa en producción** sobre el servidor cliente `172.18.164.35`. Tiene dos modos de funcionamiento:

| Modo | Estado | Qué hace |
|---|---|---|
| **Pasivo (always-on)** | ✅ Corriendo 24/7 | Lee logs del 3CX vía SSH, parsea métricas, detecta anomalías y las muestra en el dashboard. No interrumpe operación. |
| **Activo (carga sintética)** | 🟡 Listo, falta dato del cliente | Genera llamadas controladas con SIPp contra el 3CX para medir el límite real del sistema. Stack 100% wired-up; bloqueado por una extensión válida de destino. |

**Lo que ya se puede ver hoy** (capturas en sección 7):

- Dashboard con 14 KPIs en tiempo real (host, llamadas, calidad, colas)
- Estado de la troncal Tigo UNE con conteo de errores 408/503
- 4 hallazgos críticos detectados desde el día uno
- Historial de pruebas ejecutadas con resultado PASS/FAIL

**Para arrancar las pruebas serias necesitamos del lado de OLAM:**
1. Una **extensión válida** del 3CX para usar como destino del SIPp (probablemente la extensión `100` que veníamos usando no existe).
2. Una **ventana de licencia trial SC192** (o autorización para llegar al límite contractual SC32) para correr los tests de pico de 180 llamadas.

---

## 2. Lo que se ha avanzado

### Capa siempre activa

| Componente | Estado |
|---|---|
| Backend Node.js + WebSocket | ✅ Corriendo en producción `:3001` |
| Conexión SSH persistente al 3CX | ✅ Estable, key-based auth |
| Lector de logs del 3CX (5 archivos) | ✅ `tail -Fq` en streaming, no polling |
| Parser de logs → métricas | ✅ Activo |
| Motor de detección de anomalías | ✅ 7 reglas de severidad (crítico → bajo) |
| Dashboard React en tiempo real | ✅ Updates cada 5s vía WebSocket |
| Persistencia SQLite | ✅ Historial y configuración |

### Capa de pruebas sintéticas (SIPp)

| Componente | Estado |
|---|---|
| Cygwin instalado en el host de la app | ✅ |
| SIPp v3.7.3 compilado y validado | ✅ |
| Backend invoca SIPp con parámetros sanitizados | ✅ |
| Autenticación SIP digest (extensión 1910) | ✅ Confirmado, ya no hay errores 407 |
| Límites duros de seguridad (200 calls / 20 ramp / 8h) | ✅ Aplicados en backend, no se pueden saltar desde el frontend |
| Lock para evitar pruebas concurrentes | ✅ |
| Audit log (quién inició la prueba, parámetros, duración) | ✅ |

### API REST + WebSocket

11 endpoints HTTP y 5 eventos WebSocket. Validados extremo a extremo con colección de Postman incluida en el repo.

---

## 3. Hallazgos detectados

Cuatro hallazgos visibles en el panel de alertas desde el primer arranque:

| ID | Severidad | Hallazgo | Impacto |
|---|---|---|---|
| **H-01** | 🔴 Crítico | Licencia SC32 insuficiente para el objetivo (SC192) | Bloquea cualquier prueba real >32 llamadas hasta el upgrade |
| **H-07** | 🔴 Crítico | SIP sin TLS expuesto en IP pública 181.63.161.242 | Riesgo de toll fraud y escucha pasiva del tráfico de voz |
| **H-03** | 🟠 Alto | Errores 408 en troncal Tigo UNE (sip:172.17.179.166:5060) | Ya hay degradación con 32 canales — a 180 se amplifica |
| **H-05** | 🟠 Alto | Auto-updates de 3CX habilitado | Riesgo de reinicio en horario productivo y rotura del parser de logs |

H-01 y H-05 dependen de decisiones de OLAM. H-03 requiere una conversación con Tigo. H-07 es un cambio de configuración del 3CX que podemos coordinar.

---

## 4. Lo que sigue

### Inmediato (esta semana, depende del cliente)

- [ ] **OLAM:** Confirmar una extensión válida que podamos usar como destino del SIPp (sugerencia: una ext de prueba en una cola separada, sin agentes reales asignados)
- [ ] **OLAM:** Definir ventana de mantenimiento para correr el primer smoke test contra el 3CX real
- [ ] Diagnosticar warning del parser ("No log data for 2+ minutes") observado en los últimos arranques

### Mediano plazo (próximas 2 semanas)

- [ ] Implementar escenario XML custom de SIPp para tests >50 llamadas (mejor escalabilidad que el smoke loop actual)
- [ ] Mejorar el cálculo de resultados PASS/FAIL leyendo el `_statistics.csv` final de SIPp en lugar de parsear el stderr en vivo
- [ ] Correr la batería completa: smoke → light (10) → medium (50) → peak (180, requiere SC192)

### Para el reporte final del assessment

- [ ] Test de saturación (`stress`, 220 calls) para encontrar el punto exacto donde el 3CX comienza a rechazar
- [ ] Test de soak (4 horas a 125 calls) para validar estabilidad sostenida
- [ ] Recolectar capturas SIP con `tcpdump`/`sngrep` en momentos de pico para análisis post-mortem
- [ ] Documento ejecutivo con recomendaciones de upgrade (CPU/RAM/red/licencia)

---

## 5. Impedimentos / bloqueadores

| Bloqueador | Quién lo desbloquea | Urgencia |
|---|---|---|
| Extensión válida para destino SIPp | OLAM (TI / 3CX admin) | Alta — bloquea primer smoke real |
| Licencia trial SC192 (o autorización al límite SC32) | OLAM (comercial 3CX) | Media — solo bloquea peak/stress, no smoke/light |
| Ventana de mantenimiento para tests grandes | OLAM (operación contact center) | Media — para correr peak/stress fuera de horario productivo |
| Conversación con Tigo sobre errores 408 | OLAM (relación con carrier) | Baja para el assessment, alta para producción |

**Nada está bloqueado del lado técnico nuestro.** El stack está listo para correr en cuanto tengamos los inputs de OLAM.

---

## 6. KPIs que la plataforma vigila en tiempo real

| Categoría | KPI | Umbrales |
|---|---|---|
| **Host** | CPU %, RAM %, Load avg, Disco OS | OK <60/70/2/70 — Warn 60–80/70–85/2–4/70–85 — Fail >80/85/4/85 |
| **Llamadas** | Concurrentes, PDD p95, ASR, Error rate | Concurrentes vs tier (32) — PDD <2s — ASR >98% — Errores <2% |
| **Calidad voz** | MOS, Jitter p95, Packet loss | MOS ≥4.0 — Jitter <20ms — Loss <0.5% |
| **Colas** | En espera, Agentes online, Service Level, Abandono | SL ≥80/20 — Abandono <5% |
| **Troncal Tigo UNE** | Registro, canales en uso, errores 408/503, PDD al carrier | Conteo de errores por hora |

---

## 7. Capturas para incluir en el informe ejecutivo

Tomar las siguientes capturas desde el navegador (la plataforma está accesible en `http://localhost:5173`):

1. **Dashboard completo** — vista general con los 14 KPIs y panel de alertas → muestra el "modo pasivo" en acción
2. **Sección "Llamadas"** — KPI "Concurrentes" donde se ve la marca `/ 32` (el tier actual SC32) → evidencia visual del hallazgo H-01
3. **TrunkStatus (Tigo UNE)** — panel con conteo de errores 408 → evidencia de H-03
4. **AlertPanel** — los 4 hallazgos Fase 0 con su severidad → resumen de findings
5. **CallChart (gráfica de llamadas activas últimos 30 minutos)** → visualización de tráfico real
6. **Pantalla "Tests"** — sliders y presets disponibles → muestra el rango de pruebas que vamos a ejecutar
7. **Pantalla "Historial"** — tabla con pruebas previas → trazabilidad de evidencia

Para tomarlas en buena calidad: pantalla completa del navegador, modo claro/oscuro a elección (el dashboard es dark theme). Sugerencia de herramienta: la captura nativa de Windows (`Win + Shift + S`) o Snipping Tool.

---

## 8. Referencias técnicas

- Estado interno (dev): [STATUS-2026-04-30.md](./STATUS-2026-04-30.md)
- Plan de deployment Cygwin/SIPp: [PLAN-Cygwin-SIPp.md](./PLAN-Cygwin-SIPp.md)
- Handoffs operativos: [HANDOFF-2026-04-25.md](./HANDOFF-2026-04-25.md), [HANDOFF-2026-04-27.md](./HANDOFF-2026-04-27.md), [HANDOFF-2026-04-27-cygwin.md](./HANDOFF-2026-04-27-cygwin.md)
- Colección Postman para validar API: [postman/OLAM-Audit.postman_collection.json](../postman/OLAM-Audit.postman_collection.json)
