/**
 * DashboardPage — Canvas Core system overview.
 *
 * Shows Core health, connected device count, provider status, active scenes,
 * and recent voice turns (via shadow-mode status / report).
 */
import { useEffect, useState, useCallback } from 'react';
import { Box, Stack, Typography, Chip, Paper, Divider, Button } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import DevicesIcon from '@mui/icons-material/Devices';
import HubIcon from '@mui/icons-material/Hub';
import GridViewIcon from '@mui/icons-material/GridView';
import PsychologyIcon from '@mui/icons-material/Psychology';
import { useNavigate } from 'react-router-dom';
import { coreApi, ApiError, type ProviderHealth, type DeviceRow, type SceneRecord, type ShadowModeStatus } from '../api/client';
import { PageHeader, PageBody, StatCard, LoadingBox, ErrorBanner } from '../components/ui';

interface State {
  coreOk: boolean | null;
  providers: ProviderHealth[];
  devices: DeviceRow[];
  scenes: SceneRecord[];
  shadow: ShadowModeStatus | null;
  loading: boolean;
  error: string | null;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({
    coreOk: null, providers: [], devices: [], scenes: [], shadow: null,
    loading: true, error: null,
  });

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const [health, providers, devices, scenes, shadow] = await Promise.all([
        coreApi.health().then(() => true).catch(() => false),
        coreApi.providers().then(r => r.providers).catch(() => [] as ProviderHealth[]),
        coreApi.devices().then(r => r.devices).catch((e) => {
          if (e instanceof ApiError && e.status === 401) return [] as DeviceRow[];
          throw e;
        }),
        coreApi.scenes().then(r => r.scenes).catch((e) => {
          if (e instanceof ApiError && e.status === 401) return [] as SceneRecord[];
          throw e;
        }),
        coreApi.shadowStatus().catch((e) => {
          if (e instanceof ApiError && e.status === 401) return null;
          return null;
        }),
      ]);
      setState({ coreOk: health, providers, devices, scenes, shadow, loading: false, error: null });
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: (err as Error).message }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onlineDevices = state.devices.filter(d => d.status === 'online' || d.paired);
  const publishedScenes = state.scenes.filter(s => s.status === 'published');
  const healthyProviders = state.providers.filter(p => p.healthy);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader title="Dashboard" subtitle="Canvas Core system overview" onRefresh={load} loading={state.loading} />
      <PageBody>
        <Stack spacing={3} sx={{ maxWidth: 960, mx: 'auto' }}>
          {state.error && <ErrorBanner error={state.error} onRetry={load} />}
          {state.loading && state.coreOk === null ? (
            <LoadingBox label="Probing Core…" />
          ) : (
            <>
              {/* Status row */}
              <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 2 }}>
                <StatCard
                  label="Canvas Core"
                  value={state.coreOk ? 'Online' : 'Offline'}
                  ok={state.coreOk ?? false}
                  sub="centralized control plane"
                />
                <StatCard
                  label="Devices"
                  value={String(state.devices.length)}
                  sub={`${onlineDevices.length} paired/online`}
                />
                <StatCard
                  label="Scenes"
                  value={String(state.scenes.length)}
                  sub={`${publishedScenes.length} published`}
                />
                <StatCard
                  label="Providers"
                  value={`${healthyProviders.length}/${state.providers.length}`}
                  ok={state.providers.length === 0 ? undefined : healthyProviders.length === state.providers.length}
                  sub="AI brain services"
                />
              </Stack>

              {/* Provider status */}
              <Paper sx={{ p: 2.5 }}>
                <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
                  <HubIcon sx={{ color: 'primary.main', mr: 1, fontSize: 20 }} />
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>Provider Health</Typography>
                  <Button size="small" variant="outlined" onClick={() => navigate('/intelligence')}>Details</Button>
                </Stack>
                {state.providers.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No providers configured. Set LLM/Whisper/Piper/MCP URLs in Settings.
                  </Typography>
                ) : (
                  <Stack spacing={1}>
                    {state.providers.map(p => (
                      <Stack key={p.name} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                        {p.healthy
                          ? <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} />
                          : <ErrorIcon sx={{ color: 'error.main', fontSize: 18 }} />}
                        <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 60 }}>{p.name}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                          {p.kind}{p.detail ? ` · ${p.detail}` : ''}
                        </Typography>
                        {p.latencyMs !== undefined && (
                          <Chip size="small" label={`${p.latencyMs}ms`} variant="outlined" sx={{ fontSize: 10 }} />
                        )}
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Paper>

              {/* Devices + Scenes quick view */}
              <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 2 }}>
                <Paper sx={{ p: 2.5, flex: 1, minWidth: 280 }}>
                  <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
                    <DevicesIcon sx={{ color: 'primary.main', mr: 1, fontSize: 20 }} />
                    <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>Devices</Typography>
                    <Button size="small" variant="outlined" onClick={() => navigate('/devices')}>Manage</Button>
                  </Stack>
                  <Divider sx={{ mb: 1 }} />
                  {state.devices.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">No devices registered.</Typography>
                  ) : (
                    <Stack spacing={0.5}>
                      {state.devices.slice(0, 5).map(d => (
                        <Stack key={d.id} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: d.paired ? 'success.main' : 'text.disabled' }} />
                          <Typography variant="body2" sx={{ flex: 1, fontSize: 13 }}>{d.name}</Typography>
                          <Chip size="small" label={d.authority_mode} variant="outlined" sx={{ fontSize: 10 }} />
                        </Stack>
                      ))}
                      {state.devices.length > 5 && (
                        <Typography variant="caption" color="text.secondary">+{state.devices.length - 5} more</Typography>
                      )}
                    </Stack>
                  )}
                </Paper>

                <Paper sx={{ p: 2.5, flex: 1, minWidth: 280 }}>
                  <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
                    <GridViewIcon sx={{ color: 'primary.main', mr: 1, fontSize: 20 }} />
                    <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>Scenes</Typography>
                    <Button size="small" variant="outlined" onClick={() => navigate('/scenes')}>Manage</Button>
                  </Stack>
                  <Divider sx={{ mb: 1 }} />
                  {state.scenes.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">No scenes yet. Create one in the editor.</Typography>
                  ) : (
                    <Stack spacing={0.5}>
                      {state.scenes.slice(0, 5).map(s => (
                        <Stack key={s.id} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                          <Typography variant="body2" sx={{ flex: 1, fontSize: 13 }}>{s.name}</Typography>
                          <Chip size="small" label={s.status} color={s.status === 'published' ? 'success' : 'default'} variant="outlined" sx={{ fontSize: 10 }} />
                        </Stack>
                      ))}
                    </Stack>
                  )}
                </Paper>
              </Stack>

              {/* AI Brain status */}
              <Paper sx={{ p: 2.5 }}>
                <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
                  <PsychologyIcon sx={{ color: 'primary.main', mr: 1, fontSize: 20 }} />
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>AI Brain</Typography>
                  <Button size="small" variant="outlined" onClick={() => navigate('/intelligence')}>Open</Button>
                </Stack>
                <Divider sx={{ mb: 1 }} />
                {state.shadow ? (
                  <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 2 }}>
                    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                      <Typography variant="caption" color="text.secondary">Shadow mode:</Typography>
                      <Chip size="small" label={state.shadow.active ? 'active' : 'idle'} color={state.shadow.active ? 'success' : 'default'} variant="outlined" sx={{ fontSize: 10 }} />
                    </Stack>
                    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                      <Typography variant="caption" color="text.secondary">Hermes:</Typography>
                      <Chip size="small" label={state.shadow.hermes_configured ? 'configured' : 'off'} variant="outlined" sx={{ fontSize: 10 }} />
                    </Stack>
                    {state.shadow.corpus_size !== null && (
                      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                        <Typography variant="caption" color="text.secondary">Corpus:</Typography>
                        <Chip size="small" label={`${state.shadow.corpus_size}`} variant="outlined" sx={{ fontSize: 10 }} />
                      </Stack>
                    )}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Sign in as admin to view AI brain status.
                  </Typography>
                )}
              </Paper>
            </>
          )}
        </Stack>
      </PageBody>
    </Box>
  );
}
