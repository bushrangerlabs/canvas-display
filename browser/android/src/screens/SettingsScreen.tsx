import React, { useState } from 'react';
import {
  Box, Button, TextField, Typography, Switch, FormControlLabel,
  Alert, CircularProgress, Divider, Paper, InputAdornment, IconButton,
} from '@mui/material';
import { invoke } from '@tauri-apps/api/core';
import { saveConfig, type AppConfig } from '../store/config';

interface Props {
  onSaved: (config: AppConfig) => void;
  isEditing?: boolean;
  existingConfig?: AppConfig;
  onCancel?: () => void;
}

export default function SettingsScreen({ onSaved, isEditing, existingConfig, onCancel }: Props) {
  const [serverUrl, setServerUrl] = useState(existingConfig?.serverUrl ?? '');
  const [haUrl, setHaUrl] = useState(existingConfig?.haUrl ?? '');
  const [haToken, setHaToken] = useState(existingConfig?.haToken ?? '');
  const [deviceName, setDeviceName] = useState(existingConfig?.deviceName ?? '');
  const [swipeNav, setSwipeNav] = useState(existingConfig?.swipeNavEnabled ?? true);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!serverUrl.trim()) { setError('Server URL is required'); return; }
    if (!haUrl.trim()) { setError('Home Assistant URL is required'); return; }
    if (!haToken.trim()) { setError('HA access token is required'); return; }
    if (!deviceName.trim()) { setError('Device name is required'); return; }

    setSaving(true);
    setError('');
    try {
      const config: AppConfig = {
        serverUrl: serverUrl.trim().replace(/\/$/, ''),
        haUrl: haUrl.trim().replace(/\/$/, ''),
        haToken: haToken.trim(),
        deviceName: deviceName.trim(),
        deviceId: existingConfig?.deviceId,
        swipeNavEnabled: swipeNav,
        platform: 'android',
      };
      await saveConfig(config);
      onSaved(config);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Box sx={{
      width: '100%', height: '100%', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      bgcolor: 'background.default', p: 3,
      overflowY: 'auto',
    }}>
      <Paper elevation={4} sx={{ width: '100%', maxWidth: 480, p: 4, borderRadius: 3 }}>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Canvas Display — Device Setup
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {isEditing
            ? 'Update device configuration'
            : 'Configure this device to connect to your Canvas Display server and Home Assistant.'}
        </Typography>

        <Divider sx={{ mb: 3 }} />

        <TextField
          fullWidth label="Device Name" value={deviceName}
          onChange={e => setDeviceName(e.target.value)}
          placeholder="Hallway Tablet"
          helperText="How this device appears in the Canvas Display server"
          sx={{ mb: 2 }}
        />

        <TextField
          fullWidth label="Canvas Display Server URL" value={serverUrl}
          onChange={e => setServerUrl(e.target.value)}
          placeholder="http://192.168.1.10:3100"
          helperText="Base URL of your Canvas Display server"
          sx={{ mb: 2 }}
        />

        <TextField
          fullWidth label="Home Assistant URL" value={haUrl}
          onChange={e => setHaUrl(e.target.value)}
          placeholder="http://192.168.1.10:8123"
          helperText="Base URL of your Home Assistant instance"
          sx={{ mb: 2 }}
        />

        <TextField
          fullWidth label="HA Long-Lived Access Token"
          type={showToken ? 'text' : 'password'}
          value={haToken}
          onChange={e => setHaToken(e.target.value)}
          placeholder="eyJ..."
          helperText="Profile → Security → Long-Lived Access Tokens in HA"
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton onClick={() => setShowToken(v => !v)} size="small">
                  {showToken ? '🙈' : '👁'}
                </IconButton>
              </InputAdornment>
            ),
          }}
          sx={{ mb: 2 }}
        />

        <FormControlLabel
          control={<Switch checked={swipeNav} onChange={e => setSwipeNav(e.target.checked)} />}
          label="Enable swipe gesture between views"
          sx={{ mb: 3 }}
        />

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Box sx={{ display: 'flex', gap: 2 }}>
          {isEditing && onCancel && (
            <Button fullWidth variant="outlined" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button
            fullWidth variant="contained" size="large"
            onClick={handleSave} disabled={saving}
          >
            {saving ? <CircularProgress size={22} color="inherit" /> : isEditing ? 'Save' : 'Connect'}
          </Button>
        </Box>

        {isEditing && (
          <>
            <Divider sx={{ my: 3 }} />
            <Button
              fullWidth variant="outlined" color="error" size="small"
              onClick={() => invoke('quit_app').catch(console.error)}
            >
              Quit App
            </Button>
          </>
        )}
      </Paper>
    </Box>
  );
}
