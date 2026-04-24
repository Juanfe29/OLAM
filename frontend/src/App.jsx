import { BrowserRouter, NavLink, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import Tests     from './pages/Tests.jsx';
import History   from './pages/History.jsx';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/tests',     label: 'Tests' },
  { to: '/history',   label: 'Historial' },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        {/* Top nav */}
        <header className="border-b border-surface-border bg-surface-raised/80 backdrop-blur sticky top-0 z-40">
          <div className="max-w-6xl mx-auto px-4 flex items-center h-14 gap-8">
            <div className="flex items-center gap-2 shrink-0">
              <span className="w-2 h-2 rounded-full bg-sky-400" />
              <span className="font-semibold text-slate-100 tracking-tight">OLAM</span>
              <span className="text-slate-500 text-xs font-mono">3CX Audit</span>
            </div>
            <nav className="flex gap-1">
              {NAV.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `px-3 py-1.5 rounded text-sm transition-colors ${
                      isActive
                        ? 'bg-sky-500/15 text-sky-400 font-medium'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">
          <Routes>
            <Route path="/"          element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/tests"     element={<Tests />} />
            <Route path="/history"   element={<History />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
