import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

const fmt = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
};

export function CallChart({ history, tier = 32 }) {
  const data = history.map(h => ({
    ts:    h.ts || h.timestamp,
    calls: h.calls?.active ?? 0,
    cpu:   h.host?.cpu ?? 0,
  }));

  return (
    <div className="bg-surface-raised rounded-lg border border-surface-border p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-slate-300">Llamadas activas</span>
        <span className="text-xs text-slate-500 font-mono">últimos 30 min</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <XAxis
            dataKey="ts"
            tickFormatter={fmt}
            tick={{ fill: '#64748b', fontSize: 10 }}
            interval="preserveStartEnd"
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            domain={[0, Math.max(tier * 1.2, 10)]}
          />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
            labelStyle={{ color: '#94a3b8', fontSize: 11 }}
            itemStyle={{ color: '#34d399', fontSize: 12, fontFamily: 'JetBrains Mono' }}
            labelFormatter={fmt}
            formatter={(v) => [v, 'llamadas']}
          />
          <ReferenceLine y={tier} stroke="#f59e0b" strokeDasharray="4 2" strokeOpacity={0.6} />
          <Line
            type="monotone"
            dataKey="calls"
            stroke="#34d399"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
