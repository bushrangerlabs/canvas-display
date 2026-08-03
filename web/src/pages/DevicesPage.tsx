/**
 * DevicesPage — Edge device registry.
 *
 * Lists connected devices with id, name, architecture, status, authority mode,
 * last seen, paired status. Supports revoking, creating invitations, and
 * viewing device details. Also shows the authority cutover summary.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  Box, Stack, Typography, Paper, Button, Chip, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, IconButton, Tooltip, Divider, Alert,
  Tabs, Tab, Slider, FormControlLabel, Switch, Select, MenuItem, InputLabel, FormControl, CircularProgress,
} from '@mui/material';
import AddIcon from '@mui/icons-material/PersonAdd';
import RevokeIcon from '@mui/icons-material/Block';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import MicIcon from '@mui/icons-material/Mic';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import SettingsVoiceIcon from '@mui/icons-material/SettingsVoice';
import RefreshIcon from '@mui/icons-material/Refresh';
import { coreApi, ApiError, type DeviceRow, type InvitationRecord, type AuthorityStatusSummary, type AuthorityMode } from '../api/client';
import { PageHeader, PageBody, LoadingBox, ErrorBanner, BoolChip, fmtRelative } from '../components/ui';

const AUTHORITY_MODES: AuthorityMode[] = ['legacy', 'shadow', 'core', 'rollback_pending'];
const VOICE_CUE_PRESETS = [
  { value: 'builtin:soft_chime', label: 'Soft chime' },
  { value: 'builtin:glass_ping', label: 'Glass ping' },
  { value: 'builtin:ready_up', label: 'Ready up' },
  { value: 'builtin:wood_tap', label: 'Wood tap' },
  { value: 'builtin:digital_pop', label: 'Digital pop' },
  { value: 'builtin:confirm_tone', label: 'Confirm tone' },
];

type AcceptanceStatus = 'pending' | 'running' | 'observe' | 'passed' | 'failed';
type AcceptanceResult = {
  status: AcceptanceStatus;
  note?: string;
  startedAt?: string;
  finishedAt?: string;
  apiResult?: Record<string, unknown>;
};

const HARDWARE_ACCEPTANCE_CASES = [
  { id: 'inventory', label: 'Edge audio inventory', instruction: 'Silent check: fetch the selected Pi\'s microphones, speakers, and wake-word models. Nothing will play on the Pi.' },
  { id: 'speaker', label: 'Pi speaker', instruction: 'Listen for the speaker test tone on the Pi, not this administrator browser.' },
  { id: 'microphone', label: 'Pi microphone loopback', instruction: 'Speak near the Pi. The captured sample must play back through the Pi speaker.' },
  { id: 'wakeword', label: 'Pi wake-word detector', instruction: 'After starting, say the configured wake word near the Pi within 15 seconds.' },
  { id: 'wake_cue', label: 'Wake cue', instruction: 'Confirm the configured wake cue plays once on the Pi.' },
  { id: 'good_cue', label: 'Good-intent cue', instruction: 'Confirm the configured good-intent cue plays once on the Pi.' },
  { id: 'bad_cue', label: 'No-intent cue', instruction: 'Confirm the configured no-intent cue plays once on the Pi.' },
  { id: 'full_voice', label: 'Full voice and TTS loop', instruction: 'At the Pi, say the wake word then ask “What time is it?”. Confirm one wake cue, one good-intent cue, and the complete TTS response play on that Pi without overlap or early relistening.' },
  { id: 'silent_voice', label: 'Silent/no-intent loop', instruction: 'At the Pi, say the wake word and remain silent. Confirm the no-intent cue plays once and no AI response is spoken.' },
] as const;

const acceptanceStorageKey = (deviceId: string) => `canvas.piAcceptance.v1.${deviceId}`;

export default function DevicesPage() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRecord[]>([]);
  const [authority, setAuthority] = useState<AuthorityStatusSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeviceRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, a] = await Promise.all([
        coreApi.devices().then(r => ({ devices: r.devices, invitations: r.invitations })).catch((e) => {
          if (e instanceof ApiError && e.status === 401) { setAuthRequired(true); return { devices: [], invitations: [] }; }
          throw e;
        }),
        coreApi.authorityStatus().catch((e) => {
          if (e instanceof ApiError && e.status === 401) { setAuthRequired(true); return null; }
          return null;
        }),
      ]);
      setDevices(d.devices);
      setInvitations(d.invitations);
      setAuthority(a);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createInvitation(scope: string, ttlSeconds: number) {
    const res = await coreApi.createInvitation(scope || undefined, ttlSeconds || undefined);
    setNewToken(res.token);
    setInviteOpen(false);
    load();
  }

  async function revoke(device: DeviceRow) {
    if (!confirm(`Revoke device "${device.name}"? It will need to re-pair to reconnect.`)) return;
    try {
      await coreApi.revokeDevice(device.id);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Devices"
        subtitle="Edge devices registered with Core"
        onRefresh={load}
        loading={loading}
        actions={
          <Button
            size="small" variant="contained" startIcon={<AddIcon fontSize="small" />}
            onClick={() => setInviteOpen(true)}
            sx={{ textTransform: 'none', mr: 1 }}
          >
            New invitation
          </Button>
        }
      />
      <PageBody>
        <Stack spacing={3} sx={{ maxWidth: 1100, mx: 'auto' }}>
          {authRequired && (
            <Alert severity="warning" sx={{ bgcolor: 'rgba(253,214,99,0.1)' }}>
              Admin login required to view devices. Use the login button in the top bar.
            </Alert>
          )}
          {error && <ErrorBanner error={error} onRetry={load} />}
          {loading ? <LoadingBox /> : (
            <>
              {/* Authority summary */}
              {authority && (
                <Paper sx={{ p: 2.5 }}>
                  <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
                    <SwapHorizIcon sx={{ color: 'primary.main', mr: 1, fontSize: 20 }} />
                    <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>Authority Cutover</Typography>
                    <Typography variant="caption" color="text.secondary">{authority.total} devices</Typography>
                  </Stack>
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                    {AUTHORITY_MODES.map(m => (
                      <Chip
                        key={m}
                        size="small"
                        label={`${m}: ${authority[m]}`}
                        color={m === 'core' ? 'success' : m === 'legacy' ? 'default' : 'warning'}
                        variant="outlined"
                        sx={{ fontSize: 11 }}
                      />
                    ))}
                  </Stack>
                </Paper>
              )}

              {/* Devices table */}
              <Paper sx={{ p: 0, overflow: 'hidden' }}>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>Architecture</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell>Authority</TableCell>
                        <TableCell>Paired</TableCell>
                        <TableCell>Last seen</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {devices.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} sx={{ color: 'text.secondary', py: 3 }}>
                            No devices registered. Create an invitation and pair an Edge device.
                          </TableCell>
                        </TableRow>
                      )}
                      {devices.map(d => (
                        <TableRow
                          key={d.id}
                          hover
                          sx={{ cursor: 'pointer' }}
                          onClick={() => setSelected(d)}
                        >
                          <TableCell>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{d.name}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 10 }}>{d.id}</Typography>
                          </TableCell>
                          <TableCell><Chip size="small" label={d.architecture || '—'} variant="outlined" sx={{ fontSize: 10 }} /></TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={d.status || (d.revoked_at ? 'revoked' : 'unknown')}
                              color={d.status === 'online' ? 'success' : d.revoked_at ? 'error' : 'default'}
                              variant="outlined"
                              sx={{ fontSize: 10 }}
                            />
                          </TableCell>
                          <TableCell><Chip size="small" label={d.authority_mode} variant="outlined" sx={{ fontSize: 10 }} /></TableCell>
                          <TableCell><BoolChip value={d.paired} /></TableCell>
                          <TableCell><Typography variant="caption">{fmtRelative(d.last_seen)}</Typography></TableCell>
                          <TableCell align="right" onClick={e => e.stopPropagation()}>
                            <Tooltip title="Revoke">
                              <IconButton size="small" onClick={() => revoke(d)} disabled={!!d.revoked_at}>
                                <RevokeIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>

              {/* Invitations */}
              {invitations.length > 0 && (
                <Paper sx={{ p: 2.5 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Invitations</Typography>
                  <Divider sx={{ mb: 1 }} />
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Scope</TableCell>
                          <TableCell>Created by</TableCell>
                          <TableCell>Expires</TableCell>
                          <TableCell>Used</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {invitations.map(inv => (
                          <TableRow key={inv.id}>
                            <TableCell><Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{inv.scope || '—'}</Typography></TableCell>
                            <TableCell>{inv.created_by || '—'}</TableCell>
                            <TableCell>{fmtRelative(inv.expires_at)}</TableCell>
                            <TableCell>{inv.used_at ? `by ${inv.used_by_device_id?.slice(0, 8) ?? '—'}` : 'available'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Paper>
              )}
            </>
          )}
        </Stack>
      </PageBody>

      {/* New invitation dialog */}
      <InvitationDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreate={createInvitation}
      />

      {/* Token reveal dialog */}
      <Dialog open={!!newToken} onClose={() => setNewToken(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Invitation token (copy now)</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2, bgcolor: 'rgba(253,214,99,0.1)' }}>
            This token is shown only once. Store it securely.
          </Alert>
          <TextField
            value={newToken ?? ''}
            fullWidth
            multiline
            slotProps={{ htmlInput: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
        </DialogContent>
        <DialogActions>
          <Button
            size="small"
            startIcon={<ContentCopyIcon fontSize="small" />}
            onClick={() => navigator.clipboard?.writeText(newToken ?? '')}
          >
            Copy
          </Button>
          <Button size="small" onClick={() => setNewToken(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Device details dialog */}
      <DeviceDetailDialog
        device={selected}
        onClose={() => setSelected(null)}
        onRefresh={load}
      />
    </Box>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 130 }}>{label}</Typography>
      <Typography variant="body2" sx={{ flex: 1, fontFamily: mono ? 'monospace' : undefined, fontSize: mono ? 11 : undefined, wordBreak: 'break-all' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function InvitationDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (scope: string, ttl: number) => void }) {
  const [scope, setScope] = useState('');
  const [ttl, setTtl] = useState(3600);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try { await onCreate(scope, ttl); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New invitation</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Scope (optional)" value={scope} onChange={e => setScope(e.target.value)} size="small" helperText="e.g. a device group name" />
          <TextField
            label="TTL (seconds)"
            type="number"
            value={ttl}
            onChange={e => setTtl(Number(e.target.value) || 0)}
            size="small"
            slotProps={{ htmlInput: { min: 60, max: 86400 } }}
          />
          {err && <Alert severity="error" sx={{ bgcolor: 'rgba(242,139,130,0.1)' }}>{err}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Cancel</Button>
        <Button size="small" variant="contained" onClick={submit} disabled={busy}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}

function DeviceDetailDialog({ device, onClose, onRefresh }: { device: DeviceRow | null; onClose: () => void; onRefresh: () => void }) {
  const [tab, setTab] = useState(0);
  const [audioConfig, setAudioConfig] = useState<Record<string, any>>({});
  const [voiceConfig, setVoiceConfig] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, any> | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [uploadingCue, setUploadingCue] = useState<string | null>(null);
  const [acceptance, setAcceptance] = useState<Record<string, AcceptanceResult>>({});
  const [acceptanceLoadedDevice, setAcceptanceLoadedDevice] = useState<string | null>(null);
  const [voiceMetrics, setVoiceMetrics] = useState<{
    summary: { turns: number; capture_avg_ms: number | null; first_playback_p50_ms: number | null; first_playback_p95_ms: number | null; total_p50_ms: number | null; total_p95_ms: number | null };
    recent: Array<Record<string, any>>;
  } | null>(null);
  const [audioDevices, setAudioDevices] = useState<{
    microphones: {id:string,name:string}[];
    speakers: {id:string,name:string}[];
    wake_words: {id:string,name:string}[];
  }>({ microphones: [], speakers: [], wake_words: [] });

  const loadAudioDevices = useCallback(async () => {
    if (!device) return;
    try {
      setAudioDevices(await coreApi.getDeviceAudioDevices(device.id));
    } catch (e) {
      setAudioDevices({ microphones: [], speakers: [], wake_words: [] });
      setError((e as Error).message);
    }
  }, [device]);

  useEffect(() => {
    if (!device) return;
    setAcceptance({});
    setAcceptanceLoadedDevice(null);
    try {
      const stored = localStorage.getItem(acceptanceStorageKey(device.id));
      const parsed = stored ? JSON.parse(stored) as Record<string, AcceptanceResult> : {};
      const allowedIds = new Set(HARDWARE_ACCEPTANCE_CASES.map(test => test.id));
      const restored = Object.fromEntries(Object.entries(parsed).filter(([id, result]) =>
        allowedIds.has(id as typeof HARDWARE_ACCEPTANCE_CASES[number]['id'])
        && ['pending', 'observe', 'passed', 'failed'].includes(result?.status),
      ));
      setAcceptance(restored);
    } catch {
      localStorage.removeItem(acceptanceStorageKey(device.id));
    }
    setAcceptanceLoadedDevice(device.id);
    setLoading(true); setError(null);
    coreApi.getDeviceAudio(device.id)
      .then(r => {
        setAudioConfig(r.audio_config || {});
        setVoiceConfig({
          wake_ack_enabled: false,
          wake_ack_sound: 'builtin:ready_up',
          good_intent_enabled: true,
          good_intent_sound: 'builtin:digital_pop',
          no_intent_enabled: true,
          no_intent_sound: 'builtin:wood_tap',
          ...(r.voice_config || {}),
        });
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
    void loadAudioDevices();
    void coreApi.getDeviceVoiceMetrics(device.id).then(setVoiceMetrics).catch(() => setVoiceMetrics(null));
  }, [device, loadAudioDevices]);

  useEffect(() => {
    if (!device || acceptanceLoadedDevice !== device.id) return;
    const safe = Object.fromEntries(Object.entries(acceptance).map(([id, result]) => [id, {
      ...result,
      status: result.status === 'running' ? 'pending' : result.status,
    }]));
    localStorage.setItem(acceptanceStorageKey(device.id), JSON.stringify(safe));
  }, [acceptance, acceptanceLoadedDevice, device]);

  useEffect(() => {
    if (audioDevices.wake_words.length === 0) return;
    const current = String(voiceConfig.wake_word ?? 'hey_jarvis');
    if (audioDevices.wake_words.some(model => model.id === current)) return;
    const fallback = audioDevices.wake_words.find(model => model.id === 'hey_jarvis')
      ?? audioDevices.wake_words[0];
    setVoiceConfig(config => ({ ...config, wake_word: fallback.id }));
  }, [audioDevices.wake_words, voiceConfig.wake_word]);

  async function saveAudio() {
    if (!device) return;
    setSaving(true); setError(null);
    try {
      await coreApi.updateDeviceAudio(device.id, audioConfig);
      onRefresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function saveVoice() {
    if (!device) return;
    setSaving(true); setError(null);
    try {
      await coreApi.updateDeviceVoice(device.id, voiceConfig);
      onRefresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function runTest(kind: 'mic' | 'speaker' | 'wakeword') {
    if (!device) return;
    setTesting(kind); setTestResult(null); setError(null);
    try {
      const calls = {
        mic: () => coreApi.testDeviceMic(device.id, {
          device: String(audioConfig.mic_device ?? 'default'),
          duration_ms: 3000,
        }),
        speaker: () => coreApi.testDeviceSpeaker(device.id, {
          device: String(audioConfig.speaker_device ?? 'default'),
          volume: Number(audioConfig.speaker_volume ?? 90),
        }),
        wakeword: () => coreApi.testDeviceWakeword(device.id, {
          wake_word: String(voiceConfig.wake_word ?? 'hey_jarvis'),
          wake_threshold: Number(voiceConfig.wake_threshold ?? 0.5),
          mic_device: String(audioConfig.mic_device ?? 'default'),
          timeout_ms: 15000,
        }),
      };
      const result = await calls[kind]();
      setTestResult(result);
    } catch (e) { setError((e as Error).message); }
    finally { setTesting(null); }
  }

  async function uploadCue(field: string, file: File) {
    if (!device) return;
    setUploadingCue(field); setError(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Cue audio must be 2 MB or smaller.');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read audio file'));
        reader.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.split(',', 2)[1] ?? '';
      const result = await coreApi.uploadDeviceVoiceCue(device.id, {
        data_base64: dataBase64,
        content_type: file.type,
        filename: file.name,
      });
      setVoiceConfig(config => ({ ...config, [field]: result.sound }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingCue(null);
    }
  }

  async function testCue(sound: string) {
    if (!device || !sound) return;
    setTesting('cue'); setError(null);
    try {
      await coreApi.testDeviceVoiceCue(
        device.id,
        sound,
        Number(audioConfig.speaker_volume ?? 90),
      );
      setTestResult({ note: 'Voice cue played on the selected edge device.' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(null);
    }
  }

  function acceptanceSummary(result: any): Record<string, unknown> {
    return {
      ok: result?.ok,
      detected: result?.detected,
      format: result?.format,
      note: result?.note,
      microphones: Array.isArray(result?.microphones) ? result.microphones.length : undefined,
      speakers: Array.isArray(result?.speakers) ? result.speakers.length : undefined,
      wakeWords: Array.isArray(result?.wake_words) ? result.wake_words.length : undefined,
    };
  }

  async function runAcceptance(id: string) {
    if (!device) return;
    const startedAt = new Date().toISOString();
    setAcceptance(current => ({ ...current, [id]: { status: 'running', startedAt } }));
    try {
      let result: any;
      if (id === 'inventory') result = await coreApi.getDeviceAudioDevices(device.id);
      else if (id === 'speaker') result = await coreApi.testDeviceSpeaker(device.id, {
        device: String(audioConfig.speaker_device ?? 'default'),
        volume: Number(audioConfig.speaker_volume ?? 90),
      });
      else if (id === 'microphone') result = await coreApi.testDeviceMic(device.id, {
        device: String(audioConfig.mic_device ?? 'default'), duration_ms: 3000,
      });
      else if (id === 'wakeword') result = await coreApi.testDeviceWakeword(device.id, {
        wake_word: String(voiceConfig.wake_word ?? 'hey_jarvis'),
        wake_threshold: Number(voiceConfig.wake_threshold ?? 0.5),
        mic_device: String(audioConfig.mic_device ?? 'default'), timeout_ms: 15000,
      });
      else {
        const sound = id === 'wake_cue'
          ? voiceConfig.wake_ack_sound ?? 'builtin:ready_up'
          : id === 'good_cue'
            ? voiceConfig.good_intent_sound ?? 'builtin:digital_pop'
            : voiceConfig.no_intent_sound ?? 'builtin:wood_tap';
        result = await coreApi.testDeviceVoiceCue(device.id, String(sound), Number(audioConfig.speaker_volume ?? 90));
      }
      const inventoryComplete = id === 'inventory'
        && Array.isArray(result?.microphones) && result.microphones.length > 0
        && Array.isArray(result?.speakers) && result.speakers.length > 0
        && Array.isArray(result?.wake_words) && result.wake_words.length > 0;
      const inventoryNote = id === 'inventory'
        ? inventoryComplete
          ? `Pi reported ${result.microphones.length} microphone(s), ${result.speakers.length} speaker(s), and ${result.wake_words.length} wake-word model(s). This check is silent.`
          : 'The Pi did not report at least one microphone, speaker, and wake-word model.'
        : undefined;
      setAcceptance(current => ({ ...current, [id]: {
        status: id === 'inventory'
          ? inventoryComplete ? 'passed' : 'failed'
          : id === 'wakeword' && result?.detected === false ? 'failed' : 'observe',
        startedAt, finishedAt: new Date().toISOString(), apiResult: acceptanceSummary(result),
        note: inventoryNote ?? (id === 'wakeword' && result?.detected === false ? 'Wake word was not detected.' : undefined),
      } }));
    } catch (e) {
      setAcceptance(current => ({ ...current, [id]: {
        status: 'failed', startedAt, finishedAt: new Date().toISOString(), note: (e as Error).message,
      } }));
    }
  }

  function markAcceptance(id: string, status: 'passed' | 'failed') {
    setAcceptance(current => ({ ...current, [id]: {
      ...(current[id] ?? {}), status, finishedAt: new Date().toISOString(),
    } }));
  }

  function exportAcceptance() {
    if (!device) return;
    const report = {
      schema: 'canvas-pi-hardware-acceptance-v1',
      exportedAt: new Date().toISOString(),
      device: {
        id: device.id, name: device.name, architecture: device.architecture, status: device.status,
        protocolVersion: device.protocol_version, capabilities: device.capabilities, paired: device.paired,
      },
      configuration: {
        microphone: audioConfig.mic_device ?? 'default', speaker: audioConfig.speaker_device ?? 'default',
        wakeWord: voiceConfig.wake_word ?? 'hey_jarvis', wakeThreshold: voiceConfig.wake_threshold ?? 0.5,
        wakeEnabled: !!voiceConfig.wake_enabled,
        cues: {
          wake: { enabled: !!voiceConfig.wake_ack_enabled, sound: voiceConfig.wake_ack_sound ?? 'builtin:ready_up' },
          goodIntent: { enabled: !!voiceConfig.good_intent_enabled, sound: voiceConfig.good_intent_sound ?? 'builtin:digital_pop' },
          noIntent: { enabled: !!voiceConfig.no_intent_enabled, sound: voiceConfig.no_intent_sound ?? 'builtin:wood_tap' },
        },
      },
      results: HARDWARE_ACCEPTANCE_CASES.map(test => ({ ...test, ...(acceptance[test.id] ?? { status: 'pending' }) })),
      privacy: 'No audio samples, credentials, secrets, or uploaded cue contents are included.',
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `canvas-pi-acceptance-${device.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function resetAcceptance() {
    if (!device) return;
    localStorage.removeItem(acceptanceStorageKey(device.id));
    setAcceptance({});
  }

  if (!device) return null;

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{device.name}</DialogTitle>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 2 }}>
        <Tab label="Info" />
        <Tab label="Audio" icon={<MicIcon fontSize="small" />} iconPosition="start" />
        <Tab label="Voice" icon={<SettingsVoiceIcon fontSize="small" />} iconPosition="start" />
        <Tab label="Acceptance" />
      </Tabs>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
        {testResult && (
          <Alert severity="info" sx={{ mb: 2 }} onClose={() => setTestResult(null)}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{testResult.note || 'Test complete'}</Typography>
            {testResult.detected !== undefined && (
              <Chip size="small" label={testResult.detected ? 'Wake word detected' : 'No wake word detected'}
                color={testResult.detected ? 'success' : 'default'} variant="outlined" sx={{ mt: 0.5 }} />
            )}
            {testResult.format === 'wav' && (
              <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
                Recording was captured and played back on the selected edge device.
              </Typography>
            )}
          </Alert>
        )}
        {loading ? <LoadingBox /> : (
          <>
            {tab === 0 && (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <DetailRow label="ID" value={device.id} mono />
                <DetailRow label="Architecture" value={device.architecture || '—'} />
                <DetailRow label="Protocol" value={device.protocol_version || '—'} />
                <DetailRow label="Capabilities" value={device.capabilities || '—'} />
                <DetailRow label="Authority mode" value={device.authority_mode} />
                <DetailRow label="Status" value={device.status || (device.revoked_at ? 'revoked' : 'unknown')} />
                <DetailRow label="Paired" value={device.paired ? 'yes' : 'no'} />
                <DetailRow label="Last seen" value={fmtRelative(device.last_seen)} />
                <DetailRow label="Cert fingerprint" value={device.cert_fingerprint ?? '—'} mono />
              </Stack>
            )}

            {tab === 1 && (
              <Stack spacing={2} sx={{ mt: 1 }}>
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography variant="subtitle2">Audio Device Settings</Typography>
                  <Button size="small" startIcon={<RefreshIcon />} onClick={loadAudioDevices} disabled={!!testing}>
                    Refresh devices
                  </Button>
                </Stack>
                <FormControl fullWidth size="small">
                  <InputLabel>Microphone Device</InputLabel>
                  <Select label="Microphone Device" value={audioConfig.mic_device ?? 'default'}
                    onChange={e => setAudioConfig(c => ({ ...c, mic_device: e.target.value }))}>
                    {!audioDevices.microphones.some(d => d.id === (audioConfig.mic_device ?? 'default')) && (
                      <MenuItem value={audioConfig.mic_device ?? 'default'}>{audioConfig.mic_device ?? 'default'} (unavailable)</MenuItem>
                    )}
                    {audioDevices.microphones.map(d => (
                      <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl fullWidth size="small">
                  <InputLabel>Speaker Device</InputLabel>
                  <Select label="Speaker Device" value={audioConfig.speaker_device ?? 'default'}
                    onChange={e => setAudioConfig(c => ({ ...c, speaker_device: e.target.value }))}>
                    {!audioDevices.speakers.some(d => d.id === (audioConfig.speaker_device ?? 'default')) && (
                      <MenuItem value={audioConfig.speaker_device ?? 'default'}>{audioConfig.speaker_device ?? 'default'} (unavailable)</MenuItem>
                    )}
                    {audioDevices.speakers.map(d => (
                      <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Typography variant="body2">Microphone Volume: {audioConfig.mic_volume ?? 80}%</Typography>
                <Slider value={audioConfig.mic_volume ?? 80} min={0} max={100}
                  onChange={(_, v) => setAudioConfig(c => ({ ...c, mic_volume: v as number }))} />
                <Typography variant="body2">Speaker Volume: {audioConfig.speaker_volume ?? 90}%</Typography>
                <Slider value={audioConfig.speaker_volume ?? 90} min={0} max={100}
                  onChange={(_, v) => setAudioConfig(c => ({ ...c, speaker_volume: v as number }))} />
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" onClick={saveAudio} disabled={saving}>
                    {saving ? <CircularProgress size={14} /> : 'Save Audio'}
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<MicIcon />}
                    onClick={() => runTest('mic')} disabled={!!testing}>
                    {testing === 'mic' ? <CircularProgress size={14} /> : 'Test Mic'}
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<VolumeUpIcon />}
                    onClick={() => runTest('speaker')} disabled={!!testing}>
                    {testing === 'speaker' ? <CircularProgress size={14} /> : 'Test Speaker'}
                  </Button>
                </Stack>
              </Stack>
            )}

            {tab === 2 && (
              <Stack spacing={2} sx={{ mt: 1 }}>
                <Typography variant="subtitle2">Voice Latency (last 7 days)</Typography>
                {voiceMetrics && voiceMetrics.summary.turns > 0 ? (
                  <Paper variant="outlined" sx={{ p: 1.5 }}>
                    <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1 }}>
                      <Chip label={`${voiceMetrics.summary.turns} turns`} size="small" />
                      <Chip label={`Capture avg ${voiceMetrics.summary.capture_avg_ms ?? '—'} ms`} size="small" />
                      <Chip label={`First audio p50 ${voiceMetrics.summary.first_playback_p50_ms ?? '—'} ms`} size="small" />
                      <Chip label={`First audio p95 ${voiceMetrics.summary.first_playback_p95_ms ?? '—'} ms`} size="small" />
                      <Chip label={`Total p50 ${voiceMetrics.summary.total_p50_ms ?? '—'} ms`} size="small" />
                      <Chip label={`Total p95 ${voiceMetrics.summary.total_p95_ms ?? '—'} ms`} size="small" />
                    </Stack>
                    {voiceMetrics.recent[0] && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        Latest: {voiceMetrics.recent[0].intent || 'unknown'} · capture {voiceMetrics.recent[0].capture_ms ?? '—'} ms · Core {voiceMetrics.recent[0].core_round_trip_ms ?? '—'} ms · total {voiceMetrics.recent[0].total_ms ?? '—'} ms
                      </Typography>
                    )}
                  </Paper>
                ) : <Typography variant="caption" color="text.secondary">No completed voice timing records yet.</Typography>}
                <Divider />
                <Typography variant="subtitle2">Voice Settings</Typography>
                <FormControl fullWidth size="small">
                  <InputLabel>Wake Word</InputLabel>
                  <Select label="Wake Word" value={voiceConfig.wake_word ?? 'hey_jarvis'}
                    onChange={e => setVoiceConfig(c => ({ ...c, wake_word: e.target.value }))}>
                    {!audioDevices.wake_words.some(w => w.id === (voiceConfig.wake_word ?? 'hey_jarvis')) && (
                      <MenuItem value={voiceConfig.wake_word ?? 'hey_jarvis'}>
                        {String(voiceConfig.wake_word ?? 'hey_jarvis').replace(/_/g, ' ')} (unavailable)
                      </MenuItem>
                    )}
                    {audioDevices.wake_words.map(w => <MenuItem key={w.id} value={w.id}>{w.name}</MenuItem>)}
                  </Select>
                </FormControl>
                <FormControlLabel
                  control={<Switch checked={!!voiceConfig.wake_enabled} onChange={e => setVoiceConfig(c => ({ ...c, wake_enabled: e.target.checked }))} />}
                  label="Wake Word Enabled"
                />
                <Typography variant="body2">Wake Threshold: {voiceConfig.wake_threshold ?? 0.5}</Typography>
                <Slider value={voiceConfig.wake_threshold ?? 0.5} min={0.1} max={0.9} step={0.01}
                  onChange={(_, v) => setVoiceConfig(c => ({ ...c, wake_threshold: v as number }))} />
                <TextField label="Language" size="small" fullWidth
                  value={voiceConfig.language ?? 'en'}
                  onChange={e => setVoiceConfig(c => ({ ...c, language: e.target.value }))}
                  placeholder="en"
                />
                <TextField label="Pipeline" size="small" fullWidth
                  value={voiceConfig.pipeline ?? 'default'}
                  onChange={e => setVoiceConfig(c => ({ ...c, pipeline: e.target.value }))}
                  placeholder="default"
                />
                <Divider />
                <Typography variant="subtitle2">Edge Voice Sounds</Typography>
                <Typography variant="caption" color="text.secondary">
                  Each sound plays on this edge device. Choose a preset or upload WAV, MP3, OGG, or FLAC audio up to 2 MB.
                </Typography>
                {([
                  ['wake_ack', 'Wake word detected', 'Play immediately after wake-word detection'],
                  ['good_intent', 'Intent audio received', 'Play after usable speech/intent is received'],
                  ['no_intent', 'No intent received', 'Play after silence, timeout, or a failed voice turn'],
                ] as const).map(([key, label, description]) => {
                  const enabledField = `${key}_enabled`;
                  const soundField = `${key}_sound`;
                  const sound = String(voiceConfig[soundField] ?? (
                    key === 'wake_ack' ? 'builtin:ready_up'
                      : key === 'good_intent' ? 'builtin:digital_pop'
                        : 'builtin:wood_tap'
                  ));
                  const isCustom = sound.startsWith('custom:');
                  return (
                    <Paper key={key} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack spacing={1}>
                        <FormControlLabel
                          control={<Switch
                            checked={voiceConfig[enabledField] ?? true}
                            onChange={e => setVoiceConfig(c => ({ ...c, [enabledField]: e.target.checked }))}
                          />}
                          label={label}
                        />
                        <Typography variant="caption" color="text.secondary">{description}</Typography>
                        <FormControl fullWidth size="small" disabled={!voiceConfig[enabledField] && voiceConfig[enabledField] !== undefined}>
                          <InputLabel>Sound</InputLabel>
                          <Select
                            label="Sound"
                            value={sound}
                            onChange={e => setVoiceConfig(c => ({ ...c, [soundField]: e.target.value }))}
                          >
                            {isCustom && <MenuItem value={sound}>Uploaded sound</MenuItem>}
                            {VOICE_CUE_PRESETS.map(preset => (
                              <MenuItem key={preset.value} value={preset.value}>{preset.label}</MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                        <Stack direction="row" spacing={1}>
                          <Button component="label" size="small" variant="outlined" disabled={uploadingCue === soundField}>
                            {uploadingCue === soundField ? <CircularProgress size={14} /> : 'Upload sound'}
                            <input
                              hidden
                              type="file"
                              accept="audio/wav,audio/x-wav,audio/mpeg,audio/ogg,audio/flac"
                              onChange={e => {
                                const file = e.target.files?.[0];
                                if (file) void uploadCue(soundField, file);
                                e.target.value = '';
                              }}
                            />
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<VolumeUpIcon />}
                            disabled={!sound || !!testing}
                            onClick={() => void testCue(sound)}
                          >
                            Test on device
                          </Button>
                        </Stack>
                      </Stack>
                    </Paper>
                  );
                })}
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" onClick={saveVoice} disabled={saving}>
                    {saving ? <CircularProgress size={14} /> : 'Save Voice'}
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<SettingsVoiceIcon />}
                    onClick={() => runTest('wakeword')} disabled={!!testing}>
                    {testing === 'wakeword' ? <CircularProgress size={14} /> : 'Start 15s Wake Test'}
                  </Button>
                </Stack>
                {testing === 'wakeword' && (
                  <Alert severity="info">Say “{String(voiceConfig.wake_word ?? 'hey_jarvis').replace(/_/g, ' ')}” near the selected microphone.</Alert>
                )}
              </Stack>
            )}
            {tab === 3 && (
              <Stack spacing={2} sx={{ mt: 1 }}>
                <Alert severity="info">
                  These tests target <strong>{device.name}</strong> through Core and the Edge Agent. Audio must be heard and spoken at the Pi; this browser only controls the test and exports evidence.
                </Alert>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {HARDWARE_ACCEPTANCE_CASES.filter(test => acceptance[test.id]?.status === 'passed').length} of {HARDWARE_ACCEPTANCE_CASES.length} checks passed
                  </Typography>
                  <Chip
                    size="small"
                    label={HARDWARE_ACCEPTANCE_CASES.every(test => acceptance[test.id]?.status === 'passed') ? 'Hardware evidence complete' : 'Evidence incomplete'}
                    color={HARDWARE_ACCEPTANCE_CASES.every(test => acceptance[test.id]?.status === 'passed') ? 'success' : 'warning'}
                    variant="outlined"
                  />
                </Stack>
                {HARDWARE_ACCEPTANCE_CASES.map(test => {
                  const result = acceptance[test.id] ?? { status: 'pending' as const };
                  const manual = test.id === 'full_voice' || test.id === 'silent_voice';
                  const color = result.status === 'passed' ? 'success' : result.status === 'failed' ? 'error' : result.status === 'observe' ? 'warning' : 'default';
                  return (
                    <Paper key={test.id} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Typography variant="subtitle2" sx={{ flex: 1 }}>{test.label}</Typography>
                          <Chip size="small" label={result.status} color={color} variant="outlined" />
                        </Stack>
                        <Typography variant="caption" color="text.secondary">{test.instruction}</Typography>
                        {result.note && <Alert severity={result.status === 'failed' ? 'error' : 'info'}>{result.note}</Alert>}
                        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                          {!manual && (
                            <Button size="small" variant="outlined" disabled={result.status === 'running'} onClick={() => void runAcceptance(test.id)}>
                              {result.status === 'running' ? <CircularProgress size={14} /> : test.id === 'inventory' ? 'Check Pi inventory' : 'Run on Pi'}
                            </Button>
                          )}
                          <Button size="small" color="success" variant={result.status === 'passed' ? 'contained' : 'outlined'} onClick={() => markAcceptance(test.id, 'passed')}>Pass</Button>
                          <Button size="small" color="error" variant={result.status === 'failed' ? 'contained' : 'outlined'} onClick={() => markAcceptance(test.id, 'failed')}>Fail</Button>
                          <TextField
                            size="small" placeholder="Observation notes" value={result.note ?? ''}
                            onChange={e => setAcceptance(current => ({ ...current, [test.id]: { ...result, note: e.target.value } }))}
                            sx={{ minWidth: 240, flex: 1 }}
                          />
                        </Stack>
                      </Stack>
                    </Paper>
                  );
                })}
                <Stack direction="row" spacing={1}>
                  <Button variant="contained" size="small" onClick={exportAcceptance}>Export evidence</Button>
                  <Button size="small" onClick={resetAcceptance}>Reset saved evidence</Button>
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Privacy-safe observations are saved in this administrator browser separately for this device until reset. Exported reports remain clearly incomplete until every check is marked passed.
                </Typography>
              </Stack>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
