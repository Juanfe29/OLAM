import { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useSocket } from '../hooks/useSocket.js';
import { TestControl } from '../components/TestControl.jsx';

export default function Tests() {
  const { on, off } = useSocket();
  const [testStatus,   setTestStatus]   = useState({ running: false });
  const [liveData,     setLiveData]     = useState([]);
  const [lastResult,   setLastResult]   = useState(null);

  const handleProgress = useCallback((data) => {
    setTestStatus(data);
    setLiveData(prev => {
      const next = [...prev, { t: data.elapsed, calls: data.activeCalls, err: data.errorRate }];
      return next.length > 600 ? next.slice(-600) : next;
    });
  }, []);

  const handleComplete = useCallback((data) => {
    setTestStatus({ running: false });
    setLastResult(data);
  }, []);

  useEffect(() => {
    on('test:progress', handleProgress);
    on('test:complete', handleComplete);
    return () => {
      off('test:progress', handleProgress);
      off('test:complete', handleComplete);
    };
  }, [on, off, handleProgress, handleComplete]);

  function handleTestStart() {
    setLiveData([]);
    setLastResult(null);
  }

  const elapsed  = testStatus.elapsed ?? 0;
  const duration = testStatus.duration ?? 1;
  const progress = Math.min(Math.round((elapsed / duration) * 100), 100);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold text-slate-100">Control de pruebas</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Config */}
        <TestControl testStatus={testStatus} onTestStart={handleTestStart} />

        {/* Right: Live progress */}
        <div className="flex flex-col gap-4">
          {testStatus.running && (
            <div className="bg-surface-raised rounded-lg border border-surface-border p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-300">Prueba en curso</span>
                <span className="text-xs font-mono text-sky-400">{testStatus.scenario ?? 'custom'}</span>
              </div>

              {/* Progress bar */}
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>{elapsed}s transcurridos</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-sky-500 rounded-full transition-all duration-1000"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>

              {/* Live stats */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <LiveStat label="Llamadas activas" value={testStatus.activeCalls ?? 0} />
                <LiveStat label="Error rate" value={`${testStatus.errorRate ?? 0}%`} warn={testStatus.errorRate > 5} />
                <LiveStat label="Objetivo" value={testStatus.max_calls ?? '—'} />
              </div>
            </div>
          )}

          {/* Live chart */}
          {liveData.length > 1 && (
            <div className="bg-surface-raised rounded-lg border border-surface-border p-4">
              <p className="text-xs text-slate-500 mb-3 uppercase tracking-widest">Llamadas en tiempo real</p>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={liveData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} unit="s" />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
                    itemStyle={{ fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  />
                  <Line type="monotone" dataKey="calls" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} name="llamadas" />
                  <Line type="monotone" dataKey="err"   stroke="#f87171" strokeWidth={1.5} dot={false} isAnimationActive={false} name="error%" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Last result */}
          {lastResult && (
            <div className={`rounded-lg border p-4 ${lastResult.result === 'PASS' ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm">{lastResult.scenario}</span>
                <span className={`font-mono text-sm font-bold ${lastResult.result === 'PASS' ? 'text-green-400' : 'text-red-400'}`}>
                  {lastResult.result}
                </span>
              </div>
              {lastResult.summary && (
                <div className="grid grid-cols-3 gap-2 text-xs text-slate-400 font-mono">
                  {lastResult.summary.source === 'csv' ? (
                    <>
                      <span>Total: {lastResult.summary.totalCalls}</span>
                      <span>Success: {lastResult.summary.successful}</span>
                      <span>Failed: {lastResult.summary.failed}</span>
                    </>
                  ) : (
                    <>
                      <span>Max calls: {lastResult.summary.maxCalls}</span>
                      <span>Avg error: {lastResult.summary.avgErrorRate}%</span>
                      <span>Peak reached: {lastResult.summary.peakReached ? 'sí' : 'no'}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveStat({ label, value, warn }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`metric-value text-xl font-semibold ${warn ? 'text-red-400' : 'text-slate-100'}`}>{value}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );
}
