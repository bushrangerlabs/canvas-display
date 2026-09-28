import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { useParams, useSearchParams } from 'react-router-dom';
import { coreApi } from '../api/client';
import { WIDGET_LAZY_MAP } from '../widgets/WidgetRenderer';
import type { EditorWidget } from '../types/widget';
import type { WidgetConfig } from '../widgets/types/index';
import VoiceStateOverlay from '../components/VoiceStateOverlay';
import KnowledgeOverlay from '../components/KnowledgeOverlay';

interface Manifest {
  widgets?: EditorWidget[];
  width?: number;
  height?: number;
}

// The editor lays widgets out in a fixed canvas (canvasW x canvasH) and then
// uniformly scales that canvas to fit its window. The device must use the exact
// same coordinate space + uniform scale, otherwise widgets drift / stretch.
const DEFAULT_CANVAS_W = 800;
const DEFAULT_CANVAS_H = 480;

function readManifest(scene: { manifest?: unknown }): { widgets: EditorWidget[]; w: number; h: number } {
  const manifest = (scene.manifest ?? {}) as Manifest;
  const widgets = Array.isArray(manifest.widgets) ? manifest.widgets : [];
  const w = typeof manifest.width === 'number' && manifest.width > 0 ? manifest.width : DEFAULT_CANVAS_W;
  const h = typeof manifest.height === 'number' && manifest.height > 0 ? manifest.height : DEFAULT_CANVAS_H;
  return { widgets, w, h };
}

export default function SceneDisplayPage() {
  const { sceneId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const playlistSelectionId = searchParams.get('playlist_selection_id') ?? '';
  const [displayWidgets, setDisplayWidgets] = useState<EditorWidget[] | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: DEFAULT_CANVAS_W, h: DEFAULT_CANVAS_H });
  const [error, setError] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const prevSceneId = useRef<string>('');
  // Revision of the scene currently rendered, so the refresh poll can skip the
  // expensive manifest comparison when nothing was republished.
  const lastRevisionRef = useRef<number | null>(null);

  // Stage ref measures the available viewport so we can uniformly scale the
  // canvas to fit (same behaviour as the editor's zoom-to-fit).
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    coreApi.publishedScene(sceneId)
      .then(({ scene }) => {
        const { widgets, w, h } = readManifest(scene);
        setCanvasSize({ w, h });
        // Animate transition when switching between scenes
        if (prevSceneId.current && prevSceneId.current !== sceneId) {
          setTransitioning(true);
          setTimeout(() => {
            setDisplayWidgets(widgets);
            setTimeout(() => setTransitioning(false), 50);
          }, 300);
        } else {
          setDisplayWidgets(widgets);
        }
        lastRevisionRef.current = scene.revision;
        prevSceneId.current = sceneId;
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [sceneId]);

  // Re-fetch the published scene on an interval so a freshly republished revision
  // shows up on the display without waiting for the kiosk to recreate the webview.
  // Only swap widgets (and canvas size) when the content actually changed.
  useEffect(() => {
    if (!sceneId) return;
    const refresh = async () => {
      try {
        const { scene } = await coreApi.publishedScene(sceneId);
        // Only swap widgets when the published revision actually changed. Comparing
        // the revision is far cheaper than stringifying the whole manifest on every
        // poll, which was a recurring CPU spike on the Pi.
        if (lastRevisionRef.current === scene.revision) return;
        const { widgets, w, h } = readManifest(scene);
        lastRevisionRef.current = scene.revision;
        setCanvasSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
        setDisplayWidgets(widgets);
      } catch {
        /* keep showing the last good scene; Core may briefly be busy */
      }
    };
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [sceneId]);

  // Uniformly scale the canvas to fit the viewport (preserve aspect ratio).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const next = Math.min(rect.width / canvasSize.w, rect.height / canvasSize.h);
      setScale(next > 0 ? next : 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasSize]);

  useEffect(() => {
    if (!playlistSelectionId) return;
    let stopped = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/media/youtube/selection/${encodeURIComponent(playlistSelectionId)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const selection = await response.json();
        if (stopped) return;
        (window as Window & { __canvasMediaSelection?: unknown }).__canvasMediaSelection = selection;
        window.dispatchEvent(new CustomEvent('canvas:playlist-selection', { detail: selection }));
      } catch {
        // The selection can briefly be unavailable while Core switches pages.
      } finally {
        if (!stopped) timer = window.setTimeout(refresh, 1500);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      delete (window as Window & { __canvasMediaSelection?: unknown }).__canvasMediaSelection;
    };
  }, [playlistSelectionId]);

  if (error) return <Box sx={{ p: 2, color: 'error.main' }}>{error}</Box>;
  if (!displayWidgets) return <Box sx={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center' }}><CircularProgress /></Box>;
  return (
    <Box
      ref={stageRef}
      // `placeItems` centres the scene inside its grid track, but when the canvas is
      // larger than the viewport the track itself overflows and is laid out from the
      // start edge — pushing the scene off the right/bottom. `placeContent` centres
      // the track too, so an oversized canvas is scaled and centred instead of clipped.
      sx={{ position: 'fixed', inset: 0, overflow: 'hidden', bgcolor: '#0a0a12', display: 'grid', placeItems: 'center', placeContent: 'center' }}
    >
      <Box sx={{
        position: 'relative',
        width: canvasSize.w,
        height: canvasSize.h,
        transform: `scale(${scale})`,
        transformOrigin: 'center center',
        opacity: transitioning ? 0 : 1,
        transition: 'opacity 0.3s ease',
      }}>
        {[...displayWidgets].sort((a, b) => a.zIndex - b.zIndex).filter(widget => !widget.hidden).map(widget => {
          const Component = WIDGET_LAZY_MAP[widget.type];
          if (!Component) return <Typography key={widget.id}>{widget.type}</Typography>;
          const config: WidgetConfig = {
            id: widget.id,
            type: widget.type,
            position: { x: widget.x, y: widget.y, width: widget.w, height: widget.h, zIndex: widget.zIndex },
            config: widget.config,
          };
          return (
            <Box key={widget.id} sx={{
              position: 'absolute',
              left: widget.x,
              top: widget.y,
              width: widget.w,
              height: widget.h,
              zIndex: widget.zIndex,
              overflow: 'hidden',
            }}>
              <Suspense fallback={null}><Component config={config} isEditMode={false} /></Suspense>
            </Box>
          );
        })}
      </Box>
      <VoiceStateOverlay />
      <KnowledgeOverlay />
    </Box>
  );
}
