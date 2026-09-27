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
import { listen } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid';
import { clearConfig, saveDeviceId, type AppConfig } from '../store/config';
import { useServerSocket } from '../hooks/useServerSocket';
import SettingsScreen from './SettingsScreen';
import { cachePage, loadActiveCachedPage } from '../store/pageLibrary';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PagePanel {
  id: string;
  name: string;
  x: number;   // 0-100 %
  y: number;
  w: number;
  h: number;
  view_id: string | null;
  url: string | null;
  position: number;
  content_type?: 'url' | 'scene';
  scene_id?: string | null;
  z_index?: number;
  visible?: boolean;
  opacity?: number;
}

interface FloatingConfig {
  url?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface LoadedPage {
  page_id: string;
  panels: PagePanel[];
  floating_config: FloatingConfig | null;
}

interface DisplayGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
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

async function getDisplayGeometry(): Promise<DisplayGeometry> {
  try {
    return await invoke<DisplayGeometry>('display_geometry');
  } catch (error) {
    console.warn('[KioskScreen] native display geometry unavailable:', error);
    return {
      x: window.screenX ?? 0,
      y: window.screenY ?? 0,
      width: window.screen.width,
      height: window.screen.height,
    };
  }
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
  await invoke('close_panel_webviews').catch(() => {});
  // `WebviewWindow.getAll()` returns nothing for child webviews, so the floating
  // overlay has to be closed explicitly by label.
  await invoke('close_webview', { label: 'floating' }).catch(() => {});
}

interface PanelLoadResult {
  label: string;
  ok: boolean;
  error?: string | null;
}

async function waitForPanelLoads(labels: string[], timeoutMs = 75_000): Promise<void> {
  if (labels.length === 0) throw new Error('page has no visible panels');
  const pending = new Set(labels);
  await new Promise<void>(async (resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unlisten?.();
      if (error) reject(error); else resolve();
    };
    const timer = window.setTimeout(
      () => finish(new Error(`panel load timed out: ${[...pending].join(', ')}`)),
      timeoutMs,
    );
    try {
      unlisten = await listen<PanelLoadResult>('panel-load-result', event => {
        if (!pending.has(event.payload.label)) return;
        if (!event.payload.ok) {
          finish(new Error(event.payload.error || `panel ${event.payload.label} failed to load`));
          return;
        }
        pending.delete(event.payload.label);
        if (pending.size === 0) finish();
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function resolvePanelUrl(panel: PagePanel, config: AppConfig, deviceId: string): string {
  if (panel.content_type === 'scene' && panel.scene_id) {
    const base = `${config.serverUrl.replace(/\/$/, '')}/display/scenes/${encodeURIComponent(panel.scene_id)}`;
    // Tell the scene which display it is running on so media widgets can
    // target this device for playback instead of broadcasting to all displays.
    return deviceId ? `${base}?deviceId=${encodeURIComponent(deviceId)}` : base;
  }
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
  const [controlChannel, setControlChannel] = useState({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId ?? '',
  });

  useEffect(() => {
    invoke<{ serverUrl?: string | null; deviceId?: string | null }>('core_control_config')
      .then(remote => {
        if (remote.serverUrl) {
          setControlChannel({
            serverUrl: remote.serverUrl.replace(/\/$/, ''),
            deviceId: remote.deviceId || config.deviceId || '',
          });
        }
      })
      .catch(() => { /* browser/dev mode keeps the local channel */ });
  }, [config.serverUrl, config.deviceId]);
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
  const panelTimersRef   = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tapTimestamps    = useRef<number[]>([]);
  // Tracks the floating overlay across the async gap between requesting its
  // creation and the child webview actually existing (Rust creates it on a
  // spawned thread, so `webview_exists` can still report false right after).
  const floatingOpenRef  = useRef(false);
  // Serialises page loads so concurrent `load_page` pushes cannot race each
  // other's close/create and collide on a panel label.
  const panelOpRef       = useRef<Promise<void>>(Promise.resolve());

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
        invoke('set_webview_visibility', { label, visible: false }).catch(() => {})
      );
    } else if (appState === 'ready') {
      panelLabelsRef.current.forEach(label =>
        invoke('set_webview_visibility', { label, visible: true }).catch(() => {})
      );
    }
  }, [appState]);

  // Hide panels when quit dialog is open so it's visible; restore on cancel
  useEffect(() => {
    if (showQuitDialog) {
      panelLabelsRef.current.forEach(label =>
        invoke('set_webview_visibility', { label, visible: false }).catch(() => {})
      );
    } else {
      // Only restore if not in settings (settings manages its own hide/show)
      if (appState === 'ready') {
        panelLabelsRef.current.forEach(label =>
          invoke('set_webview_visibility', { label, visible: true }).catch(() => {})
        );
      }
    }
  }, [showQuitDialog, appState]);

  // Cleanup on unmount
  useEffect(() => () => { closeAllPanelWindows(); }, []);

  // ── Wait for server ready with automatic retry ───────────────────────
  // Polls /health until the server responds — handles the kiosk starting
  // before the server (sidecar) is ready.
  // Also tries to resolve the device identity from the Edge Agent IPC socket.
  useEffect(() => {
    let cancelled = false;

    async function resolveDeviceId(): Promise<string> {
      // Try the Edge Agent IPC socket first
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const identityJson: string = await invoke('get_device_identity');
        const identity = JSON.parse(identityJson);
        if (identity.device_id) {
          console.log('[KioskScreen] resolved device identity from Edge Agent:', identity.device_id);
          return identity.device_id;
        }
      } catch (e) {
        console.warn('[KioskScreen] Edge Agent IPC not available, using fallback ID:', e);
      }
      // Fallback to stored or generated ID
      const localId = config.deviceId || nanoid(10);
      if (!config.deviceId) {
        saveDeviceId(localId);
      }
      return localId;
    }

    resolveDeviceId().then(id => {
      if (cancelled) return;
      setDeviceId(id);

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
    });

    return () => {
      cancelled = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [config.serverUrl, config.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Open child webviews attached to the fullscreen controller window ──────
  // Child webviews are positioned by Tauri relative to the parent window, so the
  // Wayland compositor cannot recenter them (unlike top-level windows). This keeps
  // exact page-relative geometry while still giving each panel a real WebKit
  // webview (TLS handling, storage, YouTube/Google, HA auth injection).
  // Creation is staggered with fire-and-forget invokes so a single blocked IPC
  // call can never stall the rest of the page from rendering.
  // ── Open child webviews attached to the fullscreen controller window ──────
  // Child webviews are positioned by Tauri relative to the parent window, so the
  // Wayland compositor cannot recenter them (unlike top-level windows). This keeps
  // exact page-relative geometry while still giving each panel a real WebKit
  // webview (TLS handling, storage, YouTube/Google, HA auth injection).
  // Panels are created strictly in sequence: each panel's window must fully build
  // before the next is requested, otherwise WebKit's NetworkProcess is overwhelmed
  // on kiosk hardware and the later panels fail to appear.
  const applyPanelWindows = useCallback(async (panels: PagePanel[], floating: FloatingConfig | null) => {
    panelTimersRef.current.forEach(t => clearTimeout(t));
    panelTimersRef.current = [];
    await closeAllPanelWindows();
    floatingOpenRef.current = false;
    panelLabelsRef.current = [];
    const { width: sw, height: sh } = await getDisplayGeometry();

    const ordered = [...panels].sort((a, b) => (a.z_index ?? a.position) - (b.z_index ?? b.position));
    const specs = ordered.map(panel => ({
      label:         `panel-${panel.id}`,
      url:           resolvePanelUrl(panel, config, deviceId),
      x:             pct(panel.x, sw),
      y:             pct(panel.y, sh),
      width:         pct(panel.w, sw),
      height:        pct(panel.h, sh),
      visible:       panel.visible !== false,
      ingressSession: null,
      initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
    }));
    panelLabelsRef.current = specs.map(s => s.label);
    const visibleLabels = specs.filter(spec => spec.visible).map(spec => spec.label);
    const loaded = waitForPanelLoads(visibleLabels);
    try {
      // Single call hands every panel to Rust, which builds them on a spawned
      // thread (with a gap between each) regardless of whether the controller
      // webview is later occluded/suspended by a large child panel.
      await invoke('create_panel_webviews', { panels: specs });
      await loaded;
    } catch (e) {
      console.error('[openPanelWindows] create_panel_webviews error:', e);
      throw e;
    }

    if (floating?.url) {
      const fc = floating;
      try {
        await invoke('create_panel_webviews', {
          panels: [{
            label:         'floating',
            url:           fc.url!,
            x:             pct(fc.x ?? 10, sw),
            y:             pct(fc.y ?? 10, sh),
            width:         pct(fc.w ?? 80, sw),
            height:        pct(fc.h ?? 80, sh),
            visible:       false,
            ingressSession: null,
            initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
          }],
        });
        panelLabelsRef.current.push('floating');
      } catch (e) {
        console.error('[floating] create_panel_webviews error:', e);
      }
    }
  }, [config, deviceId]);

  // Serialise page loads. The offline cached-page restore and the server's
  // `load_page` push can both fire at startup; running them concurrently makes
  // one batch's close race the other's create, which fails with
  // "a webview with label `panel-…` already exists" and leaves a stale panel.
  const openPanelWindows = useCallback(async (panels: PagePanel[], floating: FloatingConfig | null) => {
    const run = () => applyPanelWindows(panels, floating);
    const next = panelOpRef.current.then(run, run);
    panelOpRef.current = next.then(() => undefined, () => undefined);
    return next;
  }, [applyPanelWindows]);

  // Offline boot: restore the last fully received page definition immediately.
  // A subsequent Core load_page command replaces it and refreshes the cache.
  useEffect(() => {
    let cancelled = false;
    void loadActiveCachedPage<PagePanel, FloatingConfig>().then(async cached => {
      if (!cached || cancelled) return;
      const page: LoadedPage = {
        page_id: cached.page_id,
        panels: cached.panels,
        floating_config: cached.floating_config,
      };
      setLoadedPage(page);
      await openPanelWindows(page.panels, page.floating_config);
    });
    return () => { cancelled = true; };
  }, [openPanelWindows]);

  const openFloatingUrl = useCallback(async (url: string, fullscreen = false) => {
    try {
      // Child webviews are invisible to `WebviewWindow.getByLabel` (they are not
      // in Tauri's WebviewWindow registry), so ask Rust instead. The ref covers
      // the window between requesting creation and the webview actually existing.
      const exists = floatingOpenRef.current || await invoke<boolean>('webview_exists', { label: 'floating' });
      if (exists) {
        if (fullscreen) {
          await invoke('close_webview', { label: 'floating' }).catch(() => {});
          floatingOpenRef.current = false;
        } else {
          await invoke('navigate_webview', { label: 'floating', url }).catch(console.error);
          await invoke('set_webview_visibility', { label: 'floating', visible: true }).catch(() => {});
          return;
        }
      }
      const fc = loadedPage?.floating_config;
      const { width: sw, height: sh } = await getDisplayGeometry();
      // Use the batched command: the singular `create_panel_webview` rejects with
      // "current webview is not a WebviewWindow" from the controller webview.
      await invoke('create_panel_webviews', {
        panels: [{
          label:         'floating',
          url,
          x:             fullscreen ? 0 : pct(fc?.x ?? 10, sw),
          y:             fullscreen ? 0 : pct(fc?.y ?? 10, sh),
          width:         fullscreen ? sw : pct(fc?.w ?? 80, sw),
          height:        fullscreen ? sh : pct(fc?.h ?? 80, sh),
          visible:       true,
          ingressSession: null,
          initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
        }],
      });
      floatingOpenRef.current = true;
      panelLabelsRef.current = [...panelLabelsRef.current.filter(l => l !== 'floating'), 'floating'];
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      invoke('client_log', { message: `[floating] open failed: ${message}` }).catch(() => {});
      console.error('[floating] openFloatingUrl failed:', e);
    }
  }, [config.haToken, config.haUrl, loadedPage]);

  // ── WS command handler ───────────────────────────────────────────────────
  const handleCommand = useCallback(async (
    cmd: Record<string, any>,
    respond: (message: Record<string, unknown>) => void = () => {},
  ) => {
    console.log('[KioskScreen] command:', cmd);
    switch (cmd.type) {
      case 'device_request': {
        const requestId = String(cmd.request_id ?? '');
        try {
          let result: unknown;
          if (cmd.action === 'edge_ipc') {
            const method = String(cmd.payload?.method ?? '');
            if (!method.startsWith('audio.')) throw new Error(`Device IPC method is not allowed: ${method}`);
            const raw: string = await invoke('edge_ipc', {
              method,
              arguments: cmd.payload?.arguments ?? {},
            });
            result = raw;
            try { result = JSON.parse(raw); } catch { /* opaque string result */ }
          } else if (cmd.action === 'device_http') {
            const path = String(cmd.payload?.path ?? '');
            const allowed = new Set([
              '/api/settings',
              '/api/settings/voice/restart',
              '/api/settings/voice/wakewords',
              '/api/settings/audio/devices',
              '/api/audio/test-mic',
              '/api/audio/test-speaker',
              '/api/audio/test-cue',
              '/api/settings/voice/cue-upload',
              '/api/voice/wakeword-test',
              '/api/voice/speak',
              '/api/media/play',
              '/api/media/control',
              '/api/knowledge-card',
              '/api/app/restart',
              '/api/app/show',
              '/api/app/hide',
            ]);
            if (!allowed.has(path)) throw new Error(`Device HTTP path is not allowed: ${path}`);

            // Hide/show are performed locally by the kiosk window itself, keeping
            // the Core WebSocket and rendering alive for instant resume.
            if (path === '/api/app/hide') {
              await invoke('set_kiosk_visible', { visible: false }).catch(console.error);
              result = { action: 'hide', hidden: true };
            } else if (path === '/api/app/show') {
              await invoke('set_kiosk_visible', { visible: true }).catch(console.error);
              result = { action: 'show', shown: true };
            } else {
              const response = await fetch(`http://127.0.0.1:3100${path}`, {
                method: String(cmd.payload?.http_method ?? 'POST'),
                // Mark this as a kiosk relay so the sidecar does not also broadcast the
                // command back to us over /ws (which would run next/previous twice).
                headers: { 'content-type': 'application/json', 'x-canvas-relay': '1' },
                body: cmd.payload?.body === undefined ? undefined : JSON.stringify(cmd.payload.body),
              });
              result = await response.json();
              if (!response.ok) {
                const detail = result && typeof result === 'object' && 'error' in result
                  ? String((result as { error?: unknown }).error)
                  : `HTTP ${response.status}`;
                throw new Error(detail);
              }
              if (path === '/api/media/play') {
                // Only the YouTube iframe backend renders in a WebView. mpv-backed
                // audio (radio_browser / direct_audio / music_assistant) plays locally
                // through the sidecar's mpv process and needs no window.
                const backend = result && typeof result === 'object' && 'backend' in result
                  ? String((result as { backend?: unknown }).backend ?? '')
                  : '';
                if (backend === 'youtube_iframe_api') {
                  const playerUrl = result && typeof result === 'object' && 'url' in result
                    ? String((result as { url?: unknown }).url ?? '')
                    : '';
                  if (!playerUrl) throw new Error('Device media response did not include a player URL');
                  await openFloatingUrl(playerUrl, true);
                }
              }
              if (path === '/api/media/control') {
                const action = String(cmd.payload?.body?.action ?? '');
                if (!['pause', 'resume', 'stop', 'next', 'previous', 'volume', 'mute'].includes(action)) {
                  throw new Error(`Unsupported YouTube control: ${action}`);
                }
                const rawValue = cmd.payload?.body?.value ?? cmd.payload?.body?.level;
                const value = rawValue === undefined || rawValue === null ? undefined : Number(rawValue);
                await invoke('control_youtube_webview', { label: 'floating', action, value });
                if (action === 'stop') {
                  await invoke('close_webview', { label: 'floating' }).catch(console.error);
                }
              }
            }
          } else if (cmd.action === 'navigate_scene') {
            // Core flow: switch the main display to a scene URL
            const rawUrl = String(cmd.payload?.url ?? '');
            // Resolve relative URLs against serverUrl (Core sends paths like /display/scenes/:id)
            const url = rawUrl.startsWith('/')
              ? `${config.serverUrl.replace(/\/$/, '')}${rawUrl}`
              : rawUrl;
            if (url) {
              await invoke('navigate_webview', { label: 'main', url }).catch(console.error);
            }
            result = { navigated: !!url, url };
          } else {
            throw new Error(`Unsupported device action: ${cmd.action}`);
          }
          respond({ type: 'device_response', request_id: requestId, ok: true, result });
        } catch (error) {
          respond({
            type: 'device_response',
            request_id: requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'load_view': {
        // New architecture: server assigns a page with a canvas_view_id.
        // Kiosk navigates (or creates) a single fullscreen window to
        //   ha_host/canvas-kiosk#<canvas_view_id>
        const canvas_view_id = cmd.canvas_view_id as string | undefined;
        const url = `${config.haUrl}/canvas-ui-static/kiosk.html${canvas_view_id ? '#' + canvas_view_id : ''}`;
        const label = 'panel-fallback';
        const exists = await invoke<boolean>('webview_exists', { label });
        if (exists) {
          await invoke('navigate_webview', { label, url }).catch(console.error);
        } else {
          const { width: sw, height: sh } = await getDisplayGeometry();
          // Use the batched command: the singular `create_panel_webview` rejects
          // with "current webview is not a WebviewWindow" from the controller webview.
          await invoke('create_panel_webviews', {
            panels: [{
              label,
              url,
              x:             0,
              y:             0,
              width:         sw,
              height:        sh,
              visible:       true,
              ingressSession: null,
              initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
            }],
          }).catch(e => console.error('[load_view] create_panel_webviews error:', e));
          panelLabelsRef.current = [label];
        }
        break;
      }

      case 'load_page': {
        const pageData = cmd.page_data as { panels: PagePanel[]; floating_config: FloatingConfig | null };
        const page: LoadedPage = {
          page_id:        String(cmd.page_id),
          panels:         pageData?.panels ?? [],
          floating_config: pageData?.floating_config ?? null,
        };
        setLoadedPage(page);
        try {
          await openPanelWindows(page.panels, page.floating_config);
          await cachePage(page);
          respond({ type: 'render_result', request_id: String(cmd.request_id ?? ''), ok: true, page_id: page.page_id, phase: 'rendered' });
        } catch (error) {
          respond({
            type: 'render_result',
            request_id: String(cmd.request_id ?? ''),
            ok: false,
            page_id: page.page_id,
            phase: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case 'local_action': {
        const requestId = String(cmd.request_id ?? '');
        try {
          if (cmd.action !== 'show' && cmd.action !== 'hide') throw new Error(`Unsupported local action: ${cmd.action}`);
          await invoke('set_kiosk_visible', { visible: cmd.action === 'show' });
          respond({ type: 'local_action_result', request_id: requestId, ok: true, result: { action: cmd.action } });
        } catch (error) {
          respond({ type: 'local_action_result', request_id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        break;
      }

      case 'navigate_panel': {
        const panelId = cmd.panel_id as string;
        const url     = cmd.url as string;
        if (panelId != null && url) {
          await invoke('navigate_webview', { label: `panel-${panelId}`, url }).catch(console.error);
        }
        break;
      }

      case 'panel.patch': {
        const panelId = cmd.panel_id as string;
        const content = cmd.content as { type?: string; url?: string; scene_id?: string } | undefined;
        const panel = loadedPage?.panels.find(item => item.id === panelId);
        if (panel && content) {
          panel.content_type = content.type === 'scene' ? 'scene' : 'url';
          panel.url = content.url ?? null;
          panel.scene_id = content.scene_id ?? null;
          await invoke('navigate_webview', {
            label: `panel-${panelId}`,
            url: resolvePanelUrl(panel, config, deviceId),
          }).catch(console.error);
        }
        if (typeof cmd.visible === 'boolean') {
          await invoke('set_webview_visibility', { label: `panel-${panelId}`, visible: cmd.visible }).catch(console.error);
        }
        break;
      }

      case 'panel.reload': {
        const panelId = cmd.panel_id as string;
        const panel = loadedPage?.panels.find(item => item.id === panelId);
        if (panel) {
          await invoke('navigate_webview', {
            label: `panel-${panelId}`,
            url: resolvePanelUrl(panel, config, deviceId),
          }).catch(console.error);
        }
        break;
      }

      case 'show_floating': {
        const url = cmd.url as string | undefined;
        if (url) await openFloatingUrl(url);
        break;
      }

      case 'youtube_pause':
      case 'youtube_resume':
      case 'youtube_stop':
      case 'youtube_next':
      case 'youtube_previous':
      case 'youtube_volume':
      case 'youtube_mute': {
        const action = cmd.type.replace('youtube_', '');
        const rawValue = (cmd.payload as Record<string, unknown> | undefined)?.value;
        const value = rawValue === undefined || rawValue === null ? undefined : Number(rawValue);
        await invoke('control_youtube_webview', { label: 'floating', action, value }).catch(console.error);
        if (action === 'stop') {
          await invoke('close_webview', { label: 'floating' }).catch(console.error);
        }
        break;
      }

      case 'hide_floating':
        floatingOpenRef.current = false;
        invoke('set_webview_visibility', { label: 'floating', visible: false }).catch(() => {});
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
  }, [openPanelWindows, openFloatingUrl, loadedPage]);

  useServerSocket({
    serverUrl: controlChannel.serverUrl,
    deviceId: controlChannel.deviceId || deviceId,
    enabled:   appState === 'ready' && !!deviceId,
    onCommand: handleCommand,
  });

  // The Rust Edge Agent owns the Gateway v1 connection and applies desired scenes by
  // posting them to the embedded loopback sidecar. Keep a second local renderer socket
  // so that path can wait for a real panel-load result before the Agent reports applied.
  useServerSocket({
    serverUrl: 'http://127.0.0.1:3100',
    deviceId,
    enabled: appState === 'ready' && !!deviceId,
    onCommand: handleCommand,
  });

  // ── Fallback: single fullscreen display window when no page assigned ───────
  useEffect(() => {
    if (appState !== 'ready' || !deviceId || loadedPage) return;
    const label = 'panel-fallback';
    invoke<boolean>('webview_exists', { label }).then(async exists => {
      if (exists) return;
      const { width: sw, height: sh } = await getDisplayGeometry();
      // Use the batched command: the singular `create_panel_webview` rejects
      // with "current webview is not a WebviewWindow" from the controller webview.
      invoke('create_panel_webviews', {
        panels: [{
          label,
          url:           `${config.haUrl}/canvas-ui-static/kiosk.html`,
          x:             0,
          y:             0,
          width:         sw,
          height:        sh,
          visible:       true,
          ingressSession: null,
          initScript:    config.haToken ? buildHAAuthScript(config.haUrl, config.haToken) : null,
        }],
      }).catch(e => console.error('[fallback] create_panel_webviews error:', e));
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
      {/* corner tap target for opening settings */}
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
