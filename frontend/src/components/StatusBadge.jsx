export function statusColor(value, ok, warn) {
  if (value === null || value === undefined) return 'text-slate-500';
  if (warn === undefined) return value ? 'text-green-400' : 'text-red-500';
  // For numeric thresholds: ok < warn means lower=better (CPU, RAM, errors...)
  //                         ok > warn means higher=better (ASR, MOS, SL...)
  const lowerIsBetter = ok < warn;
  if (lowerIsBetter) {
    if (value <= ok)   return 'text-green-400';
    if (value <= warn) return 'text-yellow-400';
    return 'text-red-500';
  } else {
    if (value >= ok)   return 'text-green-400';
    if (value >= warn) return 'text-yellow-400';
    return 'text-red-500';
  }
}

export function statusBg(value, ok, warn) {
  const cls = statusColor(value, ok, warn);
  return cls
    .replace('text-green-400',  'bg-green-400/10 border-green-400/30')
    .replace('text-yellow-400', 'bg-yellow-400/10 border-yellow-400/30')
    .replace('text-red-500',    'bg-red-500/10 border-red-500/30')
    .replace('text-slate-500',  'bg-slate-500/10 border-slate-500/30');
}

const LEVEL_COLORS = {
  CRITICO: 'bg-red-500/15 border-red-500/50 text-red-400',
  ALTO:    'bg-orange-500/15 border-orange-500/50 text-orange-400',
  MEDIO:   'bg-yellow-500/15 border-yellow-500/50 text-yellow-400',
  BAJO:    'bg-sky-500/15 border-sky-500/50 text-sky-400',
};

export function LevelBadge({ level }) {
  return (
    <span className={`text-xs font-mono px-1.5 py-0.5 rounded border ${LEVEL_COLORS[level] ?? 'bg-slate-700 text-slate-400'}`}>
      {level}
    </span>
  );
}
