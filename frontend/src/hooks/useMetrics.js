import { useState, useEffect, useCallback } from 'react';
import { useSocket } from './useSocket.js';

const MAX_HISTORY = 360; // 30 minutes at 5s intervals

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
