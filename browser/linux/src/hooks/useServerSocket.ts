import { useEffect, useRef } from 'react';

interface ServerCommand {
  type: string;
  viewId?: string;
  payload?: Record<string, any>;
  [key: string]: any;
}

interface Options {
  serverUrl: string;
  deviceId: string;
  enabled: boolean;
  onCommand: (cmd: ServerCommand, respond: (message: Record<string, unknown>) => void) => void;
}

/**
 * Persistent WebSocket connection to the Canvas UI server.
 * Reconnects with exponential backoff.
 * Passes 'browser' as the client role so the server routes device commands here.
 */
export function useServerSocket({ serverUrl, deviceId, enabled, onCommand }: Options) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryDelay = useRef(1000);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    if (!enabled || !serverUrl || !deviceId) return;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const wsUrl = serverUrl.replace(/^http/, 'ws') + `/ws?role=browser&deviceId=${deviceId}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[ServerSocket] Connected');
        retryDelay.current = 1000; // reset backoff
        // Announce ourselves — field names must match the server's hello handler
        ws.send(JSON.stringify({
          type: 'hello',
          client_type: 'browser',
          device_id: deviceId,
          screen_width: window.screen.width,
          screen_height: window.screen.height,
          pixel_ratio: window.devicePixelRatio,
        }));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          onCommandRef.current(msg, response => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
          });
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        if (cancelled) return;
        console.log(`[ServerSocket] Disconnected, retrying in ${retryDelay.current}ms`);
        setTimeout(connect, retryDelay.current);
        retryDelay.current = Math.min(retryDelay.current * 2, 30000);
      };

      ws.onerror = (e) => {
        console.error('[ServerSocket] Error:', e);
        ws.close();
      };
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [serverUrl, deviceId, enabled]);
}
