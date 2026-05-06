import { useState, useEffect } from 'react';
import axios from 'axios';

const SCENARIOS = {
  smoke:  { calls: 1,   duration: 30,    ramp: 1,  label: 'Smoke'  },
  light:  { calls: 10,  duration: 60,    ramp: 2,  label: 'Light'  },
  medium: { calls: 50,  duration: 120,   ramp: 5,  label: 'Medium' },
  peak:   { calls: 180, duration: 300,   ramp: 10, label: 'Peak'   },
  stress: { calls: 256, duration: 180,   ramp: 15, label: 'Stress' },
  soak:   { calls: 125, duration: 14400, ramp: 5,  label: 'Soak'   },
};

// Tier de licencia del 3CX target. El backend cap duro está en LIMITS.maxCalls=256.
// Si OLAM downgradea a SC192 en producción, ajustar a 192.
const LICENSE_TIER = 256;

export function TestControl({ testStatus, onTestStart }) {
  const [calls,       setCalls]       = useState(10);
  const [duration,    setDuration]    = useState(60);
  const [ramp,        setRamp]        = useState(2);
  const [destination, setDestination] = useState('1910');
  const [error,       setError]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [validExts,   setValidExts]   = useState([]);

  const running = testStatus?.running;

  useEffect(() => {
    axios.get('/api/tests/destinations')
      .then(r => setValidExts(r.data?.valid || []))
      .catch(() => setValidExts([]));
  }, []);

  function applyPreset(key) {
    const p = SCENARIOS[key];
    setCalls(p.calls);
    setDuration(p.duration);
    setRamp(p.ramp);
  }

  async function handleStart() {
    setError('');
    setLoading(true);
    try {
      await axios.post('/api/tests/run', { max_calls: calls, duration, ramp_rate: ramp, destination });
      if (onTestStart) onTestStart();
    } catch (err) {
      setError(err.response?.data?.error || 'Error al iniciar la prueba');
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    await axios.post('/api/tests/stop').catch(() => {});
  }

  const overTier = calls > LICENSE_TIER;

  return (
    <div className="bg-surface-raised rounded-lg border border-surface-border p-5 flex flex-col gap-5">
      {/* Presets */}
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-2">Escenarios predefinidos</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(SCENARIOS).map(([key, p]) => (
            <button
              key={key}
              onClick={() => applyPreset(key)}
              disabled={running}
              className="px-3 py-1.5 text-xs font-mono rounded border border-surface-border text-slate-300 hover:border-sky-500 hover:text-sky-400 disabled:opacity-40 transition-colors"
            >
              {p.label} <span className="text-slate-500">({p.calls}c)</span>
            </button>
          ))}
        </div>
      </div>

      {/* Sliders */}
      <div className="grid grid-cols-1 gap-4">
        <Slider label="Llamadas simultáneas" value={calls} min={1} max={256} onChange={setCalls} disabled={running} />
        <Slider label="Duración (segundos)"  value={duration} min={10} max={28800} onChange={setDuration} disabled={running} />
        <Slider label="Rampa (llamadas/seg)" value={ramp} min={1} max={20} onChange={setRamp} disabled={running} />
      </div>

      {/* Destination */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-400 whitespace-nowrap">Destino (extensión)</label>
          <input
            type="text"
            value={destination}
            onChange={e => setDestination(e.target.value)}
            disabled={running}
            className="flex-1 bg-surface border border-surface-border rounded px-3 py-1.5 text-sm font-mono text-slate-200 focus:outline-none focus:border-sky-500 disabled:opacity-40"
          />
        </div>
        {validExts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-[6.5rem]">
            <span className="text-xs text-slate-500">Válidas:</span>
            {validExts.map(ext => (
              <button
                key={ext}
                type="button"
                onClick={() => setDestination(ext)}
                disabled={running}
                className="text-xs font-mono px-1.5 py-0.5 rounded border border-surface-border text-slate-400 hover:border-sky-500 hover:text-sky-400 disabled:opacity-40 transition-colors"
              >
                {ext}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* License warning */}
      {overTier && (
        <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded px-3 py-2">
          <span className="text-yellow-400 text-sm">⚠</span>
          <p className="text-xs text-yellow-300 leading-snug">
            <strong>{calls} llamadas supera el tier {LICENSE_TIER}.</strong> El 3CX rechazará llamadas por encima del límite de licencia con código <code className="font-mono">600 Busy Everywhere</code>.
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</p>
      )}

      {/* Action button */}
      {running ? (
        <button
          onClick={handleStop}
          className="w-full py-2.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold text-sm transition-colors"
        >
          Detener prueba
        </button>
      ) : (
        <button
          onClick={handleStart}
          disabled={loading}
          className="w-full py-2.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold text-sm transition-colors"
        >
          {loading ? 'Iniciando...' : 'Iniciar prueba'}
        </button>
      )}
    </div>
  );
}

function Slider({ label, value, min, max, onChange, disabled }) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-xs text-slate-400">{label}</span>
        <span className="text-xs font-mono text-slate-200">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        disabled={disabled}
        className="w-full accent-sky-500 disabled:opacity-40"
      />
    </div>
  );
}
