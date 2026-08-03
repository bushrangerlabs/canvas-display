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
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
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
import { PageHeader, ErrorBanner } from '../components/ui';
import { WIDGET_CATALOG, CATEGORY_ORDER, CATEGORY_LABELS, type WidgetMetadata, type FieldMetadata } from '../widgets/widget-catalog';
import { WIDGET_LAZY_MAP } from '../widgets/WidgetRenderer';
import type { WidgetConfig } from '../widgets/types/index';


// ── Constants ─────────────────────────────────────────────────────────────────

const GRID = 20;
const CANVAS_W = 800;
const CANVAS_H = 480;
const MIN_WIDGET_SIZE = 20;
const HANDLE_SIZE = 10;

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

// ── Main Component ────────────────────────────────────────────────────────────

export default function EditorPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSceneId = searchParams.get('scene');
  // Widget state
  const [widgets, setWidgets] = useState<EditorWidget[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nextZ, setNextZ] = useState(1);
  const [snap, setSnap] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canvasPan, setCanvasPan] = useState<CanvasPan>({ panX: 0, panY: 0, zoom: 1 });

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

  // Alignment guides
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const spaceBarRef = useRef(false);
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
    setNextZ(z => z + nextZ + newWidgets.length);
    setWidgets(prev => [...prev, ...newWidgets]);
    setSelectedIds(newIds);
  }

  function moveSelected(dx: number, dy: number) {
    if (selectedIds.length === 0) return;
    pushHistory(widgets);
    setWidgets(prev => prev.map(w => {
      if (!selectedIds.includes(w.id)) return w;
      let nx = snap ? snapTo(w.x + dx) : w.x + dx;
      let ny = snap ? snapTo(w.y + dy) : w.y + dy;
      nx = clamp(nx, 0, CANVAS_W - w.w);
      ny = clamp(ny, 0, CANVAS_H - w.h);
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

  // ── Drag logic ────────────────────────────────────────────────────────────



  const onPointerDown = useCallback((e: React.PointerEvent, widgetId: string) => {
    const w = widgets.find(x => x.id === widgetId);
    if (!w || w.locked) return;
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
      setWidgets(prev => prev.map(w => {
        if (!d.ids.includes(w.id)) return w;
        const o = d.origins[w.id];
        let nx = o.x + dx;
        let ny = o.y + dy;
        if (snap) { nx = snapTo(nx); ny = snapTo(ny); }
        nx = clamp(nx, 0, CANVAS_W - w.w);
        ny = clamp(ny, 0, CANVAS_H - w.h);

        // Alignment guides — check against stationary widgets
        for (const other of prev) {
          if (d.ids.includes(other.id)) continue;
          const threshold = 5 / (canvasPan.zoom || 1);
          // Vertical align: same x
          if (Math.abs(nx - other.x) < threshold) {
            newGuides.x = other.x;
            nx = other.x;
          }
          // Horizontal align: same y
          if (Math.abs(ny - other.y) < threshold) {
            newGuides.y = other.y;
            ny = other.y;
          }
          // Same width align (right edge)
          if (typeof other.x === 'number' && Math.abs(nx + w.w - (other.x + other.w)) < threshold) {
            newGuides.x = other.x + other.w - w.w;
            nx = other.x + other.w - w.w;
          }
          // Same height align (bottom edge)
          if (Math.abs(ny + w.h - (other.y + other.h)) < threshold) {
            newGuides.y = other.y + other.h - w.h;
            ny = other.y + other.h - w.h;
          }
        }
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
        nw = Math.max(minW, Math.min(nw, CANVAS_W - nx));
        nh = Math.max(minH, Math.min(nh, CANVAS_H - ny));
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

  function handleWheel(e: React.WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setCanvasPan(prev => ({
        ...prev,
        zoom: clamp(prev.zoom - e.deltaY * 0.001, 0.25, 3),
      }));
    } else {
      setCanvasPan(prev => ({
        ...prev,
        panX: prev.panX - e.deltaX,
        panY: prev.panY - e.deltaY,
      }));
    }
  }

  // Spacebar hand panning
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space') { spaceBarRef.current = true; e.preventDefault(); }
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
      if (e.code === 'Space') spaceBarRef.current = false;
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, [selectedIds, widgets, snap]);

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
    const manifest: SceneManifest = { widgets };
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
          sx={{ flex: 1, overflow: 'hidden', position: 'relative' }}
          onWheel={handleWheel}
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
              width: CANVAS_W,
              height: CANVAS_H,
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
                />
              ))}

            {/* Alignment guides */}
            {guides.x !== undefined && (
              <Box sx={{ position: 'absolute', left: guides.x, top: 0, width: 1, height: CANVAS_H, bgcolor: '#6c63ff', zIndex: 9999, pointerEvents: 'none', opacity: 0.8 }} />
            )}
            {guides.y !== undefined && (
              <Box sx={{ position: 'absolute', left: 0, top: guides.y, width: CANVAS_W, height: 1, bgcolor: '#6c63ff', zIndex: 9999, pointerEvents: 'none', opacity: 0.8 }} />
            )}
          </Box>

          {/* Zoom indicator */}
          <Box sx={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', alignItems: 'center', gap: 0.5, zIndex: 10 }}>
            <IconButton size="small" onClick={() => setCanvasPan(p => ({ ...p, zoom: clamp(p.zoom - 0.1, 0.25, 3) }))}>
              <ZoomOutIcon fontSize="small" />
            </IconButton>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 36, textAlign: 'center' }}>
              {Math.round(canvasPan.zoom * 100)}%
            </Typography>
            <IconButton size="small" onClick={() => setCanvasPan(p => ({ ...p, zoom: clamp(p.zoom + 0.1, 0.25, 3) }))}>
              <ZoomInIcon fontSize="small" />
            </IconButton>
          </Box>
        </Box>

        {/* ── Right sidebar: Inspector ── */}
        <RightInspector
          selected={selected}
          selectedIds={selectedIds}
          widgets={widgets}
          widgetMeta={WIDGET_META_CACHE}
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
  w, isSelected, onPointerDown,
}: {
  w: EditorWidget;
  isSelected: boolean;
  zoom: number;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const meta = WIDGET_CATALOG[w.type];
  return (
    <Box
      onPointerDown={onPointerDown}
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
        outline: isSelected ? '2px solid #6c63ff' : '1px solid rgba(255,255,255,0.12)',
        pointerEvents: 'none',
        zIndex: 8,
        '&:hover': { outlineColor: isSelected ? '#6c63ff' : 'rgba(108,99,255,0.55)' },
      }} />
      {isSelected && (
        <Box sx={{
          position: 'absolute',
          left: 0,
          top: -16,
          color: 'text.secondary',
          bgcolor: 'background.paper',
          px: 0.5,
          fontSize: 9,
          lineHeight: '14px',
          pointerEvents: 'none',
          zIndex: 9,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}>
          {meta?.name ?? w.type}{w.locked ? ' · locked' : ''}
        </Box>
      )}

      {/* Resize handles when selected */}
      {isSelected && (
        <>
          {/* Corner handles */}
          <Handle data="resize-nw" sx={{ top: -HANDLE_SIZE/2, left: -HANDLE_SIZE/2, cursor: 'nwse-resize' }} />
          <Handle data="resize-ne" sx={{ top: -HANDLE_SIZE/2, right: -HANDLE_SIZE/2, cursor: 'nesw-resize' }} />
          <Handle data="resize-sw" sx={{ bottom: -HANDLE_SIZE/2, left: -HANDLE_SIZE/2, cursor: 'nesw-resize' }} />
          <Handle data="resize-se" sx={{ bottom: -HANDLE_SIZE/2, right: -HANDLE_SIZE/2, cursor: 'nwse-resize' }} />
          {/* Edge handles */}
          <Handle data="resize-n" sx={{ top: -HANDLE_SIZE/2, left: '50%', ml: -HANDLE_SIZE/2, cursor: 'ns-resize' }} />
          <Handle data="resize-s" sx={{ bottom: -HANDLE_SIZE/2, left: '50%', ml: -HANDLE_SIZE/2, cursor: 'ns-resize' }} />
          <Handle data="resize-w" sx={{ left: -HANDLE_SIZE/2, top: '50%', mt: -HANDLE_SIZE/2, cursor: 'ew-resize' }} />
          <Handle data="resize-e" sx={{ right: -HANDLE_SIZE/2, top: '50%', mt: -HANDLE_SIZE/2, cursor: 'ew-resize' }} />
        </>
      )}
    </Box>
  );
}

function Handle({ data, sx }: { data: string; sx: any }) {
  return (
    <Box
      data-handle={data}
      sx={{
        position: 'absolute',
        width: HANDLE_SIZE, height: HANDLE_SIZE,
        bgcolor: '#6c63ff',
        border: '2px solid #fff',
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

/** Right-side inspector panel */
function RightInspector({
  selected, selectedIds, widgets, widgetMeta, onUpdate, onDelete, onDuplicate, onLock, onHide,
}: {
  selected: EditorWidget | null;
  selectedIds: string[];
  widgets: EditorWidget[];
  widgetMeta: Record<string, WidgetMetadata>;
  onUpdate: (patch: any) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onLock: (id: string) => void;
  onHide: (id: string) => void;
}) {
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
    case 'color':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <input
            type="color"
            value={val || '#ffffff'}
            onChange={e => onChange(e.target.value)}
            style={{ width: 32, height: 28, padding: 0, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
          />
          <TextField
            label={field.label}
            size="small"
            fullWidth
            value={val || '#ffffff'}
            onChange={e => onChange(e.target.value)}
            slotProps={{ htmlInput: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
        </Stack>
      );
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
