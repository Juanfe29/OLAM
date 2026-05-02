// Evaluates anomaly rules against live metrics.
// Deduplicates: won't re-fire the same rule within its cooldown window.

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per rule

const PHASE0_FINDINGS = [
  {
    id: 'H-01',
    level: 'CRITICO',
    title: 'Licencia SC32 insuficiente',
    msg: 'La licencia actual es SC32. El objetivo es 180 llamadas (SC192). Las pruebas por encima de 32 concurrentes serán rechazadas hasta el upgrade.',
    permanent: true,
  },
  {
    id: 'H-07',
    level: 'CRITICO',
    title: 'SIP sin TLS en IP pública',
    msg: 'Puerto 5060 UDP expuesto en 181.63.161.242 sin cifrado. Riesgo de toll fraud y escucha pasiva.',
    permanent: true,
  },
  {
    id: 'H-03',
    level: 'ALTO',
    title: 'Errores 408 en troncal Tigo UNE',
    msg: 'Request Timeout detectados hacia sip:172.17.179.166:5060. Problema presente con 32 canales; se amplifica a 180.',
    permanent: true,
  },
  {
    id: 'H-05',
    level: 'ALTO',
    title: 'Auto-updates habilitado',
    msg: 'El 3CX aplica actualizaciones automáticamente. Riesgo de reinicio en horario productivo y rotura del parser de logs.',
    permanent: true,
  },
];

const RULES = [
  {
    id: 'no_calls',
    level: 'CRITICO',
    msg: 'Sin llamadas activas por más de 30 segundos — posible caída del servicio',
    check: (m) => m.calls.active === 0,
  },
  {
    id: 'high_errors',
    level: 'CRITICO',
    msg: 'Tasa de error > 20% en los últimos 60 segundos — sistema saturado o caído',
    check: (m) => m.calls.errorRate > 20,
  },
  {
    id: 'near_capacity',
    level: 'ALTO',
    msg: 'Llamadas activas > 90% de la capacidad licenciada',
    check: (m) => m.calls.tier > 0 && m.calls.active > m.calls.tier * 0.9,
  },
  {
    id: 'high_latency',
    level: 'ALTO',
    msg: 'PDD p95 > 4 segundos — degradación severa de señalización',
    check: (m) => m.calls.pdd_p95 > 4,
  },
  {
    id: 'timeout_408',
    level: 'ALTO',
    msg: 'Más de 5 errores 408 en la última hora — problema activo con troncal Tigo UNE',
    check: (m) => m.trunk.errors408 > 5,
  },
  {
    id: 'med_errors',
    level: 'MEDIO',
    msg: 'Tasa de error > 5% — degradación moderada del sistema',
    check: (m) => m.calls.errorRate > 5 && m.calls.errorRate <= 20,
  },
  {
    id: 'call_drop',
    level: 'BAJO',
    msg: 'Caída brusca de llamadas detectada — posible drop masivo',
    check: (m, prev) => prev && prev.calls.active > 5 && m.calls.active < prev.calls.active * 0.7,
  },
  {
    id: 'high_cpu',
    level: 'ALTO',
    msg: 'CPU del host > 80% — riesgo de rechazo de llamadas',
    check: (m) => m.host.cpu > 80,
  },
  {
    id: 'high_ram',
    level: 'ALTO',
    msg: 'RAM del host > 85% — degradación silenciosa del PBX',
    check: (m) => m.host.ram > 85,
  },
  {
    id: 'low_mos',
    level: 'ALTO',
    msg: 'MOS promedio < 3.6 — calidad de voz inaceptable',
    check: (m) => m.quality.mos > 0 && m.quality.mos < 3.6,
  },
];

const lastFiredAt = new Map();
const activeAlerts = new Map();
let prevMetrics = null;
let onAlertCallback = null;

export function startAnomalyDetector(onAlert) {
  onAlertCallback = onAlert;

  // Pre-load Phase 0 findings as permanent alerts
  for (const finding of PHASE0_FINDINGS) {
    activeAlerts.set(finding.id, {
      ...finding,
      ts: new Date().toISOString(),
      permanent: true,
    });
  }
}

export function evaluate(metrics) {
  const now = Date.now();

  for (const rule of RULES) {
    const fired = rule.check(metrics, prevMetrics);
    const lastFired = lastFiredAt.get(rule.id) || 0;

    if (fired) {
      if (now - lastFired > COOLDOWN_MS) {
        lastFiredAt.set(rule.id, now);
        const alert = {
          id: rule.id,
          level: rule.level,
          msg: rule.msg,
          ts: new Date().toISOString(),
          permanent: false,
        };
        activeAlerts.set(rule.id, alert);
        if (onAlertCallback) onAlertCallback(alert);
      }
    } else {
      // Auto-resolve non-permanent alerts
      if (activeAlerts.has(rule.id)) {
        activeAlerts.delete(rule.id);
      }
    }
  }

  prevMetrics = metrics;
}

export function getActiveAlerts() {
  return Array.from(activeAlerts.values());
}

// Permite que otros servicios (logReader, sippManager) registren alertas
// que persistan en el snapshot devuelto a clientes recién conectados.
// Sin esto las alertas vía io.emit('alert:new') se pierden si el frontend
// se reconecta — solo viven el momento del envío.
export function addExternalAlert(alert) {
  if (!alert?.id) return;
  activeAlerts.set(alert.id, { ...alert, permanent: false });
}

export function clearExternalAlert(id) {
  if (!id) return;
  const existing = activeAlerts.get(id);
  if (existing && !existing.permanent) activeAlerts.delete(id);
}
