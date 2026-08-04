import { Suspense, useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { useParams, useSearchParams } from 'react-router-dom';
import { coreApi } from '../api/client';
import { WIDGET_LAZY_MAP } from '../widgets/WidgetRenderer';
import type { EditorWidget } from '../types/widget';
import type { WidgetConfig } from '../widgets/types/index';
import VoiceStateOverlay from '../components/VoiceStateOverlay';

export default function SceneDisplayPage() {
  const { sceneId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const playlistSelectionId = searchParams.get('playlist_selection_id') ?? '';
  const [widgets, setWidgets] = useState<EditorWidget[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    coreApi.publishedScene(sceneId)
      .then(({ scene }) => {
        const manifest = scene.manifest as { widgets?: EditorWidget[] };
        setWidgets(Array.isArray(manifest?.widgets) ? manifest.widgets : []);
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [sceneId]);

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
  if (!widgets) return <Box sx={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center' }}><CircularProgress /></Box>;
  return (
    <Box sx={{ position: 'fixed', inset: 0, overflow: 'hidden', bgcolor: '#0a0a12' }}>
      {[...widgets].sort((a, b) => a.zIndex - b.zIndex).filter(widget => !widget.hidden).map(widget => {
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
            left: `${widget.x / 8}%`,
            top: `${widget.y / 4.8}%`,
            width: `${widget.w / 8}%`,
            height: `${widget.h / 4.8}%`,
            zIndex: widget.zIndex,
            overflow: 'hidden',
          }}>
            <Suspense fallback={null}><Component config={config} isEditMode={false} /></Suspense>
          </Box>
        );
      })}
      <VoiceStateOverlay />
    </Box>
  );
}
