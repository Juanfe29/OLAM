export function TrunkStatus({ trunk }) {
  if (!trunk) return null;

  const usedPct = trunk.channelsTotal > 0
    ? Math.round((trunk.channelsUsed / trunk.channelsTotal) * 100)
    : 0;

  return (
    <div className="bg-surface-raised rounded-lg border border-surface-border p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-slate-300">Troncal SIP — Tigo UNE</span>
        <span className={`flex items-center gap-1.5 text-xs font-mono font-medium ${trunk.registered ? 'text-green-400' : 'text-red-500'}`}>
          <span className={`w-2 h-2 rounded-full ${trunk.registered ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
          {trunk.registered ? 'REGISTRADA' : 'DESREGISTRADA'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <Stat label="Canales"    value={`${trunk.channelsUsed ?? 0} / ${trunk.channelsTotal ?? 0}`} />
        <Stat label="Err 408/h"  value={trunk.errors408 ?? 0} warn={trunk.errors408 > 5} />
        <Stat label="Err 503/h"  value={trunk.errors503 ?? 0} warn={trunk.errors503 > 0} />
      </div>

      <div>
        <div className="flex justify-between text-xs text-slate-500 mb-1">
          <span>Uso de canales</span>
          <span className="font-mono">{usedPct}%</span>
        </div>
        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${usedPct > 90 ? 'bg-red-500' : usedPct > 70 ? 'bg-yellow-400' : 'bg-green-400'}`}
            style={{ width: `${Math.min(usedPct, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
      <span className={`metric-value text-lg font-semibold ${warn ? 'text-red-400' : 'text-slate-200'}`}>{value}</span>
    </div>
  );
}
