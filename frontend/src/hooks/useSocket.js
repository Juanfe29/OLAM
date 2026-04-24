import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = typeof window !== 'undefined'
  ? window.location.origin
  : 'http://localhost:3000';

let sharedSocket = null;
let refCount = 0;

function getSocket() {
  if (!sharedSocket) {
    sharedSocket = io(SOCKET_URL, {
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
  }
  refCount++;
  return sharedSocket;
}

function releaseSocket() {
  refCount--;
  if (refCount <= 0 && sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
    refCount = 0;
  }
}

export function useSocket() {
  const [connected, setConnected]   = useState(false);
  const socketRef                   = useRef(null);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    setConnected(socket.connected);

    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      releaseSocket();
    };
  }, []);

  function on(event, handler) {
    socketRef.current?.on(event, handler);
  }

  function off(event, handler) {
    socketRef.current?.off(event, handler);
  }

  return { connected, on, off };
}
