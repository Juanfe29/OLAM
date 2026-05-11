import { memo, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';

const fmt = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
};

// Custom equality: solo re-renderizar si cambió la longitud del history
// (nuevo sample) o el tier. Esto evita renders cuando Dashboard se re-pinta
// por cualquier otro motivo y `history` mantiene la misma cola pero distinta
// referencia.
function chartPropsEqual(prev, next) {
  if (prev.tier !== next.tier) return false;
  if (prev.history === next.history) return true;
  if (prev.history.length !== next.history.length) return false;
  const a = prev.history[prev.history.length - 1];
  const b = next.history[next.history.length - 1];
  return a?.ts === b?.ts &&
         a?.calls?.active === b?.calls?.active &&
         a?.host?.cpu     === b?.host?.cpu &&
         a?.host?.ram     === b?.host?.ram;
}

export const CallChart = memo(function CallChart({ history, tier = 256 }) {
  // useMemo: el .map() recorre todo history en cada render. Lo memoizamos
  // contra la referencia de history — cuando memo deja pasar un re-render,
  // useMemo evita el recompute redundante.
  const data = useMemo(
    () => history.map(h => ({
      ts:    h.ts || h.timestamp,
      calls: h.calls?.active ?? 0,
      cpu:   h.host?.cpu     ?? 0,
      ram:   h.host?.ram     ?? 0,
    })),
    [history],
  );

  return (
    <div className="bg-surface-raised rounded-lg border border-surface-border p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-slate-300">Llamadas · CPU · RAM</span>
        <span className="text-xs text-slate-500 font-mono">últimos 15 min</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 4, right: 36, bottom: 0, left: -20 }}>
          <XAxis
            dataKey="ts"
            tickFormatter={fmt}
            tick={{ fill: '#64748b', fontSize: 10 }}
            interval="preserveStartEnd"
            tickLine={false}
          />
          {/* Eje izquierdo: llamadas concurrentes */}
          <YAxis
            yAxisId="calls"
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            domain={[0, Math.max(tier * 1.2, 10)]}
          />
          {/* Eje derecho: porcentaje CPU / RAM */}
          <YAxis
            yAxisId="pct"
            orientation="right"
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            domain={[0, 100]}
            tickFormatter={v => `${v}%`}
          />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
            labelStyle={{ color: '#94a3b8', fontSize: 11 }}
            itemStyle={{ fontSize: 12, fontFamily: 'JetBrains Mono' }}
            labelFormatter={fmt}
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 11, color: '#64748b', paddingTop: 4 }}
          />
          {/* Línea de referencia: límite de licencia y umbral FAIL de CPU */}
          <ReferenceLine yAxisId="calls" y={tier}  stroke="#f59e0b" strokeDasharray="4 2" strokeOpacity={0.5} />
          <ReferenceLine yAxisId="pct"   y={80}    stroke="#ef4444" strokeDasharray="3 2" strokeOpacity={0.35} />
          <Line yAxisId="calls" type="monotone" dataKey="calls" name="llamadas" stroke="#34d399" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line yAxisId="pct"   type="monotone" dataKey="cpu"   name="CPU %"    stroke="#fb923c" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Line yAxisId="pct"   type="monotone" dataKey="ram"   name="RAM %"    stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}, chartPropsEqual);
