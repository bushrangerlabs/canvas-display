/**
 * FlowEditorPage — visual automation flow editor using React Flow.
 *
 * Left panel:  node palette (drag or click to add)
 * Center:      React Flow canvas with custom nodes + edges
 * Right panel: selected node config inspector
 * Top bar:     flow name edit, save, enable/disable, back
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Button, Chip, CircularProgress, Divider, IconButton, MenuItem,
  Paper, Select, Stack, Switch, TextField, Tooltip, Typography, Alert,
  FormControlLabel, InputLabel, FormControl,
} from '@mui/material';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  MarkerType,
  Handle,
  Position,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate, useParams } from 'react-router-dom';
import { coreApi, type FlowDefinition, type FlowNode, type FlowRow, type FlowNodeType } from '../api/client';
import { randomUUID } from '../utils/uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Node metadata catalog
// ─────────────────────────────────────────────────────────────────────────────

interface NodeMeta {
  label: string;
  color: string;         // header bg
  textColor: string;
  group: 'Triggers' | 'Actions' | 'Logic';
  icon: string;
  configFields: ConfigField[];
}

interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number';
  options?: string[];
  placeholder?: string;
  hint?: string;
}

const NODE_CATALOG: Record<FlowNodeType, NodeMeta> = {
  // ── Triggers ──────────────────────────────────────────────────────────────
  trigger_voice: {
    label: 'Voice Trigger', color: '#c05621', textColor: '#fff',
    group: 'Triggers', icon: '🎙️',
    configFields: [
      { key: 'phrases', label: 'Match phrases (one per line)', type: 'textarea', placeholder: 'good morning\nstart movie night', hint: 'ANY phrase triggers this flow' },
      { key: 'keywords', label: 'ALL keywords (one per line)', type: 'textarea', placeholder: 'movie\nnight', hint: 'ALL keywords must be present' },
    ],
  },
  trigger_schedule: {
    label: 'Schedule', color: '#c05621', textColor: '#fff',
    group: 'Triggers', icon: '⏰',
    configFields: [
      { key: 'cron', label: 'Cron expression', type: 'text', placeholder: '0 7 * * *', hint: 'e.g. 0 7 * * * = 7am daily' },
    ],
  },
  trigger_ha_state: {
    label: 'HA State Change', color: '#c05621', textColor: '#fff',
    group: 'Triggers', icon: '🏠',
    configFields: [
      { key: 'entity_id', label: 'Entity ID', type: 'text', placeholder: 'binary_sensor.motion' },
      { key: 'to_state', label: 'New state (optional)', type: 'text', placeholder: 'on' },
    ],
  },
  trigger_webhook: {
    label: 'Webhook', color: '#c05621', textColor: '#fff',
    group: 'Triggers', icon: '🔗',
    configFields: [
      { key: 'note', label: 'POST to /api/flows/{id}/execute', type: 'text', placeholder: '(auto-configured)' },
    ],
  },
  trigger_manual: {
    label: 'Manual / Button', color: '#c05621', textColor: '#fff',
    group: 'Triggers', icon: '▶️',
    configFields: [],
  },
  trigger_intent: {
    label: 'AI Intent Detected', color: '#c05621', textColor: '#fff',
    group: 'Triggers', icon: '🧠',
    configFields: [
      {
        key: 'intents',
        label: 'Match intents (one per line, blank = any)',
        type: 'textarea',
        placeholder: 'weather_query\nmedia_play\nlight_set',
        hint: 'Fires when AI classifies the request as any of these intents',
      },
      {
        key: 'domains',
        label: 'Limit to domains (one per line, optional)',
        type: 'textarea',
        placeholder: 'media\nlight\nclimate',
        hint: 'Optional extra filter: intent must start with one of these prefixes',
      },
    ],
  },

  // ── Actions ───────────────────────────────────────────────────────────────
  action_ha_service: {
    label: 'HA Service', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🏠',
    configFields: [
      { key: 'domain', label: 'Domain', type: 'text', placeholder: 'light' },
      { key: 'service', label: 'Service', type: 'text', placeholder: 'turn_on' },
      { key: 'entity_id', label: 'Entity ID', type: 'text', placeholder: 'light.living_room or {{variable}}' },
    ],
  },
  action_tts: {
    label: 'Speak (TTS)', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🔊',
    configFields: [
      { key: 'text', label: 'Text to speak', type: 'textarea', placeholder: 'Good morning! {{greeting}}' },
      { key: 'device_id', label: 'Device ID (blank = all)', type: 'text', placeholder: '' },
    ],
  },
  action_scene: {
    label: 'Switch Scene', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🖥️',
    configFields: [
      { key: 'scene', label: 'Scene name', type: 'text', placeholder: 'Movie Night' },
      { key: 'device_id', label: 'Device ID', type: 'text', placeholder: '' },
    ],
  },
  action_delay: {
    label: 'Delay', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '⏳',
    configFields: [
      { key: 'seconds', label: 'Seconds', type: 'number', placeholder: '5' },
    ],
  },
  action_http: {
    label: 'HTTP Request', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🌐',
    configFields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com/api' },
      { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'DELETE'] },
      { key: 'body', label: 'Body (JSON)', type: 'textarea', placeholder: '{"key": "{{value}}"}' },
    ],
  },
  action_set_variable: {
    label: 'Set Variable', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '📦',
    configFields: [
      { key: 'variable', label: 'Variable name', type: 'text', placeholder: 'greeting' },
      { key: 'value', label: 'Value', type: 'text', placeholder: 'Hello World or {{other_var}}' },
    ],
  },
  action_ai_reply: {
    label: 'Ask AI', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🤖',
    configFields: [
      { key: 'prompt', label: 'Prompt', type: 'textarea', placeholder: 'What is the weather like today?' },
      { key: 'result_variable', label: 'Store reply in variable', type: 'text', placeholder: 'ai_reply' },
    ],
  },
  action_knowledge_card: {
    label: 'Show Knowledge Card', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '📚',
    configFields: [
      { key: 'title', label: 'Title', type: 'text', placeholder: '{{topic}}' },
      { key: 'body', label: 'Body', type: 'textarea', placeholder: '{{ai_reply}}' },
      { key: 'device_id', label: 'Device ID (blank = all)', type: 'text' },
    ],
  },

  action_device_command: {
    label: 'Device Command', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '📺',
    configFields: [
      { key: 'device_id', label: 'Device ID (blank = all)', type: 'text', placeholder: 'kitchen-display' },
      { key: 'command', label: 'Command', type: 'select', options: ['navigate', 'overlay_show', 'overlay_hide', 'media_play', 'media_pause', 'media_stop', 'volume_set', 'reload'] },
      { key: 'payload', label: 'Payload (JSON or text)', type: 'textarea', placeholder: '{"scene": "Movie Night"}' },
    ],
  },
  action_log: {
    label: 'Log Message', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '📝',
    configFields: [
      { key: 'message', label: 'Message', type: 'textarea', placeholder: 'Debug: temperature={{temp}}' },
      { key: 'level', label: 'Level', type: 'select', options: ['info', 'warn', 'error'] },
    ],
  },

  // ── Logic ─────────────────────────────────────────────────────────────────
  logic_if_else: {
    label: 'If / Else', color: '#553c9a', textColor: '#fff',
    group: 'Logic', icon: '🔀',
    configFields: [
      { key: 'condition', label: 'Condition', type: 'text', placeholder: 'temperature > 25', hint: 'Supports ==, !=, >, <, >=, <=' },
    ],
  },
  logic_switch: {
    label: 'Switch', color: '#553c9a', textColor: '#fff',
    group: 'Logic', icon: '🔄',
    configFields: [
      { key: 'variable', label: 'Variable to switch on', type: 'text', placeholder: 'room' },
    ],
  },
  logic_for_each: {
    label: 'For Each', color: '#553c9a', textColor: '#fff',
    group: 'Logic', icon: '🔁',
    configFields: [
      { key: 'array_variable', label: 'Array variable', type: 'text', placeholder: 'devices' },
      { key: 'item_variable', label: 'Item variable name', type: 'text', placeholder: 'device' },
    ],
  },
};

const GROUPS: Array<'Triggers' | 'Actions' | 'Logic'> = ['Triggers', 'Actions', 'Logic'];

// ─────────────────────────────────────────────────────────────────────────────
// Custom node component
// ─────────────────────────────────────────────────────────────────────────────

function FlowNodeComponent({ data, selected }: { data: { flowNode: FlowNode }; selected?: boolean }) {
  const fn = data.flowNode;
  const meta = NODE_CATALOG[fn.type];
  const isTrigger = fn.type.startsWith('trigger_');
  const isIfElse = fn.type === 'logic_if_else';

  return (
    <Box
      sx={{
        minWidth: 180,
        maxWidth: 240,
        borderRadius: 2,
        overflow: 'hidden',
        border: selected ? '2px solid #90cdf4' : '2px solid transparent',
        boxShadow: selected ? '0 0 0 3px rgba(99,179,237,0.3)' : '0 2px 8px rgba(0,0,0,0.4)',
      }}
    >
      {/* Input handle — not on triggers */}
      {!isTrigger && (
        <Handle type="target" position={Position.Top} style={{ background: '#718096', width: 10, height: 10 }} />
      )}

      {/* Header */}
      <Box sx={{ bgcolor: meta.color, px: 1.5, py: 0.75, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <span style={{ fontSize: 14 }}>{meta.icon}</span>
        <Typography sx={{ color: meta.textColor, fontSize: '0.72rem', fontWeight: 700, flex: 1 }}>
          {fn.label || meta.label}
        </Typography>
      </Box>

      {/* Body */}
      <Box sx={{ bgcolor: '#1a202c', px: 1.5, py: 1 }}>
        {Object.entries(fn.config).slice(0, 2).map(([k, v]) => (
          v ? (
            <Typography key={k} sx={{ fontSize: '0.68rem', color: '#a0aec0', lineHeight: 1.4 }} noWrap>
              <b style={{ color: '#718096' }}>{k}:</b> {String(v).slice(0, 40)}
            </Typography>
          ) : null
        ))}
        {Object.keys(fn.config).length === 0 && (
          <Typography sx={{ fontSize: '0.68rem', color: '#4a5568' }}>No config</Typography>
        )}
      </Box>

      {/* Output handles */}
      {isIfElse ? (
        <>
          <Handle type="source" id="true" position={Position.Bottom} style={{ background: '#48bb78', left: '30%', width: 10, height: 10 }}>
          </Handle>
          <Handle type="source" id="false" position={Position.Bottom} style={{ background: '#fc8181', left: '70%', width: 10, height: 10 }}>
          </Handle>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} style={{ background: '#718096', width: 10, height: 10 }} />
      )}
    </Box>
  );
}

const NODE_TYPES: NodeTypes = {
  flowNode: FlowNodeComponent,
};

// ─────────────────────────────────────────────────────────────────────────────
// Convert between FlowDefinition and React Flow
// ─────────────────────────────────────────────────────────────────────────────

function defToNodes(def: FlowDefinition): Node[] {
  return def.nodes.map(fn => ({
    id: fn.id,
    type: 'flowNode',
    position: fn.position,
    data: { flowNode: fn },
  }));
}

function defToEdges(def: FlowDefinition): Edge[] {
  return def.edges.map(fe => ({
    id: fe.id,
    source: fe.source,
    sourceHandle: fe.sourceHandle,
    target: fe.target,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4a5568' },
    style: { stroke: '#4a5568', strokeWidth: 2 },
  }));
}

function nodesToDef(rfNodes: Node[], rfEdges: Edge[], meta: { name: string; description?: string }): FlowDefinition {
  return {
    schemaVersion: 1,
    name: meta.name,
    description: meta.description,
    nodes: rfNodes.map(n => (n.data as { flowNode: FlowNode }).flowNode).map(fn => ({
      ...fn,
      position: rfNodes.find(n => n.id === fn.id)!.position,
    })),
    edges: rfEdges.map(e => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? undefined,
      target: e.target,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function FlowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [flow, setFlow] = useState<FlowRow | null>(null);
  const [flowName, setFlowName] = useState('');
  const [flowDesc, setFlowDesc] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);

  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // Load flow
  useEffect(() => {
    if (!id) return;
    coreApi.getFlow(id)
      .then(f => {
        setFlow(f);
        setFlowName(f.name);
        setFlowDesc(f.description ?? '');
        setEnabled(f.enabled);
        setRfNodes(defToNodes(f.definition));
        setRfEdges(defToEdges(f.definition));
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  const onConnect = useCallback((connection: Connection) => {
    setRfEdges(eds => addEdge({
      ...connection,
      id: randomUUID(),
      markerEnd: { type: MarkerType.ArrowClosed, color: '#4a5568' },
      style: { stroke: '#4a5568', strokeWidth: 2 },
    }, eds));
  }, [setRfEdges]);

  const addNode = (type: FlowNodeType) => {
    const fn: FlowNode = {
      id: randomUUID(),
      type,
      position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 },
      label: '',
      config: {},
    };
    setRfNodes(ns => [...ns, { id: fn.id, type: 'flowNode', position: fn.position, data: { flowNode: fn } }]);
  };

  const updateSelectedConfig = (key: string, value: string) => {
    if (!selectedNode) return;
    // Special: 'cases' is stored as a JSON array
    const parsed: unknown = key === 'cases' ? (JSON.parse(value) as unknown) : value;
    const updated = { ...selectedNode, config: { ...selectedNode.config, [key]: parsed } };
    setSelectedNode(updated);
    setRfNodes(ns => ns.map(n =>
      n.id === selectedNode.id
        ? { ...n, data: { flowNode: updated } }
        : n
    ));
  };

  const updateSelectedLabel = (label: string) => {
    if (!selectedNode) return;
    const updated = { ...selectedNode, label };
    setSelectedNode(updated);
    setRfNodes(ns => ns.map(n =>
      n.id === selectedNode.id
        ? { ...n, data: { flowNode: updated } }
        : n
    ));
  };

  const deleteSelectedNode = () => {
    if (!selectedNode) return;
    setRfNodes(ns => ns.filter(n => n.id !== selectedNode.id));
    setRfEdges(es => es.filter(e => e.source !== selectedNode.id && e.target !== selectedNode.id));
    setSelectedNode(null);
  };

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode((node.data as { flowNode: FlowNode }).flowNode);
  }, []);

  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const def = nodesToDef(rfNodes, rfEdges, { name: flowName, description: flowDesc || undefined });
      const updated = await coreApi.updateFlow(id, def);
      setFlow(updated);
      setSaveMsg('Saved!');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!id) return;
    try {
      await coreApi.setFlowEnabled(id, !enabled);
      setEnabled(e => !e);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRun = async () => {
    if (!id) return;
    setRunning(true);
    try {
      await handleSave();
      const res = await coreApi.executeFlow(id);
      setSaveMsg(`Running — execution ${res.executionId.slice(0, 8)}…`);
      setTimeout(() => setSaveMsg(''), 5000);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}><CircularProgress /></Box>;
  if (!flow && !loading) return <Box sx={{ p: 3 }}><Alert severity="error">Flow not found</Alert></Box>;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: '#0d1117' }}>
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1,
        bgcolor: '#161b22', borderBottom: '1px solid #30363d',
      }}>
        <IconButton size="small" sx={{ color: '#8b949e' }} onClick={() => navigate('/flows')}>
          <ArrowBackIcon />
        </IconButton>
        <TextField
          value={flowName}
          onChange={e => setFlowName(e.target.value)}
          variant="standard"
          slotProps={{ input: { disableUnderline: true, style: { fontSize: 16, fontWeight: 700, color: "#e6edf3" } } }}
          sx={{ flex: 1, '& input': { p: 0 } }}
        />
        {saveMsg && <Chip label={saveMsg} size="small" color="success" />}
        {error && <Chip label={error.slice(0, 60)} size="small" color="error" onDelete={() => setError('')} />}
        <FormControlLabel
          control={<Switch checked={enabled} onChange={handleToggleEnabled} size="small" color="success" />}
          label={<Typography sx={{ color: '#8b949e', fontSize: '0.8rem' }}>{enabled ? 'Enabled' : 'Disabled'}</Typography>}
          sx={{ mr: 0 }}
        />
        <Button
          size="small"
          startIcon={running ? <CircularProgress size={14} /> : <PlayArrowIcon />}
          onClick={handleRun}
          disabled={running}
          sx={{ color: '#3fb950', borderColor: '#3fb950' }}
          variant="outlined"
        >
          Run
        </Button>
        <Button
          size="small"
          variant="contained"
          startIcon={saving ? <CircularProgress size={14} /> : <SaveIcon />}
          onClick={handleSave}
          disabled={saving}
        >
          Save
        </Button>
      </Box>

      {/* Main area */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Node palette */}
        <Box sx={{
          width: 200, bgcolor: '#161b22', borderRight: '1px solid #30363d',
          overflowY: 'auto', flexShrink: 0, py: 1,
        }}>
          {GROUPS.map(group => {
            const items = Object.entries(NODE_CATALOG).filter(([, m]) => m.group === group);
            return (
              <Box key={group} sx={{ mb: 1 }}>
                <Typography sx={{ px: 1.5, py: 0.5, fontSize: '0.65rem', color: '#484f58', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
                  {group}
                </Typography>
                {items.map(([type, meta]) => (
                  <Box
                    key={type}
                    onClick={() => addNode(type as FlowNodeType)}
                    sx={{
                      mx: 1, mb: 0.5, px: 1.5, py: 0.75,
                      borderRadius: 1.5,
                      bgcolor: '#1c2128',
                      border: '1px solid #30363d',
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 1,
                      '&:hover': { bgcolor: '#2d333b', borderColor: '#58a6ff' },
                    }}
                  >
                    <span style={{ fontSize: 13 }}>{meta.icon}</span>
                    <Typography sx={{ fontSize: '0.72rem', color: '#cdd9e5' }}>{meta.label}</Typography>
                  </Box>
                ))}
                <Divider sx={{ mx: 1, mt: 1, borderColor: '#21262d' }} />
              </Box>
            );
          })}
        </Box>

        {/* Center: React Flow canvas */}
        <Box ref={reactFlowWrapper} sx={{ flex: 1, position: 'relative' }}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={NODE_TYPES}
            fitView
            colorMode="dark"
            style={{ background: '#0d1117' }}
          >
            <Background color="#21262d" gap={20} />
            <Controls style={{ bottom: 40 }} />
            <MiniMap
              style={{ background: '#161b22', border: '1px solid #30363d' }}
              nodeColor={n => {
                const fn = (n.data as { flowNode: FlowNode })?.flowNode;
                if (!fn) return '#484f58';
                return NODE_CATALOG[fn.type]?.color ?? '#484f58';
              }}
            />
            <Panel position="top-center">
              <Typography sx={{ fontSize: '0.7rem', color: '#484f58' }}>
                Click palette to add nodes · Click node to configure · Drag handles to connect
              </Typography>
            </Panel>
          </ReactFlow>
        </Box>

        {/* Right: Inspector */}
        <Box sx={{
          width: 280, bgcolor: '#161b22', borderLeft: '1px solid #30363d',
          overflowY: 'auto', flexShrink: 0,
        }}>
          {selectedNode ? (
            <Box sx={{ p: 2 }}>
              <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}>
                <Box>
                  <Typography sx={{ fontSize: '0.65rem', color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                    {NODE_CATALOG[selectedNode.type]?.group}
                  </Typography>
                  <Typography sx={{ fontWeight: 700, color: '#e6edf3', fontSize: '0.9rem' }}>
                    {NODE_CATALOG[selectedNode.type]?.label}
                  </Typography>
                </Box>
                <Tooltip title="Delete node">
                  <IconButton size="small" color="error" onClick={deleteSelectedNode}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>

              <TextField
                label="Label (optional)"
                value={selectedNode.label ?? ''}
                onChange={e => updateSelectedLabel(e.target.value)}
                fullWidth size="small"
                sx={{ mb: 2 }}
                placeholder={NODE_CATALOG[selectedNode.type]?.label}
              />

              {NODE_CATALOG[selectedNode.type]?.configFields.map(field => (
                <Box key={field.key} sx={{ mb: 2 }}>
                  {field.type === 'select' ? (
                    <FormControl fullWidth size="small">
                      <InputLabel>{field.label}</InputLabel>
                      <Select
                        value={String(selectedNode.config[field.key] ?? field.options?.[0] ?? '')}
                        label={field.label}
                        onChange={e => updateSelectedConfig(field.key, e.target.value)}
                      >
                        {field.options?.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                      </Select>
                    </FormControl>
                  ) : (
                    <TextField
                      label={field.label}
                      value={String(selectedNode.config[field.key] ?? '')}
                      onChange={e => updateSelectedConfig(field.key, e.target.value)}
                      fullWidth size="small"
                      multiline={field.type === 'textarea'}
                      rows={field.type === 'textarea' ? 3 : undefined}
                      type={field.type === 'number' ? 'number' : 'text'}
                      placeholder={field.placeholder}
                      helperText={field.hint}
                    />
                  )}
                </Box>
              ))}

              {selectedNode.type === 'logic_if_else' && (
                <Paper sx={{ p: 1.5, bgcolor: '#0d1117', border: '1px solid #30363d', borderRadius: 1.5 }}>
                  <Typography sx={{ fontSize: '0.7rem', color: '#8b949e', lineHeight: 1.5 }}>
                    Connect the <b style={{ color: '#48bb78' }}>green</b> bottom-left handle → True path<br />
                    Connect the <b style={{ color: '#fc8181' }}>red</b> bottom-right handle → False path
                  </Typography>
                </Paper>
              )}

              {selectedNode.type === 'logic_switch' && (
                <Box>
                  <Divider sx={{ borderColor: '#30363d', my: 1.5 }} />
                  <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography sx={{ fontSize: '0.75rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Case values
                    </Typography>
                    <IconButton
                      size="small"
                      sx={{ color: '#58a6ff' }}
                      onClick={() => {
                        const current = (selectedNode.config.cases as string[] | undefined) ?? [];
                        updateSelectedConfig('cases', JSON.stringify([...current, '']));
                      }}
                    >
                      <AddIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                  {((selectedNode.config.cases as string[] | undefined) ?? []).map((caseVal, idx) => (
                    <Stack key={idx} direction="row" sx={{ alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                      <TextField
                        value={caseVal}
                        size="small"
                        placeholder={`case ${idx + 1}`}
                        onChange={e => {
                          const current = [...((selectedNode.config.cases as string[] | undefined) ?? [])];
                          current[idx] = e.target.value;
                          updateSelectedConfig('cases', JSON.stringify(current));
                        }}
                        fullWidth
                        sx={{ '& .MuiInputBase-root': { fontSize: '0.75rem' } }}
                      />
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => {
                          const current = [...((selectedNode.config.cases as string[] | undefined) ?? [])];
                          current.splice(idx, 1);
                          updateSelectedConfig('cases', JSON.stringify(current));
                        }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  ))}
                  <Typography sx={{ fontSize: '0.65rem', color: '#484f58', mt: 1, lineHeight: 1.5 }}>
                    Each case value routes to edges whose sourceHandle matches. Draw edges from this node and set their handle to the case value.
                  </Typography>
                </Box>
              )}

              {selectedNode.type === 'trigger_intent' && (
                <Paper sx={{ p: 1.5, bgcolor: '#0d1117', border: '1px solid #30363d', borderRadius: 1.5, mt: 1 }}>
                  <Typography sx={{ fontSize: '0.7rem', color: '#8b949e', mb: 0.5, fontWeight: 600 }}>
                    Available intents
                  </Typography>
                  <Typography sx={{ fontSize: '0.65rem', color: '#484f58', lineHeight: 1.8, fontFamily: 'monospace' }}>
                    {[
                      'light_set', 'lock_set', 'climate_set', 'climate_query',
                      'weather_query', 'device_query',
                      'media_play', 'media_pause', 'media_resume', 'media_stop',
                      'media_next', 'media_select',
                      'scene_activate', 'navigation',
                      'timer_set', 'time_query', 'date_query',
                      'unknown',
                    ].join(' · ')}
                  </Typography>
                  <Typography sx={{ fontSize: '0.65rem', color: '#484f58', mt: 0.5 }}>
                    Intent flows run as side effects — they don't replace the AI's main response.
                    Context variables available: <code>intent</code>, <code>transcript</code>, <code>deviceId</code>, <code>slots</code>
                  </Typography>
                </Paper>
              )}
            </Box>
          ) : (
            <Box sx={{ p: 3,  color: '#484f58', textAlign: 'center', mt: 4 }}>
              <Typography sx={{ fontSize: '0.85rem' }}>Select a node to configure it</Typography>
            </Box>
          )}

          {/* Flow description at bottom of inspector */}
          <Divider sx={{ borderColor: '#21262d', mx: 2 }} />
          <Box sx={{ p: 2 }}>
            <TextField
              label="Flow description"
              value={flowDesc}
              onChange={e => setFlowDesc(e.target.value)}
              fullWidth size="small"
              multiline rows={2}
              sx={{ mt: 1 }}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
