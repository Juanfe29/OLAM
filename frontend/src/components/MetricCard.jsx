import { statusColor, statusBg } from './StatusBadge.jsx';

export function MetricCard({ label, value, unit = '', ok, warn, decimals = 1, children }) {
  const display = value === null || value === undefined ? '—' : Number(value).toFixed(decimals);
  const color   = statusColor(value, ok, warn);
  const bg      = statusBg(value, ok, warn);

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-1 ${bg}`}>
      <span className="text-xs uppercase tracking-widest text-slate-400 font-medium">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className={`metric-value text-2xl font-semibold ${color}`}>{display}</span>
        {unit && <span className="text-sm text-slate-500">{unit}</span>}
      </div>
      {children && <div className="text-xs text-slate-500 mt-1">{children}</div>}
    </div>
  );
}
