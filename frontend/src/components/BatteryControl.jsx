import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useSocket } from '../hooks/useSocket.js';

const LEVELS = [
  { key: 'light',  label: 'Light',  calls: 10,  duration: 89, ramp: 2  },
  { key: 'medium', label: 'Medium', calls: 50,  duration: 89, ramp: 5  },
  { key: 'peak',   label: 'Peak',   calls: 180, duration: 89, ramp: 10 },
  { key: 'stress', label: 'Stress', calls: 220, duration: 89, ramp: 15 },
  { key: 'max',    label: 'Max',    calls: 256, duration: 89, ramp: 15 },
];

const EST_MINUTES = Math.ceil(LEVELS.reduce((s, l) => s + l.duration + 10, 0) / 60);

export function BatteryControl() {
  const { on, off } = useSocket();
  const [destination, setDestination] = useState('6013849924');
  const [validExts,   setValidExts]   = useState([]);
  const [running,     setRunning]     = useState(false);
  const [levelIdx,    setLevelIdx]    = useState(-1);
  const [results,     setResults]     = useState([]);
  const [report,      setReport]      = useState(null);
  const [error,       setError]       = useState('');
  const [loading,     setLoading]     = useState(false);

  useEffect(() => {
    axios.get('/api/tests/destinations')
      .then(r => setValidExts(r.data?.valid || []))
      .catch(() => {});
  }, []);

  const handleProgress = useCallback((data) => {
    setLevelIdx(data.levelIdx ?? -1);
    if (data.results) setResults(data.results);
  }, []);

  const handleComplete = useCallback((data) => {
    setRunning(false);
    setLevelIdx(-1);
    setResults(data.levels || []);
    setReport(data);
  }, []);

  useEffect(() => {
    on('battery:progress', handleProgress);
    on('battery:complete', handleComplete);
    return () => {
      off('battery:progress', handleProgress);
      off('battery:complete', handleComplete);
    };
  }, [on, off, handleProgress, handleComplete]);

  async function handleStart() {
    setError('');
    setLoading(true);
    setReport(null);
    setResults([]);
    setLevelIdx(-1);
    try {
      await axios.post('/api/tests/run-battery', { destination });
      setRunning(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al iniciar la batería');
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    await axios.post('/api/tests/stop-battery').catch(() => {});
  }

  function downloadJSON() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `olam-battery-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Config panel */}
      <div className="bg-surface-raised rounded-lg border border-surface-border p-5 flex flex-col gap-5">
        <div>
          <p className="text-sm font-medium text-slate-200 mb-1">Batería progresiva</p>
          <p className="text-xs text-slate-500">
            {LEVELS.length} niveles en secuencia · duración por nivel: 89s · estimado total: ~{EST_MINUTES} min
          </p>
        </div>

        {/* Levels table */}
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-slate-500 border-b border-surface-border">
              <th className="text-left pb-1.5 pr-4">Nivel</th>
              <th className="text-right pr-4">Llamadas</th>
              <th className="text-right pr-4">Duración</th>
              <th className="text-right">Rampa</th>
            </tr>
          </thead>
          <tbody>
            {LEVELS.map((level, i) => {
              const res       = results.find(r => r.key === level.key);
              const isRunning = running && levelIdx === i && !res;
              const isPending = running && levelIdx < i && !res;
              return (
                <tr key={level.key} className="border-b border-surface-border/30">
                  <td className="py-1.5 pr-4">
                    <span className="flex items-center gap-2">
                      <LevelIcon res={res} isRunning={isRunning} />
                      <span className={isRunning ? 'text-sky-300' : isPending ? 'text-slate-500' : res ? 'text-slate-200' : 'text-slate-400'}>
                        {level.label}
                      </span>
                    </span>
                  </td>
                  <td className="text-right pr-4 text-slate-300">{level.calls}</td>
                  <td className="text-right pr-4 text-slate-400">{level.duration}s</td>
                  <td className="text-right text-slate-400">{level.ramp}/s</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Destination */}
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-400 shrink-0">Destino</label>
          <input
            type="text"
            value={destination}
            onChange={e => setDestination(e.target.value)}
            disabled={running}
            className="flex-1 bg-surface border border-surface-border rounded px-3 py-1.5 text-sm font-mono text-slate-200 focus:outline-none focus:border-sky-500 disabled:opacity-40"
          />
          {validExts.map(ext => (
            <button
              key={ext}
              onClick={() => setDestination(ext)}
              disabled={running}
              className="text-xs font-mono px-2 py-1 rounded border border-surface-border text-slate-400 hover:border-sky-500 hover:text-sky-400 disabled:opacity-40 transition-colors"
            >
              {ext}
            </button>
          ))}
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</p>
        )}

        {running && levelIdx >= 0 && (
          <div className="flex items-center gap-2 text-xs text-slate-400 bg-surface/50 rounded px-3 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse shrink-0" />
            Nivel {levelIdx + 1}/{LEVELS.length} —
            <span className="text-sky-300 ml-0.5">{LEVELS[levelIdx]?.label}</span>
            <span className="text-slate-500">({LEVELS[levelIdx]?.calls} llamadas · {LEVELS[levelIdx]?.duration}s)</span>
          </div>
        )}

        {running ? (
          <button
            onClick={handleStop}
            className="w-full py-2.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold text-sm transition-colors"
          >
            Detener batería
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={loading}
            className="w-full py-2.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-sm transition-colors"
          >
            {loading ? 'Iniciando...' : 'Iniciar batería progresiva'}
          </button>
        )}
      </div>

      {/* Report */}
      {report && <BatteryReport report={report} onDownload={downloadJSON} />}
    </div>
  );
}

function LevelIcon({ res, isRunning }) {
  if (isRunning) return <span className="text-sky-400 animate-pulse w-3 text-center">▶</span>;
  if (!res)      return <span className="text-slate-600 w-3 text-center">◦</span>;
  if (res.result === 'PASS')    return <span className="text-green-400 w-3 text-center">✓</span>;
  if (res.result === 'STOPPED') return <span className="text-yellow-400 w-3 text-center">■</span>;
  return <span className="text-red-400 w-3 text-center">✗</span>;
}

function BatteryReport({ report, onDownload }) {
  const date = new Date(report.completedAt).toLocaleString('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const allPass   = report.levels.length > 0 && report.levels.every(l => l.result === 'PASS');
  const safeCalls = allPass
    ? Math.max(...report.levels.filter(l => l.result === 'PASS').map(l => l.calls))
    : null;
  const firstFail = report.levels.find(l => l.result === 'FAIL' || l.result === 'ERROR');

  return (
    <div className="bg-surface-raised rounded-lg border border-surface-border p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-200">Informe de Batería</p>
          <p className="text-xs text-slate-500">{date} · destino: {report.destination}</p>
        </div>
        <button
          onClick={onDownload}
          className="text-xs px-3 py-1.5 rounded border border-surface-border text-slate-400 hover:border-sky-500 hover:text-sky-400 transition-colors font-mono"
        >
          Exportar JSON
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono border-collapse">
          <thead>
            <tr className="text-slate-500 border-b border-surface-border">
              <th className="text-left py-1.5 pr-3">Test</th>
              <th className="text-right pr-3">Llamadas</th>
              <th className="text-right pr-3">Exitosas</th>
              <th className="text-right pr-3">Fallidas</th>
              <th className="text-right pr-3">CPU steady</th>
              <th className="text-right pr-3">CPU peak</th>
              <th className="text-right pr-3">RAM</th>
              <th className="text-right">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {report.levels.map(level => (
              <tr key={level.key} className="border-b border-surface-border/30 hover:bg-slate-800/30">
                <td className="py-1.5 pr-3 text-slate-300">{level.label}</td>
                <td className="text-right pr-3 text-slate-300">{level.calls}</td>
                <td className="text-right pr-3 text-green-400">{level.successful}</td>
                <td className="text-right pr-3 text-red-400">{level.failed || 0}</td>
                <td className="text-right pr-3 text-slate-400">~{level.cpuSteady}%</td>
                <td className={`text-right pr-3 font-semibold ${level.cpuPeak > 80 ? 'text-red-400' : level.cpuPeak > 60 ? 'text-yellow-400' : 'text-slate-200'}`}>
                  {level.cpuPeak}%
                </td>
                <td className="text-right pr-3 text-slate-400">{level.ramPeak}%</td>
                <td className="text-right">
                  <ResultBadge result={level.result} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.aborted && (
        <p className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded px-3 py-2">
          Batería detenida manualmente. Se completaron {report.completedLevels}/{report.totalLevels} niveles.
        </p>
      )}

      {!report.aborted && allPass && (
        <p className="text-xs text-green-300 bg-green-500/10 border border-green-500/30 rounded px-3 py-2">
          Todos los niveles PASS. Límite operativo seguro: ~{safeCalls} llamadas simultáneas.
        </p>
      )}

      {!report.aborted && firstFail && (
        <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          Primer nivel con problema: <strong>{firstFail.label}</strong>
          {firstFail.failReason ? ` — ${firstFail.failReason}` : ''}
        </p>
      )}
    </div>
  );
}

function ResultBadge({ result }) {
  const classes = {
    PASS:    'text-green-400',
    FAIL:    'text-red-400',
    STOPPED: 'text-yellow-400',
    ERROR:   'text-red-500',
  };
  return <span className={`font-semibold ${classes[result] || 'text-slate-400'}`}>{result}</span>;
}
