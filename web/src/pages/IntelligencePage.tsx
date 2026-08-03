/**
 * IntelligencePage — AI brain status + test-voice input.
 *
 * Shows provider health, shadow mode status, intent router / tool registry
 * output for a typed transcript (POST /api/admin/shadow-mode/run-single), and
 * audio-focus state.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box, Stack, Typography, Paper, Chip, Button, TextField, Divider, Alert,
  CircularProgress, Accordion, AccordionSummary, AccordionDetails, Select, MenuItem, FormControl,
  IconButton, Tooltip,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SendIcon from '@mui/icons-material/Send';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import DnsIcon from '@mui/icons-material/Dns';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { coreApi, ApiError, type ProviderHealth, type ShadowModeStatus, type ShadowResult, type AudioFocusState, type ChatMessage, type AiProvidersResponse, type McpServerInfo, type PendingToolConfirmation } from '../api/client';
import { PageHeader, PageBody, LoadingBox, ErrorBanner } from '../components/ui';

export default function IntelligencePage() {
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [shadow, setShadow] = useState<ShadowModeStatus | null>(null);
  const [audioFocus, setAudioFocus] = useState<AudioFocusState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [voiceBridge, setVoiceBridge] = useState<{ configured: boolean; source: string; token: string | null; coreUrl: string } | null>(null);

  const [transcript, setTranscript] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ShadowResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [p, s, af, vb] = await Promise.all([
        coreApi.providers().then(r => r.providers).catch(() => [] as ProviderHealth[]),
        coreApi.shadowStatus().catch((e) => {
          if (e instanceof ApiError && e.status === 401) { setAuthRequired(true); return null; }
          return null;
        }),
        coreApi.audioFocus().catch((e) => {
          if (e instanceof ApiError && e.status === 401) return null;
          return null;
        }),
        coreApi.voiceBridge().catch(() => null),
      ]);
      setProviders(p);
      setShadow(s);
      setAudioFocus(af);
      setVoiceBridge(vb);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runSingle() {
    if (!transcript.trim()) return;
    setRunning(true); setResultError(null); setResult(null);
    try {
      const r = await coreApi.shadowRunSingle(transcript);
      setResult(r);
    } catch (e) {
      setResultError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader title="AI Brain" subtitle="Intelligence pipeline · providers · shadow mode" onRefresh={load} loading={loading} />
      <PageBody>
        <Stack spacing={3} sx={{ maxWidth: 1000, mx: 'auto' }}>
          {authRequired && (
            <Alert severity="warning" sx={{ bgcolor: 'rgba(253,214,99,0.1)' }}>
              Admin login required to view AI brain status and run transcripts.
            </Alert>
          )}
          {error && <ErrorBanner error={error} onRetry={load} />}
          {loading ? <LoadingBox /> : (
            <>
              {/* Providers */}
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Providers</Typography>
                <Divider sx={{ mb: 1 }} />
                {providers.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No providers configured.</Typography>
                ) : (
                  <Stack spacing={1}>
                    {providers.map(p => (
                      <Stack key={p.name} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                        {p.healthy ? <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} /> : <ErrorIcon sx={{ color: 'error.main', fontSize: 18 }} />}
                        <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 60 }}>{p.name}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{p.kind}{p.detail ? ` · ${p.detail}` : ''}{p.lastError ? ` · ${p.lastError}` : ''}</Typography>
                        {p.latencyMs !== undefined && <Chip size="small" label={`${p.latencyMs}ms`} variant="outlined" sx={{ fontSize: 10 }} />}
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Paper>

              {/* Shadow mode + audio focus */}
              <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 2 }}>
                <Paper sx={{ p: 2.5, flex: 1, minWidth: 240 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Shadow mode</Typography>
                  <Divider sx={{ mb: 1 }} />
                  {shadow ? (
                    <Stack spacing={0.5}>
                      <Row label="Active" value={<Chip size="small" label={shadow.active ? 'yes' : 'no'} color={shadow.active ? 'success' : 'default'} variant="outlined" sx={{ fontSize: 10 }} />} />
                      <Row label="Hermes" value={<Chip size="small" label={shadow.hermes_configured ? 'configured' : 'off'} variant="outlined" sx={{ fontSize: 10 }} />} />
                      <Row label="Corpus" value={<Typography variant="caption">{shadow.corpus_size ?? '—'}</Typography>} />
                      <Row label="Last run" value={<Typography variant="caption">{shadow.last_run ? 'yes' : 'never'}</Typography>} />
                    </Stack>
                  ) : <Typography variant="body2" color="text.secondary">Sign in to view.</Typography>}
                </Paper>
                <Paper sx={{ p: 2.5, flex: 1, minWidth: 240 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Audio focus</Typography>
                  <Divider sx={{ mb: 1 }} />
                  {audioFocus ? (
                    <Stack spacing={0.5}>
                      <Row label="State" value={<Chip size="small" label={audioFocus.state} variant="outlined" sx={{ fontSize: 10 }} />} />
                      <Row label="Duck level" value={<Typography variant="caption">{audioFocus.duckLevel ?? '—'}</Typography>} />
                    </Stack>
                  ) : <Typography variant="body2" color="text.secondary">Sign in to view.</Typography>}
                </Paper>
              </Stack>

              {/* Voice Bridge */}
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Voice bridge</Typography>
                <Divider sx={{ mb: 1.5 }} />
                {voiceBridge ? (
                  <Stack spacing={1}>
                    <Row label="Status" value={
                      <Chip size="small" label={voiceBridge.configured ? 'connected' : 'not configured'} color={voiceBridge.configured ? 'success' : 'warning'} variant="outlined" sx={{ fontSize: 10 }} />
                    } />
                    <Row label="Source" value={<Typography variant="caption">{voiceBridge.source}</Typography>} />
                    {voiceBridge.token && (
                      <Row label="Token" value={
                        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={0.5}>
                          <Typography variant="caption" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                            {voiceBridge.token}
                          </Typography>
                          <Tooltip title="Copy token">
                            <IconButton size="small" onClick={() => navigator.clipboard.writeText(voiceBridge.token!)}>
                              <ContentCopyIcon sx={{ fontSize: 14 }} />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      } />
                    )}
                    {!voiceBridge.configured && (
                      <Alert severity="info" sx={{ mt: 1, bgcolor: 'rgba(100,181,246,0.1)', fontSize: 12 }}>
                        The core will auto-learn the token when a display device first connects. Trigger the wake word to pair automatically.
                      </Alert>
                    )}
                  </Stack>
                ) : <Typography variant="body2" color="text.secondary">Sign in to view.</Typography>}
              </Paper>

              {/* Test voice */}
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Test voice intent</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Type a transcript to route through the intent router + tool registry (shadow-mode single run).
                </Typography>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                  <TextField
                    value={transcript}
                    onChange={e => setTranscript(e.target.value)}
                    placeholder="e.g. turn off the kitchen light"
                    size="small"
                    fullWidth
                    onKeyDown={e => { if (e.key === 'Enter') runSingle(); }}
                  />
                  <Button
                    size="small" variant="contained" startIcon={running ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon fontSize="small" />}
                    onClick={runSingle} disabled={running || !transcript.trim()}
                    sx={{ textTransform: 'none' }}
                  >
                    Run
                  </Button>
                </Stack>
                {resultError && <Alert severity="error" sx={{ mt: 2, bgcolor: 'rgba(242,139,130,0.1)' }}>{resultError}</Alert>}
                {result && <ShadowResultView r={result} />}
              </Paper>

              {/* AI Chat */}
              <AiChatSection />

              {/* MCP Servers */}
              <McpServersSection />
            </>
          )}
        </Stack>
      </PageBody>
    </Box>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 80 }}>{label}</Typography>
      {value}
    </Stack>
  );
}

function ShadowResultView({ r }: { r: ShadowResult }) {
  return (
    <Box sx={{ mt: 2 }}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
        <Chip size="small" label={`intent: ${r.canvas_result.intent}`} color="primary" variant="outlined" sx={{ fontSize: 10 }} />
        <Chip size="small" label={`confidence: ${(r.canvas_result.confidence * 100).toFixed(0)}%`} variant="outlined" sx={{ fontSize: 10 }} />
        <Chip size="small" label={`canvas ${r.canvas_latency_ms}ms`} variant="outlined" sx={{ fontSize: 10 }} />
        {r.hermes_latency_ms !== null && <Chip size="small" label={`hermes ${r.hermes_latency_ms}ms`} variant="outlined" sx={{ fontSize: 10 }} />}
        <Chip size="small" label={r.matches ? 'matches' : 'differs'} color={r.matches ? 'success' : 'warning'} variant="outlined" sx={{ fontSize: 10 }} />
        <Chip size="small" label={r.safety_pass ? 'safe' : 'unsafe'} color={r.safety_pass ? 'success' : 'error'} variant="outlined" sx={{ fontSize: 10 }} />
        {r.clarification_needed && <Chip size="small" label="clarification" color="warning" variant="outlined" sx={{ fontSize: 10 }} />}
      </Stack>
      {r.error && <Alert severity="error" sx={{ mb: 1, bgcolor: 'rgba(242,139,130,0.1)' }}>{r.error}</Alert>}
      <Typography variant="body2" sx={{ mb: 1 }}>{r.canvas_result.response}</Typography>
      {r.canvas_result.tool_calls.length > 0 && (
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="caption" color="text.secondary">Tool calls ({r.canvas_result.tool_calls.length})</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box sx={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre' }}>
              {JSON.stringify(r.canvas_result.tool_calls, null, 2)}
            </Box>
          </AccordionDetails>
        </Accordion>
      )}
      {r.hermes_result && (
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="caption" color="text.secondary">Hermes result</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box sx={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre' }}>
              {JSON.stringify(r.hermes_result, null, 2)}
            </Box>
          </AccordionDetails>
        </Accordion>
      )}
    </Box>
  );
}

function AiChatSection() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AiProvidersResponse | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingToolConfirmation | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch available LLM providers on mount.
  useEffect(() => {
    coreApi.aiProviders().then((r) => {
      setProviders(r);
      // Pre-select the first LLM provider if there is one.
      const llm = r.providers.find((p) => p.type === 'llm');
      if (llm) setSelectedProvider(llm.id);
    }).catch(() => {
      // Not critical — chat will use the default.
    });
  }, []);

  // Auto-scroll when new messages are added.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = { role: 'user', content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput('');
    setSending(true);
    setError(null);

    try {
      const res = await coreApi.chatSend(updated, selectedProvider || undefined);
      const assistantMsg: ChatMessage = { role: 'assistant', content: res.reply };
      setMessages((prev) => [...prev, assistantMsg]);
      setPendingConfirmation(res.pendingConfirmation ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  function clearChat() {
    setMessages([]);
    setError(null);
    setPendingConfirmation(null);
  }

  async function confirmTool() {
    if (!pendingConfirmation || sending) return;
    setSending(true); setError(null);
    try {
      const res = await coreApi.confirmChatTool(pendingConfirmation.token);
      setMessages(prev => [...prev, { role: 'assistant', content: res.reply }]);
      setPendingConfirmation(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const llmProviders = providers?.providers.filter((p) => p.type === 'llm') ?? [];

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>AI Chat</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {llmProviders.length > 1 && (
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                sx={{ fontSize: 12, '& .MuiSelect-select': { py: 0.5 } }}
              >
                {llmProviders.map((p) => (
                  <MenuItem key={p.id} value={p.id} sx={{ fontSize: 12 }}>
                    {p.id}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<DeleteSweepIcon fontSize="small" />}
            onClick={clearChat}
            disabled={messages.length === 0}
            sx={{ textTransform: 'none', fontSize: 12 }}
          >
            Clear
          </Button>
        </Stack>
      </Stack>
      <Divider sx={{ mb: 1 }} />

      {/* Message history */}
      <Box
        sx={{
          maxHeight: 320,
          overflowY: 'auto',
          mb: 1.5,
          p: 1,
          bgcolor: 'rgba(0,0,0,0.15)',
          borderRadius: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {messages.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
            Send a message to start a conversation with the AI.
          </Typography>
        )}
        {messages.map((msg, i) => (
          <Box
            key={i}
            sx={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
            }}
          >
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-end' }}>
              {msg.role === 'assistant' && (
                <SmartToyIcon sx={{ fontSize: 16, color: 'primary.main', mb: 0.5 }} />
              )}
              <Paper
                elevation={0}
                sx={{
                  px: 1.5,
                  py: 0.8,
                  borderRadius: 2,
                  bgcolor: msg.role === 'user' ? 'primary.dark' : 'grey.800',
                  color: msg.role === 'user' ? 'primary.contrastText' : 'grey.100',
                }}
              >
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {msg.content}
                </Typography>
              </Paper>
              {msg.role === 'user' && (
                <PersonIcon sx={{ fontSize: 16, color: 'primary.light', mb: 0.5 }} />
              )}
            </Stack>
          </Box>
        ))}
        {sending && (
          <Box sx={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <SmartToyIcon sx={{ fontSize: 16, color: 'primary.main' }} />
            <CircularProgress size={14} sx={{ color: 'grey.500' }} />
          </Box>
        )}
        <div ref={messagesEndRef} />
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 1, bgcolor: 'rgba(242,139,130,0.1)' }}>
          {error}
        </Alert>
      )}

      {pendingConfirmation && (
        <Alert severity="warning" sx={{ mb: 1 }} action={
          <Stack direction="row" spacing={0.5}>
            <Button size="small" color="inherit" onClick={() => setPendingConfirmation(null)}>Cancel</Button>
            <Button size="small" variant="contained" color="warning" disabled={sending} onClick={() => void confirmTool()}>Confirm</Button>
          </Stack>
        }>
          <Typography variant="body2">Allow <strong>{pendingConfirmation.tool}</strong>?</Typography>
          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{JSON.stringify(pendingConfirmation.params)}</Typography>
        </Alert>
      )}

      {/* Input area */}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          size="small"
          fullWidth
          multiline
          maxRows={4}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <Button
          size="small"
          variant="contained"
          startIcon={sending ? <CircularProgress size={14} color="inherit" /> : <SendIcon fontSize="small" />}
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          sx={{ textTransform: 'none', minWidth: 80 }}
        >
          Send
        </Button>
      </Stack>
    </Paper>
  );
}

function McpServersSection() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'http' | 'stdio'>('http');
  const [formUrl, setFormUrl] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formArgs, setFormArgs] = useState('');
  const [saving, setSaving] = useState(false);

  const loadServers = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await coreApi.mcpServers();
      setServers(res.servers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadServers(); }, [loadServers]);

  async function handleSave() {
    const name = formName.trim();
    if (!name && !editName) return;
    setSaving(true);
    try {
      const payload = formType === 'stdio'
        ? { type: 'stdio' as const, command: formCommand.trim(), args: formArgs.trim() ? formArgs.trim().split(/\s+/) : [] }
        : { type: 'http' as const, url: formUrl.trim() };
      if (editName) {
        await coreApi.updateMcpServer(editName, payload);
      } else {
        await coreApi.addMcpServer({ name, ...payload });
      }
      setShowForm(false);
      setEditName(null);
      setFormName(''); setFormUrl(''); setFormCommand(''); setFormArgs('');
      await loadServers();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function startEdit(s: McpServerInfo) {
    setEditName(s.name);
    setFormName(s.name);
    setFormType(s.type ?? 'http');
    setFormUrl(s.url ?? '');
    setFormCommand(s.command ?? '');
    setFormArgs((s.args ?? []).join(' '));
    setShowForm(true);
  }

  function startAdd() {
    setEditName(null);
    setFormName(''); setFormType('http'); setFormUrl(''); setFormCommand(''); setFormArgs('');
    setShowForm(true);
  }

  async function handleDelete(name: string) {
    if (!window.confirm(`Delete MCP server "${name}"?`)) return;
    try {
      await coreApi.deleteMcpServer(name);
      await loadServers();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const formValid = editName
    ? (formType === 'stdio' ? !!formCommand.trim() : !!formUrl.trim())
    : (!!formName.trim() && (formType === 'stdio' ? !!formCommand.trim() : !!formUrl.trim()));

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>MCP Servers</Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon fontSize="small" />}
          onClick={startAdd}
          sx={{ textTransform: 'none', fontSize: 12 }}
        >
          Add Server
        </Button>
      </Stack>
      <Divider sx={{ mb: 1 }} />

      {error && <Alert severity="error" sx={{ mb: 1, bgcolor: 'rgba(242,139,130,0.1)' }}>{error}</Alert>}

      {showForm && (
        <Paper elevation={0} sx={{ p: 1.5, mb: 1.5, bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 1 }}>
          <Stack spacing={1.5}>
            {!editName && (
              <TextField size="small" label="Name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. bowling" fullWidth />
            )}
            <FormControl size="small" fullWidth>
              <Select value={formType} onChange={(e) => setFormType(e.target.value as 'http' | 'stdio')}>
                <MenuItem value="http">HTTP</MenuItem>
                <MenuItem value="stdio">stdio (child process)</MenuItem>
              </Select>
            </FormControl>
            {formType === 'http' ? (
              <TextField size="small" label="URL" value={formUrl} onChange={(e) => setFormUrl(e.target.value)} placeholder="http://host.docker.internal:5020" fullWidth />
            ) : (
              <>
                <TextField size="small" label="Command" value={formCommand} onChange={(e) => setFormCommand(e.target.value)} placeholder="python3" fullWidth />
                <TextField size="small" label="Args (space-separated)" value={formArgs} onChange={(e) => setFormArgs(e.target.value)} placeholder="/app/bowling_mcp.py" fullWidth />
              </>
            )}
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="contained" onClick={handleSave} disabled={saving || !formValid} sx={{ textTransform: 'none' }}>
                {saving ? <CircularProgress size={14} color="inherit" /> : editName ? 'Update' : 'Add'}
              </Button>
              <Button size="small" variant="text" onClick={() => { setShowForm(false); setEditName(null); }} sx={{ textTransform: 'none' }}>Cancel</Button>
            </Stack>
          </Stack>
        </Paper>
      )}

      {loading ? (
        <LoadingBox />
      ) : servers.length === 0 ? (
        <Typography variant="body2" color="text.secondary">No MCP servers configured.</Typography>
      ) : (
        <Stack spacing={1}>
          {servers.map((s) => (
            <Accordion key={s.name} elevation={0} sx={{ bgcolor: 'rgba(255,255,255,0.02)', border: '1px solid', borderColor: 'divider', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" sx={{ alignItems: 'center', gap: 1, width: '100%', pr: 2 }}>
                  <DnsIcon sx={{ fontSize: 18, color: s.healthy ? 'success.main' : 'error.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 100 }}>{s.name}</Typography>
                  <Chip size="small" label={s.healthy ? 'UP' : 'DOWN'} color={s.healthy ? 'success' : 'error'} variant="outlined" sx={{ fontSize: 10 }} />
                  <Chip size="small" label={s.type === 'stdio' ? 'stdio' : 'http'} variant="outlined" sx={{ fontSize: 10 }} />
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.type === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() : (s.url ?? '')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">{s.tools.length} tool{s.tools.length === 1 ? '' : 's'}</Typography>
                  <Button size="small" variant="text" onClick={(e) => { e.stopPropagation(); startEdit(s); }} sx={{ minWidth: 30, p: 0.5 }}>
                    <EditIcon fontSize="small" />
                  </Button>
                  <Button size="small" variant="text" color="error" onClick={(e) => { e.stopPropagation(); handleDelete(s.name); }} sx={{ minWidth: 30, p: 0.5 }}>
                    <DeleteIcon fontSize="small" />
                  </Button>
                </Stack>
              </AccordionSummary>
              {s.tools.length > 0 && (
                <AccordionDetails sx={{ pt: 0 }}>
                  <Stack spacing={0.5}>
                    {s.tools.map((tool) => (
                      <Typography key={tool} variant="caption" sx={{ fontFamily: 'monospace', fontSize: 11, color: 'text.secondary', pl: 2 }}>
                        {tool}
                      </Typography>
                    ))}
                  </Stack>
                </AccordionDetails>
              )}
            </Accordion>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
