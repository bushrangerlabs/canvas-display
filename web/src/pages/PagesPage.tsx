import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, FormControl, IconButton, InputLabel, List, ListItemButton, ListItemText,
  MenuItem, Paper, Select, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import EditIcon from '@mui/icons-material/EditOutlined';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import WebIcon from '@mui/icons-material/Web';
import { ApiError, coreApi, type DeviceRow, type LegacyPage, type PagePanel, type SceneRecord } from '../api/client';
import { ErrorBanner, LoadingBox, PageBody, PageHeader } from '../components/ui';

type PanelDraft = Omit<PagePanel, 'id'>;

const EMPTY_PANEL: PanelDraft = {
  name: '', content_type: 'url', url: '', scene_id: null,
  x: 0, y: 0, w: 100, h: 100, z_index: 0, visible: true, opacity: 1,
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Admin login required. Log in from the top bar and try again.';
    if (error.status === 403) return 'Request denied. Your session or CSRF token may have expired; log in again and retry.';
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export default function PagesPage() {
  const [pages, setPages] = useState<LegacyPage[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [scenes, setScenes] = useState<SceneRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [nameDialog, setNameDialog] = useState<'create' | 'rename' | null>(null);
  const [panelDialog, setPanelDialog] = useState<PagePanel | 'new' | null>(null);
  const [playlistPageId, setPlaylistPageId] = useState('');

  const selected = pages.find(page => page.id === selectedId) ?? null;
  const availableDevices = useMemo(
    () => devices.filter(device => !device.revoked_at),
    [devices],
  );

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    setError(null);
    setAuthRequired(false);
    try {
      const [pageRows, deviceRows, sceneRows, settings] = await Promise.all([
        coreApi.pages(),
        coreApi.devices().then(result => result.devices),
        coreApi.scenes().then(result => result.scenes),
        coreApi.settings(),
      ]);
      const normalized = pageRows.map(page => ({
        ...page,
        panels: page.panels ?? [],
        assigned_device_ids: page.assigned_device_ids ?? [],
      }));
      setPages(normalized);
      setDevices(deviceRows);
      setScenes(sceneRows);
      setPlaylistPageId(String((settings as unknown as Record<string, unknown>).playlist_selection_page_id ?? ''));
      setSelectedId(current => {
        const wanted = preferredId ?? current;
        return normalized.some(page => page.id === wanted) ? wanted : normalized[0]?.id ?? null;
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthRequired(true);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function mutate(action: () => Promise<unknown>, preferredId?: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load(preferredId);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthRequired(true);
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveName(name: string) {
    const clean = name.trim();
    if (!clean) throw new Error('Page name is required.');
    let newId: string | undefined;
    const ok = await mutate(async () => {
      if (nameDialog === 'create') {
        const created = await coreApi.createPage(clean);
        newId = created.id;
      } else if (selected) {
        await coreApi.renamePage(selected.id, clean);
        newId = selected.id;
      }
    }, newId ?? selected?.id);
    if (ok) {
      setNameDialog(null);
      if (newId) await load(newId);
    }
  }

  async function removePage() {
    if (!selected || !confirm(`Delete page "${selected.name}" and all its WebViews?`)) return;
    const ok = await mutate(() => coreApi.deletePage(selected.id));
    if (ok) setSelectedId(null);
  }

  async function savePanel(draft: PanelDraft) {
    if (!selected) return;
    if (!draft.name.trim()) throw new Error('Name is required.');
    if (draft.content_type === 'url' && !draft.url?.trim()) throw new Error('URL is required.');
    if (draft.content_type === 'scene' && !draft.scene_id) throw new Error('Scene is required.');
    const values = [draft.x, draft.y, draft.w, draft.h];
    if (values.some(value => !Number.isFinite(value) || value < 0 || value > 100) || draft.w <= 0 || draft.h <= 0) {
      throw new Error('Position and size must be valid percentages between 0 and 100.');
    }
    if (draft.x + draft.w > 100 || draft.y + draft.h > 100) {
      throw new Error('The WebView must fit within the 100% × 100% canvas.');
    }
    const panel = {
      ...draft,
      name: draft.name.trim(),
      url: draft.content_type === 'url' ? draft.url?.trim() ?? '' : null,
      scene_id: draft.content_type === 'scene' ? draft.scene_id : null,
    };
    const ok = await mutate(
      () => panelDialog === 'new'
        ? coreApi.createPagePanel(selected.id, panel)
        : coreApi.updatePagePanel(selected.id, (panelDialog as PagePanel).id, panel),
      selected.id,
    );
    if (ok) setPanelDialog(null);
  }

  async function removePanel(panel: PagePanel) {
    if (!selected || !confirm(`Delete WebView "${panel.name}"?`)) return;
    await mutate(() => coreApi.deletePagePanel(selected.id, panel.id), selected.id);
  }

  async function deviceAction(kind: 'assign' | 'unassign' | 'force') {
    if (!selected || !deviceId) return;
    const calls = {
      assign: () => coreApi.assignPage(selected.id, deviceId),
      unassign: () => coreApi.unassignPage(selected.id, deviceId),
      force: () => coreApi.forceDisplayPage(selected.id, deviceId),
    };
    await mutate(calls[kind], selected.id);
  }

  const assignedDevices = selected?.assigned_device_ids
    .map(id => devices.find(device => device.id === id) ?? { id, name: id, status: 'unknown' }) ?? [];
  const selectedAssigned = !!selected?.assigned_device_ids.includes(deviceId);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Pages"
        subtitle="Manage multi-WebView layouts and Core device assignments"
        onRefresh={() => load()}
        loading={loading}
        actions={<Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setNameDialog('create')} disabled={busy}>New page</Button>}
      />
      <PageBody>
        <Stack spacing={2} sx={{ maxWidth: 1280, mx: 'auto' }}>
          {authRequired && <Alert severity="warning">Admin login is required to manage pages.</Alert>}
          {error && <ErrorBanner error={error} onRetry={() => load()} />}
          {loading && pages.length === 0 ? <LoadingBox /> : (
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'flex-start' }}>
              <Paper sx={{ width: { xs: '100%', md: 260 }, flexShrink: 0, overflow: 'hidden' }}>
                <Box sx={{ p: 2 }}><Typography variant="subtitle2">Pages ({pages.length})</Typography></Box>
                <Divider />
                <List dense disablePadding>
                  {pages.map(page => (
                    <ListItemButton key={page.id} selected={page.id === selectedId} onClick={() => { setSelectedId(page.id); setDeviceId(''); }}>
                      <ListItemText primary={page.name} secondary={`${page.panels.length} WebView${page.panels.length === 1 ? '' : 's'}`} />
                    </ListItemButton>
                  ))}
                  {pages.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No pages yet.</Typography>}
                </List>
              </Paper>

              {selected ? (
                <Stack spacing={2} sx={{ flex: 1, minWidth: 0, width: '100%' }}>
                  <Paper sx={{ p: 2 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="h6" noWrap>{selected.name}</Typography>
                        <Typography variant="caption" color="text.secondary">{selected.id}</Typography>
                        {playlistPageId === selected.id && <Chip size="small" color="secondary" label="Playlist selection page" sx={{ ml: 1 }} />}
                      </Box>
                      <Tooltip title="Rename page"><IconButton size="small" onClick={() => setNameDialog('rename')}><EditIcon /></IconButton></Tooltip>
                      <Tooltip title="Delete page"><IconButton size="small" color="error" onClick={removePage}><DeleteIcon /></IconButton></Tooltip>
                    </Stack>
                  </Paper>

                  <Paper sx={{ p: 2 }}>
                    <Stack direction="row" sx={{ alignItems: 'center', mb: 1.5 }}>
                      <Box sx={{ flex: 1 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Layout preview</Typography>
                        <Typography variant="caption" color="text.secondary">16:9 screen · up to five tiled or layered panels</Typography>
                      </Box>
                      <Button size="small" startIcon={<AddIcon />} variant="outlined" disabled={selected.panels.length >= 5 || busy} onClick={() => setPanelDialog('new')}>Add panel</Button>
                    </Stack>
                    <Box sx={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', bgcolor: '#090912', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
                      {selected.panels.map((panel, index) => (
                        <Box key={panel.id} onClick={() => setPanelDialog(panel)} sx={{
                          position: 'absolute', left: `${panel.x}%`, top: `${panel.y}%`, width: `${panel.w}%`, height: `${panel.h}%`,
                          zIndex: panel.z_index, opacity: panel.opacity, display: panel.visible ? 'block' : 'none',
                          border: 1, borderColor: 'primary.main', bgcolor: 'rgba(108,99,255,0.18)', p: { xs: 0.5, sm: 1 }, cursor: 'pointer', overflow: 'hidden',
                        }}>
                          <Typography variant="caption" sx={{ fontWeight: 700 }}>{index + 1}. {panel.name}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                            {panel.content_type === 'scene'
                              ? `Scene: ${scenes.find(scene => scene.id === panel.scene_id)?.name ?? panel.scene_id}`
                              : panel.url}
                          </Typography>
                        </Box>
                      ))}
                      {selected.panels.length === 0 && <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}><WebIcon color="disabled" /><Typography variant="body2" color="text.secondary">Add a panel to begin</Typography></Stack>}
                    </Box>
                    <Stack spacing={1} sx={{ mt: 1.5 }}>
                      {selected.panels.map(panel => (
                        <Stack key={panel.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Typography variant="body2" sx={{ minWidth: 100, fontWeight: 600 }}>{panel.name}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>
                            {panel.content_type === 'scene' ? `Scene ${panel.scene_id}` : panel.url} · {panel.x}, {panel.y}, {panel.w}, {panel.h}% · layer {panel.z_index}
                          </Typography>
                          <IconButton size="small" onClick={() => setPanelDialog(panel)}><EditIcon fontSize="small" /></IconButton>
                          <IconButton size="small" color="error" onClick={() => removePanel(panel)}><DeleteIcon fontSize="small" /></IconButton>
                        </Stack>
                      ))}
                    </Stack>
                  </Paper>

                  <Paper sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Device assignment</Typography>
                    <Typography variant="caption" color="text.secondary">Assign persistently or temporarily force this page onto a Core device.</Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2, alignItems: { sm: 'center' } }}>
                      <FormControl size="small" sx={{ minWidth: 240, flex: 1 }}>
                        <InputLabel>Display device</InputLabel>
                        <Select label="Display device" value={deviceId} onChange={event => setDeviceId(event.target.value)}>
                          {availableDevices.map(device => <MenuItem key={device.id} value={device.id}>{device.name} · {device.architecture} · {device.authority_mode} · {device.status}</MenuItem>)}
                        </Select>
                      </FormControl>
                      <Button size="small" variant="contained" startIcon={<LinkIcon />} disabled={!deviceId || selectedAssigned || busy} onClick={() => deviceAction('assign')}>Assign</Button>
                      <Button size="small" startIcon={<LinkOffIcon />} disabled={!deviceId || !selectedAssigned || busy} onClick={() => deviceAction('unassign')}>Unassign</Button>
                      <Button size="small" variant="outlined" startIcon={<PlayArrowIcon />} disabled={!deviceId || busy} onClick={() => deviceAction('force')}>Force display now</Button>
                    </Stack>
                    {availableDevices.length === 0 && <Alert severity="info" sx={{ mt: 2 }}>No display devices are registered with Core.</Alert>}
                    <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', gap: 1 }}>
                      {assignedDevices.length === 0 ? <Typography variant="body2" color="text.secondary">No persistent assignments.</Typography> : assignedDevices.map(device => (
                        <Chip key={device.id} label={`${device.name} · ${device.status}`} color={device.status === 'online' ? 'success' : 'default'} variant="outlined" />
                      ))}
                    </Stack>
                  </Paper>
                </Stack>
              ) : pages.length > 0 ? <Paper sx={{ p: 3, flex: 1 }}><Typography color="text.secondary">Select a page to edit it.</Typography></Paper> : null}
            </Stack>
          )}
        </Stack>
      </PageBody>

      <NameDialog open={nameDialog !== null} title={nameDialog === 'create' ? 'New page' : 'Rename page'} initialName={nameDialog === 'rename' ? selected?.name ?? '' : ''} busy={busy} onClose={() => setNameDialog(null)} onSave={saveName} />
      <PanelDialog panel={panelDialog} scenes={scenes} busy={busy} onClose={() => setPanelDialog(null)} onSave={savePanel} />
    </Box>
  );
}

function NameDialog({ open, title, initialName, busy, onClose, onSave }: { open: boolean; title: string; initialName: string; busy: boolean; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(initialName); setError(null); } }, [open, initialName]);
  async function submit() { try { setError(null); await onSave(name); } catch (err) { setError(errorMessage(err)); } }
  return <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth><DialogTitle>{title}</DialogTitle><DialogContent><TextField autoFocus fullWidth size="small" label="Page name" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void submit(); }} sx={{ mt: 1 }} />{error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}</DialogContent><DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={busy || !name.trim()} onClick={submit}>Save</Button></DialogActions></Dialog>;
}

function PanelDialog({ panel, scenes, busy, onClose, onSave }: { panel: PagePanel | 'new' | null; scenes: SceneRecord[]; busy: boolean; onClose: () => void; onSave: (draft: PanelDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<PanelDraft>(EMPTY_PANEL);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (panel) {
      setDraft(panel === 'new' ? EMPTY_PANEL : {
        name: panel.name, content_type: panel.content_type, url: panel.url,
        scene_id: panel.scene_id, x: panel.x, y: panel.y, w: panel.w, h: panel.h,
        view_id: panel.view_id, z_index: panel.z_index, visible: panel.visible, opacity: panel.opacity,
      });
      setError(null);
    }
  }, [panel]);
  const setNumber = (key: 'x' | 'y' | 'w' | 'h', value: string) => setDraft(current => ({ ...current, [key]: Number(value) }));
  async function submit() { try { setError(null); await onSave(draft); } catch (err) { setError(errorMessage(err)); } }
  return <Dialog open={panel !== null} onClose={onClose} maxWidth="sm" fullWidth><DialogTitle>{panel === 'new' ? 'Add panel' : 'Edit panel'}</DialogTitle><DialogContent><Stack spacing={2} sx={{ mt: 1 }}><TextField size="small" label="Name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /><FormControl size="small"><InputLabel>Content</InputLabel><Select label="Content" value={draft.content_type} onChange={event => setDraft(current => ({ ...current, content_type: event.target.value as 'url' | 'scene' }))}><MenuItem value="url">Internal or external URL</MenuItem><MenuItem value="scene">Scene</MenuItem></Select></FormControl>{draft.content_type === 'url' ? <TextField size="small" label="URL" type="url" value={draft.url ?? ''} onChange={event => setDraft(current => ({ ...current, url: event.target.value }))} helperText="Full http:// or https:// URL loaded by this panel" /> : <FormControl size="small"><InputLabel>Scene</InputLabel><Select label="Scene" value={draft.scene_id ?? ''} onChange={event => setDraft(current => ({ ...current, scene_id: event.target.value }))}>{scenes.filter(scene => scene.status === 'published').map(scene => <MenuItem key={scene.id} value={scene.id}>{scene.name} · revision {scene.revision}</MenuItem>)}</Select></FormControl>}<Stack direction="row" spacing={1}>{(['x', 'y', 'w', 'h'] as const).map(key => <TextField key={key} size="small" label={`${key.toUpperCase()} %`} type="number" value={draft[key]} onChange={event => setNumber(key, event.target.value)} slotProps={{ htmlInput: { min: key === 'w' || key === 'h' ? 1 : 0, max: 100 } }} />)}</Stack><Stack direction="row" spacing={1}><TextField size="small" label="Layer" type="number" value={draft.z_index} onChange={event => setDraft(current => ({ ...current, z_index: Number(event.target.value) }))} /><TextField size="small" label="Opacity" type="number" value={draft.opacity} onChange={event => setDraft(current => ({ ...current, opacity: Number(event.target.value) }))} slotProps={{ htmlInput: { min: 0, max: 1, step: 0.05 } }} /></Stack>{error && <Alert severity="error">{error}</Alert>}</Stack></DialogContent><DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={busy} onClick={submit}>Save</Button></DialogActions></Dialog>;
}
