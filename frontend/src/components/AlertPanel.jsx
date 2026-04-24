import { LevelBadge } from './StatusBadge.jsx';

const ORDER = { CRITICO: 0, ALTO: 1, MEDIO: 2, BAJO: 3 };

export function AlertPanel({ alerts }) {
  const sorted = [...(alerts || [])].sort(
    (a, b) => (ORDER[a.level] ?? 9) - (ORDER[b.level] ?? 9)
  );

  return (
    <div className="bg-surface-raised rounded-lg border border-surface-border flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
        <span className="text-sm font-medium text-slate-300">Alertas activas</span>
        <span className="text-xs font-mono text-slate-500">{sorted.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin max-h-72 divide-y divide-surface-border">
        {sorted.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-slate-500">Sin alertas activas</div>
        )}
        {sorted.map(alert => (
          <div key={alert.id} className="px-4 py-3 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <LevelBadge level={alert.level} />
              {alert.permanent && (
                <span className="text-xs text-slate-500 font-mono">{alert.id}</span>
              )}
              <span className="text-xs text-slate-500 font-mono ml-auto">
                {alert.ts ? new Date(alert.ts).toLocaleTimeString('es-CO') : ''}
              </span>
            </div>
            <p className="text-sm text-slate-300 leading-snug">{alert.msg || alert.title}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
