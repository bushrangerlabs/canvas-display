/**
 * Canvas UI Platform Panel
 *
 * Companion integration panel element — loads the Canvas UI Platform SPA
 * directly into Home Assistant's page (same document, same window, same
 * customElements registry). This gives Lovelace card widgets native access
 * to window.hass and customElements exactly as the HACS version does.
 *
 * Registration in __init__.py:
 *   frontend_url_path = "canvas-ui-platform"
 *   webcomponent_name = "canvas-ui-platform-panel"
 *   embed_iframe = False   ← key: runs in HA's own document, not an iframe
 */
class CanvasUIPlatformPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._loaded = false;
  }

  // HA calls set panel() with the panel config object before connectedCallback
  set panel(panel) {
    this._panel = panel;
  }

  set hass(hass) {
    this._hass = hass;
    // Expose hass globally so the React app (and Lovelace card widgets) can
    // always access it without walking the window hierarchy.
    window.hass = hass;
    if (hass && !this._loaded) {
      this._boot();
    }
  }

  get hass() {
    return this._hass;
  }

  async connectedCallback() {
    this.style.display = 'none';
    if (this._hass && !this._loaded) {
      this._boot();
    }
  }

  disconnectedCallback() {
    const root = document.getElementById('canvas-ui-platform-root');
    if (root) root.style.display = 'none';
  }

  // ──────────────────────────────────────────────────────────────────────────

  async _boot() {
    if (this._loaded) return;
    this._loaded = true;

    try {
      // 1. Discover this add-on's ingress URL via HA's supervisor proxy
      const ingressBase = await this._getIngressBase();
      if (!ingressBase) throw new Error('Could not resolve Canvas UI Platform ingress URL');

      // 2. Create an ingress session and set the cookie (required for
      //    Fastify to accept requests from this browser session)
      await this._createIngressSession(ingressBase);

      // 3. Create the root div (positioned like the HACS panel — fills
      //    the HA content area to the right of the sidebar)
      this._ensureRoot();

      // 4. Fetch the platform SPA entry HTML from the ingress, parse it,
      //    rewrite relative asset paths, and inject into HA's document.
      //    The SPA then mounts to #canvas-ui-platform-root — same document,
      //    same window — no iframes, no cross-realm issues.
      await this._loadApp(ingressBase);

    } catch (e) {
      console.error('[Canvas UI Platform Panel] Boot error:', e);
      this._showError(String(e));
    }
  }

  async _getIngressBase() {
    try {
      const res = await fetch('/api/hassio/addons/canvas_ui_platform/info', {
        headers: { Authorization: `Bearer ${this._hass.auth.accessToken}` },
      });
      if (!res.ok) throw new Error(`Supervisor API ${res.status}`);
      const data = await res.json();
      // ingress_url looks like "/api/hassio_ingress/TOKEN/"
      let url = data.data?.ingress_url ?? data.ingress_url ?? null;
      if (!url) throw new Error('No ingress_url in response');
      if (!url.endsWith('/')) url += '/';
      // Make it absolute using current origin
      return window.location.origin + url;
    } catch (e) {
      console.warn('[Canvas UI Platform Panel] Could not get ingress URL via supervisor API:', e);
      return null;
    }
  }

  async _createIngressSession(ingressBase) {
    try {
      const res = await fetch('/api/ingress/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this._hass.auth.accessToken}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.session) {
        document.cookie = `ingress_session=${data.session}; path=/; max-age=3600; SameSite=Strict`;
      }
    } catch (e) {
      console.warn('[Canvas UI Platform Panel] Could not create ingress session:', e);
    }
  }

  _ensureRoot() {
    let root = document.getElementById('canvas-ui-platform-root');
    if (root) {
      root.style.display = 'block';
      return root;
    }

    root = document.createElement('div');
    root.id = 'canvas-ui-platform-root';

    const sidebarWidth = this._getSidebarWidth();
    root.style.cssText = [
      'position: fixed',
      'top: 0',
      `left: ${sidebarWidth}px`,
      `width: calc(100% - ${sidebarWidth}px)`,
      'height: 100vh',
      'margin: 0',
      'padding: 0',
      'z-index: 1',
      'transition: left 0.2s ease, width 0.2s ease',
    ].join('; ');

    document.body.appendChild(root);

    // Keep position in sync with sidebar expand/collapse
    let lastWidth = sidebarWidth;
    const iv = setInterval(() => {
      const w = this._getSidebarWidth();
      if (w !== lastWidth) {
        lastWidth = w;
        root.style.left = `${w}px`;
        root.style.width = `calc(100% - ${w}px)`;
      }
    }, 200);
    this._sidebarPollInterval = iv;

    return root;
  }

  _getSidebarWidth() {
    const panelCustom = this.closest('ha-panel-custom');
    if (panelCustom) {
      const r = panelCustom.getBoundingClientRect();
      if (r.left > 0) return Math.round(r.left);
    }
    if (this.offsetLeft > 0) return this.offsetLeft;
    const resolver = document.querySelector('partial-panel-resolver');
    if (resolver) {
      const r = resolver.getBoundingClientRect();
      if (r.left > 0) return Math.round(r.left);
    }
    const main = document.querySelector('home-assistant-main');
    if (main && main.hasAttribute('expanded')) return 256;
    return 56;
  }

  async _loadApp(ingressBase) {
    // Fetch the platform SPA entry HTML from the ingress URL
    const res = await fetch(ingressBase, { credentials: 'include' });
    if (!res.ok) throw new Error(`Fetch app HTML failed: ${res.status}`);
    const html = await res.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Rewrite the React root mount target so it matches our root div id.
    // The React app calls document.getElementById('root') — patch the global
    // getElementById to redirect it to our root div during app init.
    const rootDiv = document.getElementById('canvas-ui-platform-root');
    const _orig = document.getElementById.bind(document);
    const _patched = (id) => (id === 'root' ? rootDiv : _orig(id));
    document.getElementById = _patched;
    // Restore after a brief delay once React has mounted
    setTimeout(() => { document.getElementById = _orig; }, 5000);

    // Inject CSS links
    doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      const abs = this._resolveUrl(href, ingressBase);
      if (document.querySelector(`link[href="${abs}"]`)) return;
      const el = document.createElement('link');
      el.rel = 'stylesheet';
      el.crossOrigin = '';
      el.href = abs;
      document.head.appendChild(el);
    });

    // Inject module scripts — each script tag must be a fresh element to
    // force the browser to execute it (cloneNode doesn't re-execute)
    const scripts = [...doc.querySelectorAll('script[type="module"]')];
    for (const script of scripts) {
      await new Promise((resolve) => {
        const el = document.createElement('script');
        el.type = 'module';
        el.crossOrigin = '';
        const src = script.getAttribute('src');
        if (src) {
          el.src = this._resolveUrl(src, ingressBase);
          el.onload = resolve;
          el.onerror = resolve;
        } else {
          el.textContent = script.textContent;
          resolve();
        }
        document.head.appendChild(el);
      });
    }
  }

  _resolveUrl(path, base) {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('/')) return window.location.origin + path;
    // Relative path — resolve against ingress base
    try { return new URL(path, base).href; } catch { return path; }
  }

  _showError(msg) {
    const root = document.getElementById('canvas-ui-platform-root');
    if (root) {
      root.innerHTML = `<div style="color:#f57;padding:24px;font-family:sans-serif">
        <b>Canvas UI Platform</b><br><br>${msg}
      </div>`;
    }
  }
}

if (!customElements.get('canvas-ui-platform-panel')) {
  customElements.define('canvas-ui-platform-panel', CanvasUIPlatformPanel);
}
