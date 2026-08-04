import { useCallback, useEffect, useState } from 'react';
import {
  Box, Button, Chip, CircularProgress, IconButton, Paper, Stack,
  Switch, Table, TableBody, TableCell, TableHead, TableRow,
  Tooltip, Typography, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, Alert,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import { useNavigate } from 'react-router-dom';
import { coreApi, type FlowRow } from '../api/client';

export default function FlowsListPage() {
  const navigate = useNavigate();
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await coreApi.listFlows();
      setFlows(res.flows);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (flow: FlowRow) => {
    try {
      await coreApi.setFlowEnabled(flow.id, !flow.enabled);
      setFlows(f => f.map(r => r.id === flow.id ? { ...r, enabled: !r.enabled } : r));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this automation flow?')) return;
    try {
      await coreApi.deleteFlow(id);
      setFlows(f => f.filter(r => r.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRun = async (id: string, name: string) => {
    setRunningId(id);
    try {
      const res = await coreApi.executeFlow(id);
      setRunResult(`Started "${name}" — execution ${res.executionId.slice(0, 8)}…`);
    } catch (e) {
      setRunResult(`Error: ${String(e)}`);
    } finally {
      setRunningId(null);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const flow = await coreApi.createFlow({
        schemaVersion: 1,
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        nodes: [],
        edges: [],
      });
      setCreateOpen(false);
      setNewName('');
      setNewDesc('');
      navigate(`/flows/${flow.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1100, mx: 'auto' }}>
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 3 }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1.5 }}>
          <AccountTreeIcon sx={{ color: 'primary.main' }} />
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Automations</Typography>
          <Chip label={`${flows.length} flows`} size="small" />
        </Stack>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          New Flow
        </Button>
      </Stack>

      {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>{error}</Alert>}
      {runResult && <Alert severity="info" onClose={() => setRunResult(null)} sx={{ mb: 2 }}>{runResult}</Alert>}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 6 }}><CircularProgress /></Box>
      ) : flows.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <AccountTreeIcon sx={{ fontSize: 56, color: 'text.disabled', mb: 2 }} />
          <Typography sx={{ color: "text.secondary" }}>No automation flows yet.</Typography>
          <Typography variant="body2" sx={{ color: "text.disabled", mt: 1 }}>
            Create a flow to automate actions with a visual Node-RED style editor.
          </Typography>
          <Button variant="outlined" sx={{ mt: 3 }} startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
            Create your first flow
          </Button>
        </Paper>
      ) : (
        <Paper>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="center">Nodes</TableCell>
                <TableCell align="center">Enabled</TableCell>
                <TableCell align="center">Updated</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {flows.map(flow => (
                <TableRow key={flow.id} hover>
                  <TableCell>
                    <Typography
                      sx={{
                      fontWeight: 600,
                       cursor: 'pointer', '&:hover': { color: 'primary.main' } }}
                      onClick={() => navigate(`/flows/${flow.id}`)}
                    >
                      {flow.name}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', maxWidth: 280 }}>
                    {flow.description ?? '—'}
                  </TableCell>
                  <TableCell align="center">
                    <Chip label={flow.definition?.nodes?.length ?? 0} size="small" />
                  </TableCell>
                  <TableCell align="center">
                    <Switch
                      checked={flow.enabled}
                      size="small"
                      onChange={() => handleToggle(flow)}
                      color="success"
                    />
                  </TableCell>
                  <TableCell align="center" sx={{ color: 'text.secondary', fontSize: '0.75rem' }}>
                    {new Date(flow.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
                      <Tooltip title="Run now">
                        <span>
                          <IconButton
                            size="small"
                            disabled={runningId === flow.id}
                            onClick={() => handleRun(flow.id, flow.name)}
                          >
                            {runningId === flow.id ? <CircularProgress size={16} /> : <PlayArrowIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Edit flow">
                        <IconButton size="small" onClick={() => navigate(`/flows/${flow.id}`)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" color="error" onClick={() => handleDelete(flow.id)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>New Automation Flow</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 2, mt: 1 }}>
            <TextField
              label="Flow name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              autoFocus
              placeholder="e.g. Morning Routine, Movie Night"
              fullWidth
            />
            <TextField
              label="Description (optional)"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              multiline
              rows={2}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!newName.trim() || creating}
            onClick={handleCreate}
          >
            {creating ? 'Creating…' : 'Create & Edit'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
