import fs from 'fs';
import path from 'path';
import { getTest } from '../db/queries.js';

const REPORTS_DIR = path.resolve('data/reports');

export async function generateReport(testId) {
  const test = await getTest(testId);
  if (!test) throw new Error(`Test ${testId} not found`);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = path.join(REPORTS_DIR, `run-${testId}.html`);
  fs.writeFileSync(filePath, buildHTML(test), 'utf8');
  console.log(`[Report] run-${testId}.html generado`);
  return filePath;
}

export function reportExists(testId) {
  return fs.existsSync(path.join(REPORTS_DIR, `run-${testId}.html`));
}

// ─── HTML builder ──────────────────────────────────────────────────────────────

function buildHTML(test) {
  const { id, scenario, max_calls, duration, ramp_rate, destination,
          started_at, ended_at, result, summary, snapshots } = test;

  const startDate      = new Date(started_at);
  const endDate        = ended_at ? new Date(ended_at) : null;
  const actualDuration = endDate ? Math.round((endDate - startDate) / 1000) : duration;
  const startStr       = fmt(startDate);
  const endStr         = endDate ? fmt(endDate) : '—';
  const generatedAt    = fmt(new Date());

  const hasSnaps = Array.isArray(snapshots) && snapshots.length > 0;

  // Derive peaks from snapshots
  const cpuArr  = hasSnaps ? snapshots.map(s => s.host?.cpu  ?? 0) : [];
  const ramArr  = hasSnaps ? snapshots.map(s => s.host?.ram  ?? 0) : [];
  const mosArr  = hasSnaps ? snapshots.map(s => s.quality?.mos).filter(v => v != null) : [];
  const peakCpu = cpuArr.length ? Math.max(...cpuArr).toFixed(1) : null;
  const peakRam = ramArr.length ? Math.max(...ramArr).toFixed(1) : null;
  const avgMos  = mosArr.length ? (mosArr.reduce((a, b) => a + b, 0) / mosArr.length).toFixed(2) : null;

  const verdict = VERDICTS[result] ?? VERDICTS.STOPPED;
  const sipErrors   = summary?.sipErrors ?? {};
  const hasSipErr   = Object.keys(sipErrors).length > 0;

  const chartData = hasSnaps ? snapshots.map(s => ({
    t:      s.timestamp,
    calls:  s.calls?.active      ?? 0,
    err:    s.calls?.errorRate   ?? 0,
    cpu:    s.host?.cpu          ?? 0,
    ram:    s.host?.ram          ?? 0,
    mos:    s.quality?.mos       ?? null,
    jitter: s.quality?.jitter_p95 ?? null,
  })) : [];

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte #${id} — ${esc(scenario ?? 'custom')} — OLAM Audit</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>${CSS}</style>
</head>
<body>
<div class="page">

  <header class="header">
    <div class="logo">OLAM Audit</div>
    <div class="header-right">
      <div class="run-title">Reporte de Prueba #${id}</div>
      <div class="run-date">${startStr}</div>
    </div>
  </header>

  <div class="verdict" style="background:${verdict.bg};border-color:${verdict.border}">
    <div class="verdict-badge" style="color:${verdict.color};border-color:${verdict.border}">${result}</div>
    <div class="verdict-body">
      <div class="verdict-label" style="color:${verdict.color}">Prueba ${verdict.label}</div>
      ${summary?.failReason ? `<div class="verdict-detail">${esc(summary.failReason)}</div>` : ''}
      ${hasSipErr ? `<div class="sip-tags">${
        Object.entries(sipErrors).sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `<span class="sip-tag">${c === 'timeout' ? 'timeout' : 'SIP ' + c} ×${n}</span>`)
          .join('')
      }</div>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Configuración</div>
    <div class="grid-4">
      ${param('Escenario',            esc(scenario ?? 'custom'))}
      ${param('Concurrencia objetivo',`${max_calls} llamadas`)}
      ${param('Duración configurada', fmtDur(duration))}
      ${param('Rampa',               `${ramp_rate} llamadas/s`)}
      ${param('Destino SIP',          esc(destination ?? '—'))}
      ${param('Inicio',               startStr,  'small')}
      ${param('Fin',                  endStr,    'small')}
      ${param('Duración real',        fmtDur(actualDuration))}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Resultados de la prueba</div>
    <div class="grid-kpi">
      ${kpi('Peak alcanzado',   summary?.maxCalls ?? '—',
            summary?.maxCalls != null ? (summary.maxCalls >= max_calls * 0.9 ? 'ok' : 'fail') : null,
            `objetivo: ${max_calls}`)}
      ${summary?.source === 'csv' ? kpi('Total llamadas', summary.totalCalls ?? '—') : ''}
      ${summary?.source === 'csv' ? kpi('Exitosas',  summary.successful ?? '—', 'ok') : ''}
      ${summary?.source === 'csv' ? kpi('Fallidas',  summary.failed ?? 0,
            summary?.failed > 0 ? 'warn' : 'ok') : ''}
      ${kpi('Tasa de error',
            summary?.avgErrorRate != null ? summary.avgErrorRate + '%' : '—',
            summary?.avgErrorRate != null ? (summary.avgErrorRate < 5 ? 'ok' : 'fail') : null,
            'umbral: < 5%')}
      ${summary?.callRate != null ? kpi('Call rate', summary.callRate.toFixed(2) + ' cps') : ''}
      ${peakCpu ? kpi('CPU peak', peakCpu + '%',
            parseFloat(peakCpu) < 80 ? 'ok' : 'fail', 'durante la prueba') : ''}
      ${peakRam ? kpi('RAM peak', peakRam + '%',
            parseFloat(peakRam) < 85 ? 'ok' : 'warn', 'durante la prueba') : ''}
      ${avgMos  ? kpi('MOS promedio', avgMos,
            parseFloat(avgMos) >= 4.0 ? 'ok' : parseFloat(avgMos) >= 3.6 ? 'warn' : 'fail',
            'umbral: ≥ 4.0') : ''}
    </div>
  </div>

  ${hasSnaps ? `
  <div class="section">
    <div class="section-title">Timeline de la prueba (${snapshots.length} muestras)</div>
    <div class="chart-box" style="margin-bottom:14px">
      <div class="chart-title">Llamadas activas y tasa de error</div>
      <canvas id="callsChart" height="110"></canvas>
    </div>
    <div class="chart-box">
      <div class="chart-title">CPU % y RAM % del host</div>
      <canvas id="hostChart" height="90"></canvas>
    </div>
    ${mosArr.length > 2 ? `
    <div class="chart-box" style="margin-top:14px">
      <div class="chart-title">Calidad de llamada — MOS y jitter</div>
      <canvas id="qualityChart" height="80"></canvas>
    </div>` : ''}
  </div>` : `
  <div class="section">
    <div class="no-snaps">Sin datos de timeline — los snapshots se guardan automáticamente en pruebas futuras.</div>
  </div>`}

  ${debugSection(summary?.debug)}

  <div class="section">
    <div class="section-title">Hallazgos de referencia — Fase 0</div>
    ${finding('CRÍTICO', 'H-01', 'Licencia SC32 insuficiente (objetivo SC192). Cualquier prueba por encima de 32 concurrentes será rechazada hasta el upgrade.')}
    ${finding('CRÍTICO', 'H-07', 'SIP sin TLS en IP pública 181.63.161.242. Riesgo de toll fraud y escucha pasiva.')}
    ${finding('ALTO',    'H-03', 'Errores 408 en troncal Tigo UNE (sip:172.17.179.166:5060). Ya hay problemas con 32 canales; a 180 se amplifica.')}
    ${finding('ALTO',    'H-05', 'Auto-updates habilitado. Riesgo de reinicio en horario productivo y rotura del parser de logs.')}
  </div>

  <footer class="footer">
    <span>OLAM Audit Platform · 3CX v20 · Tigo UNE</span>
    <span>Generado el ${generatedAt}</span>
  </footer>

</div>
${hasSnaps ? chartScript(chartData, mosArr.length > 2) : ''}
</body>
</html>`;
}

// ─── Chart script ──────────────────────────────────────────────────────────────

function chartScript(data, hasQuality) {
  const sparse = data.length > 60;
  return `<script>
(function() {
  const D = ${JSON.stringify(data)};
  const labels = D.map(s => {
    const d = new Date(s.t);
    return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });
  const grid   = 'rgba(51,65,85,0.6)';
  const tick   = '#475569';
  const pt     = ${sparse} ? 0 : 3;
  const font   = { size: 11 };
  const base   = {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: tick, font, boxWidth: 12 } } },
  };

  new Chart(document.getElementById('callsChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Llamadas activas',
          data: D.map(s => s.calls),
          borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)',
          fill: true, tension: 0.3, pointRadius: pt, yAxisID: 'y',
        },
        {
          label: 'Error rate %',
          data: D.map(s => s.err),
          borderColor: '#f87171', backgroundColor: 'transparent',
          tension: 0.3, pointRadius: pt > 0 ? pt - 1 : 0,
          borderDash: [4, 3], yAxisID: 'y2',
        },
      ]
    },
    options: {
      ...base,
      scales: {
        x: { ticks: { color: tick, font, maxTicksLimit: 10 }, grid: { color: grid } },
        y: {
          min: 0,
          title: { display: true, text: 'Llamadas', color: tick, font },
          ticks: { color: tick, font }, grid: { color: grid },
        },
        y2: {
          min: 0,
          max: Math.max(20, Math.ceil(Math.max(...D.map(s => s.err || 0)) / 5) * 5 + 5),
          position: 'right',
          title: { display: true, text: 'Error %', color: '#f87171', font },
          ticks: { color: '#f87171', font, callback: v => v + '%' },
          grid: { drawOnChartArea: false },
        },
      },
    }
  });

  new Chart(document.getElementById('hostChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'CPU %',
          data: D.map(s => s.cpu),
          borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.08)',
          fill: true, tension: 0.3, pointRadius: pt,
        },
        {
          label: 'RAM %',
          data: D.map(s => s.ram),
          borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.06)',
          fill: true, tension: 0.3, pointRadius: pt,
        },
      ]
    },
    options: {
      ...base,
      scales: {
        x: { ticks: { color: tick, font, maxTicksLimit: 10 }, grid: { color: grid } },
        y: {
          min: 0, max: 100,
          title: { display: true, text: '%', color: tick, font },
          ticks: { color: tick, font, callback: v => v + '%' }, grid: { color: grid },
        },
      },
    }
  });

  ${hasQuality ? `
  new Chart(document.getElementById('qualityChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'MOS',
          data: D.map(s => s.mos), spanGaps: true,
          borderColor: '#fbbf24', backgroundColor: 'transparent',
          tension: 0.3, pointRadius: pt, yAxisID: 'y',
        },
        {
          label: 'Jitter (ms)',
          data: D.map(s => s.jitter), spanGaps: true,
          borderColor: '#f97316', backgroundColor: 'transparent',
          tension: 0.3, pointRadius: pt > 0 ? pt - 1 : 0, yAxisID: 'y2',
        },
      ]
    },
    options: {
      ...base,
      scales: {
        x: { ticks: { color: tick, font, maxTicksLimit: 10 }, grid: { color: grid } },
        y: {
          min: 1, max: 5,
          title: { display: true, text: 'MOS', color: '#fbbf24', font },
          ticks: { color: '#fbbf24', font }, grid: { color: grid },
        },
        y2: {
          min: 0,
          position: 'right',
          title: { display: true, text: 'Jitter ms', color: '#f97316', font },
          ticks: { color: '#f97316', font }, grid: { drawOnChartArea: false },
        },
      },
    }
  });` : ''}
})();
</script>`;
}

// ─── HTML helpers ──────────────────────────────────────────────────────────────

function debugSection(debug) {
  if (!debug) return '';

  const hasScreen  = debug.scenarioScreen?.trim();
  const hasStderr  = debug.stderrTail?.trim();
  const hasLog3cx  = Array.isArray(debug.logLines3cx) && debug.logLines3cx.length > 0;
  if (!hasScreen && !hasStderr && !hasLog3cx) return '';

  return `
  <div class="section">
    <details class="debug-details">
      <summary class="debug-summary">
        Debug — actividad durante la prueba
        <span class="debug-counts">
          ${hasLog3cx ? `${debug.logLines3cx.length} líneas 3CX` : ''}
          ${hasScreen ? ' · SIPp Scenario Screen' : ''}
          ${hasStderr ? ' · stderr' : ''}
        </span>
      </summary>
      <div class="debug-body">
        ${hasLog3cx ? `
        <div class="debug-block">
          <div class="debug-title">Actividad del 3CX durante la prueba (${debug.logLines3cx.length} líneas)</div>
          <pre class="debug-pre">${esc(debug.logLines3cx.join('\n'))}</pre>
        </div>` : ''}
        ${hasScreen ? `
        <div class="debug-block">
          <div class="debug-title">SIPp — Scenario Screen (tabla de mensajes)</div>
          <pre class="debug-pre">${esc(debug.scenarioScreen)}</pre>
        </div>` : ''}
        ${hasStderr ? `
        <div class="debug-block">
          <div class="debug-title">SIPp — stderr</div>
          <pre class="debug-pre">${esc(debug.stderrTail)}</pre>
        </div>` : ''}
        ${debug.sippCwd ? `
        <div class="debug-block">
          <div class="debug-title">Directorio de trabajo SIPp</div>
          <pre class="debug-pre" style="font-size:12px">${esc(debug.sippCwd)}</pre>
        </div>` : ''}
      </div>
    </details>
  </div>`;
}

const VERDICTS = {
  PASS:    { color: '#4ade80', bg: '#052e16', border: '#166534', label: 'APROBADA' },
  FAIL:    { color: '#f87171', bg: '#450a0a', border: '#991b1b', label: 'FALLIDA'  },
  ERROR:   { color: '#fb923c', bg: '#431407', border: '#9a3412', label: 'con ERROR' },
  STOPPED: { color: '#94a3b8', bg: '#0f172a', border: '#334155', label: 'DETENIDA' },
};

function param(label, value, sizeClass = '') {
  return `<div class="param">
    <div class="param-label">${label}</div>
    <div class="param-value${sizeClass ? ' ' + sizeClass : ''}">${value ?? '—'}</div>
  </div>`;
}

function kpi(label, value, status, sub) {
  const cls = status ? ` ${status}` : '';
  return `<div class="stat">
    <div class="stat-label">${label}</div>
    <div class="stat-value${cls}">${value ?? '—'}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

function finding(severity, code, text) {
  const cls = severity === 'CRÍTICO' ? 'critico' : 'alto';
  return `<div class="finding ${cls}">
    <div class="finding-badge">${severity}</div>
    <div class="finding-text"><span class="finding-id">${code}</span>${esc(text)}</div>
  </div>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(date) {
  return date.toLocaleString('es-CO', { timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDur(s) {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ─── Inline CSS ────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.5;font-size:14px}
.page{max-width:1100px;margin:0 auto;padding:32px 24px}

.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid #1e293b}
.logo{font-size:18px;font-weight:700;color:#38bdf8;letter-spacing:-.5px}
.header-right{text-align:right}
.run-title{font-size:15px;font-weight:600;color:#f1f5f9}
.run-date{font-size:12px;color:#64748b;margin-top:2px}

.verdict{border-radius:12px;padding:22px 26px;margin-bottom:26px;border:1px solid;display:flex;align-items:flex-start;gap:18px}
.verdict-badge{font-size:12px;font-weight:700;font-family:monospace;padding:4px 10px;border-radius:6px;border:1.5px solid;white-space:nowrap}
.verdict-body{flex:1}
.verdict-label{font-size:20px;font-weight:700;margin-bottom:4px}
.verdict-detail{font-size:13px;color:#94a3b8;margin-top:6px;line-height:1.5}
.sip-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.sip-tag{font-size:11px;font-family:monospace;padding:2px 8px;border-radius:4px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#fca5a5}

.section{margin-bottom:26px}
.section-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:12px}

.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.grid-kpi{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
@media(max-width:700px){.grid-4{grid-template-columns:repeat(2,1fr)}}

.param{background:#1e293b;border:1px solid #1e293b;border-radius:8px;padding:11px 14px}
.param-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.param-value{font-size:13px;font-weight:600;color:#cbd5e1;font-family:monospace}
.param-value.small{font-size:11px}

.stat{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 16px}
.stat-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:5px}
.stat-value{font-size:22px;font-weight:700;font-family:monospace;color:#f1f5f9}
.stat-value.ok{color:#4ade80}
.stat-value.warn{color:#fb923c}
.stat-value.fail{color:#f87171}
.stat-sub{font-size:11px;color:#475569;margin-top:3px}

.chart-box{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:18px 20px}
.chart-title{font-size:12px;font-weight:600;color:#94a3b8;margin-bottom:14px}

.no-snaps{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;color:#475569;font-size:13px;text-align:center}

.finding{display:flex;gap:12px;padding:12px 16px;border-radius:8px;margin-bottom:8px;font-size:13px}
.finding.critico{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25)}
.finding.alto{background:rgba(249,115,22,.08);border:1px solid rgba(249,115,22,.25)}
.finding-badge{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap;height:fit-content;margin-top:1px}
.critico .finding-badge{background:rgba(239,68,68,.2);color:#f87171}
.alto .finding-badge{background:rgba(249,115,22,.2);color:#fb923c}
.finding-text{flex:1;color:#94a3b8}
.finding-id{font-weight:700;color:#64748b;margin-right:6px;font-size:11px;font-family:monospace}

.footer{margin-top:40px;padding-top:18px;border-top:1px solid #1e293b;display:flex;justify-content:space-between;font-size:11px;color:#334155}

.debug-details{background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden}
.debug-summary{padding:14px 18px;cursor:pointer;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#475569;display:flex;align-items:center;gap:10px;user-select:none;list-style:none}
.debug-summary::-webkit-details-marker{display:none}
.debug-summary::before{content:'▶';font-size:9px;color:#334155;transition:transform .15s}
details[open] .debug-summary::before{transform:rotate(90deg)}
.debug-counts{font-weight:400;color:#334155;text-transform:none;letter-spacing:0}
.debug-body{padding:0 18px 18px;display:flex;flex-direction:column;gap:14px}
.debug-block{}
.debug-title{font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.debug-pre{background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:12px 14px;font-size:11px;font-family:'Cascadia Code','Fira Mono','Consolas',monospace;color:#94a3b8;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;line-height:1.55}
`;

