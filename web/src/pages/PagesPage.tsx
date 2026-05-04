/**
 * PagesPage — named display layouts with one or more panels (webviews).
 *
 * Each panel is a native WebviewWindow on the kiosk, positioned by percentage
 * (x/y/w/h 0-100) and pointing to a canvas-ui-hacs view or a raw URL.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Paper, List, ListItemButton, ListItemText,
  ListItemSecondaryAction, IconButton, Tooltip, Button, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions,
  CircularProgress, Alert, Divider, Stack, Chip,
  Table, TableBody, TableCell, TableHead, TableRow,
  InputAdornment,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import SendIcon from '@mui/icons-material/Send';
import WebAssetIcon from '@mui/icons-material/WebAsset';
import { pagesApi, type PanelCreate } from '../api/client';
import type { Page, PagePanel } from '../types';

// ── Panel colours for visual preview ─────────────────────────────────────────
const PANEL_COLORS = ['#1976d2', '#2e7d32', '#c62828', '#6a1b9a', '#e65100', '#00695c'];

// ── Panel layout preview ──────────────────────────────────────────────────────
function LayoutPreview({ panels }: { panels: PagePanel[] }) {
  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16/9',
        bgcolor: '#111',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      {panels.length === 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <Typography variant="caption" color="text.disabled">No panels — add one below</Typography>
        </Box>
      )}
      {panels.map((p, i) => (
        <Box
          key={p.id}
          sx={{
            position: 'absolute',
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: `${p.w}%`,
            height: `${p.h}%`,
            bgcolor: PANEL_COLORS[i % PANEL_COLORS.length] + '33',
            border: `2px solid ${PANEL_COLORS[i % PANEL_COLORS.length]}`,
            borderRadius: 0.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          <Typography variant="caption" sx={{ fontSize: 9, color: '#fff', textAlign: 'center', px: 0.5 }} noWrap>
            {p.name}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

// ── Panel dialog (add / edit) ─────────────────────────────────────────────────
interface PanelDialogProps {
  open: boolean;
  initial: Partial<PagePanel> | null;
  onClose: () => void;
  onSave: (data: PanelCreate) => Promise<void>;
}

function PanelDialog({ open, initial, onClose, onSave }: PanelDialogProps) {
  const [name, setName] = useState('');
  const [viewId, setViewId] = useState('');
  const [url, setUrl] = useState('');
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [w, setW] = useState(100);
  const [h, setH] = useState(100);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setViewId(initial?.view_id ?? '');
      setUrl(initial?.url ?? '');
      setX(initial?.x ?? 0);
      setY(initial?.y ?? 0);
      setW(initial?.w ?? 100);
      setH(initial?.h ?? 100);
    }
  }, [open, initial]);

  const handle = async () => {
    setSaving(true);
    try {
      await onSave({
        name: name.trim() || 'Panel',
        view_id: viewId.trim() || null,
        url: url.trim() || null,
        x, y, w, h,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{initial?.id ? 'Edit Panel' : 'Add Panel'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField label="Panel Name" value={name} onChange={e => setName(e.target.value)} fullWidth size="small" />
          <Divider><Typography variant="caption" color="text.secondary">Content (view or URL)</Typography></Divider>
          <TextField
            label="Canvas View ID"
            value={viewId}
            onChange={e => setViewId(e.target.value)}
            fullWidth size="small"
            helperText="canvas-ui-hacs view slug → loads /canvas-kiosk#<id>"
            placeholder="e.g. main_dashboard"
          />
          <TextField
            label="Raw URL (overrides view)"
            value={url}
            onChange={e => setUrl(e.target.value)}
            fullWidth size="small"
            placeholder="https://..."
            helperText="Use instead of View ID for arbitrary web pages"
          />
          <Divider><Typography variant="caption" color="text.secondary">Position (% of screen)</Typography></Divider>
          <Stack direction="row" spacing={1}>
            <TextField label="X" type="number" value={x} onChange={e => setX(Number(e.target.value))}
              size="small"
              slotProps={{ htmlInput: { min: 0, max: 100 }, input: { endAdornment: <InputAdornment position="end">%</InputAdornment> } }} />
            <TextField label="Y" type="number" value={y} onChange={e => setY(Number(e.target.value))}
              size="small"
              slotProps={{ htmlInput: { min: 0, max: 100 }, input: { endAdornment: <InputAdornment position="end">%</InputAdornment> } }} />
            <TextField label="W" type="number" value={w} onChange={e => setW(Number(e.target.value))}
              size="small"
              slotProps={{ htmlInput: { min: 1, max: 100 }, input: { endAdornment: <InputAdornment position="end">%</InputAdornment> } }} />
            <TextField label="H" type="number" value={h} onChange={e => setH(Number(e.target.value))}
              size="small"
              slotProps={{ htmlInput: { min: 1, max: 100 }, input: { endAdornment: <InputAdornment position="end">%</InputAdornment> } }} />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handle} disabled={saving}>
          {initial?.id ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PagesPage() {
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const [newDialog, setNewDialog] = useState(false);
  const [newName, setNewName] = useState('');

  const [panelDialog, setPanelDialog] = useState<{ open: boolean; panel: Partial<PagePanel> | null }>({ open: false, panel: null });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pgs = await pagesApi.list();
      setPages(pgs);
      if (selectedId) {
        const fresh = pgs.find(p => p.id === selectedId);
        if (fresh) setEditName(fresh.name);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { load(); }, [load]);

  const selectedPage = pages.find(p => p.id === selectedId) ?? null;

  const selectPage = (p: Page) => {
    setSelectedId(p.id);
    setEditName(p.name);
  };

  const savePage = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const updated = await pagesApi.update(selectedId, { name: editName.trim() || 'Unnamed' });
      setPages(prev => prev.map(p => p.id === selectedId ? { ...updated, panels: p.panels } : p));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const createPage = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const page = await pagesApi.create({ name: newName.trim() });
      setPages(prev => [...prev, page]);
      setNewDialog(false);
      setNewName('');
      selectPage(page);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const deletePage = async (id: string) => {
    if (!confirm('Delete this page?')) return;
    try {
      await pagesApi.delete(id);
      setPages(prev => prev.filter(p => p.id !== id));
      if (selectedId === id) { setSelectedId(null); setEditName(''); }
    } catch (e: any) {
      setError(e.message);
    }
  };

  const pushPage = async () => {
    if (!selectedId) return;
    try {
      await pagesApi.push(selectedId);
      // No alert needed — the kiosk loads it immediately via WS
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Panel handlers ──────────────────────────────────────────────────────

  const handleAddPanel = () => setPanelDialog({ open: true, panel: null });
  const handleEditPanel = (panel: PagePanel) => setPanelDialog({ open: true, panel });

  const handlePanelSave = async (data: PanelCreate) => {
    if (!selectedId) return;
    try {
      if (panelDialog.panel?.id) {
        // Edit
        const updated = await pagesApi.updatePanel(selectedId, panelDialog.panel.id, data);
        setPages(prev => prev.map(p => p.id === selectedId
          ? { ...p, panels: p.panels.map(pl => pl.id === updated.id ? updated : pl) }
          : p
        ));
      } else {
        // Add
        const created = await pagesApi.addPanel(selectedId, data);
        setPages(prev => prev.map(p => p.id === selectedId
          ? { ...p, panels: [...p.panels, created] }
          : p
        ));
      }
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };

  const deletePanel = async (panel: PagePanel) => {
    if (!selectedId) return;
    if (!confirm(`Delete panel "${panel.name}"?`)) return;
    try {
      await pagesApi.deletePanel(selectedId, panel.id);
      setPages(prev => prev.map(p => p.id === selectedId
        ? { ...p, panels: p.panels.filter(pl => pl.id !== panel.id) }
        : p
      ));
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', bgcolor: 'background.default' }}>
      {/* Top bar */}
      <Box sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Typography variant="h6" sx={{ flexGrow: 1 }}>Pages</Typography>
        <Tooltip title="Refresh"><IconButton onClick={load} size="small"><RefreshIcon /></IconButton></Tooltip>
        <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={() => setNewDialog(true)}>
          New Page
        </Button>
      </Box>

      {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mx: 2, mt: 1 }}>{error}</Alert>}

      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Page list */}
        <Paper square elevation={0} sx={{ width: 240, borderRight: 1, borderColor: 'divider', overflow: 'auto', flexShrink: 0 }}>
          {loading && <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>}
          {!loading && pages.length === 0 && (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">No pages yet.</Typography>
              <Button size="small" onClick={() => setNewDialog(true)} sx={{ mt: 1 }}>Create one</Button>
            </Box>
          )}
          <List dense disablePadding>
            {pages.map(page => (
              <ListItemButton
                key={page.id}
                selected={selectedId === page.id}
                onClick={() => selectPage(page)}
                sx={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
              >
                <ListItemText
                  primary={page.name}
                  secondary={
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
                      <Chip
                        icon={<WebAssetIcon sx={{ fontSize: '10px !important' }} />}
                        label={`${page.panels?.length ?? 0} panel${page.panels?.length === 1 ? '' : 's'}`}
                        size="small"
                        sx={{ fontSize: 9, height: 18 }}
                      />
                    </Stack>
                  }
                />
                <ListItemSecondaryAction>
                  <Tooltip title="Delete">
                    <IconButton edge="end" size="small" onClick={e => { e.stopPropagation(); deletePage(page.id); }}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </ListItemSecondaryAction>
              </ListItemButton>
            ))}
          </List>
        </Paper>

        {/* Editor */}
        {!selectedPage ? (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography color="text.secondary">Select a page to edit</Typography>
          </Box>
        ) : (
          <Box sx={{ flex: 1, p: 3, overflow: 'auto' }}>
            <Stack spacing={3} sx={{ maxWidth: 720 }}>

              {/* Name */}
              <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-end' }}>
                <TextField
                  label="Page Name"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  sx={{ flex: 1 }}
                  size="small"
                />
                <Button variant="contained" startIcon={<SaveIcon />} onClick={savePage} disabled={saving} size="small">
                  Save
                </Button>
                <Button
                  variant="outlined"
                  color="secondary"
                  startIcon={<SendIcon />}
                  onClick={pushPage}
                  size="small"
                  title="Set as active page on the kiosk"
                >
                  Activate
                </Button>
              </Stack>

              <Divider />

              {/* Layout preview */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>Layout Preview</Typography>
                <LayoutPreview panels={selectedPage.panels ?? []} />
              </Box>

              {/* Panels */}
              <Box>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                  <Typography variant="subtitle2">
                    Panels ({selectedPage.panels?.length ?? 0})
                  </Typography>
                  <Button size="small" startIcon={<AddIcon />} variant="outlined" onClick={handleAddPanel}>
                    Add Panel
                  </Button>
                </Stack>

                {(selectedPage.panels?.length ?? 0) === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    No panels yet. Add a panel to define what this page displays.
                  </Typography>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>View / URL</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>X Y W H (%)</TableCell>
                        <TableCell align="right" />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(selectedPage.panels ?? []).map((panel, i) => (
                        <TableRow key={panel.id} hover>
                          <TableCell>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                              <Box sx={{
                                width: 10, height: 10, borderRadius: '2px', flexShrink: 0,
                                bgcolor: PANEL_COLORS[i % PANEL_COLORS.length],
                              }} />
                              <Typography variant="body2">{panel.name}</Typography>
                            </Stack>
                          </TableCell>
                          <TableCell>
                            {panel.url ? (
                              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }} noWrap>
                                {panel.url}
                              </Typography>
                            ) : panel.view_id ? (
                              <Chip label={panel.view_id} size="small" sx={{ fontSize: 10 }} />
                            ) : (
                              <Typography variant="caption" color="text.disabled">not set</Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                              {panel.x} {panel.y} {panel.w} {panel.h}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Tooltip title="Edit panel">
                              <IconButton size="small" onClick={() => handleEditPanel(panel)}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Delete panel">
                              <IconButton size="small" onClick={() => deletePanel(panel)}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Box>

              <Typography variant="caption" color="text.disabled">ID: {selectedId}</Typography>
            </Stack>
          </Box>
        )}
      </Box>

      {/* New Page Dialog */}
      <Dialog open={newDialog} onClose={() => setNewDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New Page</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Page Name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            fullWidth
            sx={{ mt: 1 }}
            onKeyDown={e => { if (e.key === 'Enter') createPage(); }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={createPage} disabled={!newName.trim() || saving}>Create</Button>
        </DialogActions>
      </Dialog>

      {/* Panel Add/Edit Dialog */}
      <PanelDialog
        open={panelDialog.open}
        initial={panelDialog.panel}
        onClose={() => setPanelDialog({ open: false, panel: null })}
        onSave={handlePanelSave}
      />
    </Box>
  );
}
