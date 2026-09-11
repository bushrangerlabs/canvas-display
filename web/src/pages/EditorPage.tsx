/**
 * EditorPage — full-featured visual scene editor.
 *
 * Features:
 * - 30-widget palette (from widget-catalog.ts)
 * - Drag-and-drop canvas with pointer events
 * - Snap-to-grid (20px)
 * - Multi-select with Shift+click
 * - Alignment guides when dragging
 * - Widget resize handles (8 positions)
 * - Canvas pan/zoom via scroll wheel
 * - Right-side inspector with layout + dynamic fields per widget type
 * - Device assignment dialog
 * - Scene save / stage / publish / rollback integration
 */
import { useEffect, useMemo, useRef, useState, useCallback, Suspense } from 'react';
import {
  Box, Stack, Typography, Button, TextField, Select, MenuItem,
  InputLabel, FormControl, Divider, IconButton, Tooltip, Alert,
  Dialog, DialogTitle, DialogContent, DialogActions, ToggleButton, ToggleButtonGroup,
  Accordion, AccordionSummary, AccordionDetails, Slider as MuiSlider,
  Checkbox, FormControlLabel, Switch as MuiSwitch, Avatar, List, ListItem,
  ListItemAvatar, ListItemText, ListItemButton, CircularProgress, Chip,
  Menu as MuiMenu,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import GridOnIcon from '@mui/icons-material/GridOn';
import GridOffIcon from '@mui/icons-material/GridOff';
import SaveIcon from '@mui/icons-material/Save';
import { useSearchParams } from 'react-router-dom';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import SensorsIcon from '@mui/icons-material/Sensors';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import { coreApi, ApiError, type SceneRecord, type DeviceRow, type HaEntityCatalogueItem } from '../api/client';
import { useWebSocket } from '../widgets/providers/WebSocketProvider';
import { PageHeader, ErrorBanner } from '../components/ui';
import { WIDGET_CATALOG, CATEGORY_ORDER, CATEGORY_LABELS, type WidgetMetadata, type FieldMetadata } from '../widgets/widget-catalog';
import { WIDGET_LAZY_MAP } from '../widgets/WidgetRenderer';
import { looksTruncated, parseAiContent } from '../widgets/aiParse';
import type { WidgetConfig } from '../widgets/types/index';


// ── Constants ─────────────────────────────────────────────────────────────────

const GRID = 20;
const DEFAULT_CANVAS_W = 800;
const DEFAULT_CANVAS_H = 480;
const MIN_WIDGET_SIZE = 20;
const HANDLE_SIZE = 10;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

interface EditorWidget {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  locked: boolean;
  hidden: boolean;
  config: Record<string, any>;
}

interface SceneManifest {
  widgets: EditorWidget[];
  /** Native design resolution in pixels, retained per scene so the canvas size persists across saves. */
  width?: number;
  height?: number;
}

type DragMode = 'move' | 'resize-se' | 'resize-e' | 'resize-w' | 'resize-n' | 'resize-s' | 'resize-ne' | 'resize-nw' | 'resize-sw';

interface DragState {
  ids: string[];
  mode: DragMode;
  startX: number;
  startY: number;
  origins: Record<string, { x: number; y: number; w: number; h: number }>;
}

interface CanvasPan {
  panX: number;
  panY: number;
  zoom: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `w_${Date.now().toString(36)}_${idCounter}`;
}

function snapTo(v: number): number {
  return Math.round(v / GRID) * GRID;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Full popup code editor with copy/paste tools, opened via the pop-out icon. */
function CodeEditorDialog({ open, label, value, onClose, onChange }: {
  open: boolean;
  label: string;
  value: string;
  onClose: () => void;
  onChange: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) setText(value);
  }, [open, value]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      const el = inputRef.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const next = text.slice(0, start) + clip + text.slice(end);
      setText(next);
      const caret = start + clip.length;
      requestAnimationFrame(() => {
        if (el) { el.selectionStart = el.selectionEnd = caret; el.focus(); }
      });
    } catch { /* ignore */ }
  };

  const save = () => { onChange(text); onClose(); };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 2 }}>
        <span>{label} editor</span>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Tooltip title={copied ? 'Copied!' : 'Copy all'}>
            <IconButton size="small" onClick={copy}>
              {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Paste from clipboard (at cursor)">
            <IconButton size="small" onClick={paste}><ContentPasteIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title={wrap ? 'Wrap: on' : 'Wrap: off'}>
            <IconButton size="small" onClick={() => setWrap(w => !w)}>
              <TextFieldsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        <TextField
          inputRef={inputRef}
          fullWidth
          multiline
          minRows={22}
          maxRows={40}
          value={text}
          onChange={e => setText(e.target.value)}
          slotProps={{ input: { style: { fontFamily: 'monospace', fontSize: 13, whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: 'break-word' } } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

/** A code-editor field (HTML/CSS/JS) with a pop-out icon that opens a full editor. */
function CodeEditorField({ field, val, onChange }: {
  field: FieldMetadata;
  val: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ position: 'relative' }}>
      <TextField
        label={field.label}
        size="small"
        fullWidth
        multiline
        minRows={6}
        maxRows={24}
        value={val}
        onChange={e => onChange(e.target.value)}
        placeholder={field.description}
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 12 } } }}
      />
      <Tooltip title="Open in editor">
        <IconButton
          size="small"
          onClick={() => setOpen(true)}
          sx={{
            position: 'absolute',
            top: 6,
            right: 6,
            bgcolor: 'background.paper',
            border: '1px solid',
            borderColor: 'divider',
            opacity: 0.92,
            '&:hover': { opacity: 1 },
          }}
        >
          <OpenInFullIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <CodeEditorDialog
        open={open}
        label={field.label}
        value={val}
        onClose={() => setOpen(false)}
        onChange={onChange}
      />
    </Box>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function EditorPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSceneId = searchParams.get('scene');
  // Widget state
  const [widgets, setWidgets] = useState<EditorWidget[]>([]);
  const [canvasW, setCanvasW] = useState(DEFAULT_CANVAS_W);
  const [canvasH, setCanvasH] = useState(DEFAULT_CANVAS_H);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nextZ, setNextZ] = useState(1);
  const [snap, setSnap] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canvasPan, setCanvasPan] = useState<CanvasPan>({ panX: 0, panY: 0, zoom: 1 });
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasPanRef = useRef(canvasPan);
  canvasPanRef.current = canvasPan;
  const panDragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ mouseX: number; mouseY: number; widgetId: string } | null>(null);

  // Undo history
  const [history, setHistory] = useState<EditorWidget[][]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  // Scene management
  const [saveOpen, setSaveOpen] = useState(false);
  const [scenes, setScenes] = useState<SceneRecord[]>([]);
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  const [currentSceneName, setCurrentSceneName] = useState<string | null>(null);
  const [sceneStatus, setSceneStatus] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [_assignments, setAssignments] = useState<Map<string, string>>(new Map());

  // Canvas size dialog
  const [canvasSizeOpen, setCanvasSizeOpen] = useState(false);
  const [sizeDevices, setSizeDevices] = useState<DeviceRow[]>([]);
  const [sizeDeviceId, setSizeDeviceId] = useState<string>('');
  const [sizeW, setSizeW] = useState(canvasW);
  const [sizeH, setSizeH] = useState(canvasH);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [sizeScaleWidgets, setSizeScaleWidgets] = useState(true);

  async function openCanvasSize() {
    setSizeW(canvasW);
    setSizeH(canvasH);
    setSizeDeviceId('');
    setSizeError(null);
    setCanvasSizeOpen(true);
    try {
      const res = await coreApi.devices();
      setSizeDevices(res.devices ?? []);
    } catch {
      setSizeDevices([]);
    }
  }

  function onSizeDeviceChange(id: string) {
    setSizeDeviceId(id);
    const dev = sizeDevices.find(d => d.id === id);
    if (dev && dev.display_width && dev.display_height) {
      setSizeW(dev.display_width);
      setSizeH(dev.display_height);
      setSizeError(null);
    }
  }

  function applyCanvasSize() {
    const w = Math.round(sizeW);
    const h = Math.round(sizeH);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      setSizeError('Width and height must be positive pixel values.');
      return;
    }
    // Proportionally remap widget geometry so the composition fills the new
    // canvas instead of leaving dead margins (e.g. when matching the real
    // panel/device resolution after designing at a stale size).
    if (sizeScaleWidgets && (w !== canvasW || h !== canvasH) && widgets.length > 0) {
      const sx = w / canvasW;
      const sy = h / canvasH;
      pushHistory(widgets);
      setWidgets(prev => prev.map(widget => {
        const nw = Math.max(MIN_WIDGET_SIZE, Math.round(widget.w * sx));
        const nh = Math.max(MIN_WIDGET_SIZE, Math.round(widget.h * sy));
        const nx = clamp(Math.round(widget.x * sx), 0, Math.max(0, w - nw));
        const ny = clamp(Math.round(widget.y * sy), 0, Math.max(0, h - nh));
        return {
          ...widget,
          x: nx,
          y: ny,
          w: Math.min(nw, w - nx),
          h: Math.min(nh, h - ny),
        };
      }));
    }
    setCanvasW(w);
    setCanvasH(h);
    setCanvasSizeOpen(false);
  }

  // Alignment guides
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const spaceBarRef = useRef(false);
  const lastNudgeRef = useRef(0);
  const openedSceneRef = useRef<string | null>(null);

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  function pushHistory(w: EditorWidget[]) {
    const newHist = history.slice(0, historyIdx + 1);
    newHist.push(JSON.parse(JSON.stringify(w)));
    if (newHist.length > 50) newHist.shift();
    setHistory(newHist);
    setHistoryIdx(newHist.length - 1);
  }

  function undo() {
    if (historyIdx < 0) return;
    setWidgets(JSON.parse(JSON.stringify(history[historyIdx])));
    setHistoryIdx(historyIdx - 1);
  }

  function redo() {
    if (historyIdx + 1 >= history.length) return;
    setWidgets(JSON.parse(JSON.stringify(history[historyIdx + 1])));
    setHistoryIdx(historyIdx + 1);
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  const selected = useMemo(() => {
    if (selectedIds.length === 1) return widgets.find(w => w.id === selectedIds[0]) ?? null;
    return null;
  }, [widgets, selectedIds]);

  function selectWidget(id: string, additive: boolean = false) {
    if (additive) {
      setSelectedIds(prev =>
        prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
      );
    } else {
      setSelectedIds([id]);
    }
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  function selectAllWidgets() {
    setSelectedIds(widgets.map(w => w.id));
  }

  // ── Widget CRUD ───────────────────────────────────────────────────────────

  function addWidget(type: string) {
    const meta = WIDGET_CATALOG[type];
    const def = meta?.defaultSize ?? { w: 200, h: 60 };
    const defaults: Record<string, any> = {};
    if (meta) {
      for (const f of meta.fields) {
        if (f.default !== undefined) defaults[f.name] = f.default;
      }
    }
    const w: EditorWidget = {
      id: newId(),
      type,
      x: snap ? snapTo(20) : 20,
      y: snap ? snapTo(20) : 20,
      w: def.w,
      h: def.h,
      zIndex: nextZ,
      locked: false,
      hidden: false,
      config: defaults,
    };
    setNextZ(z => z + 1);
    pushHistory(widgets);
    setWidgets(prev => [...prev, w]);
    setSelectedIds([w.id]);
  }

  function updateWidget(id: string, patch: Partial<EditorWidget> | { config: Record<string, any> }) {
    setWidgets(prev => prev.map(w => {
      if (w.id !== id) return w;
      if ('config' in patch && patch.config) {
        return { ...w, config: { ...w.config, ...patch.config } };
      }
      return { ...w, ...patch };
    }));
  }

  function updateSelected(patch: Partial<EditorWidget> | { config: Record<string, any> }) {
    if (selectedIds.length === 0) return;
    pushHistory(widgets);
    for (const id of selectedIds) {
      updateWidget(id, patch);
    }
  }

  function deleteSelected() {
    if (selectedIds.length === 0) return;
    pushHistory(widgets);
    setWidgets(prev => prev.filter(w => !selectedIds.includes(w.id)));
    setSelectedIds([]);
  }

  function duplicateSelected() {
    if (selectedIds.length === 0) return;
    pushHistory(widgets);
    const newWidgets: EditorWidget[] = [];
    const newIds: string[] = [];
    for (const w of widgets) {
      if (selectedIds.includes(w.id)) {
        const nw: EditorWidget = {
          ...JSON.parse(JSON.stringify(w)),
          id: newId(),
          x: w.x + 20,
          y: w.y + 20,
          zIndex: nextZ + newWidgets.length,
        };
        newWidgets.push(nw);
        newIds.push(nw.id);
      }
    }
    setNextZ(z => z + newWidgets.length);
    setWidgets(prev => [...prev, ...newWidgets]);
    setSelectedIds(newIds);
  }

  function moveSelected(dx: number, dy: number) {
    if (selectedIds.length === 0) return;
    // Coalesce arrow-key nudges into a single undo step per burst.
    if (Date.now() - lastNudgeRef.current > 800) pushHistory(widgets);
    lastNudgeRef.current = Date.now();
    setWidgets(prev => prev.map(w => {
      if (!selectedIds.includes(w.id)) return w;
      let nx = snap ? snapTo(w.x + dx) : w.x + dx;
      let ny = snap ? snapTo(w.y + dy) : w.y + dy;
      nx = clamp(nx, 0, canvasW - w.w);
      ny = clamp(ny, 0, canvasH - w.h);
      return { ...w, x: nx, y: ny };
    }));
  }

  function toggleLock(id: string) {
    pushHistory(widgets);
    updateWidget(id, { locked: !widgets.find(w => w.id === id)?.locked });
  }

  function toggleHidden(id: string) {
    pushHistory(widgets);
    updateWidget(id, { hidden: !widgets.find(w => w.id === id)?.hidden });
  }

  function bringToFront(id: string) {
    pushHistory(widgets);
    const maxZ = Math.max(...widgets.map(w => w.zIndex), 0);
    setWidgets(prev => prev.map(w => w.id === id ? { ...w, zIndex: maxZ + 1 } : w));
    setNextZ(maxZ + 2);
  }

  function sendToBack(id: string) {
    pushHistory(widgets);
    const minZ = Math.min(...widgets.map(w => w.zIndex), 0);
    setWidgets(prev => prev.map(w => w.id === id ? { ...w, zIndex: minZ - 1 } : w));
  }

  function bringForward(id: string) {
    pushHistory(widgets);
    const w = widgets.find(widget => widget.id === id);
    if (!w) return;
    const above = widgets.filter(o => o.id !== id && o.zIndex > w.zIndex).sort((a, b) => a.zIndex - b.zIndex)[0];
    if (above) {
      setWidgets(prev => prev.map(o => {
        if (o.id === id) return { ...o, zIndex: above.zIndex };
        if (o.id === above.id) return { ...o, zIndex: w.zIndex };
        return o;
      }));
    }
  }

  function sendBackward(id: string) {
    pushHistory(widgets);
    const w = widgets.find(widget => widget.id === id);
    if (!w) return;
    const below = widgets.filter(o => o.id !== id && o.zIndex < w.zIndex).sort((a, b) => b.zIndex - a.zIndex)[0];
    if (below) {
      setWidgets(prev => prev.map(o => {
        if (o.id === id) return { ...o, zIndex: below.zIndex };
        if (o.id === below.id) return { ...o, zIndex: w.zIndex };
        return o;
      }));
    }
  }

  // ── Drag logic ────────────────────────────────────────────────────────────



  const onPointerDown = useCallback((e: React.PointerEvent, widgetId: string) => {
    const w = widgets.find(x => x.id === widgetId);
    if (!w || w.locked) return;
    // Only the left button starts a move/resize; middle-click (and space+drag)
    // fall through to the work-area panning handler.
    if (e.button !== 0 || spaceBarRef.current) return;
    e.stopPropagation();

    const handle = (e.target as HTMLElement).dataset?.handle;
    const isResize = !!handle;

    if (isResize) {
      // Resize a single widget
      setSelectedIds([widgetId]);
      dragRef.current = {
        ids: [widgetId],
        mode: handle as DragMode,
        startX: e.clientX,
        startY: e.clientY,
        origins: { [widgetId]: { x: w.x, y: w.y, w: w.w, h: w.h } },
      };
    } else {
      // Move — additive if shift
      const shift = e.shiftKey;
      if (!selectedIds.includes(widgetId) && !shift) {
        setSelectedIds([widgetId]);
      } else if (shift) {
        selectWidget(widgetId, true);
      }
      const ids = shift
        ? (selectedIds.includes(widgetId) ? selectedIds : [...selectedIds, widgetId])
        : [widgetId];
      const origins: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (const id of ids) {
        const wgt = widgets.find(x => x.id === id);
        if (wgt) origins[id] = { x: wgt.x, y: wgt.y, w: wgt.w, h: wgt.h };
      }
      dragRef.current = {
        ids, mode: 'move',
        startX: e.clientX, startY: e.clientY,
        origins,
      };
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [widgets, selectedIds]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    if (d.mode === 'move') {
      setGuides({});
      const newGuides: { x?: number; y?: number } = {};
      // Deltas arrive in screen px but the canvas is CSS-scaled by `zoom`:
      // divide by zoom so widgets stay glued to the cursor at any zoom level.
      const scale = canvasPan.zoom || 1;
      const threshold = 5 / scale;
      setWidgets(prev => prev.map(w => {
        if (!d.ids.includes(w.id)) return w;
        const o = d.origins[w.id];
        let nx = o.x + dx;
        let ny = o.y + dy;
        if (snap) { nx = snapTo(nx); ny = snapTo(ny); }
        nx = clamp(nx, 0, canvasW - w.w);
        ny = clamp(ny, 0, canvasH - w.h);

        // Alignment guides — check against stationary widgets: edges, opposite
        // edges and centres.
        for (const other of prev) {
          if (d.ids.includes(other.id)) continue;
          if (Math.abs(nx - other.x) < threshold) {
            newGuides.x = other.x;
            nx = other.x;
          }
          if (Math.abs(ny - other.y) < threshold) {
            newGuides.y = other.y;
            ny = other.y;
          }
          if (Math.abs(nx + w.w - (other.x + other.w)) < threshold) {
            newGuides.x = other.x + other.w - w.w;
            nx = newGuides.x;
          }
          if (Math.abs(ny + w.h - (other.y + other.h)) < threshold) {
            newGuides.y = other.y + other.h - w.h;
            ny = newGuides.y;
          }
          if (Math.abs((nx + w.w / 2) - (other.x + other.w / 2)) < threshold) {
            newGuides.x = other.x + other.w / 2 - w.w / 2;
            nx = newGuides.x;
          }
          if (Math.abs((ny + w.h / 2) - (other.y + other.h / 2)) < threshold) {
            newGuides.y = other.y + other.h / 2 - w.h / 2;
            ny = newGuides.y;
          }
        }
        // …and against the canvas edges and centre.
        if (Math.abs(nx) < threshold) { newGuides.x = 0; nx = 0; }
        if (Math.abs(ny) < threshold) { newGuides.y = 0; ny = 0; }
        if (Math.abs(nx + w.w - canvasW) < threshold) { newGuides.x = canvasW - w.w; nx = canvasW - w.w; }
        if (Math.abs(ny + w.h - canvasH) < threshold) { newGuides.y = canvasH - w.h; ny = canvasH - w.h; }
        if (Math.abs(nx + w.w / 2 - canvasW / 2) < threshold) { newGuides.x = canvasW / 2 - w.w / 2; nx = canvasW / 2 - w.w / 2; }
        if (Math.abs(ny + w.h / 2 - canvasH / 2) < threshold) { newGuides.y = canvasH / 2 - w.h / 2; ny = canvasH / 2 - w.h / 2; }
        return { ...w, x: nx, y: ny };
      }));
      setGuides(newGuides);
    } else {
      // Resize
      setWidgets(prev => prev.map(w => {
        if (!d.ids.includes(w.id)) return w;
        const o = d.origins[w.id];
        let nw = o.w;
        let nh = o.h;
        let nx = o.x;
        let ny = o.y;
        const minW = Math.max(MIN_WIDGET_SIZE, snap ? GRID : 1);
        const minH = Math.max(MIN_WIDGET_SIZE, snap ? GRID : 1);

        switch (d.mode) {
          case 'resize-se':
            nw = o.w + dx; nh = o.h + dy; break;
          case 'resize-e':
            nw = o.w + dx; break;
          case 'resize-s':
            nh = o.h + dy; break;
          case 'resize-w':
            nw = o.w - dx; nx = o.x + dx; break;
          case 'resize-n':
            nh = o.h - dy; ny = o.y + dy; break;
          case 'resize-ne':
            nw = o.w + dx; nh = o.h - dy; ny = o.y + dy; break;
          case 'resize-nw':
            nw = o.w - dx; nh = o.h - dy; nx = o.x + dx; ny = o.y + dy; break;
          case 'resize-sw':
            nw = o.w - dx; nh = o.h + dy; nx = o.x + dx; break;
        }
        if (snap) {
          nw = Math.max(minW, snapTo(nw));
          nh = Math.max(minH, snapTo(nh));
          nx = snapTo(nx);
          ny = snapTo(ny);
        }
        // Constrain to canvas
        if (nx < 0) { nw += nx; nx = 0; }
        if (ny < 0) { nh += ny; ny = 0; }
        nw = Math.max(minW, Math.min(nw, canvasW - nx));
        nh = Math.max(minH, Math.min(nh, canvasH - ny));
        return { ...w, x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
      }));
    }
  }, [snap, canvasPan.zoom]);

  const onPointerUp = useCallback(() => {
    if (dragRef.current) {
      pushHistory(widgets);
    }
    dragRef.current = null;
    setGuides({});
  }, [widgets]);

  // ── Canvas pan/zoom ──────────────────────────────────────────────────────

  const zoomAt = useCallback((next: number) => {
    setCanvasPan(prev => ({ ...prev, zoom: clamp(next, MIN_ZOOM, MAX_ZOOM) }));
  }, []);

  // Fit the whole canvas into the visible work area — the same uniform-fit
  // scaling the display page applies to the published scene.
  const zoomToFit = useCallback(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const z = clamp(Math.min((rect.width - 80) / canvasW, (rect.height - 80) / canvasH), MIN_ZOOM, MAX_ZOOM);
    setCanvasPan({ panX: 0, panY: 0, zoom: z > 0 ? z : 1 });
  }, [canvasW, canvasH]);

  // Refit whenever the work area resizes or the canvas size changes.
  useEffect(() => { zoomToFit(); }, [zoomToFit]);

  // React's synthetic onWheel is passive and cannot preventDefault, which the
  // browser page-zoom needs — so wheel handling uses a raw non-passive
  // listener. Ctrl/⌘+wheel zooms anchored at the cursor; plain wheel pans.
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        // Cursor offset from the canvas centre, in screen px.
        const px = e.clientX - (rect.left + rect.width / 2) - canvasPanRef.current.panX;
        const py = e.clientY - (rect.top + rect.height / 2) - canvasPanRef.current.panY;
        setCanvasPan(prev => {
          const zoom = clamp(prev.zoom * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
          const applied = zoom / prev.zoom;
          // Keep the point under the cursor stationary while zooming.
          return { zoom, panX: prev.panX + px * (1 - applied), panY: prev.panY + py * (1 - applied) };
        });
      } else {
        setCanvasPan(prev => ({ ...prev, panX: prev.panX - e.deltaX, panY: prev.panY - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

  // Spacebar hand panning
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space' && !isEditableElement(document.activeElement)) { spaceBarRef.current = true; setSpaceHeld(true); e.preventDefault(); }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          deleteSelected();
        }
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
        if (e.code === 'KeyZ' && e.shiftKey) { e.preventDefault(); redo(); }
        if (e.code === 'KeyA') { e.preventDefault(); selectAllWidgets(); }
        if (e.code === 'KeyD') { e.preventDefault(); duplicateSelected(); }
        if (e.code === 'Digit0') { e.preventDefault(); zoomToFit(); }
        if (e.code === 'Digit1') { e.preventDefault(); zoomAt(1); }
      }
      // Arrow keys
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !e.ctrlKey && !e.metaKey) {
        if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          const step = e.shiftKey ? 1 : (snap ? GRID : 10);
          const dirs: Record<string, [number, number]> = {
            ArrowUp: [0, -step], ArrowDown: [0, step],
            ArrowLeft: [-step, 0], ArrowRight: [step, 0],
          };
          const [dx, dy] = dirs[e.code];
          moveSelected(dx, dy);
        }
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') { spaceBarRef.current = false; setSpaceHeld(false); }
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, [selectedIds, widgets, snap, canvasW, canvasH, zoomToFit, zoomAt]);

  // ── Scene API ─────────────────────────────────────────────────────────────

  async function openSave() {
    try {
      const [s, d] = await Promise.all([
        coreApi.scenes().then(r => r.scenes).catch(() => []),
        coreApi.devices().then(r => r.devices).catch(() => []),
      ]);
      setScenes(s);
      setDevices(d);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError('Admin login required.');
        return;
      }
    }
    setSaveOpen(true);
  }

  async function saveAs(name: string, existingId?: string) {
    const manifest: SceneManifest = { widgets, width: canvasW, height: canvasH };
    try {
      if (existingId) {
        await coreApi.stageScene(existingId, manifest);
        await coreApi.publishScene(existingId);
        setCurrentSceneId(existingId);
        setCurrentSceneName(scenes.find(s => s.id === existingId)?.name ?? name);
        setSceneStatus('published');
      } else {
        const res = await coreApi.createScene(name, manifest);
        await coreApi.publishScene(res.scene.id);
        setCurrentSceneId(res.scene.id);
        setCurrentSceneName(name);
        setSceneStatus('published');
      }
      setSaveOpen(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveCurrent() {
    if (currentSceneId) await saveAs(currentSceneName ?? 'Scene', currentSceneId);
    else await openSave();
  }

  async function loadScene(sceneId: string) {
    try {
      const [revisions, sceneRows] = await Promise.all([
        coreApi.sceneRevisions(sceneId),
        scenes.length ? Promise.resolve(scenes) : coreApi.scenes().then(result => result.scenes),
      ]);
      // Core returns revisions newest-first (ORDER BY revision DESC).
      const latestRev = revisions.revisions[0];
      const manifest = latestRev?.manifest as SceneManifest | undefined;
      if (!latestRev) throw new Error('This scene has no revisions to edit.');
      if (!Array.isArray(manifest?.widgets)) throw new Error('This scene does not contain a visual-editor widget layout.');
      setScenes(sceneRows);
      setWidgets(manifest.widgets);
      setCanvasW(manifest.width ?? DEFAULT_CANVAS_W);
      setCanvasH(manifest.height ?? DEFAULT_CANVAS_H);
      setSelectedIds([]);
      setNextZ(Math.max(1, ...manifest.widgets.map(widget => Number(widget.zIndex) || 0)) + 1);
      setCurrentSceneId(sceneId);
      setCurrentSceneName(sceneRows.find(scene => scene.id === sceneId)?.name ?? 'Scene');
      setSceneStatus(latestRev.status);
      setHistory([]);
      setHistoryIdx(-1);
      setSearchParams({ scene: sceneId }, { replace: true });
      openedSceneRef.current = sceneId;
      setError(null);
      setSaveOpen(false);
    } catch (e) {
      openedSceneRef.current = sceneId;
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!requestedSceneId || openedSceneRef.current === requestedSceneId) return;
    void loadScene(requestedSceneId);
  }, [requestedSceneId]);

  async function assignToDevice(deviceId: string) {
    if (!currentSceneId) return;
    try {
      await coreApi.assignScene(currentSceneId, deviceId);
      setAssignments(prev => new Map(prev).set(deviceId, currentSceneId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const WIDGET_META_CACHE = WIDGET_CATALOG;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title={
          currentSceneName
            ? `Editor — ${currentSceneName} ${sceneStatus ? `(${sceneStatus})` : ''}`
            : 'Scene Editor'
        }
        subtitle={
          currentSceneId
            ? `${widgets.length} widgets · ${currentSceneId.slice(0, 8)}…`
            : 'Add widgets, arrange them on the canvas, then save as a scene'
        }
        actions={
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
            <Tooltip title="Undo (Ctrl+Z)">
              <span><IconButton size="small" onClick={undo} disabled={historyIdx < 0}><UndoIcon fontSize="small" /></IconButton></span>
            </Tooltip>
            <Tooltip title="Redo (Ctrl+Shift+Z)">
              <span><IconButton size="small" onClick={redo} disabled={historyIdx + 1 >= history.length}><RedoIcon fontSize="small" /></IconButton></span>
            </Tooltip>
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
            <ToggleButtonGroup
              size="small" exclusive value={snap ? 'on' : 'off'}
              onChange={(_e, v) => { if (v) setSnap(v === 'on'); }}
            >
              <ToggleButton value="on" size="small"><Tooltip title="Snap to grid"><GridOnIcon fontSize="small" /></Tooltip></ToggleButton>
              <ToggleButton value="off" size="small"><Tooltip title="Free positioning"><GridOffIcon fontSize="small" /></Tooltip></ToggleButton>
            </ToggleButtonGroup>
            <Button size="small" variant="contained" startIcon={<SaveIcon fontSize="small" />} onClick={saveCurrent} sx={{ textTransform: 'none', ml: 1 }}>
              {currentSceneId ? 'Save changes' : 'Save & publish'}
            </Button>
          </Stack>
        }
      />
      {error && <Box sx={{ px: 2, pt: 1 }}><ErrorBanner error={error} onRetry={() => setError(null)} /></Box>}

      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'row' }}>
        {/* ── Left sidebar: Widget palette ── */}
        <LeftPalette onAddWidget={addWidget} />

        {/* ── Center: Canvas ── */}
        <Box
          ref={canvasWrapRef}
          sx={{ flex: 1, overflow: 'hidden', position: 'relative', cursor: spaceHeld ? 'grab' : 'default' }}
          onPointerDown={(e) => {
            // Space+drag or middle-mouse pans the work area…
            if (spaceBarRef.current || e.button === 1) {
              e.preventDefault();
              panDragRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                panX: canvasPanRef.current.panX,
                panY: canvasPanRef.current.panY,
              };
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              return;
            }
            const el = e.target as HTMLElement;
            if (el === canvasRef.current || el.dataset?.canvas === 'true') {
              clearSelection();
            }
          }}
          onPointerMove={(e) => {
            if (!panDragRef.current) return;
            const p = panDragRef.current;
            setCanvasPan(prev => ({
              ...prev,
              panX: p.panX + (e.clientX - p.startX),
              panY: p.panY + (e.clientY - p.startY),
            }));
          }}
          onPointerUp={() => { panDragRef.current = null; }}
        >
          <Box
            ref={canvasRef}
            onPointerDown={(e) => {
              const el = e.target as HTMLElement;
              if (el === canvasRef.current || el.dataset?.canvas === 'true') {
                clearSelection();
              }
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            sx={{
              position: 'absolute',
              left: `calc(50% + ${canvasPan.panX}px)`,
              top: `calc(50% + ${canvasPan.panY}px)`,
              transform: `translate(-50%, -50%) scale(${canvasPan.zoom})`,
              transformOrigin: 'center center',
              width: canvasW,
              height: canvasH,
              bgcolor: '#0a0a12',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              backgroundImage: snap
                ? `linear-gradient(to right, rgba(108,99,255,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(108,99,255,0.07) 1px, transparent 1px)`
                : 'none',
              backgroundSize: snap ? `${GRID}px ${GRID}px` : undefined,
              touchAction: 'none',
              userSelect: 'none',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
              '& > *': { pointerEvents: 'auto' },
            }}
            data-canvas="true"
          >
            {/* Widgets count badge */}
            {widgets.length === 0 && (
              <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <Typography variant="body2" color="text.secondary">Add widgets from the palette</Typography>
              </Box>
            )}

            {/* Render widgets */}
            {[...widgets]
              .sort((a, b) => a.zIndex - b.zIndex)
              .filter(w => !w.hidden)
              .map(w => (
                <CanvasWidgetBox
                  key={w.id}
                  w={w}
                  isSelected={selectedIds.includes(w.id)}
                  zoom={canvasPan.zoom}
                  onPointerDown={(e) => onPointerDown(e, w.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selectedIds.includes(w.id)) setSelectedIds([w.id]);
                    setCtxMenu({ mouseX: e.clientX, mouseY: e.clientY, widgetId: w.id });
                  }}
                />
              ))}

            {/* Alignment guides */}
            {guides.x !== undefined && (
              <Box sx={{ position: 'absolute', left: guides.x, top: 0, width: 1, height: canvasH, bgcolor: '#6c63ff', zIndex: 9999, pointerEvents: 'none', opacity: 0.8 }} />
            )}
            {guides.y !== undefined && (
              <Box sx={{ position: 'absolute', left: 0, top: guides.y, width: canvasW, height: 1, bgcolor: '#6c63ff', zIndex: 9999, pointerEvents: 'none', opacity: 0.8 }} />
            )}
          </Box>

          {/* Zoom controls */}
          <Box sx={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', alignItems: 'center', gap: 0.5, zIndex: 10, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1, px: 0.5 }}>
            <IconButton size="small" title="Zoom out" onClick={() => zoomAt(canvasPan.zoom - 0.1)}>
              <ZoomOutIcon fontSize="small" />
            </IconButton>
            <Typography
              variant="caption"
              title="Reset zoom to 100%"
              onClick={() => zoomAt(1)}
              sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 44, textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
            >
              {Math.round(canvasPan.zoom * 100)}%
            </Typography>
            <IconButton size="small" title="Zoom in" onClick={() => zoomAt(canvasPan.zoom + 0.1)}>
              <ZoomInIcon fontSize="small" />
            </IconButton>
            <Button
              size="small"
              variant="text"
              title="Zoom to fit (Ctrl+0)"
              onClick={zoomToFit}
              sx={{ textTransform: 'none', minWidth: 0, px: 1, fontFamily: 'monospace' }}
            >
              Fit
            </Button>
          </Box>

          {/* Canvas size control */}
          <Box sx={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', alignItems: 'center', gap: 0.5, zIndex: 10 }}>
            <Button
              size="small"
              variant="outlined"
              onClick={openCanvasSize}
              sx={{ textTransform: 'none', fontFamily: 'monospace' }}
            >
              {canvasW} × {canvasH}
            </Button>
          </Box>
        </Box>

        {/* ── Context menu for z-index controls ── */}
        <MuiMenu
          open={Boolean(ctxMenu)}
          onClose={() => setCtxMenu(null)}
          anchorReference="anchorPosition"
          anchorPosition={ctxMenu ? { top: ctxMenu.mouseY, left: ctxMenu.mouseX } : undefined}
        >
          <MenuItem dense onClick={() => { if (ctxMenu) bringToFront(ctxMenu.widgetId); setCtxMenu(null); }}>
            Bring to Front
          </MenuItem>
          <MenuItem dense onClick={() => { if (ctxMenu) bringForward(ctxMenu.widgetId); setCtxMenu(null); }}>
            Bring Forward
          </MenuItem>
          <MenuItem dense onClick={() => { if (ctxMenu) sendBackward(ctxMenu.widgetId); setCtxMenu(null); }}>
            Send Backward
          </MenuItem>
          <MenuItem dense onClick={() => { if (ctxMenu) sendToBack(ctxMenu.widgetId); setCtxMenu(null); }}>
            Send to Back
          </MenuItem>
          <Divider />
          <MenuItem dense onClick={() => { if (ctxMenu) toggleLock(ctxMenu.widgetId); setCtxMenu(null); }}>
            {widgets.find(w => w.id === ctxMenu?.widgetId)?.locked ? 'Unlock' : 'Lock'}
          </MenuItem>
          <MenuItem dense onClick={() => { if (ctxMenu) toggleHidden(ctxMenu.widgetId); setCtxMenu(null); }}>
            {widgets.find(w => w.id === ctxMenu?.widgetId)?.hidden ? 'Show' : 'Hide'}
          </MenuItem>
          <Divider />
          <MenuItem dense sx={{ color: 'error.main' }} onClick={() => {
            if (ctxMenu) {
              pushHistory(widgets);
              setWidgets(prev => prev.filter(w => w.id !== ctxMenu.widgetId));
              setSelectedIds(prev => prev.filter(id => id !== ctxMenu.widgetId));
            }
            setCtxMenu(null);
          }}>
            Delete
          </MenuItem>
        </MuiMenu>

        {/* ── Right sidebar: Inspector ── */}
        <RightInspector
          selected={selected}
          selectedIds={selectedIds}
          widgets={widgets}
          widgetMeta={WIDGET_META_CACHE}
          canvasWidth={canvasW}
          canvasHeight={canvasH}
          onUpdate={updateSelected}
          onDelete={deleteSelected}
          onDuplicate={duplicateSelected}
          onLock={toggleLock}
          onHide={toggleHidden}
        />
      </Box>

      {/* ── Save / Load Dialog ── */}
      <SaveLoadDialog
        open={saveOpen}
        scenes={scenes}
        currentSceneId={currentSceneId}
        onClose={() => setSaveOpen(false)}
        onSave={saveAs}
        onLoad={loadScene}
      />

      {/* ── Assign Dialog ── */}
      <Dialog open={assignOpen} onClose={() => setAssignOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Assign scene to device</DialogTitle>
        <DialogContent>
          {devices.length === 0 ? (
            <Alert severity="info" sx={{ mt: 1, bgcolor: 'rgba(108,99,255,0.1)' }}>No devices registered.</Alert>
          ) : (
            <List>
              {devices.map(d => (
                <ListItem key={d.id}
                  secondaryAction={
                    <Button size="small" variant="outlined" onClick={() => assignToDevice(d.id)}>
                      Assign
                    </Button>
                  }
                >
                  <ListItemAvatar>
                    <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
                      {d.name.slice(0, 1).toUpperCase()}
                    </Avatar>
                  </ListItemAvatar>
                  <ListItemText
                    primary={d.name}
                    secondary={`${d.architecture || '—'} · ${d.status || 'unknown'}`}
                    slotProps={{ primary: { sx: { fontSize: 13 } }, secondary: { sx: { fontSize: 11 } } }}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setAssignOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Canvas size dialog */}
      <Dialog open={canvasSizeOpen} onClose={() => setCanvasSizeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Canvas size</DialogTitle>
        <DialogContent>
          <FormControl size="small" fullWidth sx={{ mt: 1 }}>
            <InputLabel>Match device</InputLabel>
            <Select label="Match device" value={sizeDeviceId} onChange={e => onSizeDeviceChange(e.target.value)}>
              <MenuItem value=""><em>Custom</em></MenuItem>
              {sizeDevices
                .filter(d => d.display_width && d.display_height)
                .map(d => (
                  <MenuItem key={d.id} value={d.id}>
                    {d.name} ({d.display_width}×{d.display_height})
                  </MenuItem>
                ))}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Set the native pixel resolution of the device display. The canvas matches the real screen so widget layout reflects what the device actually shows.
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ mt: 1.25, flexWrap: 'wrap', gap: 0.75 }}>
            {([[1920, 1080], [1920, 918], [1280, 720], [800, 480]] as const).map(([pw, ph]) => (
              <Chip
                key={`${pw}x${ph}`}
                size="small"
                label={`${pw}×${ph}`}
                variant={Number(sizeW) === pw && Number(sizeH) === ph ? 'filled' : 'outlined'}
                onClick={() => { setSizeW(pw); setSizeH(ph); }}
              />
            ))}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField
              size="small" label="Width (px)" type="number" fullWidth
              value={sizeW} onChange={e => setSizeW(Number(e.target.value))}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
            <TextField
              size="small" label="Height (px)" type="number" fullWidth
              value={sizeH} onChange={e => setSizeH(Number(e.target.value))}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block', fontFamily: 'monospace' }}>
            {Number(sizeW) > 0 && Number(sizeH) > 0
              ? `${sizeW}×${sizeH} px · aspect ${(sizeW / sizeH).toFixed(3)} · ${(sizeW * sizeH / 1e6).toFixed(2)} MP`
              : 'Enter a valid size'}
          </Typography>
          <FormControlLabel
            control={<Checkbox size="small" checked={sizeScaleWidgets} onChange={e => setSizeScaleWidgets(e.target.checked)} />}
            label={<Typography variant="caption">Scale widget layout with the canvas</Typography>}
            sx={{ mt: 0.5 }}
          />
          {sizeError && <Alert severity="error" sx={{ mt: 2 }}>{sizeError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setCanvasSizeOpen(false)}>Cancel</Button>
          <Button size="small" variant="contained" onClick={applyCanvasSize}>Apply</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

/** Left palette sidebar with categorized widget buttons */
function LeftPalette({ onAddWidget }: { onAddWidget: (type: string) => void }) {
  return (
    <Box sx={{
      width: 200, flexShrink: 0, bgcolor: 'background.paper',
      borderRight: 1, borderColor: 'divider', overflowY: 'auto',
    }}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5, p: 1.5, pb: 0, display: 'block' }}>
        Widget palette
      </Typography>
      <Box sx={{ px: 1.5, pb: 1.5 }}>
        <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>
          {Object.keys(WIDGET_CATALOG).length} widgets · click to add
        </Typography>
      </Box>
      {CATEGORY_ORDER.map(cat => {
        const items = Object.entries(WIDGET_CATALOG).filter(([, m]) => m.category === cat);
        if (items.length === 0) return null;
        return (
          <Box key={cat} sx={{ mb: 1 }}>
            <Typography variant="caption" sx={{
              px: 1.5, py: 0.5, display: 'block',
              color: 'text.disabled', fontSize: 10, fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: 0.5,
            }}>
              {CATEGORY_LABELS[cat] ?? cat}
            </Typography>
            <Box sx={{ px: 1 }}>
              {items.map(([type, meta]) => (
                <Button
                  key={type}
                  size="small"
                  variant="text"
                  fullWidth
                  onClick={() => onAddWidget(type)}
                  sx={{
                    textTransform: 'none', justifyContent: 'flex-start',
                    fontSize: 11, py: 0.4, color: 'text.secondary',
                    '&:hover': { color: 'primary.main', bgcolor: 'rgba(108,99,255,0.08)' },
                  }}
                >
                  {meta.icon ? (
                    <Box component="span" sx={{ mr: 0.75, fontSize: 14, lineHeight: 1 }}>◇</Box>
                  ) : null}
                  {meta.name}
                </Button>
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** Single widget rendered on the canvas */
function CanvasWidgetBox({
  w, isSelected, zoom, onPointerDown, onContextMenu,
}: {
  w: EditorWidget;
  isSelected: boolean;
  zoom: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const meta = WIDGET_CATALOG[w.type];
  // Editor chrome (handles, outline, label) is sized in screen px and divided
  // by zoom here, so it renders at a constant size on screen at any zoom.
  const z = zoom || 1;
  const hs = HANDLE_SIZE / z;
  return (
    <Box
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      sx={{
        position: 'absolute',
        left: w.x,
        top: w.y,
        width: w.w,
        height: w.h,
        cursor: w.locked ? 'default' : 'grab',
        overflow: 'visible',
        boxSizing: 'content-box',
        zIndex: w.zIndex,
        '&:active': { cursor: w.locked ? 'default' : 'grabbing' },
      }}
    >
      {/* Production-faithful widget content: no editor padding, border, background or clipping. */}
      <Box sx={{ position: 'absolute', inset: 0, width: w.w, height: w.h, overflow: 'visible' }}>
        <Suspense fallback={
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 10, color: '#666' }}>
            Loading...
          </Box>
        }>
          <WidgetPreview w={w} />
        </Suspense>
      </Box>

      {/* Editor chrome is an overlay and never changes the widget's layout box. */}
      <Box sx={{
        position: 'absolute',
        inset: 0,
        outline: isSelected ? `${2 / z}px solid #6c63ff` : `${1 / z}px solid rgba(255,255,255,0.12)`,
        pointerEvents: 'none',
        zIndex: 8,
        '&:hover': { outlineColor: isSelected ? '#6c63ff' : 'rgba(108,99,255,0.55)' },
      }} />
      {isSelected && (
        <Box sx={{
          position: 'absolute',
          left: 0,
          top: -16 / z,
          color: 'text.secondary',
          bgcolor: 'background.paper',
          padding: `${1 / z}px ${3 / z}px`,
          fontSize: 9 / z,
          lineHeight: `${14 / z}px`,
          pointerEvents: 'none',
          zIndex: 9,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
        }}>
          {meta?.name ?? w.type} · {Math.round(w.w)}×{Math.round(w.h)}{w.locked ? ' · locked' : ''}
        </Box>
      )}

      {/* Resize handles when selected */}
      {isSelected && (
        <>
          {/* Corner handles */}
          <Handle data="resize-nw" size={hs} sx={{ top: -hs/2, left: -hs/2, cursor: 'nwse-resize' }} />
          <Handle data="resize-ne" size={hs} sx={{ top: -hs/2, right: -hs/2, cursor: 'nesw-resize' }} />
          <Handle data="resize-sw" size={hs} sx={{ bottom: -hs/2, left: -hs/2, cursor: 'nesw-resize' }} />
          <Handle data="resize-se" size={hs} sx={{ bottom: -hs/2, right: -hs/2, cursor: 'nwse-resize' }} />
          {/* Edge handles */}
          <Handle data="resize-n" size={hs} sx={{ top: -hs/2, left: '50%', ml: -hs/2, cursor: 'ns-resize' }} />
          <Handle data="resize-s" size={hs} sx={{ bottom: -hs/2, left: '50%', ml: -hs/2, cursor: 'ns-resize' }} />
          <Handle data="resize-w" size={hs} sx={{ left: -hs/2, top: '50%', mt: -hs/2, cursor: 'ew-resize' }} />
          <Handle data="resize-e" size={hs} sx={{ right: -hs/2, top: '50%', mt: -hs/2, cursor: 'ew-resize' }} />
        </>
      )}
    </Box>
  );
}

function Handle({ data, size, sx }: { data: string; size: number; sx?: any }) {
  return (
    <Box
      data-handle={data}
      sx={{
        position: 'absolute',
        width: size, height: size,
        bgcolor: '#6c63ff',
        border: `${Math.max(1, size / 5)}px solid #fff`,
        borderRadius: '50%',
        zIndex: 10,
        ...sx,
      }}
    />
  );
}

/** Renders a widget using the lazy-loaded component from the widget map */
function WidgetPreview({ w }: { w: EditorWidget }) {
  const WidgetComponent = WIDGET_LAZY_MAP[w.type];
  if (!WidgetComponent) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666', fontSize: 10, flexDirection: 'column', p: 1 }}>
        <Box sx={{ fontSize: 16, mb: 0.5 }}>◇</Box>
        <Box>{w.type}</Box>
      </Box>
    );
  }
  const widgetConfig: WidgetConfig = {
    id: w.id,
    type: w.type,
    position: { x: w.x, y: w.y, width: w.w, height: w.h, zIndex: w.zIndex },
    config: w.config,
  };
  return <WidgetComponent config={widgetConfig} isEditMode />;
}

/** Extract a JSON object from an AI reply, tolerating code fences and surrounding text. */
/** Build a compact but informative entity snapshot for the AI so it can label
 * controls and set sensible initial values from real state, not just IDs. */
function describeAiEntity(id: string, e: any): string {
  const name = e?.attributes?.friendly_name ?? id;
  const state = e?.state ?? 'unknown';
  let extra = '';
  const domain = String(id).split('.')[0];
  try {
    if (domain === 'light') {
      const b = e.attributes?.brightness;
      const rgb = e.attributes?.rgb_color;
      if (b != null) extra += ` brightness=${b}`;
      if (Array.isArray(rgb)) extra += ` rgb=[${rgb.map((v: number) => Math.round(Number(v))).join(',')}]`;
      if (e.attributes?.color_mode) extra += ` color_mode=${e.attributes.color_mode}`;
    } else if (domain === 'sensor' || domain === 'binary_sensor') {
      if (e.attributes?.unit_of_measurement != null) extra += ` unit=${e.attributes.unit_of_measurement}`;
      if (e.attributes?.device_class) extra += ` class=${e.attributes.device_class}`;
    } else if (domain === 'climate') {
      if (e.attributes?.current_temperature != null) extra += ` current=${e.attributes.current_temperature}`;
      if (e.attributes?.temperature != null) extra += ` target=${e.attributes.temperature}`;
    } else if (domain === 'cover') {
      if (e.attributes?.current_position != null) extra += ` position=${e.attributes.current_position}%`;
    } else if (domain === 'media_player') {
      if (e.attributes?.media_title) extra += ` media="${e.attributes.media_title}"`;
    }
  } catch { /* ignore malformed attribute types */ }
  return `${id} — ${name} [state=${state}${extra}]`;
}

function buildAiEntityContext(entities: Record<string, any>, configured: string[]): { context: string; ids: string } {
  const ids = configured.length ? configured : Object.keys(entities || {}).slice(0, 50);
  const lines = ids.map((id) => describeAiEntity(id, entities?.[id]));
  return { context: lines.join('\n'), ids: ids.join(', ') };
}

/** Correct HA service signatures per domain. Without these the model invents
 * service names/params and every control silently fails. */
const DOMAIN_SERVICE_HINTS: Record<string, string> = {
  light: 'light.turn_on {entity_id, brightness: 0-255, rgb_color: [r,g,b], color_temp_kelvin}, light.turn_off {entity_id}, light.toggle {entity_id}',
  switch: 'switch.turn_on | switch.turn_off | switch.toggle {entity_id}',
  fan: 'fan.turn_on | fan.turn_off | fan.toggle {entity_id}, fan.set_percentage {entity_id, percentage: 0-100}',
  cover: 'cover.open_cover | cover.close_cover | cover.stop_cover {entity_id}, cover.set_cover_position {entity_id, position: 0-100}',
  climate: 'climate.set_temperature {entity_id, temperature}, climate.set_hvac_mode {entity_id, hvac_mode: off|heat|cool|auto}',
  media_player: 'media_player.media_play | media_pause | media_next_track | media_previous_track {entity_id}, media_player.volume_set {entity_id, volume_level: 0-1}',
  lock: 'lock.lock | lock.unlock {entity_id}',
  button: 'button.press {entity_id}',
  scene: 'scene.turn_on {entity_id}',
  script: 'script.turn_on {entity_id}',
  automation: 'automation.trigger | automation.turn_on | automation.turn_off {entity_id}',
  input_boolean: 'input_boolean.turn_on | turn_off | toggle {entity_id}',
  input_number: 'input_number.set_value {entity_id, value}',
  input_select: 'input_select.select_option {entity_id, option}',
  vacuum: 'vacuum.start | vacuum.stop | vacuum.return_to_base {entity_id}',
  humidifier: 'humidifier.turn_on | humidifier.turn_off {entity_id}, humidifier.set_humidity {entity_id, humidity}',
  number: 'number.set_value {entity_id, value}',
  select: 'select.select_option {entity_id, option}',
};

const READ_ONLY_DOMAINS = new Set(['sensor', 'binary_sensor', 'device_tracker', 'sun', 'weather', 'person', 'update']);

function buildServiceHints(ids: string[]): string {
  const domains = Array.from(new Set(ids.map((id) => String(id).split('.')[0])));
  const actionable = domains.filter((d) => DOMAIN_SERVICE_HINTS[d]).map((d) => `- ${DOMAIN_SERVICE_HINTS[d]}`);
  const readOnly = domains.filter((d) => READ_ONLY_DOMAINS.has(d));
  let out = actionable.length ? actionable.join('\n') : '- (no controllable domains among the bound entities)';
  if (readOnly.length) out += `\nRead-only domains (display only, never call services on them): ${readOnly.join(', ')}`;
  return out;
}

/** Syntax-check generated JS before it is applied, so broken code never reaches
 * the widget (where it would fail silently inside the iframe). */
function validateWidgetJs(js: string): string | null {
  if (!js || !js.trim()) return null;
  try {
    // eslint-disable-next-line no-new-func
    new Function(js);
    return null;
  } catch (e) {
    return (e as Error)?.message || 'Syntax error';
  }
}

/** Collect entity-ID-shaped string literals that generated code passes to the
 * CanvasHermes bridge (getState / callService payload / entity_id keys), so
 * references to entities that do not exist can be caught before applying. */
function extractEntityReferences(html: string, js: string): string[] {
  const found = new Set<string>();
  const scan = (text: string) => {
    if (!text) return;
    const patterns = [
      /CanvasHermes\.getState\(\s*['"]([a-z0-9_]+\.[a-z0-9_]+)['"]/gi,
      /entity_id['"]?\s*[:=]\s*['"]([a-z0-9_]+\.[a-z0-9_]+)['"]/gi,
      /CanvasHermes\.callService\(\s*['"][a-z0-9_]+['"]\s*,\s*['"][a-z0-9_]+['"]\s*,\s*\{[^}]*?['"]?entity_id['"]?\s*:\s*['"]([a-z0-9_]+\.[a-z0-9_]+)['"]/gi,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) found.add(m[1]);
    }
  };
  scan(js);
  scan(html);
  return Array.from(found);
}

/** Pull the `<!-- SUMMARY: … -->` line the model was asked to embed in its
 * first changed block, removing it from the content before it is applied. */
function extractAiSummary(parsed: { html?: string; css?: string; js?: string }): {
  parsed: { html?: string; css?: string; js?: string };
  summary?: string;
} {
  for (const key of ['html', 'css', 'js'] as const) {
    const text = parsed[key];
    if (!text) continue;
    const m = text.match(/<!--\s*SUMMARY:\s*([\s\S]*?)-->/i);
    if (m) {
      const cleaned = text.replace(m[0], '').replace(/^\s*\n/, '');
      return {
        parsed: { ...parsed, [key]: cleaned },
        summary: m[1].trim().replace(/\s+/g, ' ') || undefined,
      };
    }
  }
  return { parsed, summary: undefined };
}

/** True when the focused element is a text-entry control (typing must not be hijacked). */
function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return (el as HTMLElement).isContentEditable === true;
}

interface AiHistoryEntry {
  ts: number;
  prompt: string;
  /** One-line change description the model embeds as an HTML comment on edits. */
  summary?: string;
  html: string;
  css: string;
  js: string;
}

/** Right-side inspector panel */
function RightInspector({
  selected, selectedIds, widgets, widgetMeta, canvasWidth, canvasHeight, onUpdate, onDelete, onDuplicate, onLock, onHide,
}: {
  selected: EditorWidget | null;
  selectedIds: string[];
  widgets: EditorWidget[];
  widgetMeta: Record<string, WidgetMetadata>;
  canvasWidth: number;
  canvasHeight: number;
  onUpdate: (patch: any) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onLock: (id: string) => void;
  onHide: (id: string) => void;
}) {
  const { entities } = useWebSocket();
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiEditPrompt, setAiEditPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  // The HTML widget's iframe bridge reports uncaught errors from AI-generated JS.
  // Capturing them here turns a silently-dead widget into something the AI can fix.
  useEffect(() => {
    function onBridgeMessage(ev: MessageEvent) {
      const data = ev.data as any;
      if (data && data.__canvasHermes === true && data.type === 'error' && typeof data.message === 'string') {
        setRuntimeError(data.message);
      }
    }
    window.addEventListener('message', onBridgeMessage);
    return () => window.removeEventListener('message', onBridgeMessage);
  }, []);

  // A newly generated/edited widget starts from a clean slate.
  useEffect(() => { setRuntimeError(null); }, [selected?.id]);

  const history: AiHistoryEntry[] = Array.isArray((selected?.config as any)?.history)
    ? (selected?.config as any).history
    : [];
  const boundEntityCount: number = Array.isArray((selected?.config as any)?.entities)
    ? (selected?.config as any).entities.length
    : 0;

  const runAi = async (prompt: string, mode: 'generate' | 'edit' | 'fix') => {
    if (mode !== 'fix' && !prompt.trim()) return;
    if (aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setAiStatus(mode === 'fix' ? 'Diagnosing runtime error…' : mode === 'edit' ? 'Applying edit…' : 'Generating…');
    try {
      const bound = (selected?.config as any)?.entities;
      const configured = Array.isArray(bound) && bound.length ? bound : [];
      const { context: entityContext, ids: entityIds } = buildAiEntityContext(entities, configured);
      const serviceHints = buildServiceHints(configured.length ? configured : Object.keys(entities || {}).slice(0, 50));
      const knownEntityIds = new Set(Object.keys(entities || {}));
      const curHtml = (selected?.config as any)?.html ?? '';
      const curCss = (selected?.config as any)?.css ?? '';
      const curJs = (selected?.config as any)?.js ?? '';
      const widgetW = Math.round(Number(selected?.w) || 0);
      const widgetH = Math.round(Number(selected?.h) || 0);
      const widgetX = Math.round(Number(selected?.x) || 0);
      const widgetY = Math.round(Number(selected?.y) || 0);
      const sceneW = Math.round(Number(canvasWidth) || 0);
      const sceneH = Math.round(Number(canvasHeight) || 0);
      const recentChanges = history
        .slice(-3)
        .map(h => '- ' + (h.summary || h.prompt))
        .join('\n');

      const baseSystem =
        'You create custom content for a Canvas Core HTML widget. ' +
        'Respond with fenced code blocks labelled `html`, `css`, and `js` ' +
        '(provide an empty block if a section is not needed). ' +
        'Output ONLY the code blocks — no commentary before or after.\n' +
        'CRITICAL: keep each block focused — put CSS only in the `css` block and JS only in the `js` block. ' +
        'Never embed <style> or <script> tags inside the `html` block, and never wrap the output in a full <!DOCTYPE html> document.\n\n' +
        'The js runs inside an iframe with a global "CanvasHermes" API:\n' +
        '- CanvasHermes.getState(entityId) \u2192 {state, attributes, last_changed, last_updated} (undefined if unknown)\n' +
        '- CanvasHermes.getAllStates() \u2192 all entity states keyed by entity_id\n' +
        '- CanvasHermes.configuredEntities \u2192 array of user-bound entity IDs\n' +
        '- CanvasHermes.subscribe(cb) \u2192 cb(states) runs immediately and on every change; returns an unsubscribe fn\n' +
        '- CanvasHermes.callService(domain, service, data) \u2192 Promise\n\n' +
        'RUNTIME CONSTRAINTS (violating these breaks the widget):\n' +
        '- Plain ES5/ES2017 browser JS only. No imports, no modules, no bundlers, no external CDNs or network requests.\n' +
        '- No localStorage/sessionStorage. Keep state in JS variables.\n' +
        '- The document is a bare iframe: your html block is the entire body. Query only elements you created.\n' +
        '- Guard every DOM lookup (element may be null) and every entity read (state may be undefined/"unavailable").\n' +
        '- Render a sensible placeholder before the first entity update arrives; never leave a blank widget.\n\n' +
        'DESIGN GUIDANCE:\n' +
        '- This renders on a wall display: use a restrained palette declared as CSS custom properties, and default to a TRANSPARENT page background (html/body) so the widget blends into the scene beneath it.\n' +
        '- NEVER paint an opaque background on html/body unless the request explicitly asks for a background colour. Give cards and panels translucent rgba backgrounds (e.g. rgba(255,255,255,0.06)) instead.\n' +
        '- NEVER use backdrop-filter (or -webkit-backdrop-filter) inside this widget: Chromium renders it with an opaque white backdrop when the widget background is transparent, turning translucent surfaces light grey. Use rgba fills for the frosted-glass effect instead.\n' +
        '- Use a system font stack only; never reference external fonts, CDNs or network resources.\n' +
        (sceneW > 0 && sceneH > 0
          ? '- SCENE: the full scene canvas is ' + sceneW + 'x' + sceneH + ' px. Your widget is the ' + widgetW + 'x' + widgetH + ' px region at (' + widgetX + ',' + widgetY + ')' +
            (widgetW > 0 && sceneW > 0 ? ' — ' + ((100 * widgetW) / sceneW).toFixed(1) + '% wide × ' + ((100 * widgetH) / sceneH).toFixed(1) + '% tall of the scene' : '') +
            '. Design for that box, not the whole scene.\n'
          : widgetW > 0 && widgetH > 0
            ? '- Your widget is ' + widgetW + 'x' + widgetH + ' px (the iframe viewport is exactly this box).\n'
            : '- The iframe viewport equals the widget box; size typography and spacing relatively.\n') +
        '- CSS pixels inside the iframe equal scene pixels: the finished scene is scaled uniformly to fit the physical screen, so relative sizes stay correct on any display. vh/vw units equal the widget box, not the scene.\n' +
        '- Lay out with %, flex and gap so content reflows at any widget size; never hard-code pixel widths for layout.\n' +
        '- Keep a single #root container in the html block that fills the widget, and re-render it in place from subscribe() instead of rebuilding the DOM every tick.\n\n' +
        'IMPORTANT RULES:\n' +
        '1. You MUST drive the UI from CanvasHermes.subscribe() and act via CanvasHermes.callService().\n' +
        '2. Use the exact entity IDs listed below; never invent IDs.\n' +
        '3. Label controls with the entity friendly name shown in the context.\n' +
        '4. NEVER produce static content \u2014 values must update live from subscribe().\n' +
        '5. Make controls optimistic-safe: reflect the confirmed state from the next subscribe() callback, not just local assumptions.\n' +
        '6. Size layout with %/flex so it fits any widget size; avoid fixed pixel widths and overflow.\n' +
        '7. Make touch targets at least 44px for finger use on wall displays.\n\n' +
        'AVAILABLE SERVICES for the bound domains (use these exact names/params):\n' + serviceHints + '\n\n' +
        'ENTITIES (entity_id \u2014 friendly name [current state + key attrs]). The states shown are a snapshot for context; always read live values via subscribe():\n' +
        (entityContext || 'none') + '\n\n' +
        'Configured entity IDs: ' + (entityIds || 'none') + '.';

      // Mode-aware output contract. Edits/fixes return ONLY the changed
      // blocks (unchanged blocks are preserved by the caller), which keeps
      // outputs short enough to finish and avoids regressions in untouched
      // code. A one-line <!-- SUMMARY: … --> comment documents the change.
      const outputContract = mode === 'generate'
        ? 'OUTPUT: all three blocks (html, css, js), complete and working standalone.'
        : 'OUTPUT: return ONLY the block(s) you actually changed, each as a complete fenced block — omit unchanged blocks entirely, they are kept as-is. ' +
          'Begin the FIRST changed block with a single line: <!-- SUMMARY: one short sentence describing the change -->.';

      let userContent: string;
      if (mode === 'edit') {
        userContent = 'CURRENT HTML:\n' + (curHtml || '(empty)') +
          '\n\nCURRENT CSS:\n' + (curCss || '(empty)') +
          '\n\nCURRENT JS:\n' + (curJs || '(empty)') +
          (recentChanges ? '\n\nRECENT CHANGE REQUESTS (oldest first, for context):\n' + recentChanges : '') +
          '\n\nREQUEST: ' + prompt +
          '\n\n' + outputContract;
      } else if (mode === 'fix') {
        userContent = 'The widget below throws this runtime error in the browser:\n\n' + (runtimeError ?? 'unknown error') +
          '\n\nCURRENT HTML:\n' + (curHtml || '(empty)') +
          '\n\nCURRENT CSS:\n' + (curCss || '(empty)') +
          '\n\nCURRENT JS:\n' + (curJs || '(empty)') +
          (recentChanges ? '\n\nRECENT CHANGE REQUESTS (oldest first, for context):\n' + recentChanges : '') +
          '\n\nDiagnose the cause, fix it, and add defensive guards so the same class of error cannot recur.\n\n' + outputContract;
      } else {
        userContent = prompt + '\n\n' + outputContract;
      }

      const system = mode === 'generate'
        ? baseSystem
        : baseSystem + ' You are EDITING an existing widget; preserve working behaviour and styling that the request does not ask you to change.';

      // One retry absorbs transient provider/network errors instead of
      // surfacing them to the user as a dead end.
      const ask = async (content: string): Promise<string> => {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await coreApi.chatSend(
              [{ role: 'system', content: system }, { role: 'user', content }],
              undefined,
              { disableThinking: true, maxTokens: 16000, noTools: true },
            );
            return r.reply ?? '';
          } catch (err) {
            lastError = err;
            if (attempt === 0) setAiStatus('Transient AI error — retrying…');
          }
        }
        throw lastError;
      };

      // Long answers get cut off by the provider's token limit. While the
      // reply still has an unclosed code fence, ask the model to continue
      // from exactly where it stopped and stitch the pieces together.
      const askComplete = async (content: string): Promise<string> => {
        let reply = await ask(content);
        for (let pass = 0; pass < 2 && looksTruncated(reply); pass++) {
          setAiStatus(`Output was cut off — requesting continuation (${pass + 1}/2)…`);
          const more = await ask(
            'Your previous output was cut off before finishing. Continue EXACTLY where it stopped, starting with the very next character. ' +
            'Do NOT repeat any code you already wrote and add no commentary. If a fenced block was left open, complete it, then close every remaining block.\n\n' +
            'YOUR OUTPUT SO FAR (tail):\n' + reply.slice(-4000),
          );
          if (!more.trim()) break;
          reply = reply + '\n' + more;
        }
        return reply;
      };

      let reply = await askComplete(userContent);
      let parsed = parseAiContent(reply);

      // parseAiContent already recovers a truncated reply (odd fence count)
      // and normalises a single self-contained html block, and askComplete
      // stitched continuations, so only fail when we genuinely got nothing.
      if (!parsed || (parsed.html == null && parsed.css == null && parsed.js == null)) {
        setAiError('The AI response did not contain usable html/css/js. Try a simpler request.');
        return;
      }

      // Pull out the one-line change summary so it never leaks into the markup.
      const summarised = extractAiSummary(parsed);
      parsed = summarised.parsed;
      const summary = summarised.summary;

      // Never apply JS that cannot even parse — give the model one shot to repair it.
      let candidateJs = parsed.js ?? curJs;
      let syntaxError = validateWidgetJs(candidateJs);
      if (syntaxError) {
        setAiStatus('Fixing a syntax error in the generated code…');
        const repairReply = await askComplete(
          'Your previous answer contained JavaScript with a syntax error: ' + syntaxError +
          '\n\nThe JavaScript you returned was:\n' + candidateJs +
          '\n\nReturn the corrected block(s) in fenced code blocks. Ensure the js parses as valid standalone browser JavaScript. Do not repeat unchanged blocks.',
        );
        const repaired = parseAiContent(repairReply);
        const repairedJs = repaired?.js;
        if (repairedJs != null && !validateWidgetJs(repairedJs)) {
          parsed = { html: repaired?.html ?? parsed.html, css: repaired?.css ?? parsed.css, js: repairedJs };
          candidateJs = repairedJs;
          syntaxError = null;
        }
      }
      if (syntaxError) {
        setAiError('AI returned JavaScript with a syntax error and self-repair failed: ' + syntaxError);
        return;
      }

      // Entity references must point at real entities, otherwise the widget
      // renders forever-empty. One repair pass with the authoritative list.
      const unknownRefs = extractEntityReferences(parsed.html ?? '', candidateJs)
        .filter(id => knownEntityIds.size > 0 && !knownEntityIds.has(id));
      if (unknownRefs.length > 0) {
        setAiStatus('Checking entity references…');
        const fixReply = await askComplete(
          'Your code references entity IDs that do not exist on this system: ' + unknownRefs.join(', ') +
          '\n\nValid entity IDs: ' + (Array.from(knownEntityIds).slice(0, 200).join(', ') || 'none') +
          '\n\nCURRENT HTML:\n' + (parsed.html ?? (curHtml || '(empty)')) +
          '\n\nCURRENT CSS:\n' + (parsed.css ?? (curCss || '(empty)')) +
          '\n\nCURRENT JS:\n' + candidateJs +
          '\n\nFix every invalid reference (or derive IDs dynamically from CanvasHermes.configuredEntities) and return ONLY the corrected block(s).',
        );
        const fixed = parseAiContent(fixReply);
        if (fixed) {
          const mergedJs = fixed.js ?? candidateJs;
          const mergedHtml = fixed.html ?? parsed.html;
          const stillBad = extractEntityReferences(mergedHtml ?? '', mergedJs)
            .filter(id => knownEntityIds.size > 0 && !knownEntityIds.has(id));
          if (stillBad.length === 0 && !validateWidgetJs(mergedJs)) {
            parsed = { html: mergedHtml, css: fixed.css ?? parsed.css, js: mergedJs };
            candidateJs = mergedJs;
          }
        }
      }

      const html = parsed.html ?? curHtml;
      const css = parsed.css ?? curCss;
      const js = candidateJs;

      // Auto-bind every real entity the code references into the widget's JS
      // bindings, so CanvasHermes.configuredEntities (and the AI context used
      // by future edits) always matches what the code actually uses — no
      // manual re-picking after generation. User-bound entities are kept.
      const referencedIds = extractEntityReferences(html, js).filter(id => knownEntityIds.has(id));
      const prevEntities: string[] = Array.isArray((selected?.config as any)?.entities)
        ? (selected?.config as any).entities
        : [];
      const mergedEntities = referencedIds.length
        ? Array.from(new Set([...prevEntities, ...referencedIds]))
        : prevEntities;

      const prev = Array.isArray((selected?.config as any)?.history) ? (selected?.config as any).history : [];
      const entry: AiHistoryEntry = {
        ts: Date.now(),
        prompt: mode === 'fix' ? 'Fix: ' + (runtimeError ?? 'runtime error') : prompt,
        summary,
        html,
        css,
        js,
      };
      onUpdate({ config: { html, css, js, entities: mergedEntities, history: [...prev, entry].slice(-50) } });
      setRuntimeError(null);
      if (mode === 'generate') setAiPrompt('');
      else if (mode === 'edit') setAiEditPrompt('');
    } catch (e) {
      setAiError((e as Error)?.message || 'AI generation failed');
    } finally {
      setAiStatus(null);
      setAiLoading(false);
    }
  };

  const restoreHistory = (entry: AiHistoryEntry) => {
    onUpdate({ config: { html: entry.html, css: entry.css, js: entry.js } });
  };

  return (
    <Box sx={{
      width: 280, flexShrink: 0, bgcolor: 'background.paper',
      borderLeft: 1, borderColor: 'divider', overflowY: 'auto',
    }}>
      {selectedIds.length > 1 ? (
        // Multi-selection info
        <Box sx={{ p: 1.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Multi-selection
          </Typography>
          <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary' }}>
            {selectedIds.length} widgets selected
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" startIcon={<DeleteIcon />} onClick={onDelete} color="error" sx={{ textTransform: 'none' }}>
              Delete
            </Button>
            <Button size="small" variant="outlined" onClick={onDuplicate} sx={{ textTransform: 'none' }}>
              Duplicate
            </Button>
          </Stack>
        </Box>
      ) : selected ? (
        <Box sx={{ p: 1.5 }}>
          {/* Header */}
          <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
              Inspector
            </Typography>
            <Tooltip title="Duplicate">
              <IconButton size="small" onClick={onDuplicate}><ContentCopyIcon fontSize="small" /></IconButton>
            </Tooltip>
            <Tooltip title={selected.locked ? 'Unlock' : 'Lock'}>
              <IconButton size="small" onClick={() => onLock(selected.id)}>
                {selected.locked ? <LockIcon fontSize="small" /> : <LockOpenIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton size="small" onClick={onDelete}><DeleteIcon fontSize="small" /></IconButton>
            </Tooltip>
          </Stack>

          <Typography variant="caption" sx={{ color: 'text.disabled', fontFamily: 'monospace', fontSize: 10, mb: 1, display: 'block' }}>
            {(widgetMeta[selected.type]?.name ?? selected.type)} · {selected.id.slice(0, 8)}
          </Typography>

          {/* Layout section */}
          <Accordion defaultExpanded disableGutters sx={{ bgcolor: 'transparent', backgroundImage: 'none', boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 16 }} />} sx={{ minHeight: 32, px: 0, py: 0, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
              <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>Layout</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0, pb: 1, pt: 0 }}>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1}>
                  <TextField label="X" type="number" size="small" value={selected.x}
                    onChange={e => onUpdate({ x: Number(e.target.value) })}
                    slotProps={{ htmlInput: { step: 20, min: 0 } }} sx={{ flex: 1 }} />
                  <TextField label="Y" type="number" size="small" value={selected.y}
                    onChange={e => onUpdate({ y: Number(e.target.value) })}
                    slotProps={{ htmlInput: { step: 20, min: 0 } }} sx={{ flex: 1 }} />
                </Stack>
                <Stack direction="row" spacing={1}>
                  <TextField label="W" type="number" size="small" value={selected.w}
                    onChange={e => onUpdate({ w: Math.max(20, Number(e.target.value)) })}
                    slotProps={{ htmlInput: { step: 20, min: 20 } }} sx={{ flex: 1 }} />
                  <TextField label="H" type="number" size="small" value={selected.h}
                    onChange={e => onUpdate({ h: Math.max(20, Number(e.target.value)) })}
                    slotProps={{ htmlInput: { step: 20, min: 20 } }} sx={{ flex: 1 }} />
                </Stack>
                <TextField label="Layer (Z)" type="number" size="small" value={selected.zIndex}
                  onChange={e => onUpdate({ zIndex: Number(e.target.value) })}
                  slotProps={{ htmlInput: { step: 1 } }} />
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <FormControlLabel
                    control={<MuiSwitch size="small" checked={!selected.locked} onChange={() => onLock(selected.id)} />}
                    label={<Typography variant="caption">Locked</Typography>}
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: 11 } }}
                  />
                  <FormControlLabel
                    control={<MuiSwitch size="small" checked={!selected.hidden} onChange={() => onHide(selected.id)} />}
                    label={<Typography variant="caption">Visible</Typography>}
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: 11 } }}
                  />
                </Stack>
              </Stack>
            </AccordionDetails>
          </Accordion>

          <Divider />

          {/* Widget-specific fields */}
          {widgetMeta[selected.type]?.fields.filter(f => f.category === 'behavior').length > 0 && (
            <Accordion defaultExpanded disableGutters sx={{ bgcolor: 'transparent', backgroundImage: 'none', boxShadow: 'none', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 16 }} />} sx={{ minHeight: 32, px: 0, py: 0, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>Behavior</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0, pb: 1, pt: 0 }}>
                <Stack spacing={1.25}>
                  {widgetMeta[selected.type]?.fields
                    .filter(f => f.category === 'behavior')
                                        .map(f => (
                                          <FieldInput key={f.name} field={f} value={selected.config[f.name]} onChange={(v) => onUpdate({ config: { [f.name]: v } })} />
                                        ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          )}

          {/* Style fields */}
          {widgetMeta[selected.type]?.fields.filter(f => f.category === 'style').length > 0 && (
            <Accordion defaultExpanded disableGutters sx={{ bgcolor: 'transparent', backgroundImage: 'none', boxShadow: 'none', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 16 }} />} sx={{ minHeight: 32, px: 0, py: 0, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>Style</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0, pb: 1, pt: 0 }}>
                <Stack spacing={1.25}>
                  {widgetMeta[selected.type]?.fields
                    .filter(f => f.category === 'style')
                                        .map(f => (
                                          <FieldInput key={f.name} field={f} value={selected.config[f.name]} onChange={(v) => onUpdate({ config: { [f.name]: v } })} />
                                        ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          )}

          {(!widgetMeta[selected.type]?.fields || widgetMeta[selected.type].fields.length === 0) && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No configurable properties.</Typography>
          )}

          {selected.type === 'html' && (
            <Accordion defaultExpanded disableGutters sx={{ mt: 1, bgcolor: 'transparent', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">AI Builder</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <TextField
                  fullWidth
                  multiline
                  minRows={2}
                  size="small"
                  placeholder="Describe the dashboard you want, e.g. 'Energy usage gauge bound to sensor.power'"
                  label="Generate from scratch"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                />
                <Button
                  fullWidth
                  variant="contained"
                  size="small"
                  sx={{ mt: 1, textTransform: 'none' }}
                  disabled={aiLoading || !aiPrompt.trim()}
                  onClick={() => runAi(aiPrompt, 'generate')}
                >
                  {aiLoading ? 'Working…' : 'Generate'}
                </Button>

                <TextField
                  fullWidth
                  multiline
                  minRows={2}
                  size="small"
                  sx={{ mt: 1.5 }}
                  placeholder="Describe the change, e.g. 'make the title red and add a timestamp'"
                  label="Edit current content"
                  value={aiEditPrompt}
                  onChange={(e) => setAiEditPrompt(e.target.value)}
                />
                <Button
                  fullWidth
                  variant="outlined"
                  size="small"
                  sx={{ mt: 1, textTransform: 'none' }}
                  disabled={aiLoading || !aiEditPrompt.trim()}
                  onClick={() => runAi(aiEditPrompt, 'edit')}
                >
                  {aiLoading ? 'Working…' : 'Apply Edit'}
                </Button>

                {aiError && (
                  <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
                    {aiError}
                  </Typography>
                )}
                {aiLoading && aiStatus && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    {aiStatus}
                  </Typography>
                )}
                {runtimeError && (
                  <Box sx={{ mt: 1.5, p: 1, borderRadius: 1, border: 1, borderColor: 'warning.main' }}>
                    <Typography variant="caption" color="warning.main" sx={{ display: 'block', fontWeight: 600 }}>
                      Widget runtime error
                    </Typography>
                    <Typography variant="caption" sx={{ display: 'block', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 10, mt: 0.5 }}>
                      {runtimeError}
                    </Typography>
                    <Button
                      fullWidth
                      size="small"
                      variant="outlined"
                      color="warning"
                      sx={{ mt: 1, textTransform: 'none' }}
                      disabled={aiLoading}
                      onClick={() => runAi('', 'fix')}
                    >
                      {aiLoading ? 'Working…' : 'Fix with AI'}
                    </Button>
                  </Box>
                )}
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                  Uses Canvas Core's LLM to fill the HTML / CSS / JS fields. Edits return only the changed blocks —
                  unchanged code is preserved.{' '}
                  {boundEntityCount > 0
                    ? `${boundEntityCount} entit${boundEntityCount === 1 ? 'y' : 'ies'} bound for AI context. `
                    : ''}
                  Entities referenced by generated code are bound automatically.
                </Typography>

                {history.length > 0 && (
                  <Accordion disableGutters sx={{ mt: 1, bgcolor: 'transparent', '&:before': { display: 'none' } }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 28 }}>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>History ({history.length})</Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ px: 0 }}>
                      <Stack spacing={0.75}>
                        {history.slice().reverse().map((h, i) => (
                          <Box key={h.ts + '-' + i} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.75 }}>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                              {new Date(h.ts).toLocaleString()}
                            </Typography>
                            <Typography variant="caption" sx={{ display: 'block', mb: 0.5, fontSize: 11 }}>
                              {h.summary || h.prompt}
                            </Typography>
                            {h.summary && (
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, fontSize: 10 }}>
                                {h.prompt}
                              </Typography>
                            )}
                            <Button size="small" variant="text" sx={{ textTransform: 'none', minHeight: 0, p: 0, fontSize: 11 }} onClick={() => restoreHistory(h)}>
                              Restore this version
                            </Button>
                          </Box>
                        ))}
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                )}
              </AccordionDetails>
            </Accordion>
          )}
        </Box>
      ) : (
        <Box sx={{ p: 1.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5, mb: 1, display: 'block' }}>
            Inspector
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {widgets.length === 0
              ? 'Add a widget from the palette to get started.'
              : 'Click a widget to select and edit it.'}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

/** Render a single field input based on its type */
function FieldInput({ field, value, onChange }: { field: FieldMetadata; value: any; onChange: (v: any) => void }) {
  const val = value ?? field.default ?? '';
  // Be defensive about older/custom widget metadata. Entity and font fields
  // still receive rich pickers even if a plugin declared them as plain text.
  const isEntityField = field.type === 'entity'
    || /(?:entity|entity_id|entityId)$/i.test(field.name);
  const isFontField = field.type === 'font'
    || /^fontFamily/i.test(field.name);

  if (isEntityField) {
    return (
      <CoreEntityPicker
        label={field.label}
        value={String(val)}
        domains={field.domains}
        onChange={onChange}
      />
    );
  }
  if (isFontField) {
    return <FontFamilyPicker label={field.label} value={String(val)} onChange={onChange} />;
  }

  switch (field.type) {
    case 'number':
      return (
        <TextField
          label={field.label}
          type="number"
          size="small"
          fullWidth
          value={val}
          onChange={e => onChange(Number(e.target.value))}
          slotProps={{ htmlInput: { min: field.min, max: field.max, step: field.step ?? 1 } }}
        />
      );
    case 'text':
      return (
        <TextField
          label={field.label}
          size="small"
          fullWidth
          value={val}
          onChange={e => onChange(e.target.value)}
          placeholder={field.description}
        />
      );
    case 'textarea':
      return (
        <TextField
          label={field.label}
          size="small"
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          value={val}
          onChange={e => onChange(e.target.value)}
          placeholder={field.description}
        />
      );
    case 'color': {
      // 'transparent' is a first-class value: the swatch greys out, the text
      // field keeps the literal value, and the None button toggles it.
      const isTransparent = val === 'transparent';
      const swatchValue = isTransparent || !val ? '#000000' : val;
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <input
            type="color"
            value={swatchValue}
            onChange={e => onChange(e.target.value)}
            disabled={isTransparent}
            style={{ width: 32, height: 28, padding: 0, border: 'none', borderRadius: 4, cursor: isTransparent ? 'not-allowed' : 'pointer', background: 'none', opacity: isTransparent ? 0.3 : 1, flexShrink: 0 }}
          />
          <TextField
            label={field.label}
            size="small"
            fullWidth
            value={val}
            placeholder={typeof field.default === 'string' && field.default ? field.default : '#ffffff'}
            onChange={e => onChange(e.target.value)}
            slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
          <Tooltip title="Toggle a fully transparent background">
            <Button
              size="small"
              variant={isTransparent ? 'contained' : 'outlined'}
              onClick={() => onChange(isTransparent ? '#ffffff' : 'transparent')}
              sx={{ minWidth: 0, px: 1, textTransform: 'none', fontSize: 11, flexShrink: 0 }}
            >
              None
            </Button>
          </Tooltip>
        </Stack>
      );
    }
    case 'select':
      return (
        <FormControl fullWidth size="small">
          <InputLabel>{field.label}</InputLabel>
          <Select label={field.label} value={String(val)} onChange={e => onChange(e.target.value)}>
            {(field.options ?? []).map(o => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </Select>
        </FormControl>
      );
    case 'checkbox':
      return (
        <FormControlLabel
          control={<Checkbox size="small" checked={!!val} onChange={e => onChange(e.target.checked)} />}
          label={<Typography variant="body2" sx={{ fontSize: 12 }}>{field.label}</Typography>}
        />
      );
    case 'slider':
      return (
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>{field.label}</Typography>
          <MuiSlider
            size="small"
            value={typeof val === 'number' ? val : (field.default ?? 0)}
            min={field.min ?? 0}
            max={field.max ?? 1}
            step={field.step ?? 0.05}
            onChange={(_e, v) => onChange(v)}
            sx={{ color: 'primary.main' }}
          />
        </Box>
      );
    case 'icon':
      return (
        <TextField
          label={field.label}
          size="small"
          fullWidth
          value={val}
          onChange={e => onChange(e.target.value)}
          placeholder={field.description || 'mdi:icon-name'}
        />
      );
    case 'code-editor':
      return <CodeEditorField field={field} val={val} onChange={onChange} />;
    case 'entity-list': {
      const list: string[] = Array.isArray(val) ? val : [];
      const addEntity = (id: string) => {
        if (id && !list.includes(id)) onChange([...list, id]);
      };
      const removeEntity = (id: string) => onChange(list.filter(x => x !== id));
      return (
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
            {field.label}
          </Typography>
          <CoreEntityPicker label="Add entity" value="" domains={field.domains} onChange={addEntity} />
          <Stack spacing={0.5} sx={{ mt: 0.75 }}>
            {list.length === 0 && (
              <Typography variant="caption" color="text.secondary">No entities added yet.</Typography>
            )}
            {list.map(id => (
              <Chip
                key={id}
                label={id}
                size="small"
                onDelete={() => removeEntity(id)}
                sx={{ alignSelf: 'flex-start', maxWidth: '100%' }}
              />
            ))}
          </Stack>
        </Box>
      );
    }
    case 'file':
      return (
        <Button
          size="small"
          variant="outlined"
          fullWidth
          component="label"
          sx={{ textTransform: 'none' }}
        >
          {val ? 'Change file' : 'Upload file'}
          <input type="file" hidden onChange={e => {
            const file = e.target.files?.[0];
            if (file) onChange(file.name);
          }} />
        </Button>
      );
    default:
      return (
        <TextField
          label={field.label}
          size="small"
          fullWidth
          value={val}
          onChange={e => onChange(e.target.value)}
        />
      );
  }
}

const FONT_OPTIONS = [
  { label: 'Inter', value: '"Inter", sans-serif', category: 'Modern Sans' },
  { label: 'Roboto', value: '"Roboto", sans-serif', category: 'Modern Sans' },
  { label: 'Open Sans', value: '"Open Sans", sans-serif', category: 'Modern Sans' },
  { label: 'Lato', value: '"Lato", sans-serif', category: 'Modern Sans' },
  { label: 'Montserrat', value: '"Montserrat", sans-serif', category: 'Modern Sans' },
  { label: 'Poppins', value: '"Poppins", sans-serif', category: 'Modern Sans' },
  { label: 'Nunito', value: '"Nunito", sans-serif', category: 'Modern Sans' },
  { label: 'Source Sans 3', value: '"Source Sans 3", sans-serif', category: 'Modern Sans' },
  { label: 'Ubuntu', value: '"Ubuntu", sans-serif', category: 'Modern Sans' },
  { label: 'Noto Sans', value: '"Noto Sans", sans-serif', category: 'Modern Sans' },
  { label: 'Arial', value: 'Arial, sans-serif', category: 'System Sans' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif', category: 'System Sans' },
  { label: 'Verdana', value: 'Verdana, sans-serif', category: 'System Sans' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", sans-serif', category: 'System Sans' },
  { label: 'Tahoma', value: 'Tahoma, sans-serif', category: 'System Sans' },
  { label: 'Arial Narrow', value: '"Arial Narrow", sans-serif', category: 'System Sans' },
  { label: 'Liberation Sans', value: '"Liberation Sans", sans-serif', category: 'Linux' },
  { label: 'DejaVu Sans', value: '"DejaVu Sans", sans-serif', category: 'Linux' },
  { label: 'Noto Serif', value: '"Noto Serif", serif', category: 'Serif' },
  { label: 'Georgia', value: 'Georgia, serif', category: 'Serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif', category: 'Serif' },
  { label: 'Garamond', value: 'Garamond, serif', category: 'Serif' },
  { label: 'Palatino', value: 'Palatino, serif', category: 'Serif' },
  { label: 'Merriweather', value: '"Merriweather", serif', category: 'Serif' },
  { label: 'Playfair Display', value: '"Playfair Display", serif', category: 'Serif' },
  { label: 'Roboto Mono', value: '"Roboto Mono", monospace', category: 'Monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace', category: 'Monospace' },
  { label: 'Fira Code', value: '"Fira Code", monospace', category: 'Monospace' },
  { label: 'Source Code Pro', value: '"Source Code Pro", monospace', category: 'Monospace' },
  { label: 'Courier New', value: '"Courier New", monospace', category: 'Monospace' },
  { label: 'Liberation Mono', value: '"Liberation Mono", monospace', category: 'Linux' },
  { label: 'DejaVu Sans Mono', value: '"DejaVu Sans Mono", monospace', category: 'Linux' },
  { label: 'DSEG7 Classic', value: '"DSEG7 Classic", monospace', category: 'Display' },
  { label: 'DSEG14 Classic', value: '"DSEG14 Classic", monospace', category: 'Display' },
  { label: 'Orbitron', value: '"Orbitron", sans-serif', category: 'Display' },
  { label: 'Saira Extra Condensed', value: '"Saira Extra Condensed", sans-serif', category: 'Display' },
  { label: 'Bebas Neue', value: '"Bebas Neue", sans-serif', category: 'Display' },
  { label: 'Oswald', value: '"Oswald", sans-serif', category: 'Display' },
  { label: 'Pacifico', value: '"Pacifico", cursive', category: 'Decorative' },
  { label: 'Comic Sans MS', value: '"Comic Sans MS", cursive', category: 'Decorative' },
];

function FontFamilyPicker({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customValue, setCustomValue] = useState(value);
  const filteredFonts = FONT_OPTIONS.filter((font) =>
    `${font.label} ${font.category}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <Button
        fullWidth
        size="small"
        variant="outlined"
        startIcon={<TextFieldsIcon />}
        onClick={() => { setCustomValue(value); setOpen(true); }}
        sx={{ justifyContent: 'flex-start', textTransform: 'none', fontFamily: value || 'inherit' }}
      >
        {FONT_OPTIONS.find((font) => font.value === value)?.label || value || 'Choose font…'}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{label}</DialogTitle>
        <DialogContent dividers>
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <TextField
              autoFocus
              fullWidth
              size="small"
              label="Search fonts"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{ input: { startAdornment: <SearchIcon sx={{ mr: 1, color: 'text.secondary' }} /> } }}
            />
            <TextField
              fullWidth
              size="small"
              label="Custom CSS font-family"
              value={customValue}
              onChange={(event) => setCustomValue(event.target.value)}
              sx={{ '& input': { fontFamily: customValue || 'inherit' } }}
            />
          </Stack>
          <List sx={{ maxHeight: 520, overflow: 'auto' }}>
            {filteredFonts.map((font) => {
              const primaryFamily = font.value.split(',')[0].trim();
              const available = typeof document === 'undefined' || document.fonts.check(`16px ${primaryFamily}`);
              return (
                <ListItem
                  key={font.value}
                  disablePadding
                  secondaryAction={<Chip size="small" label={available ? 'Available' : 'Fallback'} color={available ? 'success' : 'default'} />}
                >
                  <ListItemButton
                    selected={value === font.value}
                    onClick={() => { onChange(font.value); setOpen(false); }}
                  >
                    <ListItemText
                      primary={`${font.label} — The quick brown fox 012345`}
                      secondary={`${font.category} · ${font.value}`}
                      slotProps={{ primary: { sx: { fontFamily: font.value, fontSize: 18 } } }}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!customValue.trim()}
            onClick={() => { onChange(customValue.trim()); setOpen(false); }}
          >
            Use custom font
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function CoreEntityPicker({ label, value, domains, onChange }: {
  label: string;
  value: string;
  domains?: string[];
  onChange: (value: string) => void;
}) {
  const [entities, setEntities] = useState<HaEntityCatalogueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('all');
  const [pendingValue, setPendingValue] = useState(value);
  const handleEntitySearch = (input: string) => {
    setSearch(input);
    // If the input resembles an HA entity ID, retain it as the manual value so
    // Enter/Select still works for entities not yet present in the cache.
    if (/^[a-z0-9_]+\.[a-z0-9_]*$/i.test(input.trim())) {
      setPendingValue(input.trim());
    }
  };
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await coreApi.haEntities();
      setEntities(result.entities);
      setStatus({ configured: result.configured, connected: result.connected });
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ApiError && error.status === 401
        ? 'Your admin session has expired. Log in again to load Home Assistant entities.'
        : error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await coreApi.refreshHaEntities();
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const availableEntities = domains?.length
    ? entities.filter((entity) => domains.includes(entity.domain))
    : entities;
  const selected = entities.find((entity) => entity.entity_id === value) ?? null;
  const matchingEntities = availableEntities.filter((entity) => {
    if (domain !== 'all' && entity.domain !== domain) return false;
    const term = search.toLowerCase();
    return !term
      || entity.entity_id.toLowerCase().includes(term)
      || (entity.friendly_name ?? '').toLowerCase().includes(term)
      || entity.state.toLowerCase().includes(term);
  });
  const availableDomains = [...new Set(availableEntities.map((entity) => entity.domain))].sort();
  return (
    <>
      <Button
        fullWidth
        size="small"
        variant="outlined"
        startIcon={<SensorsIcon />}
        onClick={() => { setPendingValue(value); setSearch(''); setDomain('all'); setOpen(true); }}
        sx={{ justifyContent: 'flex-start', textTransform: 'none', fontFamily: 'monospace' }}
      >
        {selected?.friendly_name ? `${selected.friendly_name} · ${value}` : value || `Choose ${label.toLowerCase()}…`}
      </Button>
      <Typography variant="caption" color="text.secondary">
        {status ? `${availableEntities.length} entities · ${status.connected ? 'HA live' : 'cached'}` : 'Loading entities…'}
      </Typography>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Select {label}</DialogTitle>
        <DialogContent dividers>
          {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <TextField
              autoFocus
              fullWidth
              size="small"
              label="Search name, entity ID or state"
              value={search}
              onChange={(event) => handleEntitySearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && matchingEntities.length === 1) {
                  event.preventDefault();
                  setPendingValue(matchingEntities[0].entity_id);
                }
              }}
              slotProps={{ input: { startAdornment: <SearchIcon sx={{ mr: 1, color: 'text.secondary' }} /> } }}
            />
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>Domain</InputLabel>
              <Select value={domain} label="Domain" onChange={(event) => setDomain(event.target.value)}>
                <MenuItem value="all">All domains</MenuItem>
                {availableDomains.map((item) => <MenuItem key={item} value={item}>{item}</MenuItem>)}
              </Select>
            </FormControl>
            <Tooltip title="Refresh from Home Assistant">
              <span>
                <IconButton disabled={refreshing || status?.configured === false} onClick={() => void refresh()}>
                  {refreshing ? <CircularProgress size={18} /> : <RefreshIcon />}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          <List sx={{ maxHeight: 500, overflow: 'auto' }}>
            {loading && <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}><CircularProgress /></Box>}
            {!loading && matchingEntities.slice(0, 500).map((entity) => (
              <ListItemButton
                key={entity.entity_id}
                selected={pendingValue === entity.entity_id}
                onClick={() => setPendingValue(entity.entity_id)}
              >
                <ListItemText
                  primary={entity.friendly_name || entity.entity_id}
                  secondary={`${entity.entity_id} · ${entity.state}`}
                  slotProps={{ secondary: { sx: { fontFamily: 'monospace' } } }}
                />
                <Chip size="small" label={entity.domain} />
              </ListItemButton>
            ))}
            {!loading && matchingEntities.length === 0 && (
              <ListItem><ListItemText primary="No matching entities" /></ListItem>
            )}
          </List>
          {matchingEntities.length > 500 && (
            <Typography variant="caption" color="text.secondary">
              Showing the first 500 matches. Refine the search to narrow the list.
            </Typography>
          )}
          <TextField
            fullWidth
            size="small"
            label="Selected or manual entity ID"
            value={pendingValue}
            onChange={(event) => {
              setPendingValue(event.target.value);
              setSearch(event.target.value);
            }}
            helperText="Typing here also searches the entity catalogue."
            sx={{ mt: 2, '& input': { fontFamily: 'monospace' } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingValue('')}>Clear</Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => { onChange(pendingValue); setOpen(false); }}>Select entity</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/** Save / load dialog */
function SaveLoadDialog({
  open, scenes, currentSceneId, onClose, onSave, onLoad,
}: {
  open: boolean;
  scenes: SceneRecord[];
  currentSceneId: string | null;
  onClose: () => void;
  onSave: (name: string, existingId?: string) => Promise<void>;
  onLoad: (sceneId: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'new' | 'stage' | 'load'>('new');
  const [name, setName] = useState('New scene');
  const [existingId, setExistingId] = useState('');
  const [loadId, setLoadId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode(currentSceneId ? 'stage' : 'new');
      setName('New scene');
      setExistingId(currentSceneId ?? '');
      setLoadId('');
      setErr(null);
    }
  }, [open, currentSceneId]);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      if (mode === 'load') {
        await onLoad(loadId);
      } else if (mode === 'new') {
        await onSave(name);
      } else {
        await onSave('', existingId);
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Save / Load scene</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, v) => { if (v) setMode(v); }}>
            <ToggleButton value="new" size="small">New scene</ToggleButton>
            <ToggleButton value="stage" size="small" disabled={!currentSceneId}>Stage revision</ToggleButton>
            <ToggleButton value="load" size="small">Load existing</ToggleButton>
          </ToggleButtonGroup>

          {mode === 'new' && (
            <TextField label="Scene name" value={name} onChange={e => setName(e.target.value)} size="small" fullWidth autoFocus />
          )}

          {mode === 'stage' && (
            <FormControl fullWidth size="small">
              <InputLabel>Scene</InputLabel>
              <Select label="Scene" value={existingId} onChange={e => setExistingId(e.target.value)}>
                {scenes.length === 0 && <MenuItem value="" disabled>No scenes</MenuItem>}
                {scenes.map(s => <MenuItem key={s.id} value={s.id}>{s.name} (rev {s.revision})</MenuItem>)}
              </Select>
            </FormControl>
          )}

          {mode === 'load' && (
            <FormControl fullWidth size="small">
              <InputLabel>Load scene</InputLabel>
              <Select label="Load scene" value={loadId} onChange={e => setLoadId(e.target.value)}>
                {scenes.length === 0 && <MenuItem value="" disabled>No scenes</MenuItem>}
                {scenes.map(s => <MenuItem key={s.id} value={s.id}>{s.name} (rev {s.revision} · {s.status})</MenuItem>)}
              </Select>
            </FormControl>
          )}

          {err && <Alert severity="error" sx={{ bgcolor: 'rgba(242,139,130,0.1)' }}>{err}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Cancel</Button>
        <Button size="small" variant="contained" onClick={submit} disabled={busy || (mode === 'load' && !loadId)}>
          {busy ? 'Working...' : mode === 'load' ? 'Load' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
