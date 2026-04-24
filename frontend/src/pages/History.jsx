import { useState, useEffect } from 'react';
import axios from 'axios';

export default function History() {
  const [tests,    setTests]    = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    axios.get('/api/history')
      .then(r => setTests(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function openDetail(id) {
    const { data } = await axios.get(`/api/history/${id}`);
    setSelected(data);
  }

  function exportJSON(test) {
    const blob = new Blob([JSON.stringify(test, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `olam-test-${test.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="text-slate-500 text-sm py-12 text-center">Cargando historial...</div>;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold text-slate-100">Historial de pruebas</h1>

      {tests.length === 0 && (
        <div className="text-center py-16 text-slate-500 text-sm">
          No hay pruebas registradas todavía. Ejecutá una desde la pestaña Tests.
        </div>
      )}

      {tests.length > 0 && (
        <div className="bg-surface-raised rounded-lg border border-surface-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border text-xs uppercase tracking-widest text-slate-500">
                <th className="px-4 py-3 text-left">ID</th>
                <th className="px-4 py-3 text-left">Escenario</th>
                <th className="px-4 py-3 text-right">Concurrencia</th>
                <th className="px-4 py-3 text-right">Duración</th>
                <th className="px-4 py-3 text-left">Inicio</th>
                <th className="px-4 py-3 text-center">Resultado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {tests.map(t => (
                <tr key={t.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-slate-400">{t.id}</td>
                  <td className="px-4 py-3 text-slate-200">{t.scenario}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-300">{t.max_calls}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-300">{t.duration}s</td>
                  <td className="px-4 py-3 text-slate-400 text-xs font-mono">
                    {new Date(t.started_at).toLocaleString('es-CO')}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {t.result
                      ? <ResultBadge result={t.result} />
                      : <span className="text-xs text-slate-500">—</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openDetail(t.id)}
                      className="text-xs text-sky-400 hover:text-sky-300 transition-colors"
                    >
                      Ver detalle →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div
            className="bg-surface-raised border border-surface-border rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto scrollbar-thin"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border">
              <div>
                <span className="font-semibold text-slate-100">Prueba #{selected.id}</span>
                <span className="ml-2 text-sm text-slate-400">{selected.scenario}</span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => exportJSON(selected)}
                  className="text-xs px-3 py-1.5 rounded border border-surface-border text-slate-300 hover:text-sky-400 hover:border-sky-500 transition-colors"
                >
                  Exportar JSON
                </button>
                <button
                  onClick={() => setSelected(null)}
                  className="text-slate-400 hover:text-white text-lg leading-none"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="p-6 flex flex-col gap-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <DetailStat label="Concurrencia" value={selected.max_calls} />
                <DetailStat label="Duración"     value={`${selected.duration}s`} />
                <DetailStat label="Rampa"        value={`${selected.ramp_rate}/s`} />
                <DetailStat label="Destino"      value={selected.destination} />
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs text-slate-400 font-mono">
                <div>Inicio: {new Date(selected.started_at).toLocaleString('es-CO')}</div>
                <div>Fin: {selected.ended_at ? new Date(selected.ended_at).toLocaleString('es-CO') : '—'}</div>
              </div>

              {selected.result && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-400">Resultado:</span>
                  <ResultBadge result={selected.result} />
                </div>
              )}

              {selected.summary && (
                <div className="bg-surface border border-surface-border rounded-lg p-4">
                  <p className="text-xs uppercase tracking-widest text-slate-500 mb-3">Resumen</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono">
                    <DetailStat label="Max calls"   value={selected.summary.maxCalls}   />
                    <DetailStat label="Avg calls"   value={selected.summary.avgCalls}   />
                    <DetailStat label="Avg error"   value={`${selected.summary.avgErrorRate}%`} />
                    <DetailStat label="Peak reached" value={selected.summary.peakReached ? 'sí' : 'no'} />
                    <DetailStat label="Pasó"         value={selected.summary.passed ? 'sí' : 'no'} />
                  </div>
                </div>
              )}

              {selected.snapshots?.length > 0 && (
                <div className="text-xs text-slate-500 font-mono">
                  {selected.snapshots.length} snapshots almacenados
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultBadge({ result }) {
  const colors = {
    PASS:    'bg-green-500/15 border-green-500/40 text-green-400',
    FAIL:    'bg-red-500/15 border-red-500/40 text-red-400',
    ERROR:   'bg-orange-500/15 border-orange-500/40 text-orange-400',
    STOPPED: 'bg-slate-500/15 border-slate-500/40 text-slate-400',
  };
  return (
    <span className={`text-xs font-mono px-2 py-0.5 rounded border ${colors[result] ?? colors.STOPPED}`}>
      {result}
    </span>
  );
}

function DetailStat({ label, value }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
      <span className="font-mono text-sm text-slate-200">{value ?? '—'}</span>
    </div>
  );
}
