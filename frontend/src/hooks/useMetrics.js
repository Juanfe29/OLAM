import { useState, useEffect, useCallback } from 'react';
import { useSocket } from './useSocket.js';

// 180 = 15 min @ 5s intervals. Antes era 360 (30 min) pero el SVG path de
// Recharts con tantos puntos hacía sentir laggy el dashboard. 15 min sigue
// dando contexto suficiente para ver tendencias durante un test de carga.
const MAX_HISTORY = 180;

export function useMetrics() {
  const { connected, on, off } = useSocket();
  const [metrics, setMetrics]   = useState(null);
  const [alerts,  setAlerts]    = useState([]);
  const [history, setHistory]   = useState([]);  // rolling window for charts

  const handleMetrics = useCallback((data) => {
    setMetrics(data);
    setHistory(prev => {
      const next = [...prev, { ...data, ts: data.timestamp }];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, []);

  const handleAlert = useCallback((alert) => {
    setAlerts(prev => {
      const filtered = prev.filter(a => a.id !== alert.id);
      return [alert, ...filtered];
    });
  }, []);

  const handleAlertsInit = useCallback((all) => {
    setAlerts(all);
  }, []);

  useEffect(() => {
    on('metrics:update',  handleMetrics);
    on('alert:new',       handleAlert);
    on('alerts:current',  handleAlertsInit);

    return () => {
      off('metrics:update',  handleMetrics);
      off('alert:new',       handleAlert);
      off('alerts:current',  handleAlertsInit);
    };
  }, [on, off, handleMetrics, handleAlert, handleAlertsInit]);

  return { metrics, alerts, history, connected };
}
