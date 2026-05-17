/**
 * SettingsPage — global application settings.
 *
 * Sections:
 *   • Device settings (name)
 *   • MQTT broker configuration
 *   • Canvas defaults (snap size, default resolution)
 *   • About / version
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Paper, Divider, Slider, Switch, FormControlLabel,
  TextField, Button, Stack, Alert, CircularProgress,
  Chip, Select, MenuItem, InputLabel, FormControl, IconButton, Tooltip,
} from '@mui/material';

import WifiIcon from '@mui/icons-material/Wifi';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import { api } from '../api/client';
import { useEditorStore } from '../store';

interface ServerSettings {
  device_name: string;
  server_port: string;
  mqtt_enabled: string;
  mqtt_broker_url: string;
  mqtt_username: string;
  mqtt_password: string;
  voice_enabled: string;
  voice_port: string;
  voice_mic_device: string;
  voice_friendly_name: string;
  voice_wake_word: string;
  voice_tts_volume: string;
}

interface MqttStatus {
  enabled: boolean;
  url: string;
  connected: boolean;
}

interface VoiceStatus {
  status: 'disabled' | 'starting' | 'running' | 'stopped' | 'error';
  port: number;
  micDevice: string;
  friendlyName: string;
}

interface MicrophoneDevice {
  id: string;
  label: string;
}

export default function SettingsPage() {
  const { snapEnabled, snapSize, toggleSnap } = useEditorStore();
  const [localSnapSize, setLocalSnapSize] = useState(snapSize);
  const [defaultWidth, setDefaultWidth] = useState(1920);
  const [defaultHeight, setDefaultHeight] = useState(1080);

  // Server settings state
  const [_settings, setSettings] = useState<ServerSettings | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [mqttEnabled, setMqttEnabled] = useState(false);
  const [mqttUrl, setMqttUrl] = useState('');
  const [mqttUsername, setMqttUsername] = useState('');
  const [mqttPassword, setMqttPassword] = useState('');
  const [mqttStatus, setMqttStatus] = useState<MqttStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Voice settings state
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voicePort, setVoicePort] = useState('6053');
  const [voiceMicDevice, setVoiceMicDevice] = useState('default');
  const [voiceFriendlyName, setVoiceFriendlyName] = useState('Canvas Display');
  const [voiceWakeWord, setVoiceWakeWord] = useState('okay_nabu');
  const [voiceTtsVolume, setVoiceTtsVolume] = useState('80');
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voiceRestarting, setVoiceRestarting] = useState(false);
  const [micDevices, setMicDevices] = useState<MicrophoneDevice[]>([{ id: 'default', label: 'Default' }]);
  const [micDevicesLoading, setMicDevicesLoading] = useState(false);

  const loadMicDevices = useCallback(async () => {
    setMicDevicesLoading(true);
    try {
      const devices = await api.get<MicrophoneDevice[]>('/api/settings/voice/microphones');
      if (devices.length > 0) setMicDevices(devices);
    } catch {
      // non-fatal — keep existing list
    } finally {
      setMicDevicesLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        api.get<ServerSettings>('/api/settings'),
        api.get<MqttStatus>('/api/settings/mqtt'),
      ]);
      setSettings(s);
      setDeviceName(s.device_name ?? '');
      setMqttEnabled(s.mqtt_enabled === '1');
      setMqttUrl(s.mqtt_broker_url ?? '');
      setMqttUsername(s.mqtt_username ?? '');
      setMqttPassword(''); // never pre-fill password
      setMqttStatus(m);
      setVoiceEnabled(s.voice_enabled === '1');
      setVoicePort(s.voice_port ?? '6053');
      setVoiceMicDevice(s.voice_mic_device ?? 'default');
      setVoiceFriendlyName(s.voice_friendly_name ?? 'Canvas Display');
      setVoiceWakeWord(s.voice_wake_word ?? 'okay_nabu');
      setVoiceTtsVolume(s.voice_tts_volume ?? '80');
      // Fetch voice status separately (non-fatal)
      api.get<VoiceStatus>('/api/settings/voice').then(setVoiceStatus).catch(() => {});
    } catch (e) {
      console.error('Failed to load settings', e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadMicDevices();
  }, [loadSettings, loadMicDevices]);

  async function saveSettings() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, string> = {
        device_name:         deviceName,
        mqtt_enabled:        mqttEnabled ? '1' : '0',
        mqtt_broker_url:     mqttUrl,
        mqtt_username:       mqttUsername,
        voice_enabled:       voiceEnabled ? '1' : '0',
        voice_port:          voicePort,
        voice_mic_device:    voiceMicDevice,
        voice_friendly_name: voiceFriendlyName,
        voice_wake_word:     voiceWakeWord,
        voice_tts_volume:    voiceTtsVolume,
      };
      if (mqttPassword && mqttPassword !== '••••••••') {
        body.mqtt_password = mqttPassword;
      }
      await api.put('/api/settings', body);
      setSaveMsg({ type: 'success', text: 'Settings saved.' });
      await loadSettings();
    } catch (e: any) {
      setSaveMsg({ type: 'error', text: e.message ?? 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  async function reconnectMqtt() {
    setReconnecting(true);
    setSaveMsg(null);
    try {
      await saveSettings();
      await api.post('/api/settings/mqtt/reconnect');
      setSaveMsg({ type: 'success', text: 'MQTT reconnecting…' });
      // Refresh status after a short delay
      setTimeout(() => {
        api.get<MqttStatus>('/api/settings/mqtt').then(setMqttStatus).catch(() => {});
      }, 2000);
    } catch (e: any) {
      setSaveMsg({ type: 'error', text: e.message ?? 'Reconnect failed.' });
    } finally {
      setReconnecting(false);
    }
  }

  async function restartVoice() {
    setVoiceRestarting(true);
    setSaveMsg(null);
    try {
      await saveSettings();
      const result = await api.post<{ ok: boolean; status: string }>('/api/settings/voice/restart');
      setSaveMsg({ type: 'success', text: `Voice satellite ${result.status}.` });
      setTimeout(() => {
        api.get<VoiceStatus>('/api/settings/voice').then(setVoiceStatus).catch(() => {});
      }, 1500);
    } catch (e: any) {
      setSaveMsg({ type: 'error', text: e.message ?? 'Voice restart failed.' });
    } finally {
      setVoiceRestarting(false);
    }
  }

  function applyCanvasDefaults() {
    useEditorStore.setState({ snapSize: localSnapSize });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <Box sx={{ px: 2.5, py: 1.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>Settings</Typography>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflowY: 'auto', p: 3, maxWidth: 640, mx: 'auto', width: '100%' }}>
        <Stack spacing={3}>

          {saveMsg && (
            <Alert severity={saveMsg.type} onClose={() => setSaveMsg(null)}>
              {saveMsg.text}
            </Alert>
          )}

          {/* ── Device Settings ─────────────────────────────────────────── */}
          <Paper sx={{ p: 3 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
              Device
            </Typography>
            <TextField
              label="Device Name"
              size="small"
              fullWidth
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              helperText="Displayed in the devices list and used as the MQTT client identifier."
              sx={{ mb: 2 }}
            />
            <Button
              variant="contained"
              size="small"
              onClick={saveSettings}
              disabled={saving}
              startIcon={saving ? <CircularProgress size={14} /> : null}
            >
              Save
            </Button>
          </Paper>

          {/* ── MQTT Settings ───────────────────────────────────────────── */}
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                MQTT
              </Typography>
              {mqttStatus && (
                <Chip
                  size="small"
                  icon={mqttStatus.connected ? <WifiIcon /> : <WifiOffIcon />}
                  label={mqttStatus.connected ? 'Connected' : 'Disconnected'}
                  color={mqttStatus.connected ? 'success' : 'default'}
                />
              )}
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={mqttEnabled}
                  onChange={(e) => setMqttEnabled(e.target.checked)}
                />
              }
              label="Enable MQTT"
              sx={{ mb: 2, display: 'block' }}
            />

            <Stack spacing={2}>
              <TextField
                label="Broker URL"
                size="small"
                fullWidth
                value={mqttUrl}
                onChange={(e) => setMqttUrl(e.target.value)}
                disabled={!mqttEnabled}
                placeholder="mqtt://192.168.1.x:1883"
                helperText="e.g. mqtt://192.168.1.10:1883 or mqtt://homeassistant.local:1883"
              />
              <Stack direction="row" spacing={2}>
                <TextField
                  label="Username"
                  size="small"
                  value={mqttUsername}
                  onChange={(e) => setMqttUsername(e.target.value)}
                  disabled={!mqttEnabled}
                  sx={{ flex: 1 }}
                />
                <TextField
                  label="Password"
                  size="small"
                  type="password"
                  value={mqttPassword}
                  onChange={(e) => setMqttPassword(e.target.value)}
                  disabled={!mqttEnabled}
                  placeholder="Leave blank to keep existing"
                  sx={{ flex: 1 }}
                />
              </Stack>
            </Stack>

            <Stack direction="row" spacing={1.5} sx={{ mt: 2.5 }}>
              <Button
                variant="contained"
                size="small"
                onClick={saveSettings}
                disabled={saving}
                startIcon={saving ? <CircularProgress size={14} /> : null}
              >
                Save
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={reconnectMqtt}
                disabled={reconnecting || !mqttEnabled}
                startIcon={reconnecting ? <CircularProgress size={14} /> : null}
              >
                Save & Reconnect
              </Button>
            </Stack>

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              MQTT topics: <code>canvas_display/{'<device_id>'}/state</code>, <code>canvas_display/{'<device_id>'}/cmd/page</code>, <code>canvas_display/{'<device_id>'}/cmd/navigate</code>
            </Typography>
          </Paper>

          {/* ── Voice Satellite ──────────────────────────────────────────── */}
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Voice Satellite
              </Typography>
              {voiceStatus && (
                <Chip
                  size="small"
                  icon={voiceStatus.status === 'running' ? <MicIcon /> : <MicOffIcon />}
                  label={voiceStatus.status}
                  color={voiceStatus.status === 'running' ? 'success' : voiceStatus.status === 'error' ? 'error' : 'default'}
                />
              )}
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={voiceEnabled}
                  onChange={(e) => setVoiceEnabled(e.target.checked)}
                />
              }
              label="Enable voice satellite"
              sx={{ mb: 2, display: 'block' }}
            />

            <Stack spacing={2}>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="Port"
                  size="small"
                  value={voicePort}
                  onChange={(e) => setVoicePort(e.target.value)}
                  disabled={!voiceEnabled}
                  helperText="ESPHome API port (default 6053)"
                  sx={{ width: 120 }}
                />
                <FormControl size="small" sx={{ flex: 1 }} disabled={!voiceEnabled}>
                  <InputLabel>Mic Device</InputLabel>
                  <Select
                    label="Mic Device"
                    value={micDevices.some(d => d.id === voiceMicDevice) ? voiceMicDevice : 'default'}
                    onChange={(e) => setVoiceMicDevice(e.target.value)}
                    endAdornment={
                      <Tooltip title="Refresh microphone list">
                        <span>
                          <IconButton
                            size="small"
                            onClick={(e) => { e.stopPropagation(); loadMicDevices(); }}
                            disabled={micDevicesLoading}
                            sx={{ mr: 2 }}
                          >
                            {micDevicesLoading
                              ? <CircularProgress size={14} />
                              : <RefreshIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                    }
                  >
                    {micDevices.map(d => (
                      <MenuItem key={d.id} value={d.id}>{d.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="Friendly Name"
                  size="small"
                  value={voiceFriendlyName}
                  onChange={(e) => setVoiceFriendlyName(e.target.value)}
                  disabled={!voiceEnabled}
                  helperText="Shown in HA device UI"
                  sx={{ flex: 1 }}
                />
                <FormControl size="small" sx={{ flex: 1 }} disabled={!voiceEnabled}>
                  <InputLabel>Wake Word</InputLabel>
                  <Select
                    label="Wake Word"
                    value={voiceWakeWord}
                    onChange={(e) => setVoiceWakeWord(e.target.value)}
                  >
                    <MenuItem value="okay_nabu">Okay Nabu</MenuItem>
                    <MenuItem value="hey_jarvis">Hey Jarvis</MenuItem>
                  </Select>
                </FormControl>
              </Stack>
              <Box>
                <Typography variant="body2" gutterBottom color={voiceEnabled ? 'text.primary' : 'text.disabled'}>
                  TTS volume: {voiceTtsVolume}%
                </Typography>
                <Slider
                  value={parseInt(voiceTtsVolume) || 80}
                  min={0} max={100} step={5}
                  onChange={(_, v) => setVoiceTtsVolume(String(v))}
                  valueLabelDisplay="auto"
                  disabled={!voiceEnabled}
                  sx={{ width: '100%', maxWidth: 320 }}
                />
              </Box>
            </Stack>

            <Stack direction="row" spacing={1.5} sx={{ mt: 2.5 }}>
              <Button
                variant="contained"
                size="small"
                onClick={saveSettings}
                disabled={saving}
                startIcon={saving ? <CircularProgress size={14} /> : null}
              >
                Save
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={restartVoice}
                disabled={voiceRestarting}
                startIcon={voiceRestarting ? <CircularProgress size={14} /> : null}
              >
                {voiceEnabled ? 'Save & Restart' : 'Save & Stop'}
              </Button>
            </Stack>

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              After enabling, add this device in HA via <strong>Settings → Devices & Services → ESPHome</strong> using this device's IP and the port above.
            </Typography>
          </Paper>

          {/* ── Canvas defaults ──────────────────────────────────────────── */}
          <Paper sx={{ p: 3 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
              Canvas Defaults
            </Typography>
            <FormControlLabel
              control={<Switch checked={snapEnabled} onChange={toggleSnap} />}
              label="Snap to grid"
              sx={{ mb: 2 }}
            />
            <Box sx={{ mb: 3 }}>
              <Typography variant="body2" gutterBottom>
                Snap size: {localSnapSize}px
              </Typography>
              <Slider
                value={localSnapSize}
                min={1} max={50} step={1}
                onChange={(_, v) => setLocalSnapSize(v as number)}
                valueLabelDisplay="auto"
                disabled={!snapEnabled}
                sx={{ width: '100%', maxWidth: 320 }}
              />
            </Box>
            <Divider sx={{ mb: 2 }} />
            <Typography variant="body2" color="text.secondary" gutterBottom>
              Default new view resolution
            </Typography>
            <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: 'center' }}>
              <TextField
                label="Width" type="number" size="small"
                value={defaultWidth}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDefaultWidth(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 320, max: 7680, step: 1 } }}
                sx={{ width: 110 }}
              />
              <Typography variant="body2" color="text.secondary">×</Typography>
              <TextField
                label="Height" type="number" size="small"
                value={defaultHeight}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDefaultHeight(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 240, max: 4320, step: 1 } }}
                sx={{ width: 110 }}
              />
            </Stack>
            <Button variant="contained" size="small" onClick={applyCanvasDefaults}>
              Apply
            </Button>
          </Paper>

          {/* ── About ────────────────────────────────────────────────────── */}
          <Paper sx={{ p: 3 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
              About
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Canvas Display — standalone kiosk display manager
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Built with React + MUI + Zustand + Fastify + MQTT
            </Typography>
          </Paper>

        </Stack>
      </Box>
    </Box>
  );
}
