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
  Chip,
} from '@mui/material';

import WifiIcon from '@mui/icons-material/Wifi';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import { api } from '../api/client';
import { useEditorStore } from '../store';

interface ServerSettings {
  device_name: string;
  server_port: string;
  mqtt_enabled: string;
  mqtt_broker_url: string;
  mqtt_username: string;
  mqtt_password: string;
}

interface MqttStatus {
  enabled: boolean;
  url: string;
  connected: boolean;
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
    } catch (e) {
      console.error('Failed to load settings', e);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  async function saveSettings() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, string> = {
        device_name: deviceName,
        mqtt_enabled: mqttEnabled ? '1' : '0',
        mqtt_broker_url: mqttUrl,
        mqtt_username: mqttUsername,
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
