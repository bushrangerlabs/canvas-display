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
  Autocomplete, Box, Button, Checkbox, Chip, CircularProgress, Divider,
  FormControl, FormControlLabel, FormGroup, IconButton, InputLabel, MenuItem,
  Paper, Select, Stack, Switch, TextField, Tooltip, Typography, Alert,
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
import { coreApi, type FlowDefinition, type FlowNode, type FlowRow, type FlowNodeType,
  type HaEntityCatalogueItem, type DeviceRow, type SceneRecord } from '../api/client';
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
  type: 'text' | 'textarea' | 'select' | 'number'
      | 'intent_multiselect'   // checkboxes for known AI intent names
      | 'cron_preset'          // common schedule presets + custom cron input
      | 'entity_picker'        // searchable HA entity autocomplete
      | 'device_picker'        // enrolled display device dropdown
      | 'scene_picker'         // published scene dropdown
      | 'ha_service_picker';   // domain + service combined selector
  options?: string[];
  domain_filter?: string;      // for entity_picker: filter by HA domain (e.g. 'light')
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
      { key: 'cron', label: 'Schedule', type: 'cron_preset', placeholder: '0 7 * * *', hint: 'When to run' },
    ],
  },
  trigger_ha_state: {
    label: 'HA State Change', color: '#c05621', textColor: '#fff',
    group: 'Triggers', icon: '🏠',
    configFields: [
      { key: 'entity_id', label: 'Entity', type: 'entity_picker', placeholder: 'binary_sensor.motion' },
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
        label: 'Match intents (blank = any)',
        type: 'intent_multiselect',
        hint: 'Fires when AI classifies the request as any of these intents',
      },
      {
        key: 'domains',
        label: 'Limit to domains (optional prefix filter)',
        type: 'text',
        placeholder: 'media, light',
        hint: 'Comma-separated — intent must start with one of these',
      },
    ],
  },

  // ── Actions ───────────────────────────────────────────────────────────────
  action_ha_service: {
    label: 'HA Service', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🏠',
    configFields: [
      { key: 'ha_service', label: 'Service', type: 'ha_service_picker', hint: 'domain.service' },
      { key: 'entity_id', label: 'Entity', type: 'entity_picker', placeholder: 'light.living_room or {{variable}}' },
    ],
  },
  action_tts: {
    label: 'Speak (TTS)', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🔊',
    configFields: [
      { key: 'text', label: 'Text to speak', type: 'textarea', placeholder: 'Good morning! {{greeting}}' },
      { key: 'device_id', label: 'Device', type: 'device_picker' },
    ],
  },
  action_scene: {
    label: 'Switch Scene', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '🖥️',
    configFields: [
      { key: 'scene', label: 'Scene', type: 'scene_picker' },
      { key: 'device_id', label: 'Device', type: 'device_picker' },
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
      { key: 'device_id', label: 'Device (blank = all)', type: 'device_picker' },
    ],
  },

  action_device_command: {
    label: 'Device Command', color: '#2b6cb0', textColor: '#fff',
    group: 'Actions', icon: '📺',
    configFields: [
      { key: 'device_id', label: 'Device (blank = all)', type: 'device_picker' },
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

  // Reference data for smart pickers
  const [haEntities, setHaEntities] = useState<HaEntityCatalogueItem[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [scenes, setScenes] = useState<SceneRecord[]>([]);

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

  // Load reference data for pickers
  useEffect(() => {
    coreApi.haEntities().then(r => setHaEntities(r.entities)).catch(() => {/* optional */});
    coreApi.devices().then(r => setDevices(r.devices.filter(d => d.paired))).catch(() => {});
    coreApi.scenes().then(r => setScenes(r.scenes.filter(s => s.status === 'published'))).catch(() => {});
  }, []);

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
    updateSelectedConfigRaw(key, key === 'cases' ? (JSON.parse(value) as unknown) : value);
  };

  const updateSelectedConfigRaw = (key: string, value: unknown) => {
    if (!selectedNode) return;
    const updated = { ...selectedNode, config: { ...selectedNode.config, [key]: value } };
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

              {NODE_CATALOG[selectedNode.type]?.configFields.map(field => {
                const cfgVal = selectedNode.config[field.key];
                const strVal = cfgVal != null ? String(cfgVal) : '';

                // ── intent_multiselect ───────────────────────────────────
                if (field.type === 'intent_multiselect') {
                  const ALL_INTENTS = [
                    'light_set','lock_set','climate_set','climate_query',
                    'weather_query','device_query',
                    'media_play','media_pause','media_resume','media_stop','media_next','media_select',
                    'scene_activate','navigation','timer_set','time_query','date_query','unknown',
                  ];
                  const selected: string[] = Array.isArray(cfgVal) ? cfgVal as string[]
                    : strVal ? strVal.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean) : [];
                  return (
                    <Box key={field.key} sx={{ mb: 2 }}>
                      <Typography sx={{ fontSize: '0.72rem', color: '#8b949e', mb: 0.5 }}>{field.label}</Typography>
                      <Paper sx={{ p: 1, bgcolor: '#0d1117', border: '1px solid #30363d', borderRadius: 1 }}>
                        <FormGroup>
                          {ALL_INTENTS.map(intent => (
                            <FormControlLabel key={intent}
                              sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.72rem', fontFamily: 'monospace', color: '#e6edf3' }, my: -0.5 }}
                              control={
                                <Checkbox
                                  checked={selected.includes(intent)}
                                  size="small"
                                  sx={{ color: '#484f58', '&.Mui-checked': { color: '#58a6ff' }, py: 0.25 }}
                                  onChange={e => {
                                    const next = e.target.checked
                                      ? [...selected, intent]
                                      : selected.filter(i => i !== intent);
                                    updateSelectedConfigRaw(field.key, next);
                                  }}
                                />
                              }
                              label={intent}
                            />
                          ))}
                        </FormGroup>
                        {field.hint && <Typography sx={{ fontSize: '0.62rem', color: '#484f58', mt: 0.5 }}>{field.hint}</Typography>}
                      </Paper>
                    </Box>
                  );
                }

                // ── cron_preset ──────────────────────────────────────────
                if (field.type === 'cron_preset') {
                  const PRESETS = [
                    { label: 'Every minute', value: '* * * * *' },
                    { label: 'Every 5 minutes', value: '*/5 * * * *' },
                    { label: 'Every 15 minutes', value: '*/15 * * * *' },
                    { label: 'Every hour', value: '0 * * * *' },
                    { label: 'Daily at 6am', value: '0 6 * * *' },
                    { label: 'Daily at 7am', value: '0 7 * * *' },
                    { label: 'Daily at 8am', value: '0 8 * * *' },
                    { label: 'Daily at noon', value: '0 12 * * *' },
                    { label: 'Daily at 6pm', value: '0 18 * * *' },
                    { label: 'Daily at 9pm', value: '0 21 * * *' },
                    { label: 'Daily at midnight', value: '0 0 * * *' },
                    { label: 'Weekdays at 7am', value: '0 7 * * 1-5' },
                    { label: 'Weekends at 9am', value: '0 9 * * 0,6' },
                    { label: 'Weekly (Mon 7am)', value: '0 7 * * 1' },
                    { label: 'Custom…', value: '__custom__' },
                  ];
                  const isCustom = strVal && !PRESETS.some(p => p.value === strVal && p.value !== '__custom__');
                  const selectVal = isCustom ? '__custom__' : (strVal || '');
                  return (
                    <Box key={field.key} sx={{ mb: 2 }}>
                      <FormControl fullWidth size="small" sx={{ mb: isCustom ? 1 : 0 }}>
                        <InputLabel sx={{ color: '#8b949e' }}>{field.label}</InputLabel>
                        <Select value={selectVal} label={field.label}
                          onChange={e => {
                            if (e.target.value === '__custom__') updateSelectedConfig(field.key, '');
                            else updateSelectedConfig(field.key, e.target.value);
                          }}
                        >
                          {PRESETS.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
                        </Select>
                      </FormControl>
                      {isCustom && (
                        <TextField label="Cron expression" value={strVal} fullWidth size="small"
                          onChange={e => updateSelectedConfig(field.key, e.target.value)}
                          placeholder="0 7 * * *" helperText="min hour day month weekday"
                        />
                      )}
                    </Box>
                  );
                }

                // ── entity_picker ────────────────────────────────────────
                if (field.type === 'entity_picker') {
                  const filtered = field.domain_filter
                    ? haEntities.filter(e => e.domain === field.domain_filter)
                    : haEntities;
                  const opts = filtered.map(e => ({
                    label: e.friendly_name ? `${e.friendly_name} (${e.entity_id})` : e.entity_id,
                    id: e.entity_id,
                  }));
                  const cur = opts.find(o => o.id === strVal) ?? (strVal ? { label: strVal, id: strVal } : null);
                  return (
                    <Box key={field.key} sx={{ mb: 2 }}>
                      <Autocomplete
                        freeSolo size="small" options={opts}
                        value={cur} inputValue={strVal}
                        getOptionLabel={o => typeof o === 'string' ? o : o.label}
                        onInputChange={(_, v) => updateSelectedConfig(field.key, v)}
                        onChange={(_, v) => updateSelectedConfig(field.key, typeof v === 'string' ? v : (v?.id ?? ''))}
                        renderInput={params => (
                          <TextField {...params} label={field.label} placeholder={field.placeholder ?? 'Search entities…'} helperText={field.hint} />
                        )}
                        renderOption={(props, option) => (
                          <li {...props} key={option.id}>
                            <Box>
                              <Typography variant="body2">{typeof option === 'string' ? option : option.label.split('(')[0].trim()}</Typography>
                              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{typeof option === 'string' ? '' : option.id}</Typography>
                            </Box>
                          </li>
                        )}
                        noOptionsText={haEntities.length === 0 ? 'Loading entities…' : 'No matches'}
                      />
                    </Box>
                  );
                }

                // ── device_picker ────────────────────────────────────────
                if (field.type === 'device_picker') {
                  return (
                    <Box key={field.key} sx={{ mb: 2 }}>
                      <FormControl fullWidth size="small">
                        <InputLabel>{field.label}</InputLabel>
                        <Select value={strVal} label={field.label}
                          onChange={e => updateSelectedConfig(field.key, e.target.value)}
                        >
                          <MenuItem value=""><em>All devices</em></MenuItem>
                          {devices.map(d => (
                            <MenuItem key={d.id} value={d.id}>{d.name || d.id}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Box>
                  );
                }

                // ── scene_picker ─────────────────────────────────────────
                if (field.type === 'scene_picker') {
                  return (
                    <Box key={field.key} sx={{ mb: 2 }}>
                      <FormControl fullWidth size="small">
                        <InputLabel>{field.label}</InputLabel>
                        <Select value={strVal} label={field.label}
                          onChange={e => updateSelectedConfig(field.key, e.target.value)}
                        >
                          <MenuItem value=""><em>Select scene…</em></MenuItem>
                          {scenes.map(s => (
                            <MenuItem key={s.id} value={s.name}>{s.name}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Box>
                  );
                }

                // ── ha_service_picker ────────────────────────────────────
                if (field.type === 'ha_service_picker') {
                  const HA_SERVICES = [
                    'light.turn_on','light.turn_off','light.toggle',
                    'switch.turn_on','switch.turn_off','switch.toggle',
                    'climate.set_temperature','climate.set_hvac_mode',
                    'lock.lock','lock.unlock',
                    'media_player.play_media','media_player.pause','media_player.stop',
                    'media_player.volume_set','media_player.next_track',
                    'scene.turn_on',
                    'script.turn_on',
                    'automation.trigger','automation.turn_on','automation.turn_off',
                    'cover.open_cover','cover.close_cover',
                    'fan.turn_on','fan.turn_off',
                    'notify.notify',
                    'input_boolean.turn_on','input_boolean.turn_off','input_boolean.toggle',
                    'input_number.set_value',
                    'input_select.select_option',
                  ];
                  // Split stored "ha_service" back into domain/service for the executor
                  const svcVal = strVal || (String(selectedNode.config.domain ?? '') ? `${selectedNode.config.domain}.${selectedNode.config.service}` : '');
                  return (
                    <Box key={field.key} sx={{ mb: 2 }}>
                      <Autocomplete
                        freeSolo size="small"
                        options={HA_SERVICES}
                        value={svcVal}
                        inputValue={svcVal}
                        onInputChange={(_, v) => {
                          const [domain, ...rest] = v.split('.');
                          updateSelectedConfigRaw(field.key, v);
                          updateSelectedConfigRaw('domain', domain ?? '');
                          updateSelectedConfigRaw('service', rest.join('.') ?? '');
                        }}
                        onChange={(_, v) => {
                          const svc = typeof v === 'string' ? v : '';
                          const [domain, ...rest] = svc.split('.');
                          updateSelectedConfigRaw(field.key, svc);
                          updateSelectedConfigRaw('domain', domain ?? '');
                          updateSelectedConfigRaw('service', rest.join('.') ?? '');
                        }}
                        renderInput={params => (
                          <TextField {...params} label={field.label} placeholder="light.turn_on" helperText={field.hint} />
                        )}
                      />
                    </Box>
                  );
                }

                // ── select ───────────────────────────────────────────────
                if (field.type === 'select') {
                  return (
                    <Box key={field.key} sx={{ mb: 2 }}>
                      <FormControl fullWidth size="small">
                        <InputLabel>{field.label}</InputLabel>
                        <Select value={strVal || (field.options?.[0] ?? '')} label={field.label}
                          onChange={e => updateSelectedConfig(field.key, e.target.value)}
                        >
                          {field.options?.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                        </Select>
                      </FormControl>
                    </Box>
                  );
                }

                // ── text / textarea / number ─────────────────────────────
                return (
                  <Box key={field.key} sx={{ mb: 2 }}>
                    <TextField
                      label={field.label} value={strVal}
                      onChange={e => updateSelectedConfig(field.key, e.target.value)}
                      fullWidth size="small"
                      multiline={field.type === 'textarea'} rows={field.type === 'textarea' ? 3 : undefined}
                      type={field.type === 'number' ? 'number' : 'text'}
                      placeholder={field.placeholder} helperText={field.hint}
                    />
                  </Box>
                );
              })}

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
                  <Typography sx={{ fontSize: '0.65rem', color: '#484f58', lineHeight: 1.6 }}>
                    Runs as a side effect alongside the AI response. Context variables: <code>{'{{intent}}'}</code>, <code>{'{{transcript}}'}</code>, <code>{'{{deviceId}}'}</code>, <code>{'{{slots}}'}</code>
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
