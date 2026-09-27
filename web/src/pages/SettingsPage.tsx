/**
 * SettingsPage — Canvas Core configuration.
 *
 * Three sections:
 *  1. Global Core settings (admin credentials, HA URL/token, LLM/Whisper/Piper/
 *     MCP provider URLs) — backed by the legacy /api/settings store.
 *  2. Privacy controls (retain transcripts/audio, retention days, providers
 *     allowed, transcript log level) — /api/admin/privacy.
 *  3. Storage status + GC + audio focus state.
 *
 * Per-device settings will land with the desired/reported state model; for now
 * the device list links to /devices.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box, Stack, Typography, Paper, Button, TextField, Switch, FormControlLabel,
  Divider, Alert, Chip, MenuItem, Select, InputLabel, FormControl, IconButton, Tabs, Tab,
  CircularProgress, InputAdornment, Tooltip, TableContainer, Table, TableHead, TableRow, TableCell, TableBody,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import EditIcon from '@mui/icons-material/Edit';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import WifiIcon from '@mui/icons-material/Wifi';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { coreApi, ApiError, type AiProviderInfo, type AiProviderType, type AiProviderKind, type PrivacySettings, type StorageStatus, type AudioState, type LegacySettings, type MqttStatus, type RequestClassification, type VoiceCommandTemplate } from '../api/client';
import { PageHeader, PageBody, LoadingBox, ErrorBanner, fmtBytes } from '../components/ui';

const PROVIDER_FIELDS: { key: string; label: string; placeholder?: string }[] = [
  { key: 'voice_ha_url', label: 'Home Assistant URL', placeholder: 'http://homeassistant.local:8123' },
  { key: 'voice_ha_token', label: 'Home Assistant long-lived token', placeholder: '••••••••' },
  { key: 'voice_pipeline_id', label: 'HA voice pipeline ID', placeholder: '' },
];

// These keys are not in the legacy SETTING_DEFAULTS, so we keep them as
// display-only fields backed by localStorage until a dedicated Core config
// endpoint exists. They document the expected provider URLs.
const CORE_PROVIDER_FIELDS: { key: string; label: string; placeholder: string; env: string }[] = [
  { key: 'llm_base_url', label: 'LLM base URL', placeholder: 'http://llm:8080/v1', env: 'CANVAS_CORE_LLM_BASE_URL' },
  { key: 'whisper_url', label: 'Whisper (ASR) URL', placeholder: 'http://asr:8000', env: 'CANVAS_CORE_WHISPER_URL' },
  { key: 'piper_url', label: 'Piper (TTS) URL', placeholder: 'http://tts:5000', env: 'CANVAS_CORE_PIPER_URL' },
  { key: 'mcp_url', label: 'MCP server URL', placeholder: 'http://mcp:9000', env: 'CANVAS_CORE_MCP_URL' },
];

const VOICE_CUE_PRESETS = [
  { value: 'builtin:soft_chime', label: 'Soft chime' },
  { value: 'builtin:glass_ping', label: 'Glass ping' },
  { value: 'builtin:ready_up', label: 'Ready up' },
  { value: 'builtin:wood_tap', label: 'Wood tap' },
  { value: 'builtin:digital_pop', label: 'Digital pop' },
  { value: 'builtin:confirm_tone', label: 'Confirm tone' },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general');
  const [settings, setSettings] = useState<LegacySettings | null>(null);
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [audio, setAudio] = useState<AudioState | null>(null);
  const [mqtt, setMqtt] = useState<MqttStatus | null>(null);
  const [coreBridge, setCoreBridge] = useState<{ url: string; tokenSet: boolean; source: string } | null>(null);
  const [bridgeTestResult, setBridgeTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [bridgeTesting, setBridgeTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, p, st, a, mq, cb] = await Promise.all([
        coreApi.settings().catch((e) => {
          if (e instanceof ApiError && e.status === 401) { setAuthRequired(true); return null; }
          throw e;
        }),
        coreApi.privacy().then(r => r.settings).catch((e) => {
          if (e instanceof ApiError && e.status === 401) { setAuthRequired(true); return null; }
          return null;
        }),
        coreApi.storageStatus().catch((e) => {
          if (e instanceof ApiError && e.status === 401) { setAuthRequired(true); return null; }
          return null;
        }),
        coreApi.audioState().catch(() => null),
        coreApi.mqttStatus().catch(() => null),
        coreApi.coreBridgeStatus().catch(() => null),
      ]);
      setSettings(s);
      setPrivacy(p);
      setStorage(st);
      setAudio(a);
      setMqtt(mq);
      setCoreBridge(cb);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveSettings(patch: Partial<LegacySettings>) {
    if (!settings) return;
    setSaved(null);
    try {
      await coreApi.updateSettings(patch as Record<string, string>);
      setSaved('Settings saved.');
      load();
    } catch (e) { setError((e as Error).message); }
  }

  async function saveCoreBridge() {
    if (!settings) return;
    setSaved(null);
    try {
      await coreApi.updateSettings({ canvas_core_url: settings.canvas_core_url ?? '', edge_voice_token: settings.edge_voice_token ?? '' });
      setSaved('Core bridge settings saved. Restart voice to apply.');
      setBridgeTestResult(null);
      load();
    } catch (e) { setError((e as Error).message); }
  }

  async function testBridgeConnection() {
    setBridgeTesting(true); setBridgeTestResult(null);
    try {
      const result = await coreApi.testCoreBridge();
      setBridgeTestResult(result);
    } catch (e) { setBridgeTestResult({ ok: false, error: (e as Error).message }); }
    finally { setBridgeTesting(false); }
  }

  async function savePrivacy(patch: Partial<PrivacySettings>) {
    if (!privacy) return;
    setSaved(null);
    try {
      const r = await coreApi.updatePrivacy(patch);
      setPrivacy(r.settings);
      setSaved('Privacy settings saved.');
    } catch (e) { setError((e as Error).message); }
  }

  async function reconnectMqtt() {
    try {
      setMqtt(await coreApi.reconnectMqtt());
      setSaved('MQTT connection restarted.');
    } catch (e) { setError((e as Error).message); }
  }

  async function disconnectMqtt() {
    try {
      await coreApi.disconnectMqtt();
      setMqtt(current => current ? { ...current, connected: false, connectedAt: null } : current);
      setSaved('MQTT disconnected. Disable MQTT and save to keep it off after restart.');
    } catch (e) { setError((e as Error).message); }
  }

  async function purge() {
    if (!confirm('Purge ALL stored transcripts and audio? This cannot be undone.')) return;
    try {
      const r = await coreApi.purgePrivacy();
      setSaved(`Purged ${r.purgedTranscripts} transcripts, ${r.purgedAudio} audio.`);
    } catch (e) { setError((e as Error).message); }
  }

  async function runGc() {
    if (!confirm('Run garbage collection now?')) return;
    try {
      await coreApi.runGc();
      setSaved('Garbage collection complete.');
      load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader title="Settings" subtitle="Canvas Core configuration" onRefresh={load} loading={loading} />
      <PageBody>
        <Stack spacing={3} sx={{ maxWidth: 900, mx: 'auto' }}>
          {authRequired && (
            <Alert severity="warning" sx={{ bgcolor: 'rgba(253,214,99,0.1)' }}>
              Admin login required to view/edit Core settings.
            </Alert>
          )}
          {error && <ErrorBanner error={error} onRetry={load} />}
          {saved && <Alert severity="success" sx={{ bgcolor: 'rgba(74,222,128,0.1)' }} onClose={() => setSaved(null)}>{saved}</Alert>}
          <Paper sx={{ overflowX: 'auto' }}>
            <Tabs value={activeTab} onChange={(_, value: string) => setActiveTab(value)} variant="scrollable" scrollButtons="auto" aria-label="Settings sections">
              <Tab value="general" label="General" />
              <Tab value="integrations" label="Integrations" />
              <Tab value="request-routing" label="Request routing" />
              <Tab value="privacy-storage" label="Privacy &amp; storage" />
              <Tab value="ai" label="AI providers" />
              <Tab value="voice-commands" label="Voice commands" />
            </Tabs>
          </Paper>
          {loading ? <LoadingBox /> : (
            <>
              {activeTab === 'general' && <>
              {/* Core identity */}
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Core identity</Typography>
                <Divider sx={{ mb: 2 }} />
                {settings && (
                  <Stack spacing={2}>
                    <TextField
                      label="Device name"
                      value={settings.device_name ?? ''}
                      onChange={e => setSettings({ ...settings, device_name: e.target.value })}
                      size="small" fullWidth
                    />
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="contained" startIcon={<SaveIcon fontSize="small" />} onClick={() => saveSettings({ device_name: settings.device_name })} sx={{ textTransform: 'none' }}>
                        Save identity
                      </Button>
                    </Stack>
                  </Stack>
                )}
              </Paper>

              {/* Log level */}
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Logging</Typography>
                <Divider sx={{ mb: 2 }} />
                <LogLevelControl />
              </Paper>

              </>}

              {activeTab === 'integrations' && <>
              {/* Canvas Core Bridge */}
              <Paper sx={{ p: 2.5 }}>
                <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Canvas Core bridge</Typography>
                  <Chip
                    size="small" sx={{ ml: 'auto' }}
                    icon={coreBridge?.tokenSet && coreBridge?.url ? <WifiIcon sx={{ fontSize: 14 }} /> : <WifiOffIcon sx={{ fontSize: 14 }} />}
                    color={coreBridge?.tokenSet && coreBridge?.url ? 'success' : 'warning'}
                    label={coreBridge?.tokenSet && coreBridge?.url ? `connected (${coreBridge.source})` : 'not configured'}
                    variant="outlined"
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Configure the connection to Canvas Core for AI voice processing. The voice pipeline uses these settings at runtime — no restart required.
                </Typography>
                <Divider sx={{ mb: 2 }} />
                {settings && (
                  <Stack spacing={2}>
                    <TextField
                      label="Canvas Core URL"
                      size="small" fullWidth
                      value={settings.canvas_core_url ?? ''}
                      placeholder="http://192.168.1.108:3101"
                      onChange={e => setSettings({ ...settings, canvas_core_url: e.target.value })}
                    />
                    <TextField
                      label="Edge voice token"
                      size="small" fullWidth
                      type={showToken ? 'text' : 'password'}
                      value={settings.edge_voice_token ?? ''}
                      placeholder={coreBridge?.tokenSet ? '••••••••' : 'Enter token from Core → AI Brain → Voice bridge'}
                      onChange={e => setSettings({ ...settings, edge_voice_token: e.target.value })}
                      slotProps={{
                        input: {
                          endAdornment: (
                            <InputAdornment position="end">
                              <Tooltip title={showToken ? 'Hide token' : 'Show token'}>
                                <IconButton size="small" onClick={() => setShowToken(v => !v)}>
                                  {showToken ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                                </IconButton>
                              </Tooltip>
                            </InputAdornment>
                          ),
                        },
                      }}
                    />
                    {bridgeTestResult && (
                      <Alert severity={bridgeTestResult.ok ? 'success' : 'error'} sx={{ fontSize: 12 }}>
                        {bridgeTestResult.ok ? '✓ Core is reachable' : `Connection failed: ${bridgeTestResult.error}`}
                      </Alert>
                    )}
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="contained" startIcon={<SaveIcon fontSize="small" />} onClick={saveCoreBridge} sx={{ textTransform: 'none' }}>
                        Save
                      </Button>
                      <Button size="small" variant="outlined" startIcon={bridgeTesting ? <CircularProgress size={12} /> : <WifiIcon fontSize="small" />} onClick={testBridgeConnection} disabled={bridgeTesting || !settings.canvas_core_url} sx={{ textTransform: 'none' }}>
                        Test connection
                      </Button>
                    </Stack>
                    {coreBridge?.source === 'env' && (
                      <Alert severity="info" sx={{ fontSize: 12, bgcolor: 'rgba(100,181,246,0.1)' }}>
                        Currently using env var values. Saving here will store them in the database and take precedence over env vars.
                      </Alert>
                    )}
                  </Stack>
                )}
              </Paper>
              {/* Provider URLs (display-only — set via env / Core config) */}
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Provider URLs</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  These are set via environment variables in the Core container. Listed here for visibility.
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <Stack spacing={1.5}>
                  {CORE_PROVIDER_FIELDS.map(f => (
                    <Stack key={f.key} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2" sx={{ minWidth: 160 }}>{f.label}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, fontFamily: 'monospace' }}>{f.placeholder}</Typography>
                      <Chip size="small" label={f.env} variant="outlined" sx={{ fontSize: 10 }} />
                    </Stack>
                  ))}
                </Stack>
              </Paper>

              {/* Home Assistant */}
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Home Assistant</Typography>
                <Divider sx={{ mb: 2 }} />
                {settings && (
                  <Stack spacing={2}>
                    {PROVIDER_FIELDS.map(f => (
                      <TextField
                        key={f.key}
                        label={f.label}
                        value={settings[f.key] ?? ''}
                        placeholder={f.placeholder}
                        onChange={e => setSettings({ ...settings, [f.key]: e.target.value })}
                        size="small" fullWidth
                        type={f.key.includes('token') ? 'password' : 'text'}
                      />
                    ))}
                    <Button size="small" variant="contained" startIcon={<SaveIcon fontSize="small" />} onClick={() => saveSettings({ voice_ha_url: settings.voice_ha_url, voice_ha_token: settings.voice_ha_token, voice_pipeline_id: settings.voice_pipeline_id })} sx={{ textTransform: 'none' }}>
                      Save HA settings
                    </Button>
                  </Stack>
                )}
              </Paper>

              {/* MQTT navigation */}
              <Paper sx={{ p: 2.5 }}>
                <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>MQTT navigation</Typography>
                  <Chip
                    size="small"
                    sx={{ ml: 'auto' }}
                    color={mqtt?.connected ? 'success' : mqtt?.enabled ? 'warning' : 'default'}
                    label={mqtt?.connected ? 'CONNECTED' : mqtt?.enabled ? 'DISCONNECTED' : 'DISABLED'}
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Core subscribes to device page and panel command topics and delivers every change through the authenticated Edge channel.
                </Typography>
                <Divider sx={{ my: 2 }} />
                {settings && (
                  <Stack spacing={2}>
                    <FormControlLabel
                      control={<Switch checked={settings.mqtt_enabled === '1'} onChange={e => setSettings({ ...settings, mqtt_enabled: e.target.checked ? '1' : '0' })} />}
                      label="Enable MQTT in Core"
                    />
                    <TextField label="Broker URL" size="small" value={settings.mqtt_broker_url ?? ''} placeholder="mqtt://192.168.1.10:1883" onChange={e => setSettings({ ...settings, mqtt_broker_url: e.target.value })} />
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                      <TextField label="Username" size="small" value={settings.mqtt_username ?? ''} onChange={e => setSettings({ ...settings, mqtt_username: e.target.value })} sx={{ flex: 1 }} />
                      <TextField label="Password" type="password" size="small" value={settings.mqtt_password ?? ''} onChange={e => setSettings({ ...settings, mqtt_password: e.target.value })} sx={{ flex: 1 }} />
                    </Stack>
                    {mqtt?.lastError && <Alert severity="warning">{mqtt.lastError}</Alert>}
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="contained" startIcon={<SaveIcon fontSize="small" />} onClick={() => saveSettings({
                        mqtt_enabled: settings.mqtt_enabled,
                        mqtt_broker_url: settings.mqtt_broker_url,
                        mqtt_username: settings.mqtt_username,
                        mqtt_password: settings.mqtt_password,
                      })} sx={{ textTransform: 'none' }}>Save & apply</Button>
                      <Button size="small" variant="outlined" startIcon={<RefreshIcon fontSize="small" />} onClick={reconnectMqtt} sx={{ textTransform: 'none' }}>Reconnect</Button>
                      <Button size="small" variant="outlined" color="warning" onClick={disconnectMqtt} sx={{ textTransform: 'none' }}>Disconnect</Button>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      Page: canvas/devices/&lt;deviceId&gt;/commands/page · Panel: canvas/devices/&lt;deviceId&gt;/panels/&lt;panelId&gt;/commands
                    </Typography>
                  </Stack>
                )}
              </Paper>

              </>}

              {activeTab === 'request-routing' && settings && (
                <RequestRoutingSection settings={settings} onChange={setSettings} onSave={saveSettings} />
              )}

              {activeTab === 'privacy-storage' && <>
              {/* Privacy */}
              {privacy && (
                <Paper sx={{ p: 2.5 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Privacy</Typography>
                  <Divider sx={{ mb: 2 }} />
                  <Stack spacing={2}>
                    <FormControlLabel
                      control={<Switch checked={privacy.retain_transcripts} onChange={e => savePrivacy({ retain_transcripts: e.target.checked })} />}
                      label="Retain transcripts"
                    />
                    <FormControlLabel
                      control={<Switch checked={privacy.retain_audio} onChange={e => savePrivacy({ retain_audio: e.target.checked })} />}
                      label="Retain audio"
                    />
                    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                      <TextField
                        label="Retention (days, 0 = none)"
                        type="number"
                        size="small"
                        value={privacy.retention_days}
                        onChange={e => savePrivacy({ retention_days: Number(e.target.value) })}
                        slotProps={{ htmlInput: { min: 0 } }}
                      />
                      <FormControl size="small" sx={{ minWidth: 200 }}>
                        <InputLabel>Transcript log level</InputLabel>
                        <Select
                          label="Transcript log level"
                          value={privacy.transcript_log_level}
                          onChange={e => savePrivacy({ transcript_log_level: e.target.value as PrivacySettings['transcript_log_level'] })}
                        >
                          <MenuItem value="none">none</MenuItem>
                          <MenuItem value="anonymized">anonymized</MenuItem>
                          <MenuItem value="full">full</MenuItem>
                        </Select>
                      </FormControl>
                    </Stack>
                    <Stack direction="row" spacing={1}>
                      <Button size="small" color="error" variant="outlined" startIcon={<DeleteForeverIcon fontSize="small" />} onClick={purge} sx={{ textTransform: 'none' }}>
                        Purge all transcripts & audio
                      </Button>
                    </Stack>
                  </Stack>
                </Paper>
              )}

              {/* Storage */}
              {storage && (
                <Paper sx={{ p: 2.5 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Storage</Typography>
                  <Divider sx={{ mb: 2 }} />
                  <Stack spacing={0.5}>
                    <Row label="Assets" value={`${storage.assetCount} (${fmtBytes(storage.assetTotalBytes)})`} />
                    <Row label="Unreferenced assets" value={String(storage.unreferencedAssetCount)} />
                    <Row label="Scenes" value={String(storage.sceneCount)} />
                    <Row label="Schedules" value={String(storage.scheduleCount)} />
                  </Stack>
                  <Button size="small" variant="outlined" startIcon={<CleaningServicesIcon fontSize="small" />} onClick={runGc} sx={{ textTransform: 'none', mt: 2 }}>
                    Run garbage collection
                  </Button>
                </Paper>
              )}

              {/* Audio focus */}
              {audio && (
                <Paper sx={{ p: 2.5 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Audio focus</Typography>
                  <Divider sx={{ mb: 2 }} />
                  <Stack spacing={0.5}>
                    <Row label="State" value={audio.state} />
                    <Row label="Title" value={audio.title || '—'} />
                    <Row label="Volume" value={String(audio.volume)} />
                    <Row label="Muted" value={audio.muted ? 'yes' : 'no'} />
                  </Stack>
                </Paper>
              )}

              </>}

              {/* AI Providers */}
              {activeTab === 'ai' && settings && <>
                <VoiceCueSettings settings={settings} onSave={saveSettings} />
                <CloudAiSection settings={settings} onSave={saveSettings} />
                <AiProvidersSection />
              </>}
              {activeTab === 'voice-commands' && <VoiceCommandTemplatesSection />}
            </>
          )}
        </Stack>
      </PageBody>
    </Box>
  );
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

function VoiceCueSettings({ settings, onSave }: { settings: LegacySettings; onSave: (patch: Partial<LegacySettings>) => Promise<void> }) {
  const rows = [
    { enabled: 'voice_wake_ack_enabled', sound: 'voice_wake_ack_sound', label: 'Wake word detected', help: 'Plays immediately after the wake word is accepted.' },
    { enabled: 'voice_good_intent_enabled', sound: 'voice_good_intent_sound', label: 'Intent received', help: 'Plays when Core has understood and accepted the request.' },
    { enabled: 'voice_no_intent_enabled', sound: 'voice_no_intent_sound', label: 'No intent', help: 'Plays when the request is empty or could not be understood.' },
  ] as const;
  const [draft, setDraft] = useState(() => Object.fromEntries(rows.flatMap(row => [
    [row.enabled, settings[row.enabled]], [row.sound, settings[row.sound]],
  ])) as Record<string, string>);
  useEffect(() => {
    setDraft(Object.fromEntries(rows.flatMap(row => [[row.enabled, settings[row.enabled]], [row.sound, settings[row.sound]]])) as Record<string, string>);
  }, [settings]);
  return <Paper sx={{ p: 2.5 }}>
    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Edge voice feedback sounds</Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>These fleet defaults are sent to Linux and Android Edge devices.</Typography>
    <Stack spacing={2}>
      {rows.map(row => <Stack key={row.enabled} direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
        <Box sx={{ flex: 1 }}>
          <FormControlLabel control={<Switch checked={draft[row.enabled] === '1'} onChange={event => setDraft(value => ({ ...value, [row.enabled]: event.target.checked ? '1' : '0' }))} />} label={row.label} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{row.help}</Typography>
        </Box>
        <FormControl size="small" sx={{ minWidth: 190 }} disabled={draft[row.enabled] !== '1'}>
          <InputLabel>Sound</InputLabel>
          <Select label="Sound" value={draft[row.sound] || VOICE_CUE_PRESETS[0].value} onChange={event => setDraft(value => ({ ...value, [row.sound]: event.target.value }))}>
            {VOICE_CUE_PRESETS.map(cue => <MenuItem key={cue.value} value={cue.value}>{cue.label}</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>)}
      <Box><Button variant="contained" startIcon={<SaveIcon />} onClick={() => onSave(draft)}>Save voice sounds</Button></Box>
    </Stack>
  </Paper>;
}

function LogLevelControl() {
  const [level, setLevelState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    coreApi.logLevel()
      .then(r => setLevelState(r.level))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleChange(newLevel: string) {
    setSaving(true);
    try {
      const r = await coreApi.setLogLevel(newLevel);
      setLevelState(r.level);
    } catch {
      // revert on failure
      setLevelState(level);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Typography variant="body2" color="text.secondary">Loading…</Typography>;

  return (
    <FormControl size="small" sx={{ minWidth: 200 }}>
      <InputLabel>Log level</InputLabel>
      <Select
        label="Log level"
        value={level ?? 'warn'}
        onChange={e => handleChange(e.target.value)}
        disabled={saving}
      >
        {LOG_LEVELS.map(l => (
          <MenuItem key={l} value={l}>
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
              <Chip
                size="small"
                label={l}
                variant="outlined"
                color={l === 'error' ? 'error' : l === 'warn' ? 'warning' : l === 'info' ? 'info' : 'default'}
                sx={{ minWidth: 50, fontSize: 10 }}
              />
            </Stack>
          </MenuItem>
        ))}
      </Select>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
        {level === 'debug' ? 'All messages including debug details.' :
         level === 'info'  ? 'Startup, status, and request/response logs.' :
         level === 'warn'  ? 'Only warnings and errors.' :
                            'Only errors.'}
      </Typography>
    </FormControl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 180 }}>{label}</Typography>
      <Typography variant="body2">{value}</Typography>
    </Stack>
  );
}

const ROUTING_DOMAINS = [
  ['general_knowledge', 'General knowledge'],
  ['home_automation', 'Home automation'],
  ['music_audio', 'Music and audio'],
  ['video', 'Video'],
  ['display_navigation', 'Display navigation'],
  ['device_control', 'Device control'],
] as const;

function RequestRoutingSection({ settings, onChange, onSave }: {
  settings: LegacySettings;
  onChange: (settings: LegacySettings) => void;
  onSave: (patch: Partial<LegacySettings>) => Promise<void>;
}) {
  const [testText, setTestText] = useState('');
  const [testing, setTesting] = useState(false);
  const [classification, setClassification] = useState<RequestClassification | null>(null);
  const [testError, setTestError] = useState('');
  const setBool = (key: string, checked: boolean) => onChange({ ...settings, [key]: checked ? '1' : '0' });
  const routingPatch = Object.fromEntries(
    Object.entries(settings).filter(([key]) => key.startsWith('request_routing_')),
  );

  async function runTest() {
    if (!testText.trim()) return;
    setTesting(true); setTestError(''); setClassification(null);
    try {
      const result = await coreApi.testRequestRouting(testText.trim());
      setClassification(result.classification);
    } catch (error) {
      setTestError((error as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return <Stack spacing={3}>
    <Paper sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Request routing policy</Typography>
      <Typography variant="caption" color="text.secondary">Classify requests before selecting a domain handler. Classification never bypasses typed tools, permissions, or confirmation rules.</Typography>
      <Divider sx={{ my: 2 }} />
      <Stack spacing={1.5}>
        <FormControlLabel control={<Switch checked={settings.request_routing_enabled === '1'} onChange={event => setBool('request_routing_enabled', event.target.checked)} />} label="Enable configurable request routing" />
        <FormControlLabel control={<Switch checked={settings.request_routing_use_ai === '1'} onChange={event => setBool('request_routing_use_ai', event.target.checked)} />} label="Use the assigned Intent Routing AI model" />
        <FormControlLabel control={<Switch checked={settings.request_routing_prefer_deterministic === '1'} onChange={event => setBool('request_routing_prefer_deterministic', event.target.checked)} />} label="Prefer fast deterministic routing for high-confidence commands" />
        <FormControlLabel control={<Switch checked={settings.request_routing_clarify_below_threshold === '1'} onChange={event => setBool('request_routing_clarify_below_threshold', event.target.checked)} />} label="Ask for clarification below the confidence threshold" />
        <FormControlLabel control={<Switch checked={settings.request_routing_use_context === '1'} onChange={event => setBool('request_routing_use_context', event.target.checked)} />} label="Use conversation context when available" />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Minimum confidence" type="number" size="small" value={settings.request_routing_confidence_threshold ?? '0.72'} onChange={event => onChange({ ...settings, request_routing_confidence_threshold: event.target.value })} slotProps={{ htmlInput: { min: 0, max: 1, step: 0.01 } }} />
          <FormControl size="small" sx={{ minWidth: 240 }}><InputLabel>Fallback behaviour</InputLabel><Select label="Fallback behaviour" value={settings.request_routing_fallback ?? 'clarify'} onChange={event => onChange({ ...settings, request_routing_fallback: event.target.value })}><MenuItem value="clarify">Ask for clarification</MenuItem><MenuItem value="general_knowledge">General AI response</MenuItem></Select></FormControl>
        </Stack>
        <FormControlLabel control={<Switch checked={settings.request_routing_debug_logging === '1'} onChange={event => setBool('request_routing_debug_logging', event.target.checked)} />} label="Log domain, classifier and confidence" />
      </Stack>
    </Paper>

    <Paper sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Enabled request domains</Typography>
      <Divider sx={{ my: 2 }} />
      <Stack direction={{ xs: 'column', sm: 'row' }} useFlexGap spacing={1} sx={{ flexWrap: 'wrap' }}>
        {ROUTING_DOMAINS.map(([key, label]) => <FormControlLabel key={key} sx={{ minWidth: 250 }} control={<Switch checked={settings[`request_routing_domain_${key}`] === '1'} onChange={event => setBool(`request_routing_domain_${key}`, event.target.checked)} />} label={label} />)}
      </Stack>
      <Button sx={{ mt: 2, textTransform: 'none' }} variant="contained" startIcon={<SaveIcon />} onClick={() => onSave(routingPatch)}>Save request routing</Button>
    </Paper>

    <Paper sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Test request classification</Typography>
      <Typography variant="caption" color="text.secondary">This classifies the text but does not execute the resulting action.</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2 }}>
        <TextField fullWidth size="small" label="Example request" value={testText} onChange={event => setTestText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runTest(); }} />
        <Button variant="outlined" disabled={testing || !testText.trim()} onClick={() => void runTest()} sx={{ minWidth: 110, textTransform: 'none' }}>{testing ? 'Testing…' : 'Classify'}</Button>
      </Stack>
      {testError && <Alert severity="error" sx={{ mt: 2 }}>{testError}</Alert>}
      {classification && <Stack spacing={0.75} sx={{ mt: 2 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}><Chip label={classification.domain.replace(/_/g, ' ')} color="primary" /><Chip label={classification.intent} variant="outlined" /><Chip label={`${Math.round(classification.confidence * 100)}% confidence`} variant="outlined" /><Chip label={classification.classifier} variant="outlined" color={classification.classifier === 'ai' ? 'secondary' : 'default'} />{classification.needs_clarification && <Chip label="Clarification required" color="warning" />}</Stack>
        {classification.query && <Row label="Query" value={classification.query} />}
        {classification.media_type && <Row label="Media type" value={classification.media_type} />}
        {classification.source && <Row label="Preferred source" value={classification.source} />}
        {classification.reasoning && <Row label="Reasoning" value={classification.reasoning} />}
      </Stack>}
    </Paper>
  </Stack>;
}

// ── AI Providers section ─────────────────────────────────────────────────

const TASK_NAMES: Record<string, string> = {
  intent_routing: 'Intent Routing',
  conversation: 'Conversation',
  vision: 'Camera Vision',
  asr: 'Speech-to-Text (ASR)',
  tts: 'Text-to-Speech (TTS)',
  embedding: 'Embeddings',
};

const PROVIDER_KIND_LABELS: Record<string, string> = {
  openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic',
  gemini: 'Google Gemini', groq: 'Groq', azure: 'Azure OpenAI',
  'llama-cpp': 'llama.cpp', ollama: 'Ollama', vllm: 'vLLM',
  whisper: 'Whisper', piper: 'Piper', coqui: 'Coqui TTS',
};

const AI_PROVIDER_HEALTH_INTERVAL_MS = 30_000;

function CloudAiSection({ settings, onSave }: {
  settings: LegacySettings;
  onSave: (patch: Partial<LegacySettings>) => Promise<void>;
}) {
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const enabled = settings.cloud_ai_enabled === '1';
  const providerId = settings.cloud_ai_provider ?? '';

  useEffect(() => {
    coreApi.aiProviders()
      .then(res => setProviders(res.providers.filter(p => p.type === 'llm')))
      .catch(() => {});
  }, []);

  return (
    <Paper sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ mb: 0.5 }}>Cloud AI</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        When enabled, the cloud model is used for coding / HA-automation drafting and only as a
        last resort in chat (after every local model fails). Every cloud call is logged separately
        in <code>cloud_ai_usage</code> for later fine-tuning.
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            onChange={(_, checked) => void onSave({ cloud_ai_enabled: checked ? '1' : '0' })}
          />
        }
        label="Allow AI to use cloud models"
      />
      <FormControl fullWidth size="small" sx={{ mt: 1.5, maxWidth: 360 }}>
        <InputLabel>Cloud provider</InputLabel>
        <Select
          label="Cloud provider"
          value={providerId}
          onChange={(e) => void onSave({ cloud_ai_provider: e.target.value })}
        >
          <MenuItem value="">Auto (first non-local LLM)</MenuItem>
          {providers.map(p => (
            <MenuItem key={p.id} value={p.id}>{p.id} ({p.kind})</MenuItem>
          ))}
        </Select>
      </FormControl>
    </Paper>
  );
}

function AiProvidersSection() {
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [lastHealthCheck, setLastHealthCheck] = useState<Date | null>(null);
  const healthCheckActive = useRef(false);

  // Add provider form state
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newType, setNewType] = useState<AiProviderType>('llm');
  const [newKind, setNewKind] = useState<AiProviderKind>('openai');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newModel, setNewModel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // Edit provider form state
  const [editing, setEditing] = useState<AiProviderInfo | null>(null);
  const [editId, setEditId] = useState('');
  const [editType, setEditType] = useState<AiProviderType>('llm');
  const [editKind, setEditKind] = useState<AiProviderKind>('openai');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [editModel, setEditModel] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await coreApi.aiProviders();
      setProviders(res.providers);
      setAssignments(res.assignments);
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, []);

  const checkHealth = useCallback(async (announce = false) => {
    if (healthCheckActive.current) return;
    healthCheckActive.current = true;
    setCheckingHealth(true);
    try {
      const res = await coreApi.healthCheckAiProviders();
      const healthById = new Map(res.providers.map(provider => [provider.id, provider]));
      setProviders(current => current.map(provider => {
        const health = healthById.get(provider.id);
        return health ? { ...provider, healthy: health.healthy, detail: health.detail } : provider;
      }));
      setLastHealthCheck(new Date());
      setError(null);
      if (announce) {
        setSaved(`Health check complete — ${res.providers.filter(p => p.healthy).length}/${res.providers.length} UP`);
      }
    } catch (e) {
      setError(`Automatic provider health check failed: ${(e as Error).message}`);
    } finally {
      healthCheckActive.current = false;
      setCheckingHealth(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then(() => {
      if (!cancelled) void checkHealth();
    });
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void checkHealth();
    }, AI_PROVIDER_HEALTH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkHealth();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [load, checkHealth]);

  async function assignTask(task: string, providerId: string) {
    setSaved(null);
    try {
      await coreApi.assignAiProvider(task, providerId);
      setAssignments(prev => ({ ...prev, [task]: providerId }));
      setSaved('Assignment saved.');
    } catch (e) { setError((e as Error).message); }
  }

  async function handleAddProvider() {
    if (!newId.trim()) { setAddError('Provider ID is required'); return; }
    setAddError(null);
    const config: Record<string, unknown> = {};
    if (newBaseUrl) config.baseUrl = newBaseUrl;
    if (newApiKey) config.apiKey = newApiKey;
    if (newModel) config.model = newModel;
    try {
      await coreApi.addAiProvider(newId.trim(), newType, newKind, config);
      setSaved(`Provider '${newId}' added.`);
      setNewId('');
      setNewBaseUrl('');
      setNewApiKey('');
      setNewModel('');
      setAdding(false);
      load();
    } catch (e) {
      setAddError((e as Error).message);
    }
  }

  async function handleDeleteProvider(id: string) {
    if (!confirm(`Delete provider '${id}'?`)) return;
    try {
      await coreApi.deleteAiProvider(id);
      setSaved(`Provider '${id}' deleted.`);
      load();
    } catch (e) { setError((e as Error).message); }
  }

  function handleEditProvider(p: AiProviderInfo) {
    setEditing(p);
    setEditId(p.id);
    setEditType(p.type);
    setEditKind(p.kind);
    setEditBaseUrl((p.config?.baseUrl as string) ?? '');
    setEditApiKey((p.config?.apiKey as string) ?? '');
    setEditModel((p.config?.model as string) ?? '');
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editing) return;
    setEditError(null);
    const config: Record<string, unknown> = {};
    if (editBaseUrl) config.baseUrl = editBaseUrl;
    if (editApiKey) config.apiKey = editApiKey;
    if (editModel) config.model = editModel;
    try {
      await coreApi.updateAiProvider(editId, editType, editKind, config);
      setSaved(`Provider '${editId}' updated.`);
      setEditing(null);
      load();
    } catch (e) { setEditError((e as Error).message); }
  }

  async function handleHealthCheck() {
    setSaved(null);
    await checkHealth(true);
  }

  // Helper: get providers of a specific type for assignment dropdowns
  const providersByType = (type: AiProviderType) =>
    providers.filter(p => p.type === type);

  // Map task to required provider type
  const taskType = (task: string): AiProviderType => {
    if (task === 'asr') return 'asr';
    if (task === 'tts') return 'tts';
    return 'llm';
  };

  return (
    <Paper sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>AI Providers</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Manage AI service providers (LLM, ASR, TTS) and assign them to platform tasks. Health is checked automatically every 30 seconds.
      </Typography>
      <Divider sx={{ mb: 2 }} />
      {saved && <Alert severity="success" sx={{ bgcolor: 'rgba(74,222,128,0.1)', mb: 2 }} onClose={() => setSaved(null)}>{saved}</Alert>}
      {error && <ErrorBanner error={error} onRetry={load} />}

      {/* Toolbar */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button size="small" variant="contained" startIcon={<AddIcon fontSize="small" />} onClick={() => setAdding(!adding)} sx={{ textTransform: 'none' }}>
          {adding ? 'Cancel' : 'Add Provider'}
        </Button>
        <Button size="small" variant="outlined" disabled={checkingHealth} startIcon={<RefreshIcon fontSize="small" />} onClick={handleHealthCheck} sx={{ textTransform: 'none' }}>
          {checkingHealth ? 'Checking…' : 'Check Now'}
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center', ml: 'auto !important' }}>
          {lastHealthCheck ? `Updated ${lastHealthCheck.toLocaleTimeString()}` : 'Waiting for first automatic check…'}
        </Typography>
      </Stack>

      {/* Add provider form */}
      {adding && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'rgba(108,99,255,0.04)' }}>
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>New Provider</Typography>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1.5}>
              <TextField
                label="Provider ID"
                value={newId}
                onChange={e => setNewId(e.target.value)}
                size="small"
                placeholder="e.g. my-openai"
                sx={{ flex: 1 }}
              />
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <InputLabel>Type</InputLabel>
                <Select label="Type" value={newType} onChange={e => setNewType(e.target.value as AiProviderType)}>
                  <MenuItem value="llm">LLM</MenuItem>
                  <MenuItem value="asr">ASR</MenuItem>
                  <MenuItem value="tts">TTS</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 140 }}>
                <InputLabel>Kind</InputLabel>
                <Select label="Kind" value={newKind} onChange={e => setNewKind(e.target.value as AiProviderKind)}>
                  {Object.entries(PROVIDER_KIND_LABELS).map(([k, v]) => (
                    <MenuItem key={k} value={k}>{v}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <TextField
                label="Base URL"
                value={newBaseUrl}
                onChange={e => setNewBaseUrl(e.target.value)}
                size="small"
                placeholder="http://host:port/v1"
                sx={{ flex: 1 }}
              />
              <TextField
                label="API Key"
                type="password"
                value={newApiKey}
                onChange={e => setNewApiKey(e.target.value)}
                size="small"
                placeholder="Optional"
                sx={{ flex: 1 }}
              />
              <TextField
                label="Model"
                value={newModel}
                onChange={e => setNewModel(e.target.value)}
                size="small"
                placeholder="Optional"
                sx={{ flex: 1 }}
              />
            </Stack>
            {addError && <Typography variant="caption" color="error">{addError}</Typography>}
            <Button size="small" variant="contained" onClick={handleAddProvider} sx={{ textTransform: 'none', alignSelf: 'flex-start' }}>
              Add
            </Button>
          </Stack>
        </Paper>
      )}

      {/* Edit provider dialog */}
      {editing && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'rgba(108,99,255,0.04)' }}>
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Edit Provider: {editing.id}</Typography>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1.5}>
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <InputLabel>Type</InputLabel>
                <Select label="Type" value={editType} onChange={e => setEditType(e.target.value as AiProviderType)}>
                  <MenuItem value="llm">LLM</MenuItem>
                  <MenuItem value="asr">ASR</MenuItem>
                  <MenuItem value="tts">TTS</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 140 }}>
                <InputLabel>Kind</InputLabel>
                <Select label="Kind" value={editKind} onChange={e => setEditKind(e.target.value as AiProviderKind)}>
                  {Object.entries(PROVIDER_KIND_LABELS).map(([k, v]) => (
                    <MenuItem key={k} value={k}>{v}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <TextField label="Base URL" value={editBaseUrl} onChange={e => setEditBaseUrl(e.target.value)} size="small" placeholder="http://host:port/v1" sx={{ flex: 1 }} />
              <TextField label="API Key" type="password" value={editApiKey} onChange={e => setEditApiKey(e.target.value)} size="small" placeholder="Optional" sx={{ flex: 1 }} />
              <TextField label="Model" value={editModel} onChange={e => setEditModel(e.target.value)} size="small" placeholder="Optional" sx={{ flex: 1 }} />
            </Stack>
            {editError && <Typography variant="caption" color="error">{editError}</Typography>}
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="contained" onClick={handleSaveEdit} sx={{ textTransform: 'none' }}>Save</Button>
              <Button size="small" variant="outlined" onClick={() => setEditing(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
            </Stack>
          </Stack>
        </Paper>
      )}

      {loading ? <LoadingBox /> : (
        <>
          {/* Provider list */}
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Configured Providers</Typography>
          <Stack spacing={1} sx={{ mb: 3 }}>
            {providers.map(p => (
              <Stack key={p.id} direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <Chip size="small" label={p.id} variant="outlined" sx={{ minWidth: 100, fontFamily: 'monospace', fontSize: 11 }} />
                <Chip size="small" label={p.type.toUpperCase()} color="default" variant="outlined" sx={{ minWidth: 50, fontSize: 10 }} />
                <Chip size="small" label={PROVIDER_KIND_LABELS[p.kind] || p.kind} sx={{ minWidth: 100 }} />
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1, fontSize: 11 }}>
                  {p.config?.baseUrl ? p.config.baseUrl as string : ''}
                  {p.config?.model ? ` / ${p.config.model}` : ''}
                </Typography>
                <Chip
                  size="small"
                  label={p.healthy ? 'UP' : 'DOWN'}
                  color={p.healthy ? 'success' : 'error'}
                  variant="outlined"
                  title={p.detail || 'No health detail reported'}
                  sx={{ minWidth: 50 }}
                />
                <IconButton size="small" onClick={() => handleEditProvider(p)} title="Edit provider">
                  <EditIcon fontSize="small" />
                </IconButton>
                <IconButton size="small" color="error" onClick={() => handleDeleteProvider(p.id)} title="Delete provider">
                  <DeleteForeverIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
            {providers.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>No AI providers configured. Add one above.</Typography>}
          </Stack>

          {/* Task assignments */}
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Task Assignments</Typography>
          <Stack spacing={1.5}>
            {Object.entries(TASK_NAMES).map(([task, label]) => {
              const t = taskType(task);
              const candidates = providersByType(t);
              return (
                <Stack key={task} direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <Typography variant="body2" sx={{ minWidth: 160 }}>{label}</Typography>
                  <FormControl size="small" sx={{ minWidth: 220 }}>
                    <Select
                      value={assignments[task] || ''}
                      onChange={e => assignTask(task, e.target.value)}
                      displayEmpty
                    >
                      <MenuItem value=""><em>Default (first available)</em></MenuItem>
                      {candidates.map(p => (
                        <MenuItem key={p.id} value={p.id}>{p.id} ({PROVIDER_KIND_LABELS[p.kind] || p.kind})</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  {candidates.length === 0 && (
                    <Typography variant="caption" color="text.warning">No {t.toUpperCase()} providers available</Typography>
                  )}
                </Stack>
              );
            })}
          </Stack>
        </>
      )}
    </Paper>
  );
}

function VoiceCommandTemplatesSection() {
  const emptyTemplate: VoiceCommandTemplate = {
    id: '', domain: 'light', action: 'turn_on', phrase_template: 'turn on {name}',
    service: 'turn_on', priority: 100, enabled: true, requires_confirmation: false,
  };
  const [templates, setTemplates] = useState<VoiceCommandTemplate[]>([]);
  const [index, setIndex] = useState<Array<{ domain: string; commands: number; phrases: number; ambiguous: number }>>([]);
  const [draft, setDraft] = useState<VoiceCommandTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await coreApi.voiceCommandTemplates();
      setTemplates(result.templates);
      setIndex(result.index);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!draft) return;
    setSaving(true); setError(null);
    try {
      if (!draft.id.trim()) throw new Error('Template ID is required.');
      await coreApi.saveVoiceCommandTemplate(draft.id.trim(), {
        domain: draft.domain, action: draft.action, phrase_template: draft.phrase_template,
        service: draft.service, priority: Number(draft.priority), enabled: draft.enabled,
        requires_confirmation: draft.requires_confirmation,
      });
      setDraft(null);
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  async function remove(id: string) {
    setError(null);
    try { await coreApi.deleteVoiceCommandTemplate(id); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  async function rebuild() {
    setSaving(true); setError(null);
    try { await coreApi.rebuildVoiceCommandIndex(); await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  const setField = <K extends keyof VoiceCommandTemplate>(key: K, value: VoiceCommandTemplate[K]) =>
    setDraft(current => current ? { ...current, [key]: value } : current);

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Voice command templates</Typography>
        <Button size="small" variant="outlined" startIcon={<RefreshIcon fontSize="small" />} onClick={rebuild} disabled={saving} sx={{ ml: 'auto', textTransform: 'none' }}>Rebuild index</Button>
        <Button size="small" variant="contained" startIcon={<AddIcon fontSize="small" />} onClick={() => setDraft(emptyTemplate)} sx={{ textTransform: 'none' }}>Add template</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Use {'{name}'} in every phrase. Templates generate exact commands for every cached entity in the selected domain. New domain names are supported; unrecognized services require confirmation.
      </Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {draft && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack spacing={1.25}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
              <TextField label="Template ID" size="small" value={draft.id} onChange={e => setField('id', e.target.value)} sx={{ flex: 1 }} />
              <TextField label="Domain" size="small" value={draft.domain} onChange={e => setField('domain', e.target.value)} sx={{ flex: 1 }} />
              <TextField label="Action" size="small" value={draft.action} onChange={e => setField('action', e.target.value)} sx={{ flex: 1 }} />
              <TextField label="HA service" size="small" value={draft.service ?? ''} onChange={e => setField('service', e.target.value || null)} sx={{ flex: 1 }} />
            </Stack>
            <TextField label="Phrase template" size="small" value={draft.phrase_template} onChange={e => setField('phrase_template', e.target.value)} helperText="Example: turn on {name}" fullWidth />
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <TextField label="Priority" type="number" size="small" value={draft.priority} onChange={e => setField('priority', Number(e.target.value))} slotProps={{ htmlInput: { min: 0, max: 10000 } }} sx={{ width: 120 }} />
              <FormControlLabel control={<Switch checked={draft.enabled} onChange={e => setField('enabled', e.target.checked)} />} label="Enabled" />
              <FormControlLabel control={<Switch checked={draft.requires_confirmation} onChange={e => setField('requires_confirmation', e.target.checked)} />} label="Require confirmation" />
              <Button size="small" variant="contained" onClick={save} disabled={saving} sx={{ textTransform: 'none' }}>Save</Button>
              <Button size="small" variant="outlined" onClick={() => setDraft(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
            </Stack>
          </Stack>
        </Paper>
      )}
      {loading ? <LoadingBox /> : <>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mb: 2 }}>
          {index.map(item => <Chip key={item.domain} size="small" label={`${item.domain}: ${item.phrases} phrases${item.ambiguous ? `, ${item.ambiguous} ambiguous` : ''}`} color={item.ambiguous ? 'warning' : 'default'} />)}
        </Stack>
        <TableContainer><Table size="small">
          <TableHead><TableRow><TableCell>Domain</TableCell><TableCell>Phrase</TableCell><TableCell>Action / service</TableCell><TableCell>Safety</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>{templates.map(template => <TableRow key={template.id}>
            <TableCell><Typography variant="caption">{template.domain}</Typography></TableCell>
            <TableCell><Typography variant="body2">{template.phrase_template}</Typography><Typography variant="caption" color="text.secondary">{template.id}</Typography></TableCell>
            <TableCell><Typography variant="caption">{template.action}{template.service ? ` / ${template.service}` : ''}</Typography></TableCell>
            <TableCell><Chip size="small" label={template.requires_confirmation ? 'Confirm' : template.enabled ? 'Direct' : 'Disabled'} color={template.requires_confirmation ? 'warning' : template.enabled ? 'success' : 'default'} /></TableCell>
            <TableCell><Tooltip title="Edit template"><IconButton size="small" onClick={() => setDraft(template)}><EditIcon fontSize="small" /></IconButton></Tooltip><Tooltip title="Delete template"><IconButton size="small" color="error" onClick={() => remove(template.id)}><DeleteForeverIcon fontSize="small" /></IconButton></Tooltip></TableCell>
          </TableRow>)}</TableBody>
        </Table></TableContainer>
      </>}
    </Paper>
  );
}
