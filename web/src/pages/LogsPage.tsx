/**
 * LogsPage — live server log viewer via SSE.
 *
 * Connects to GET /api/logs/stream and displays lines as they arrive,
 * auto-scrolling to the bottom. Supports filtering by keyword and
 * pausing the auto-scroll so you can inspect a specific line.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Box, Typography, TextField, IconButton, Tooltip, Chip, Stack,
  ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';

const MAX_DISPLAY = 2000;

type Level = 'all' | 'err' | 'wrn';

function lineLevel(line: string): 'err' | 'wrn' | 'info' {
  if (line.includes('[ERR]')) return 'err';
  if (line.includes('[WRN]')) return 'wrn';
  return 'info';
}

function levelColor(lvl: 'err' | 'wrn' | 'info'): string {
  if (lvl === 'err') return '#f28b82';
  if (lvl === 'wrn') return '#fdd663';
  return '#c3c9d4';
}

export default function LogsPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<Level>('all');
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // SSE connection
  useEffect(() => {
    const es = new EventSource('/api/logs/stream');

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      if (pausedRef.current) return;
      try {
        const line: string = JSON.parse(e.data);
        setLines(prev => {
          const next = [...prev, line];
          return next.length > MAX_DISPLAY ? next.slice(next.length - MAX_DISPLAY) : next;
        });
      } catch { /* ignore malformed */ }
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };

    return () => es.close();
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [lines, paused]);

  const handleClear = useCallback(() => setLines([]), []);

  const handleDownload = useCallback(() => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canvas-server-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lines]);

  const lowerFilter = filter.toLowerCase();
  const displayed = lines.filter(line => {
    if (level === 'err' && lineLevel(line) !== 'err') return false;
    if (level === 'wrn' && lineLevel(line) === 'info') return false;
    if (lowerFilter && !line.toLowerCase().includes(lowerFilter)) return false;
    return true;
  });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 1.5 }}>
      {/* Header */}
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" sx={{ fontWeight: 700, flex: 1 }}>Server Logs</Typography>
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
      </Stack>

      {/* Toolbar */}
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          sx={{ flex: 1, minWidth: 160, maxWidth: 340 }}
          slotProps={{ htmlInput: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
        />

        <ToggleButtonGroup
          size="small"
          exclusive
          value={level}
          onChange={(_e, v) => { if (v) setLevel(v); }}
        >
          <ToggleButton value="all" sx={{ fontSize: 11, px: 1 }}>All</ToggleButton>
          <ToggleButton value="wrn" sx={{ fontSize: 11, px: 1, color: '#fdd663' }}>Warn+</ToggleButton>
          <ToggleButton value="err" sx={{ fontSize: 11, px: 1, color: '#f28b82' }}>Errors</ToggleButton>
        </ToggleButtonGroup>

        <Tooltip title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}>
          <IconButton size="small" onClick={() => setPaused(p => !p)} color={paused ? 'warning' : 'default'}>
            {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
          </IconButton>
        </Tooltip>

        <Tooltip title="Download log">
          <IconButton size="small" onClick={handleDownload}>
            <DownloadIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title="Clear display">
          <IconButton size="small" onClick={handleClear}>
            <ClearAllIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Log output */}
      <Box sx={{
        flex: 1,
        overflow: 'auto',
        bgcolor: '#0a0a12',
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        p: 1.5,
        fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
        fontSize: 12,
        lineHeight: 1.6,
      }}>
        {displayed.length === 0 && (
          <Typography variant="caption" sx={{ color: 'text.disabled' }}>
            {lines.length === 0 ? 'Waiting for log lines…' : 'No lines match the filter.'}
          </Typography>
        )}
        {displayed.map((line, i) => {
          const lvl = lineLevel(line);
          return (
            <Box
              key={i}
              component="div"
              sx={{
                color: levelColor(lvl),
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                py: '1px',
              }}
            >
              {line}
            </Box>
          );
        })}
        <div ref={bottomRef} />
      </Box>
    </Box>
  );
}
