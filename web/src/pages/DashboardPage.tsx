/**
 * DashboardPage — home page showing system status at a glance.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Paper, Stack, Chip, Button, CircularProgress,
  Divider,
} from '@mui/material';
import WifiIcon from '@mui/icons-material/Wifi';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import LayersIcon from '@mui/icons-material/Layers';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendIcon from '@mui/icons-material/Send';
import { useNavigate } from 'react-router-dom';
import { api, pagesApi } from '../api/client';
import type { Page } from '../types';

interface MqttStatus {
  enabled: boolean;
  url: string;
  connected: boolean;
}

interface ServerSettings {
  device_name: string;
  active_page_id?: string;
  [key: string]: string | undefined;
}

function StatusCard({ label, value, ok, sub }: { label: string; value: string; ok?: boolean; sub?: string }) {
  return (
    <Paper sx={{ p: 2.5, flex: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }}>
        {ok === true  && <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} />}
        {ok === false && <ErrorIcon       sx={{ color: 'error.main',   fontSize: 18 }} />}
        <Typography variant="h6" sx={{ fontSize: 15, fontWeight: 600 }}>{value}</Typography>
      </Stack>
      {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    </Paper>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [serverOk, setServerOk] = useState(false);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [mqtt, setMqtt] = useState<MqttStatus | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [activePage, setActivePage] = useState<Page | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [health, s, m, pgs] = await Promise.all([
        api.get<{ ok: boolean }>('/health').then(() => true).catch(() => false),
        api.get<ServerSettings>('/api/settings').catch(() => null),
        api.get<MqttStatus>('/api/settings/mqtt').catch(() => null),
        pagesApi.list().catch(() => [] as Page[]),
      ]);
      setServerOk(health as boolean);
      setSettings(s);
      setMqtt(m);
      setPages(pgs);
      if (s?.active_page_id) {
        setActivePage(pgs.find(p => p.id === s.active_page_id) ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function activatePage(page: Page) {
    await pagesApi.push(page.id);
    setActivePage(page);
    if (settings) setSettings({ ...settings, active_page_id: page.id });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <Box sx={{ px: 2.5, py: 1.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="h6" sx={{ flex: 1, fontWeight: 600 }}>Dashboard</Typography>
        <Button size="small" startIcon={loading ? <CircularProgress size={12} /> : <RefreshIcon />} onClick={load} disabled={loading}>
          Refresh
        </Button>
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
        <Stack spacing={3} sx={{ maxWidth: 800 }}>

          {/* Status row */}
          <Stack direction="row" spacing={2}>
            <StatusCard
              label="Server"
              value={serverOk ? 'Running' : 'Offline'}
              ok={serverOk}
              sub={`Port ${settings?.server_port ?? '3100'}`}
            />
            <StatusCard
              label="MQTT"
              value={!mqtt?.enabled ? 'Disabled' : mqtt.connected ? 'Connected' : 'Disconnected'}
              ok={!mqtt?.enabled ? undefined : mqtt.connected}
              sub={mqtt?.enabled ? mqtt.url : undefined}
            />
            <StatusCard
              label="Pages"
              value={String(pages.length)}
              sub={`${activePage ? `Active: ${activePage.name}` : 'None active'}`}
            />
          </Stack>

          {/* Active page */}
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
              <LayersIcon sx={{ color: 'primary.main', mr: 1 }} />
              <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>Active Page</Typography>
              <Button size="small" variant="outlined" onClick={() => navigate('/pages')}>Manage Pages</Button>
            </Stack>

            {activePage ? (
              <>
                <Typography variant="body1" sx={{ fontWeight: 500 }}>{activePage.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {activePage.panels?.length ?? 0} panel{activePage.panels?.length === 1 ? '' : 's'} · ID: {activePage.id}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">No page is currently active on the kiosk.</Typography>
            )}

            {pages.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Activate a page:
                </Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                  {pages.map(p => (
                    <Chip
                      key={p.id}
                      label={p.name}
                      size="small"
                      onClick={() => activatePage(p)}
                      icon={<SendIcon sx={{ fontSize: '12px !important' }} />}
                      color={activePage?.id === p.id ? 'primary' : 'default'}
                      variant={activePage?.id === p.id ? 'filled' : 'outlined'}
                      clickable
                    />
                  ))}
                </Stack>
              </>
            )}
          </Paper>

          {/* MQTT details */}
          {mqtt && (
            <Paper sx={{ p: 3 }}>
              <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
                {mqtt.connected
                  ? <WifiIcon sx={{ color: 'success.main', mr: 1 }} />
                  : <WifiOffIcon sx={{ color: 'text.disabled', mr: 1 }} />}
                <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>MQTT</Typography>
                <Button size="small" variant="outlined" onClick={() => navigate('/settings')}>Configure</Button>
              </Stack>
              {!mqtt.enabled ? (
                <Typography variant="body2" color="text.secondary">MQTT is disabled. Enable it in Settings to control the kiosk from automations.</Typography>
              ) : (
                <Stack spacing={0.5}>
                  <Typography variant="body2">Broker: <code>{mqtt.url}</code></Typography>
                  <Typography variant="body2">
                    Status: <Chip size="small" label={mqtt.connected ? 'Connected' : 'Disconnected'} color={mqtt.connected ? 'success' : 'default'} />
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    Topic prefix: <code>canvas_display/{settings?.device_name ?? 'device'}/</code>
                  </Typography>
                </Stack>
              )}
            </Paper>
          )}

        </Stack>
      </Box>
    </Box>
  );
}
