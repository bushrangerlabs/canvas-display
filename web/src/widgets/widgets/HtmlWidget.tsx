/**
 * HTML Widget - Display custom HTML/CSS/JS content with entity connection.
 *
 * Renders the widget content inside an <iframe> with srcDoc. A small bridge
 * injects a global `window.CanvasHermes` API that talks to the host via
 * postMessage, letting AI-generated (or hand-written) content read Home
 * Assistant entity states and call services.
 *
 * Note: we intentionally do NOT set the `sandbox` attribute. The Canvas Core
 * display runs inside a WebKit/Tauri webview (Raspberry Pi), which does not
 * paint sandboxed (null-origin) iframes — they render blank. A plain iframe
 * renders everywhere while the postMessage bridge still keeps the custom JS in
 * its own document realm.
 *
 * This is what enables the AI to build custom, entity-connected dashboards
 * *inside* an HTML widget rather than across the whole editor.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { useWebSocket } from '../providers/WebSocketProvider';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';

// Tag every postMessage exchanged with the iframe so we can ignore unrelated ones.
const BRIDGE_TAG = '__canvasHermes';

function isTransparentCssColor(value: unknown): boolean {
  const color = String(value ?? '').replace(/\s+/g, '').toLowerCase();
  return !color || color === 'transparent' || color === 'rgba(0,0,0,0)' || color === '#0000' || color === '#00000000';
}

const HtmlWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const {
    html: htmlContent = '<div>Enter HTML here</div>',
    htmlEntity = '',
    useEntityHtml = false,
    htmlAttribute = '',
    css: cssContent = '',
    js: jsContent = '',
    backgroundColor = 'transparent',
    padding = 8,
    overflow = 'auto',
    entities: boundEntities = [],
  } = config.config;

  const { entities, callService } = useWebSocket();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Keep latest values in refs so the (once-attached) message listener always
  // reads current data without re-subscribing every render.
  const entitiesRef = useRef(entities);
  const callServiceRef = useRef(callService);

  useEffect(() => {
    entitiesRef.current = entities;
  }, [entities]);

  useEffect(() => {
    callServiceRef.current = callService;
  }, [callService]);

  // Effective HTML: prefer an entity's state/attribute when enabled, else static config.
  const effectiveHtml = useMemo(() => {
    if (useEntityHtml && htmlEntity) {
      const entity = entities?.[htmlEntity];
      if (entity) {
        if (htmlAttribute && entity.attributes?.[htmlAttribute] != null) {
          return String(entity.attributes[htmlAttribute]);
        }
        return String(entity.state || '');
      }
    }
    return String(htmlContent);
  }, [useEntityHtml, htmlEntity, htmlAttribute, htmlContent, entities]);

  // Build the sandboxed document from html/css/js. Entity state updates are
  // delivered via postMessage (not by rebuilding srcDoc) so live data flows in
  // without reloading the custom code.
  const srcDoc = useMemo(() => {
    const safeJs = String(jsContent).replace(/<\/script>/gi, '<\\/script>');
    const safeCss = String(cssContent).replace(/<\/style>/gi, '<\\/style>');
    // When the widget's Background Color is 'transparent', enforce it AFTER the
    // user/AI CSS: generated styles frequently paint html/body opaque, which
    // would otherwise defeat the transparency setting (equal specificity, but
    // later in the cascade — and !important beats non-important).
    const forceTransparent = isTransparentCssColor(backgroundColor)
      ? '<style>' +
        'html, body, body *, #root, [id], [class] { ' +
        'background: transparent !important; ' +
        'background-color: transparent !important; ' +
        'background-image: none !important; ' +
        'border-color: transparent !important; ' +
        'box-shadow: none !important; ' +
        '}' +
        '</style>'
      : '';
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; box-sizing: border-box; background: transparent; }
  *, *::before, *::after { box-sizing: border-box; }
  body { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
</style>
<style>${safeCss}</style>
${forceTransparent}
</head>
<body>
${effectiveHtml}
<script>
(function () {
  var SUBSCRIBERS = new Set();
  var ENTITIES = {};
  function notify() {
    SUBSCRIBERS.forEach(function (cb) {
      try { cb(ENTITIES); } catch (e) { /* ignore subscriber errors */ }
    });
  }
  window.CanvasHermes = {
    getState: function (id) {
      var e = ENTITIES[id];
      if (!e) return undefined;
      return { state: e.state, attributes: e.attributes, last_changed: e.last_changed, last_updated: e.last_updated };
    },
    getAllStates: function () { return ENTITIES; },
    configuredEntities: ${JSON.stringify(Array.isArray(boundEntities) ? boundEntities : [])},
    subscribe: function (cb) {
      if (typeof cb === 'function') {
        SUBSCRIBERS.add(cb);
        cb(ENTITIES);
        // Ask the host for a fresh push in case we subscribed before its first
        // entity delivery (avoids a race where the initial state is empty).
        parent.postMessage({ __canvasHermes: true, type: 'requestEntities' }, '*');
      }
      return function () { SUBSCRIBERS.delete(cb); };
    },
    callService: function (domain, service, data) {
      return new Promise(function (resolve, reject) {
        var id = 'call_' + Math.random().toString(36).slice(2);
        function handler(ev) {
          if (ev.data && ev.data.__canvasHermes && ev.data.type === 'callResult' && ev.data.id === id) {
            window.removeEventListener('message', handler);
            if (ev.data.error) reject(new Error(ev.data.error));
            else resolve(ev.data.result);
          }
        }
        window.addEventListener('message', handler);
        parent.postMessage({ __canvasHermes: true, type: 'callService', id: id, domain: domain, service: service, data: data || {} }, '*');
      });
    }
  };
  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.__canvasHermes && ev.data.type === 'entities') {
      ENTITIES = ev.data.entities || {};
      notify();
    }
  });
  // Surface runtime errors (from either the harness or AI/user JS) so the
  // device logs / editor can show what went wrong instead of failing silently.
  window.addEventListener('error', function (ev) {
    var msg = (ev && ev.message) ? String(ev.message) : 'Unknown script error';
    parent.postMessage({ __canvasHermes: true, type: 'error', message: msg + (ev && ev.lineno ? ' (line ' + ev.lineno + ')' : '') }, '*');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    parent.postMessage({ __canvasHermes: true, type: 'error', message: 'Unhandled rejection: ' + (r && r.message ? String(r.message) : String(r)) }, '*');
  });
  parent.postMessage({ __canvasHermes: true, type: 'ready' }, '*');
})();
<${'/'}script>
<script>
${safeJs}
<${'/'}script>
</body>
</html>`;
  }, [effectiveHtml, cssContent, jsContent, backgroundColor, boundEntities]);

  // Listen for messages coming FROM the iframe (ready / re-request / service calls).
  // Attached once; reads current values via refs so it never misses a message
  // due to re-subscription churn.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || ev.source !== iframe.contentWindow) return;
      const data = ev.data;
      if (!data || data[BRIDGE_TAG] !== true) return;

      if (data.type === 'ready' || data.type === 'requestEntities') {
        iframe.contentWindow?.postMessage(
          { [BRIDGE_TAG]: true, type: 'entities', entities: entitiesRef.current },
          '*',
        );
      } else if (data.type === 'callService') {
        const respond = (result: unknown, error?: string) => {
          iframe.contentWindow?.postMessage(
            { [BRIDGE_TAG]: true, type: 'callResult', id: data.id, result, error },
            '*',
          );
        };
        if (!callServiceRef.current) {
          respond(null, 'Entity service not available');
          return;
        }
        Promise.resolve(callServiceRef.current(data.domain, data.service, data.data))
          .then((res) => respond(res))
          .catch((err) => respond(null, (err as Error)?.message || 'Service call failed'));
      } else if (data.type === 'error') {
        // Forward sandbox JS errors to the runtime console so they surface in
        // device logs and are debuggable on the actual display hardware.
        console.warn('[canvas:html-widget] sandbox error:', data.message);
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Push live entity updates into the iframe whenever HA state changes. Not gated
  // on a `ready` handshake — if the iframe isn't ready yet the post is harmless,
  // and the iframe also re-requests on subscribe (see srcDoc), so data always
  // arrives regardless of message-timing races.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(
        { [BRIDGE_TAG]: true, type: 'entities', entities },
        '*',
      );
    }
  }, [entities]);

  const universalStyle = useResolvedUniversalStyle(config.config.style || config.config as any);
  const isTransparentBackground = isTransparentCssColor(backgroundColor);
  const baseStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    backgroundColor,
    padding: `${padding}px`,
    overflow,
    boxSizing: 'border-box',
  };
  const finalStyle = applyUniversalStyles(universalStyle, baseStyle);

  const iframeStyle: React.CSSProperties = {
    ...finalStyle,
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
    background: isTransparentBackground ? 'transparent' : backgroundColor,
    backgroundColor: isTransparentBackground ? 'transparent' : backgroundColor,
    boxSizing: 'border-box',
    pointerEvents: isEditMode ? 'none' : 'auto',
  };

  return (
    <iframe
      ref={iframeRef}
      title="HTML Widget"
      srcDoc={srcDoc}
      style={iframeStyle}
    />
  );
};

export const htmlWidgetMetadata: WidgetMetadata = {
  name: 'HTML',
  description: 'Display custom HTML/CSS/JS with Home Assistant entity connection (AI can build inside it)',
  icon: 'CodeOutlined',
  category: 'display',
  defaultSize: { w: 400, h: 300 },
  fields: [
    // Layout
    { name: 'width', type: 'number', label: 'Width', default: 400, min: 100, category: 'layout' },
    { name: 'height', type: 'number', label: 'Height', default: 300, min: 100, category: 'layout' },

    // Behavior
    {
      name: 'useEntityHtml',
      type: 'checkbox',
      label: 'HTML From Entity',
      default: false,
      category: 'behavior',
      description: 'Data-source mode: render an entity\'s state/attribute AS the whole widget HTML. Keep OFF for AI-built widgets that read entities in JS.',
    },
    {
      name: 'htmlEntity',
      type: 'entity',
      label: 'HTML Source Entity',
      default: '',
      category: 'behavior',
      description: 'Only used when "HTML From Entity" is enabled — the entity whose state/attribute becomes the HTML',
    },
    {
      name: 'htmlAttribute',
      type: 'text',
      label: 'HTML Source Attribute',
      default: '',
      category: 'behavior',
      description: 'Only with "HTML From Entity": attribute containing the HTML (bypasses the 255-char state limit). Leave blank to use state.',
    },
    {
      name: 'entities',
      type: 'entity-list',
      label: 'JS Entity Bindings',
      default: [],
      category: 'behavior',
      description: 'Entities your widget JS reads via CanvasHermes and the AI Builder uses as context. Entities referenced by AI-generated code are bound here automatically.',
    },
    {
      name: 'html',
      type: 'code-editor',
      label: 'HTML',
      default: '<div id="root">Custom content</div>',
      category: 'behavior',
      description: 'Custom HTML markup (AI can generate this)',
    },
    {
      name: 'css',
      type: 'code-editor',
      label: 'CSS',
      default: '#root { font-family: sans-serif; color: #fff; }',
      category: 'behavior',
      description: 'CSS applied to the HTML (AI can generate this)',
    },
    {
      name: 'js',
      type: 'code-editor',
      label: 'JavaScript',
      default:
        "const unsub = CanvasHermes.subscribe((states) => {\n  const el = document.getElementById('root');\n  if (el) el.textContent = 'Entities: ' + Object.keys(states).length;\n});",
      category: 'behavior',
      description: 'JavaScript executed in the widget. Use the global CanvasHermes API to connect entities.',
    },
    {
      name: 'overflow',
      type: 'select',
      label: 'Overflow',
      default: 'auto',
      category: 'behavior',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'hidden', label: 'Hidden' },
        { value: 'scroll', label: 'Scroll' },
        { value: 'visible', label: 'Visible' },
      ],
    },

    // Style
    { name: 'backgroundColor', type: 'color', label: 'Background Color', default: 'transparent', category: 'style' },
    { name: 'padding', type: 'number', label: 'Padding', default: 8, min: 0, max: 50, category: 'style' },
  ],
};

export default HtmlWidget;
