/**
 * KioskScreen — Android kiosk controller using the native MultiWebViewPlugin.
 *
 * Architecture mirrors the Linux version exactly:
 *   • This React app (main window) is the WS controller only — black background.
 *   • load_view      → navigate (or create) a single fullscreen WebView to
 *                       ha_host/canvas-kiosk#<canvas_view_id>
 *   • load_page      → multi-panel support via native Android WebViews
 *   • navigate_panel → navigates an existing WebView in-place
 *   • show/hide_floating → create / show / hide a floating WebView
 *   • screen_on/off, set_brightness → Kotlin plugin via WindowManager
 *   • reload         → close panels + window.location.reload()
 *   • Settings overlay: hides panel views while shown, restores after
 *   • Fallback (no page assigned): single fullscreen panel → ha_host/canvas-kiosk
 *
 * All Tauri invocations go through `../tauriInvoke` which routes panel/screen
 * commands to `plugin:multiwebview|<cmd>`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Typography } from '@mui/material';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nanoid } from 'nanoid';
import { clearConfig, saveDeviceId, type AppConfig } from '../store/config';
import { useServerSocket } from '../hooks/useServerSocket';
import { invoke } from '../tauriInvoke';
import SettingsScreen from './SettingsScreen';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PagePanel {
  id: number;
  name: string;
  x: number;   // 0-100 %
  y: number;
  w: number;
  h: number;
  view_id: string | null;
  url: string | null;
  position: number;
}

interface FloatingConfig {
  url?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface LoadedPage {
  page_id: number;
  panels: PagePanel[];
  floating_config: FloatingConfig | null;
}

type AppState = 'registering' | 'ready' | 'error' | 'settings';

interface Props {
  config: AppConfig;
  onResetConfig: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(percent: number, total: number) {
  return Math.round((percent / 100) * total);
}

/** Minimal init script: set hassTokens so HA auto-logs in. */
function buildHAAuthScript(haUrl: string, haToken: string): string {
  const hassTokens = JSON.stringify({
    access_token:  haToken,
    token_type:    'Bearer',
    expires_in:    99999999,
    hassUrl:       haUrl,
    clientId:      `${haUrl}/`,
    expires:       new Date('2099-01-01').getTime(),
    refresh_token: '',
  });
  const tokensJson = JSON.stringify(hassTokens);
  return `(function(){ try{ localStorage.setItem('hassTokens', ${tokensJson}); }catch(e){} })();`;
}

/** Close all panel/floating webviews created by the plugin. */
async function closeAllPanelWindows() {
  try {
    const result = await invoke<{ labels: string[] }>('get_all_webview_labels');
    await Promise.all(
      result.labels
        .filter(l => l.startsWith('panel-') || l === 'floating')
        .map(label => invoke('close_webview', { label }).catch(() => {})),
    );
  } catch {
    // No panels open or plugin not yet ready.
  }
}

function resolvePanelUrl(panel: PagePanel, config: AppConfig, _deviceId: string): string {
  if (panel.url) return panel.url;
  if (panel.view_id) return `${config.haUrl}/canvas-ui-static/kiosk.html#${encodeURIComponent(panel.view_id)}`;
  return `${config.haUrl}/canvas-ui-static/kiosk.html`;
}

// ─── Component ───────────────────────────────────────────────────────────────

const SETTINGS_TAP_COUNT = 5;
const SETTINGS_TAP_WINDOW_MS = 3000;

export default function KioskScreen({ config, onResetConfig }: Props) {
  const [appState, setAppState]     = useState<AppState>('registering');
  const [errorMsg, setErrorMsg]     = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [showQuitDialog, setShowQuitDialog] = useState(false);
  const retryTimerRef               = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deviceId, setDeviceId]     = useState(config.deviceId ?? '');
  const [loadedPage, setLoadedPage] = useState<LoadedPage | null>(null);

  // HA ingress session for Lovelace cards in panel webviews
  const ingressRef = useRef<{ session: string; ingressPath: string; haUrl: string } | null>(null);

  useEffect(() => {
    async function fetchIngress() {
      if (!config.haUrl || !config.haToken) return;
      try {
        const infoRes = await fetch(`${config.serverUrl}/api/ingress-info`);
        if (!infoRes.ok) return;
        const info = await infoRes.json() as { ingress_url: string | null };
        if (!info.ingress_url) return;
        const ingressPath = info.ingress_url.endsWith('/') ? info.ingress_url : info.ingress_url + '/';

        const sessionRes = await fetch(`${config.haUrl}/api/ingress/session`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.haToken}` },
        });
        if (!sessionRes.ok) return;
        const sessionData = await sessionRes.json() as { session: string };
        if (!sessionData.session) return;

        ingressRef.current = { session: sessionData.session, ingressPath, haUrl: config.haUrl };
        console.log('[KioskScreen] HA ingress ready, path:', ingressPath);
      } catch (e) {
        console.warn('[KioskScreen] Could not get HA ingress session:', e);
      }
    }
    fetchIngress();
  }, [config.haUrl, config.haToken, config.serverUrl]);

  const panelLabelsRef   = useRef<string[]>([]);
  const tapTimestamps    = useRef<number[]>([]);

  function handleCornerTap() {
    const now = Date.now();
    tapTimestamps.current = tapTimestamps.current
      .filter(t => now - t < SETTINGS_TAP_WINDOW_MS)
      .concat(now);
    if (tapTimestamps.current.length >= SETTINGS_TAP_COUNT) {
      tapTimestamps.current = [];
      setAppState('settings');
    }
  }

  // Hide / show panel webviews when settings overlay opens/closes
  useEffect(() => {
    if (appState === 'settings') {
      panelLabelsRef.current.forEach(label =>
        invoke('hide_webview', { label }).catch(() => {}),
      );
    } else if (appState === 'ready') {
      panelLabelsRef.current.forEach(label =>
        invoke('show_webview', { label }).catch(() => {}),
      );
    }
  }, [appState]);

  // Hide panels when quit dialog is open so it's visible; restore on cancel
  useEffect(() => {
    if (showQuitDialog) {
      panelLabelsRef.current.forEach(label =>
        invoke('hide_webview', { label }).catch(() => {}),
      );
    } else {
      if (appState === 'ready') {
        panelLabelsRef.current.forEach(label =>
          invoke('show_webview', { label }).catch(() => {}),
        );
      }
    }
  }, [showQuitDialog, appState]);

  // Cleanup on unmount
  useEffect(() => () => { closeAllPanelWindows(); }, []);

  // ── Wait for server ready with automatic retry ─────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const localId = config.deviceId || nanoid(10);
    if (!config.deviceId) {
      saveDeviceId(localId);
      setDeviceId(localId);
    }

    async function attempt(n: number) {
      try {
        const res = await fetch(`${config.serverUrl}/health`);
        if (!res.ok) throw new Error(`Server not ready: ${res.status}`);
        if (cancelled) return;
        setRetryCount(0);
        setAppState('ready');
      } catch (e) {
        if (cancelled) return;
        const delay = Math.min(2000 * Math.pow(1.5, n), 30000);
        setRetryCount(n + 1);
        setErrorMsg(String(e));
        retryTimerRef.current = setTimeout(() => {
          if (!cancelled) attempt(n + 1);
        }, delay);
      }
    }

    attempt(0);
    return () => {
      cancelled = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [config.serverUrl, config.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Open native WebView panels ─────────────────────────────────────────────
  const openPanelWindows = useCallback(async (panels: PagePanel[], floating: FloatingConfig | null) => {
    await closeAllPanelWindows();
    panelLabelsRef.current = [];

    const sw = window.screen.width;
    const sh = window.screen.height;

    for (const panel of panels) {
      const label = `panel-${panel.id}`;
      const directUrl = resolvePanelUrl(panel, config, deviceId);

      await invoke('create_panel_webview', {
        label,
        url:            directUrl,
        x:              pct(panel.x, sw),
        y:              pct(panel.y, sh),
        width:          pct(panel.w, sw),
        height:         pct(panel.h, sh),
        title:          panel.name,
        visible:        true,
        ingressSession: null,
        initScript:     config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
      }).catch(e => console.error(`[${label}] create_panel_webview error:`, e));
      panelLabelsRef.current.push(label);
      // Give WebView time to stabilise before spawning the next one.
      await new Promise(r => setTimeout(r, 500));
    }

    if (floating?.url) {
      const fc = floating;
      invoke('create_panel_webview', {
        label:          'floating',
        url:            fc.url!,
        x:              pct(fc.x ?? 10, sw),
        y:              pct(fc.y ?? 10, sh),
        width:          pct(fc.w ?? 80, sw),
        height:         pct(fc.h ?? 80, sh),
        title:          'Floating',
        visible:        false,
        ingressSession: null,
        initScript:     config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
      }).catch(e => console.error('[floating] create_panel_webview error:', e));
    }
  }, [config, deviceId]);

  // ── WS command handler ────────────────────────────────────────────────────
  const handleCommand = useCallback(async (cmd: Record<string, unknown>) => {
    console.log('[KioskScreen] command:', cmd);
    switch (cmd.type) {

      case 'load_view': {
        const canvas_view_id = cmd.canvas_view_id as string | undefined;
        const url = `${config.haUrl}/canvas-ui-static/kiosk.html${canvas_view_id ? '#' + canvas_view_id : ''}`;
        const label = 'panel-fallback';

        const result = await invoke<{ labels: string[] }>('get_all_webview_labels').catch(() => ({ labels: [] as string[] }));
        if (result.labels.includes(label)) {
          await invoke('navigate_webview', { label, url }).catch(console.error);
        } else {
          const sw = window.screen.width;
          const sh = window.screen.height;
          await invoke('create_panel_webview', {
            label,
            url,
            x:              0,
            y:              0,
            width:          sw,
            height:         sh,
            title:          'Canvas Display',
            visible:        true,
            ingressSession: null,
            initScript:     config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
          }).catch(e => console.error('[load_view] create_panel_webview error:', e));
          panelLabelsRef.current = [label];
        }
        break;
      }

      case 'load_page': {
        const pageData = cmd.page_data as { panels: PagePanel[]; floating_config: FloatingConfig | null };
        const page: LoadedPage = {
          page_id:         cmd.page_id as number,
          panels:          pageData?.panels ?? [],
          floating_config: pageData?.floating_config ?? null,
        };
        setLoadedPage(page);
        await openPanelWindows(page.panels, page.floating_config);
        break;
      }

      case 'navigate_panel': {
        const panelId = cmd.panel_id as number;
        const url     = cmd.url as string;
        if (panelId != null && url) {
          await invoke('navigate_webview', { label: `panel-${panelId}`, url }).catch(console.error);
        }
        break;
      }

      case 'show_floating': {
        const url = cmd.url as string | undefined;
        const result = await invoke<{ labels: string[] }>('get_all_webview_labels').catch(() => ({ labels: [] as string[] }));
        const exists = result.labels.includes('floating');

        if (url && exists) {
          await invoke('navigate_webview', { label: 'floating', url }).catch(console.error);
        } else if (url && !exists) {
          const fc = loadedPage?.floating_config;
          const sw = window.screen.width;
          const sh = window.screen.height;
          await invoke('create_panel_webview', {
            label:          'floating',
            url,
            x:              pct(fc?.x ?? 10, sw),
            y:              pct(fc?.y ?? 10, sh),
            width:          pct(fc?.w ?? 80, sw),
            height:         pct(fc?.h ?? 80, sh),
            title:          'Floating',
            visible:        true,
            ingressSession: null,
            initScript:     config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
          }).catch(e => console.error('[floating] create_panel_webview error:', e));
          return;
        }
        invoke('show_webview', { label: 'floating' }).catch(() => {});
        break;
      }

      case 'hide_floating':
        invoke('hide_webview', { label: 'floating' }).catch(() => {});
        break;

      case 'screen_off':
        invoke('screen_off').catch(console.error);
        break;

      case 'screen_on':
        invoke('screen_on').catch(console.error);
        break;

      case 'set_brightness':
        invoke('set_brightness', { brightness: Number(cmd.brightness ?? 1) }).catch(console.error);
        break;

      case 'reload':
        await closeAllPanelWindows();
        window.location.reload();
        break;

      case 'show_quit_dialog':
        setShowQuitDialog(true);
        break;

      // Generic command envelope sent by POST /api/devices/:id/command
      case 'command': {
        const action = cmd.action as string | undefined;
        if (action) await handleCommand({ ...cmd, ...(cmd.payload as Record<string, unknown> ?? {}), type: action });
        break;
      }
    }
  }, [openPanelWindows, loadedPage, config]);

  useServerSocket({
    serverUrl: config.serverUrl,
    deviceId,
    enabled:   appState === 'ready' && !!deviceId,
    onCommand: handleCommand,
  });

  // ── Fallback: single fullscreen panel when no page assigned ────────────────
  useEffect(() => {
    if (appState !== 'ready' || !deviceId || loadedPage) return;
    const label = 'panel-fallback';
    invoke<{ labels: string[] }>('get_all_webview_labels')
      .then(result => {
        if (result.labels.includes(label)) return;
        const sw = window.screen.width;
        const sh = window.screen.height;
        invoke('create_panel_webview', {
          label,
          url:            `${config.haUrl}/canvas-ui-static/kiosk.html`,
          x:              0,
          y:              0,
          width:          sw,
          height:         sh,
          title:          'Canvas Display',
          visible:        true,
          ingressSession: null,
          initScript:     config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
        }).catch(e => console.error('[fallback] create_panel_webview error:', e));
        panelLabelsRef.current = [label];
      })
      .catch(() => {
        // Plugin not yet registered — will retry on next state change.
      });
  }, [appState, deviceId, loadedPage, config]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (appState === 'settings') {
    return (
      <SettingsScreen
        isEditing
        existingConfig={config}
        onSaved={() => window.location.reload()}
        onCancel={() => setAppState('ready')}
      />
    );
  }

  if (appState === 'registering') {
    return (
      <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#0a0a0a', flexDirection: 'column', gap: 2, p: 4 }}>
        <CircularProgress size={40} />
        <Typography color="text.secondary" variant="body2">
          {retryCount === 0
            ? `Connecting to ${config.serverUrl}…`
            : `Retrying… (attempt ${retryCount + 1})`}
        </Typography>
        {retryCount > 0 && (
          <Typography color="error" variant="caption" sx={{ maxWidth: 480, textAlign: 'center', opacity: 0.7 }}>
            {errorMsg}
          </Typography>
        )}
        {retryCount >= 3 && (
          <Button variant="outlined" size="small" onClick={() => setAppState('settings')} sx={{ mt: 1 }}>
            Open Settings
          </Button>
        )}
      </Box>
    );
  }

  if (appState === 'error') {
    return (
      <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#0a0a0a', flexDirection: 'column', gap: 2, p: 4 }}>
        <Alert severity="error" sx={{ maxWidth: 500 }}>{errorMsg}</Alert>
        <Button variant="outlined" onClick={() => setAppState('settings')}>Open Settings</Button>
        <Button variant="text" color="error" onClick={async () => { await clearConfig(); onResetConfig(); }}>Reset Config</Button>
      </Box>
    );
  }

  // appState === 'ready' — main window is the invisible controller + corner tap
  return (
    <Box sx={{ width: '100%', height: '100%', position: 'relative', bgcolor: '#000' }}>
      <Box
        onClick={handleCornerTap}
        sx={{ position: 'absolute', top: 0, right: 0, width: 60, height: 60, zIndex: 9999, cursor: 'default' }}
      />

      {/* Quit confirmation dialog */}
      <Dialog open={showQuitDialog} onClose={() => setShowQuitDialog(false)}>
        <DialogTitle>Quit Canvas Display?</DialogTitle>
        <DialogContent>
          <DialogContentText>This will close the kiosk app.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowQuitDialog(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={async () => {
            await closeAllPanelWindows();
            await getCurrentWindow().close();
          }}>Quit</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
