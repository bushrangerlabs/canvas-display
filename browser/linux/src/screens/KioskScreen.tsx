/**
 * KioskScreen — Tauri kiosk controller using native WebviewWindows.
 *
 * Architecture:
 *   • This React app (main window) is the WS controller only — black background.
 *   • load_view      → navigate (or create) a single fullscreen WebviewWindow to
 *                       ha_host/canvas-kiosk#<canvas_view_id>
 *   • load_page      → legacy multi-panel support (panels become native WebviewWindows)
 *   • navigate_panel → Rust command navigates window URL in-place
 *   • show/hide_floating → create / show / hide a floating WebviewWindow
 *   • screen_on/off, set_brightness → xset / xrandr via Tauri invoke
 *   • reload         → close panels + window.location.reload()
 *   • Settings overlay: hides panel windows while shown, restores after
 *   • Fallback (no page assigned): single fullscreen panel → ha_host/canvas-kiosk
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Typography } from '@mui/material';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { nanoid } from 'nanoid';
import { clearConfig, saveDeviceId, type AppConfig } from '../store/config';
import { useServerSocket } from '../hooks/useServerSocket';
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
/**
 * Builds the initialization_script that:
 * 1. Stores the HA long-lived token in localStorage so HA auto-logs in.
 * 2. Installs __canvas_hass_bridge on the parent window so the canvas iframe
 *    can set .hass on Lovelace card elements entirely within the parent realm
 *    (avoids WebKit cross-realm property restrictions).
 *    When the parent is ha:8123/canvas-ui-platform the companion panel element
 *    calls window.hass = hass directly, so the bridge has hass immediately.
 * 3. On DOMContentLoaded, hides HA chrome and injects a full-screen iframe
 *    pointing to the canvas display view via HA ingress.
 */
/** Minimal init script: set hassTokens so HA auto-logs in.
 *  Panel webviews run in incognito mode (no persisted SW or cache) so the
 *  HA PWA service worker can never intercept requests in panel webviews.
 */
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

function buildHAKioskScript(params: {
  haUrl: string;
  haToken: string;
  iframeSrc: string;
}): string {
  const hassTokens = JSON.stringify({
    access_token:  params.haToken,
    token_type:    'Bearer',
    expires_in:    99999999,
    hassUrl:       params.haUrl,
    clientId:      `${params.haUrl}/`,
    expires:       new Date('2099-01-01').getTime(),
    refresh_token: '',
  });
  const iframeSrc  = JSON.stringify(params.iframeSrc);
  const tokensJson = JSON.stringify(hassTokens);

  return `(function(){
  try{ localStorage.setItem('hassTokens', ${tokensJson}); }catch(e){}
  // Hass bridge: runs in HA parent window's realm. The companion panel element
  // sets window.hass directly via its set hass() setter, so getHass() works
  // immediately without needing to query the home-assistant custom element.
  window.__canvas_hass_bridge = {
    getHass: function(){ return window.hass || null; },
    setHass: function(el){
      var h = window.hass;
      if(!h){
        var ha = document.querySelector('home-assistant');
        h = ha && ha.hass ? ha.hass : null;
      }
      if(h && el) el.hass = h;
    }
  };
  function setup(){
    var s=document.createElement('style');
    s.textContent='ha-sidebar,ha-drawer,app-header,app-toolbar,.header,[slot="toolbar"],ha-menu-button,paper-icon-button{display:none!important}body,html{margin:0;padding:0;overflow:hidden;width:100%;height:100%}';
    (document.head||document.documentElement).appendChild(s);
    var f=document.createElement('iframe');
    f.src=${iframeSrc};
    f.style.cssText='position:fixed;top:0;left:0;width:100vw;height:100vh;border:none;z-index:2147483647;background:#000;pointer-events:auto;';
    f.allow='autoplay; fullscreen';
    document.body.appendChild(f);
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',setup);
  }else{
    setTimeout(setup,0);
  }
})();`;
}
async function closeAllPanelWindows() {
  const all = await WebviewWindow.getAll();
  await Promise.all(
    all
      .filter(w => w.label.startsWith('panel-') || w.label === 'floating')
      .map(w => w.close().catch(() => {}))
  );
}

function resolvePanelUrl(panel: PagePanel, config: AppConfig, _deviceId: string): string {
  if (panel.url) return panel.url;
  // view_id is a canvas-ui-hacs view slug — load via the kiosk panel
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

  // HA ingress session for Lovelace cards in panel windows
  const ingressRef = useRef<{ session: string; ingressPath: string; haUrl: string } | null>(null);

  // Fetch HA ingress session + path so panel windows can load via HA ingress.
  // This gives them access to HA's custom element registry (needed for Lovelace cards).
  useEffect(() => {
    async function fetchIngress() {
      if (!config.haUrl || !config.haToken) return;
      try {
        // 1. Get this add-on's ingress path from our server
        const infoRes = await fetch(`${config.serverUrl}/api/ingress-info`);
        if (!infoRes.ok) return;
        const info = await infoRes.json() as { ingress_url: string | null };
        if (!info.ingress_url) return;
        const ingressPath = info.ingress_url.endsWith('/') ? info.ingress_url : info.ingress_url + '/';

        // 2. Create an HA ingress session using the long-lived token
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

  // Hide / show panel windows when settings overlay opens/closes
  useEffect(() => {
    if (appState === 'settings') {
      panelLabelsRef.current.forEach(label =>
        WebviewWindow.getByLabel(label).then(w => w?.hide().catch(() => {}))
      );
    } else if (appState === 'ready') {
      panelLabelsRef.current.forEach(label =>
        WebviewWindow.getByLabel(label).then(w => w?.show().catch(() => {}))
      );
    }
  }, [appState]);

  // Hide panels when quit dialog is open so it's visible; restore on cancel
  useEffect(() => {
    if (showQuitDialog) {
      panelLabelsRef.current.forEach(label =>
        WebviewWindow.getByLabel(label).then(w => w?.hide().catch(() => {}))
      );
    } else {
      // Only restore if not in settings (settings manages its own hide/show)
      if (appState === 'ready') {
        panelLabelsRef.current.forEach(label =>
          WebviewWindow.getByLabel(label).then(w => w?.show().catch(() => {}))
        );
      }
    }
  }, [showQuitDialog, appState]);

  // Cleanup on unmount
  useEffect(() => () => { closeAllPanelWindows(); }, []);

  // ── Wait for server ready with automatic retry ───────────────────────
  // Polls /health until the server responds — handles the kiosk starting
  // before the server (sidecar) is ready.
  useEffect(() => {
    let cancelled = false;

    // Ensure we have a stable local device ID (no server round-trip needed)
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
        const delay = Math.min(2000 * Math.pow(1.5, n), 30000); // 2s→30s cap
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

  // ── Open native WebviewWindow panels ─────────────────────────────────────
  const openPanelWindows = useCallback(async (panels: PagePanel[], floating: FloatingConfig | null) => {
    await closeAllPanelWindows();
    panelLabelsRef.current = [];

    const sw = window.screen.width;
    const sh = window.screen.height;
    const ox = window.screenX ?? 0;
    const oy = window.screenY ?? 0;

    for (const panel of panels) {
      const label = `panel-${panel.id}`;
      const directUrl = resolvePanelUrl(panel, config, deviceId);

      // Await each panel creation before starting the next one.
      // Creating all panels simultaneously causes WebKit's NetworkProcess to crash
      // on kiosk hardware when multiple HA WebSocket connections race at startup.
      await invoke('create_panel_webview', {
        label,
        url:           directUrl,
        x:             ox + pct(panel.x, sw),
        y:             oy + pct(panel.y, sh),
        width:         pct(panel.w, sw),
        height:        pct(panel.h, sh),
        title:         panel.name,
        visible:       true,
        ingressSession: null,
        initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
      }).catch(e => console.error(`[${label}] create_panel_webview error:`, e));
      panelLabelsRef.current.push(label);
      // Give WebKit 2000ms to stabilise its subprocess before spawning the next
      // webview — prevents the NetworkProcess from being overwhelmed at startup.
      await new Promise(r => setTimeout(r, 2000));
    }

    if (floating?.url) {
      const fc = floating;
      invoke('create_panel_webview', {
        label:         'floating',
        url:           fc.url!,
        x:             ox + pct(fc.x ?? 10, sw),
        y:             oy + pct(fc.y ?? 10, sh),
        width:         pct(fc.w ?? 80, sw),
        height:        pct(fc.h ?? 80, sh),
        title:         'Floating',
        visible:       false,
        ingressSession: null,
        initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
      }).catch(e => console.error('[floating] create_panel_webview error:', e));
    }
  }, [config, deviceId]);

  // ── WS command handler ───────────────────────────────────────────────────
  const handleCommand = useCallback(async (cmd: Record<string, any>) => {
    console.log('[KioskScreen] command:', cmd);
    switch (cmd.type) {

      case 'load_view': {
        // New architecture: server assigns a page with a canvas_view_id.
        // Kiosk navigates (or creates) a single fullscreen window to
        //   ha_host/canvas-kiosk#<canvas_view_id>
        const canvas_view_id = cmd.canvas_view_id as string | undefined;
        const url = `${config.haUrl}/canvas-ui-static/kiosk.html${canvas_view_id ? '#' + canvas_view_id : ''}`;
        const label = 'panel-fallback';
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
          await invoke('navigate_webview', { label, url }).catch(console.error);
        } else {
          const sw = window.screen.width;
          const sh = window.screen.height;
          await invoke('create_panel_webview', {
            label,
            url,
            x:             window.screenX ?? 0,
            y:             window.screenY ?? 0,
            width:         sw,
            height:        sh,
            title:         'Canvas Display',
            visible:       true,
            ingressSession: null,
            initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
          }).catch(e => console.error('[load_view] create_panel_webview error:', e));
          panelLabelsRef.current = [label];
        }
        break;
      }

      case 'load_page': {
        const pageData = cmd.page_data as { panels: PagePanel[]; floating_config: FloatingConfig | null };
        const page: LoadedPage = {
          page_id:        cmd.page_id as number,
          panels:         pageData?.panels ?? [],
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
        const existing = await WebviewWindow.getByLabel('floating');
        if (url && existing) {
          await invoke('navigate_webview', { label: 'floating', url }).catch(console.error);
        } else if (url && !existing) {
          const fc = loadedPage?.floating_config;
          const sw = window.screen.width;
          const sh = window.screen.height;
          const ox = window.screenX ?? 0;
          const oy = window.screenY ?? 0;
          await invoke('create_panel_webview', {
            label:         'floating',
            url,
            x:             ox + pct(fc?.x ?? 10, sw),
            y:             oy + pct(fc?.y ?? 10, sh),
            width:         pct(fc?.w ?? 80, sw),
            height:        pct(fc?.h ?? 80, sh),
            title:         'Floating',
            visible:       true,
            ingressSession: null,
            initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
          }).catch(e => console.error('[floating] create_panel_webview error:', e));
          return;
        }
        WebviewWindow.getByLabel('floating').then(w => w?.show().catch(() => {}));
        break;
      }

      case 'hide_floating':
        WebviewWindow.getByLabel('floating').then(w => w?.hide().catch(() => {}));
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
        if (action) await handleCommand({ ...cmd, ...(cmd.payload ?? {}), type: action });
        break;
      }
    }
  }, [openPanelWindows, loadedPage]);

  useServerSocket({
    serverUrl: config.serverUrl,
    deviceId,
    enabled:   appState === 'ready' && !!deviceId,
    onCommand: handleCommand,
  });

  // ── Fallback: single fullscreen display window when no page assigned ───────
  useEffect(() => {
    if (appState !== 'ready' || !deviceId || loadedPage) return;
    const label = 'panel-fallback';
    WebviewWindow.getByLabel(label).then(existing => {
      if (existing) return;
      const sw = window.screen.width;
      const sh = window.screen.height;
      invoke('create_panel_webview', {
        label,
        url:           `${config.haUrl}/canvas-ui-static/kiosk.html`,
        x:             window.screenX ?? 0,
        y:             window.screenY ?? 0,
        width:         sw,
        height:        sh,
        title:         'Canvas Display',
        visible:       true,
        ingressSession: null,
        initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
      }).catch(e => console.error('[fallback] create_panel_webview error:', e));
      panelLabelsRef.current = [label];
    });
  }, [appState, deviceId, loadedPage, config.serverUrl]);

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

      {/* Quit confirmation dialog — triggered by add-on or settings */}
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
