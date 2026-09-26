/**
 * AiLogPage — structured AI round-trip trace viewer.
 *
 * Loads Core's bounded in-memory AI trace (`/api/admin/ai-log`) and follows its
 * authenticated SSE stream. Each utterance is grouped by `turnId`; within a turn
 * you see the provider attempts, LLM round trips (request messages + tools +
 * response), and tool executions with their full payloads. This is the debugging
 * surface for the tool/web-search loop and provider failover.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Box, Typography, IconButton, Tooltip, Chip, Stack, TextField, Alert,
  Paper, Collapse,
} from '@mui/material';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { getApiBase, api } from '../api/client';
import { PageHeader } from '../components/ui';

const MAX_ENTRIES = 500;

type AiLogKind = 'provider_attempt' | 'round_trip' | 'tool_execution';

interface AiLogEntry {
  id: string;
  ts: string;
  kind: AiLogKind;
  turnId?: string;
  operation?: string;
  deviceId?: string;
  iteration?: number;
  providerId?: string;
  providerKind?: string;
  model?: string;
  latencyMs?: number;
  ok?: boolean;
  error?: string;
  degradedFallback?: boolean;
  messages?: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  responseContent?: string;
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  callId?: string;
  requestedName?: string;
  name?: string;
  args?: Record<string, unknown>;
  message?: string;
  result?: unknown;
  requiresConfirmation?: boolean;
}

interface AiLogResponse {
  count: number;
  total: number;
  entries: AiLogEntry[];
}

const KIND_META: Record<AiLogKind, { label: string; color: 'info' | 'primary' | 'secondary' }> = {
  provider_attempt: { label: 'provider', color: 'info' },
  round_trip: { label: 'round trip', color: 'primary' },
  tool_execution: { label: 'tool', color: 'secondary' },
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : iso;
}

/** Extract the user's transcript (last user message) from a round-trip trace. */
function transcriptOf(entry: AiLogEntry): string {
  const messages = entry.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function summarize(entry: AiLogEntry): string {
  const op = entry.operation ?? '';
  switch (entry.kind) {
    case 'provider_attempt':
      if (entry.degradedFallback) return `${op}: degraded fallback`;
      return `${op}: ${entry.providerId ?? '?'} (${entry.providerKind ?? '?'})${entry.model ? ` · ${entry.model}` : ''}${entry.latencyMs != null ? ` · ${entry.latencyMs}ms` : ''} · ${entry.ok ? 'ok' : 'FAILED'}${entry.error ? ` · ${entry.error}` : ''}`;
    case 'round_trip':
      return `${op}${entry.iteration != null ? ` · iter ${entry.iteration}` : ''}${entry.latencyMs != null ? ` · ${entry.latencyMs}ms` : ''} · ${entry.tools?.length ?? 0} tools offered · ${entry.toolCalls?.length ?? 0} tool calls`;
    case 'tool_execution':
      return `${op}${entry.iteration != null ? ` · iter ${entry.iteration}` : ''} · ${entry.name ?? entry.requestedName ?? '?'}${entry.requiresConfirmation ? ' · awaiting confirmation' : entry.ok ? ' · ok' : ' · FAILED'}${entry.message ? ` · ${entry.message}` : ''}`;
  }
}

function jsonOf(entry: AiLogEntry): string {
  return JSON.stringify(entry, null, 2);
}

export default function AiLogPage() {
  const [entries, setEntries] = useState<AiLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [kindFilter, setKindFilter] = useState<AiLogKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | undefined;

    async function connect() {
      if (closed) return;
      try {
        const historyResponse = await fetch(`${getApiBase()}/api/admin/ai-log`, {
          credentials: 'include',
        });
        if (!historyResponse.ok) throw new Error(`AI log history returned HTTP ${historyResponse.status}`);
        const history = await historyResponse.json() as AiLogResponse;
        if (!pausedRef.current) {
          // Backend returns newest-first; restore chronological for a top-down trace.
          setEntries((history.entries ?? []).slice(-MAX_ENTRIES).reverse());
        }
      } catch {
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 3000);
        return;
      }

      const stream = new EventSource(`${getApiBase()}/api/admin/ai-log/stream`, { withCredentials: true });
      eventSourceRef.current = stream;
      stream.onopen = () => setConnected(true);
      stream.onerror = () => {
        setConnected(false);
        stream.close();
        if (!closed) reconnectTimer = window.setTimeout(connect, 3000);
      };
      stream.onmessage = event => {
        if (pausedRef.current) return;
        try {
          const entry = JSON.parse(event.data) as AiLogEntry;
          setEntries(prev => {
            const next = [...prev, entry];
            return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
          });
        } catch { /* ignore malformed */ }
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
  }, [entries, paused]);

  const handleClear = useCallback(async () => {
    try {
      await api.delete('/api/admin/ai-log');
      setEntries([]);
    } catch { /* ignore */ }
  }, []);

  const toggleOpen = useCallback((id: string) => {
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const lower = query.toLowerCase();
  const filtered = entries.filter(entry => {
    if (kindFilter !== 'all' && entry.kind !== kindFilter) return false;
    if (lower && !jsonOf(entry).toLowerCase().includes(lower)) return false;
    return true;
  });

  // Group chronologically by turnId (in order of first appearance).
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; turnId?: string; transcript: string; entries: AiLogEntry[] }>();
    let soloIndex = 0;
    for (const entry of filtered) {
      if (entry.turnId) {
        let g = map.get(entry.turnId);
        if (!g) {
          g = { id: entry.turnId, turnId: entry.turnId, transcript: transcriptOf(entry), entries: [] };
          map.set(entry.turnId, g);
        }
        if (!g.transcript && entry.kind === 'round_trip') g.transcript = transcriptOf(entry);
        g.entries.push(entry);
      } else {
        const id = `solo-${soloIndex++}`;
        map.set(id, { id, transcript: '', entries: [entry] });
      }
    }
    return Array.from(map.values());
  }, [filtered]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader title="AI Log" subtitle="Structured LLM round-trip and tool-call trace from Canvas Core" />
      <Box sx={{ flex: 1, p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, overflow: 'hidden' }}>
        {!connected && (
          <Alert severity="info" sx={{ bgcolor: 'rgba(108,99,255,0.1)' }}>
            Connecting to the Core AI log stream…
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
            {filtered.length} records
          </Typography>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
            {(['all', 'round_trip', 'tool_execution', 'provider_attempt'] as const).map(kind => (
              <Chip
                key={kind}
                size="small"
                label={kind === 'all' ? 'all' : KIND_META[kind].label}
                color={kindFilter === kind ? KIND_META[kind === 'all' ? 'round_trip' : kind].color : 'default'}
                variant={kindFilter === kind ? 'filled' : 'outlined'}
                onClick={() => setKindFilter(kind)}
                sx={{ fontSize: 11 }}
              />
            ))}
          </Stack>
          <Box sx={{ flex: 1 }} />
          <TextField
            size="small"
            placeholder="Filter (provider, model, tool, args…)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            sx={{ minWidth: 200, maxWidth: 300 }}
            slotProps={{ htmlInput: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
          <Tooltip title={paused ? 'Resume' : 'Pause'}>
            <IconButton size="small" onClick={() => setPaused(p => !p)} color={paused ? 'warning' : 'default'}>
              {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Clear (server-side)">
            <IconButton size="small" onClick={handleClear}><ClearAllIcon fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>

        <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {groups.length === 0 && (
            <Typography variant="caption" sx={{ color: 'text.disabled', p: 1 }}>
              {entries.length === 0 ? 'Waiting for AI round trips…' : 'No records match the filter.'}
            </Typography>
          )}
          {groups.map(group => (
            <Paper key={group.id} variant="outlined" sx={{ p: 1 }}>
              {group.turnId ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
                    turn {group.turnId.slice(0, 8)}
                  </Typography>
                  {group.transcript && (
                    <Typography variant="caption" sx={{ color: 'text.primary', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      “{group.transcript}”
                    </Typography>
                  )}
                </Box>
              ) : null}
              {group.entries.map(entry => {
                const meta = KIND_META[entry.kind];
                const open = openIds.has(entry.id);
                return (
                  <Box key={entry.id} sx={{ py: 0.25 }}>
                    <Stack
                      direction="row"
                      sx={{ alignItems: 'center', gap: 1, cursor: 'pointer' }}
                      onClick={() => toggleOpen(entry.id)}
                    >
                      <IconButton size="small">{open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}</IconButton>
                      <Chip size="small" label={meta.label} color={meta.color} variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                      <Typography variant="caption" sx={{ color: '#6b6375', fontFamily: 'monospace' }}>
                        {fmtTime(entry.ts)}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          fontFamily: 'monospace', fontSize: 12, flex: 1,
                          color: !entry.ok && entry.ok !== undefined ? 'error.main' : 'text.primary',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        {summarize(entry)}
                      </Typography>
                    </Stack>
                    <Collapse in={open} unmountOnExit>
                      <Box sx={{
                        ml: 4, my: 0.5, p: 1, bgcolor: '#0a0a12', borderRadius: 1,
                        border: '1px solid', borderColor: 'divider',
                      }}>
                        <pre style={{
                          margin: 0, fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
                          fontSize: 11, lineHeight: 1.5, color: '#c3c9d4', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        }}>
                          {jsonOf(entry)}
                        </pre>
                      </Box>
                    </Collapse>
                  </Box>
                );
              })}
            </Paper>
          ))}
          <div ref={bottomRef} />
        </Box>
      </Box>
    </Box>
  );
}