/**
 * ScenesPage — scene registry with create / edit / publish / rollback / assign.
 *
 * Scene manifests are JSON. Editing happens in a textarea (JSON editor). The
 * visual editor lives at /editor and can save into a scene via this API.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  Box, Stack, Typography, Paper, Button, Chip, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, IconButton, Tooltip, Divider, Alert,
  Select, MenuItem, InputLabel, FormControl,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import PublishIcon from '@mui/icons-material/Publish';
import RollbackIcon from '@mui/icons-material/Undo';
import EditIcon from '@mui/icons-material/Edit';
import CodeIcon from '@mui/icons-material/Code';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import HistoryIcon from '@mui/icons-material/History';
import AssignIcon from '@mui/icons-material/Link';
import { useNavigate } from 'react-router-dom';
import { coreApi, ApiError, type SceneRecord, type DeviceRow, type SceneRevisionRecord } from '../api/client';
import { PageHeader, PageBody, LoadingBox, ErrorBanner, fmtRelative } from '../components/ui';

export default function ScenesPage() {
  const navigate = useNavigate();
  const [scenes, setScenes] = useState<SceneRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SceneRecord | null>(null);
  const [assigning, setAssigning] = useState<SceneRecord | null>(null);
  const [revisions, setRevisions] = useState<SceneRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, d] = await Promise.all([
        coreApi.scenes().then(r => r.scenes).catch((e) => {
          if (e instanceof ApiError && e.status === 401) { setAuthRequired(true); return []; }
          throw e;
        }),
        coreApi.devices().then(r => r.devices).catch(() => []),
      ]);
      setScenes(s);
      setDevices(d);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function publish(scene: SceneRecord) {
    try { await coreApi.publishScene(scene.id); load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function rollback(scene: SceneRecord) {
    if (!confirm(`Rollback scene "${scene.name}" to the previous revision?`)) return;
    try { await coreApi.rollbackScene(scene.id); load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function createScene(name: string, manifestText: string) {
    let manifest: unknown = {};
    try { manifest = JSON.parse(manifestText || '{}'); }
    catch { throw new Error('Manifest is not valid JSON'); }
    await coreApi.createScene(name, manifest);
    setCreateOpen(false);
    load();
  }

  async function saveEdit(scene: SceneRecord, manifestText: string) {
    let manifest: unknown = {};
    try { manifest = JSON.parse(manifestText || '{}'); }
    catch { throw new Error('Manifest is not valid JSON'); }
    await coreApi.stageScene(scene.id, manifest);
    setEditing(null);
    load();
  }

  async function assign(scene: SceneRecord, deviceId: string) {
    await coreApi.assignScene(scene.id, deviceId);
    setAssigning(null);
    load();
  }

  async function remove(scene: SceneRecord) {
    if (!confirm(`Delete scene "${scene.name}" and all of its revisions?\n\nAny device assignments and panel references will also be removed.`)) return;
    try {
      await coreApi.deleteScene(scene.id, true);
      if (editing?.id === scene.id) setEditing(null);
      if (revisions?.id === scene.id) setRevisions(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Scenes"
        subtitle="Display layouts published to Edge devices"
        onRefresh={load}
        loading={loading}
        actions={
          <>
            <Button size="small" variant="outlined" onClick={() => navigate('/editor')} sx={{ textTransform: 'none', mr: 1 }}>
              Open visual editor
            </Button>
            <Button size="small" variant="contained" startIcon={<AddIcon fontSize="small" />} onClick={() => setCreateOpen(true)} sx={{ textTransform: 'none' }}>
              New scene
            </Button>
          </>
        }
      />
      <PageBody>
        <Stack spacing={3} sx={{ maxWidth: 1100, mx: 'auto' }}>
          {authRequired && (
            <Alert severity="warning" sx={{ bgcolor: 'rgba(253,214,99,0.1)' }}>
              Admin login required to manage scenes.
            </Alert>
          )}
          {error && <ErrorBanner error={error} onRetry={load} />}
          {loading ? <LoadingBox /> : (
            <Paper sx={{ p: 0, overflow: 'hidden' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell>Revision</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Created</TableCell>
                      <TableCell>Published</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {scenes.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} sx={{ color: 'text.secondary', py: 3 }}>
                          No scenes yet. Use the visual editor or "New scene" to create one.
                        </TableCell>
                      </TableRow>
                    )}
                    {scenes.map(s => (
                      <TableRow key={s.id} hover>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>{s.name}</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 10 }}>{s.id}</Typography>
                        </TableCell>
                        <TableCell>rev {s.revision}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={s.status}
                            color={s.status === 'published' ? 'success' : s.status === 'rolled_back' ? 'default' : 'warning'}
                            variant="outlined"
                            sx={{ fontSize: 10 }}
                          />
                        </TableCell>
                        <TableCell><Typography variant="caption">{fmtRelative(s.createdAt)}</Typography></TableCell>
                        <TableCell><Typography variant="caption">{fmtRelative(s.publishedAt)}</Typography></TableCell>
                        <TableCell align="right">
                          <Tooltip title="Open in visual editor"><IconButton size="small" onClick={() => navigate(`/editor?scene=${encodeURIComponent(s.id)}`)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                          <Tooltip title="Edit raw manifest JSON"><IconButton size="small" onClick={() => setEditing(s)}><CodeIcon fontSize="small" /></IconButton></Tooltip>
                          <Tooltip title="Publish"><IconButton size="small" onClick={() => publish(s)} disabled={s.status === 'published'}><PublishIcon fontSize="small" /></IconButton></Tooltip>
                          <Tooltip title="Rollback"><IconButton size="small" onClick={() => rollback(s)} disabled={s.status !== 'published'}><RollbackIcon fontSize="small" /></IconButton></Tooltip>
                          <Tooltip title="Assign to device"><IconButton size="small" onClick={() => setAssigning(s)}><AssignIcon fontSize="small" /></IconButton></Tooltip>
                          <Tooltip title="Revisions"><IconButton size="small" onClick={() => setRevisions(s)}><HistoryIcon fontSize="small" /></IconButton></Tooltip>
                          <Tooltip title="Delete scene"><IconButton size="small" color="error" onClick={() => remove(s)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          )}
        </Stack>
      </PageBody>

      {/* Create dialog */}
      <ManifestDialog
        open={createOpen}
        title="New scene"
        initialName=""
        initialManifest='{\n  "widgets": []\n}'
        onClose={() => setCreateOpen(false)}
        onSave={createScene}
      />

      {/* Edit dialog */}
      <ManifestDialog
        open={!!editing}
        title={`Edit — ${editing?.name ?? ''}`}
        initialName={editing?.name ?? ''}
        initialManifest={JSON.stringify(editing?.manifest ?? {}, null, 2)}
        readOnlyName
        onClose={() => setEditing(null)}
        onSave={async (_name, manifest) => { if (editing) await saveEdit(editing, manifest); }}
      />

      {/* Assign dialog */}
      <Dialog open={!!assigning} onClose={() => setAssigning(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Assign scene to device</DialogTitle>
        <DialogContent>
          <FormControl fullWidth sx={{ mt: 1 }}>
            <InputLabel>Device</InputLabel>
            <Select
              label="Device"
              defaultValue=""
              onChange={(e) => assigning && assign(assigning, e.target.value)}
            >
              <MenuItem value="" disabled>Select a device…</MenuItem>
              {devices.map(d => (
                <MenuItem key={d.id} value={d.id}>{d.name} ({d.architecture || '—'})</MenuItem>
              ))}
            </Select>
          </FormControl>
          {devices.length === 0 && <Alert severity="info" sx={{ mt: 2, bgcolor: 'rgba(108,99,255,0.1)' }}>No devices registered.</Alert>}
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setAssigning(null)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      {/* Revisions dialog */}
      <RevisionsDialog scene={revisions} onClose={() => setRevisions(null)} />
    </Box>
  );
}

function ManifestDialog({
  open, title, initialName, initialManifest, readOnlyName, onClose, onSave,
}: {
  open: boolean;
  title: string;
  initialName: string;
  initialManifest: string;
  readOnlyName?: boolean;
  onClose: () => void;
  onSave: (name: string, manifest: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [manifest, setManifest] = useState(initialManifest);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(initialName); setManifest(initialManifest); setErr(null); }
  }, [open, initialName, initialManifest]);

  async function submit() {
    setBusy(true); setErr(null);
    try { await onSave(name, manifest); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Scene name"
            value={name}
            onChange={e => setName(e.target.value)}
            size="small"
            fullWidth
            disabled={readOnlyName}
          />
          <TextField
            label="Manifest (JSON)"
            value={manifest}
            onChange={e => setManifest(e.target.value)}
            multiline
            minRows={12}
            maxRows={24}
            fullWidth
            slotProps={{ htmlInput: { sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 12 } } }}
          />
          {err && <Alert severity="error" sx={{ bgcolor: 'rgba(242,139,130,0.1)' }}>{err}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Cancel</Button>
        <Button size="small" variant="contained" onClick={submit} disabled={busy}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

function RevisionsDialog({ scene, onClose }: { scene: SceneRecord | null; onClose: () => void }) {
  const [revisions, setRevisions] = useState<SceneRevisionRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!scene) { setRevisions([]); return; }
    setLoading(true);
    coreApi.sceneRevisions(scene.id)
      .then(r => setRevisions(r.revisions))
      .catch(() => setRevisions([]))
      .finally(() => setLoading(false));
  }, [scene]);

  return (
    <Dialog open={!!scene} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Revisions — {scene?.name}</DialogTitle>
      <DialogContent>
        {loading ? <LoadingBox /> : revisions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">No staged revisions.</Typography>
        ) : (
          <Stack spacing={1} divider={<Divider />}>
            {revisions.map(r => (
              <Box key={r.id}>
                <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>rev {r.revision}</Typography>
                  <Chip size="small" label={r.status} variant="outlined" sx={{ fontSize: 10 }} />
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{fmtRelative(r.createdAt)}</Typography>
                </Stack>
                <Box sx={{
                  mt: 1, p: 1, bgcolor: '#0a0a12', borderRadius: 1,
                  fontFamily: 'monospace', fontSize: 11, maxHeight: 160, overflow: 'auto',
                  whiteSpace: 'pre',
                }}>
                  {JSON.stringify(r.manifest, null, 2)}
                </Box>
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
