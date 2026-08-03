/**
 * LogsPage — live log viewer.
 *
 * Loads Core's bounded in-memory history and follows its authenticated SSE
 * stream. This shows actual application/request logs rather than browser
 * command traffic.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Box, Typography, IconButton, Tooltip, Chip, Stack, TextField, Alert,
} from '@mui/material';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';
import { getApiBase } from '../api/client';
import { PageHeader } from '../components/ui';

const MAX_DISPLAY = 2000;

interface LogLine {
  ts: number;
  text: string;
}

export default function LogsPage() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | undefined;

    async function connect() {
      if (closed) return;
      try {
        const historyResponse = await fetch(`${getApiBase()}/api/admin/logs/history`, {
          credentials: 'include',
        });
        if (!historyResponse.ok) throw new Error(`Log history returned HTTP ${historyResponse.status}`);
        const history = await historyResponse.json() as { lines?: string[] };
        if (!pausedRef.current) {
          const now = Date.now();
          setLines((history.lines ?? []).slice(-MAX_DISPLAY).map((text, index, values) => ({
            ts: now - (values.length - index),
            text,
          })));
        }
      } catch {
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 3000);
        return;
      }

      const stream = new EventSource(`${getApiBase()}/api/admin/logs/stream`, { withCredentials: true });
      eventSourceRef.current = stream;
      stream.onopen = () => setConnected(true);
      stream.onerror = () => {
        setConnected(false);
        stream.close();
        if (!closed) reconnectTimer = window.setTimeout(connect, 3000);
      };
      stream.onmessage = event => {
        if (pausedRef.current) return;
        let text = event.data;
        try { text = JSON.parse(event.data) as string; } catch { /* use raw SSE data */ }
        setLines(prev => {
          const next = [...prev, { ts: Date.now(), text }];
          return next.length > MAX_DISPLAY ? next.slice(next.length - MAX_DISPLAY) : next;
        });
      };
    }

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [lines, paused]);

  const handleClear = useCallback(() => setLines([]), []);
  const handleDownload = useCallback(() => {
    // Core log lines already contain their authoritative timestamp. Do not prepend
    // the browser receipt time (history is delivered in a burst during page load).
    const blob = new Blob([lines.map(l => l.text).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canvas-core-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lines]);

  const lower = filter.toLowerCase();
  const displayed = lines.filter(l => !lower || l.text.toLowerCase().includes(lower));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader title="Logs" subtitle="Live application and request logs from Canvas Core" />
      <Box sx={{ flex: 1, p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, overflow: 'hidden' }}>
        {!connected && (
          <Alert severity="info" sx={{ bgcolor: 'rgba(108,99,255,0.1)' }}>
            Connecting to the Core log stream…
          </Alert>
        )}
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Chip
            size="small"
            label={connected ? 'Live' : 'Reconnecting…'}
            color={connected ? 'success' : 'warning'}
            variant="outlined"
            sx={{ fontSize: 11 }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {displayed.length} / {lines.length} lines
          </Typography>
          <Box sx={{ flex: 1 }} />
          <TextField
            size="small"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            sx={{ minWidth: 160, maxWidth: 260 }}
            slotProps={{ htmlInput: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
          <Tooltip title={paused ? 'Resume' : 'Pause'}>
            <IconButton size="small" onClick={() => setPaused(p => !p)} color={paused ? 'warning' : 'default'}>
              {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Download">
            <IconButton size="small" onClick={handleDownload}><DownloadIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title="Clear">
            <IconButton size="small" onClick={handleClear}><ClearAllIcon fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>

        <Box sx={{
          flex: 1, overflow: 'auto', bgcolor: '#0a0a12', borderRadius: 1,
          border: '1px solid', borderColor: 'divider', p: 1.5,
          fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
          fontSize: 12, lineHeight: 1.6,
        }}>
          {displayed.length === 0 && (
            <Typography variant="caption" sx={{ color: 'text.disabled' }}>
              {lines.length === 0 ? 'Waiting for messages…' : 'No lines match the filter.'}
            </Typography>
          )}
          {displayed.map((l, i) => (
            <Box key={i} component="div" sx={{ color: '#c3c9d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all', py: '1px' }}>
              <span style={{ color: '#6b6375' }}>[{new Date(l.ts).toLocaleTimeString()}]</span>{' '}
              {l.text}
            </Box>
          ))}
          <div ref={bottomRef} />
        </Box>
      </Box>
    </Box>
  );
}
