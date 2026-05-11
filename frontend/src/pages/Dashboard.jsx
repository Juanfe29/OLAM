import { useMetrics } from '../hooks/useMetrics.js';
import { MetricCard } from '../components/MetricCard.jsx';
import { CallChart } from '../components/CallChart.jsx';
import { AlertPanel } from '../components/AlertPanel.jsx';
import { TrunkStatus } from '../components/TrunkStatus.jsx';

export default function Dashboard() {
  const { metrics, alerts, history, connected } = useMetrics();

  if (!metrics) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        Conectando con el backend...
      </div>
    );
  }

  const { host, calls, quality, trunk, queue } = metrics;

  return (
    <div className="flex flex-col gap-6">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">Estado en vivo</h1>
        <div className="flex items-center gap-4 text-xs font-mono">
          <span className={`flex items-center gap-1.5 ${connected ? 'text-green-400' : 'text-red-500'}`}>
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
            WS {connected ? 'conectado' : 'desconectado'}
          </span>
          {metrics.mock && (
            <span className="px-2 py-0.5 rounded border border-sky-500/40 text-sky-400 bg-sky-500/10">
              MOCK MODE
            </span>
          )}
          <span className="text-slate-500">
            {new Date(metrics.timestamp).toLocaleTimeString('es-CO')}
          </span>
        </div>
      </div>

      {/* Host KPIs */}
      <section>
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-2">Host</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="CPU"         value={host.cpu}        unit="%" ok={60}  warn={80}  decimals={1} />
          <MetricCard label="RAM"         value={host.ram}        unit="%" ok={70}  warn={85}  decimals={1} />
          <MetricCard label="Load avg 1m" value={host.loadAvg?.[0]} unit=""  ok={2}   warn={4}   decimals={2} />
          <MetricCard label="Disco OS"    value={host.disk?.os}   unit="%" ok={70}  warn={85}  decimals={0} />
        </div>
      </section>

      {/* Call KPIs */}
      <section>
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-2">Llamadas</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="Concurrentes" value={calls.active}    unit={`/ ${calls.tier}`} ok={calls.tier * 0.7} warn={calls.tier * 0.9} decimals={0}>
            {calls.active > calls.tier * 0.9 ? 'Cerca del límite' : ''}
          </MetricCard>
          <MetricCard label="PDD p95"      value={calls.pdd_p95}   unit="s"  ok={2}    warn={4}   decimals={2} />
          <MetricCard label="ASR"          value={calls.asr}       unit="%"  ok={98}   warn={95}  decimals={1} />
          <MetricCard label="Error rate"   value={calls.errorRate} unit="%"  ok={2}    warn={5}   decimals={1} />
        </div>
      </section>

      {/* Quality KPIs */}
      <section>
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-2">Calidad de voz</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <MetricCard label="MOS promedio"  value={quality.mos}        unit=""    ok={4.0}  warn={3.6} decimals={2} />
          <MetricCard label="Jitter p95"    value={quality.jitter_p95} unit="ms"  ok={20}   warn={30}  decimals={1} />
          <MetricCard label="Packet loss"   value={quality.packetLoss} unit="%"   ok={0.5}  warn={1}   decimals={2} />
        </div>
      </section>

      {/* Queue KPIs */}
      <section>
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-2">Colas</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="En espera"     value={queue.waiting}      unit=""   ok={0}   warn={5}   decimals={0} />
          <MetricCard label="Agentes online" value={queue.agentsOnline} unit=""   ok={10}  warn={5}   decimals={0} />
          <MetricCard label="Service Level"  value={queue.serviceLevel} unit="%"  ok={80}  warn={70}  decimals={1} />
          <MetricCard label="Abandono"       value={queue.abandonment}  unit="%"  ok={5}   warn={10}  decimals={1} />
        </div>
      </section>

      {/* Charts + Trunk + Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CallChart history={history} tier={calls.tier} />
        <TrunkStatus trunk={trunk} />
      </div>

      <AlertPanel alerts={alerts} />
    </div>
  );
}
