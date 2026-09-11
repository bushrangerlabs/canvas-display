/**
 * Custom Dashboard Widget - Free-form HTML/CSS/JS dashboard with entity connection
 *
 * Renders user (or AI) generated HTML/CSS/JS inside a sandboxed <iframe>
 * (sandbox="allow-scripts" only - no same-origin, so the custom code cannot
 * reach the host page DOM). A small bridge script injects a global
 * `window.CanvasHermes` API that talks to the host via postMessage so the
 * custom code can read Home Assistant entity states and call services.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { useWebSocket } from '../providers/WebSocketProvider';
import type { WidgetProps } from '../types';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';

// Tag every postMessage exchanged with the iframe so we can ignore unrelated ones.
const BRIDGE_TAG = '__canvasHermes';

const CustomDashboardWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const {
    html: htmlContent = '',
    css: cssContent = '',
    js: jsContent = '',
    backgroundColor = 'transparent',
  } = config.config;

  const { entities, callService } = useWebSocket();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Tracks whether the iframe has signalled "ready" so we only push entities then.
  const readyRef = useRef(false);

  // Build the sandboxed document once per html/css/js change.
  // Entity updates are delivered via postMessage, NOT by re-building srcdoc,
  // so live state flows in without reloading the custom code.
  const srcDoc = useMemo(() => {
    // Prevent the custom JS from prematurely closing the bridge <script> tag.
    const safeJs = String(jsContent).replace(/<\/script>/gi, '<\\/script>');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  ${String(cssContent)}
</style>
</head>
<body>
${String(htmlContent)}
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
    subscribe: function (cb) {
      if (typeof cb === 'function') {
        SUBSCRIBERS.add(cb);
        cb(ENTITIES);
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
  parent.postMessage({ __canvasHermes: true, type: 'ready' }, '*');
})();
<\/script>
<script>
${safeJs}
<\/script>
</body>
</html>`;
  }, [htmlContent, cssContent, jsContent]);

  // Listen for messages coming FROM the iframe (ready / service calls).
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const iframe = iframeRef.current;
      // Only accept messages that originate from our own iframe.
      if (!iframe || ev.source !== iframe.contentWindow) return;
      const data = ev.data;
      if (!data || data[BRIDGE_TAG] !== true) return;

      if (data.type === 'ready') {
        readyRef.current = true;
        // Push a fresh snapshot of all entity states.
        iframe.contentWindow?.postMessage(
          { [BRIDGE_TAG]: true, type: 'entities', entities },
          '*',
        );
      } else if (data.type === 'callService') {
        const respond = (result: any, error?: string) => {
          iframe.contentWindow?.postMessage(
            { [BRIDGE_TAG]: true, type: 'callResult', id: data.id, result, error },
            '*',
          );
        };
        if (!callService) {
          respond(null, 'Entity service not available');
          return;
        }
        Promise.resolve(callService(data.domain, data.service, data.data))
          .then((res) => respond(res))
          .catch((err) => respond(null, (err as Error)?.message || 'Service call failed'));
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [entities, callService]);

  // Push live entity updates into the iframe whenever HA state changes.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe && readyRef.current && iframe.contentWindow) {
      iframe.contentWindow.postMessage(
        { [BRIDGE_TAG]: true, type: 'entities', entities },
        '*',
      );
    }
  }, [entities]);

  // Reset readiness when the document is rebuilt (iframe reloads).
  useEffect(() => {
    readyRef.current = false;
  }, [srcDoc]);

  const universalStyle = useResolvedUniversalStyle(config.config.style || config.config as any);
  const baseStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    backgroundColor,
    boxSizing: 'border-box',
  };
  const finalStyle = applyUniversalStyles(universalStyle, baseStyle);

  const iframeStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
    // Disable interaction while editing so the canvas stays clickable.
    pointerEvents: isEditMode ? 'none' : 'auto',
    ...finalStyle,
  };

  return (
    <iframe
      ref={iframeRef}
      title="Custom Dashboard"
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      style={iframeStyle}
    />
  );
};

export const customDashboardMetadata: WidgetMetadata = {
  name: 'Custom Dashboard',
  description: 'Free-form HTML/CSS/JS dashboard with Home Assistant entity connection',
  icon: 'CodeOutlined',
  category: 'display',
  defaultSize: { w: 400, h: 300 },
  aiHints: [
    'Use for fully custom layouts the built-in widgets cannot express.',
    'Connect entities from JS via the global CanvasHermes API (getState, subscribe, callService).',
    'Return one or more of these widgets to compose a free-form dashboard.',
  ],
  fields: [
    // Layout
    { name: 'width', type: 'number', label: 'Width', default: 400, min: 100, category: 'layout' },
    { name: 'height', type: 'number', label: 'Height', default: 300, min: 100, category: 'layout' },

    // Behavior
    {
      name: 'html',
      type: 'code-editor',
      label: 'HTML',
      default: '<div id="root">Custom dashboard</div>',
      category: 'behavior',
      description: 'HTML markup rendered inside the widget',
    },
    {
      name: 'css',
      type: 'code-editor',
      label: 'CSS',
      default: '#root { font-family: sans-serif; color: #fff; }',
      category: 'behavior',
      description: 'CSS applied to the HTML',
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

    // Style
    { name: 'backgroundColor', type: 'color', label: 'Background Color', default: 'transparent', category: 'style' },
  ],
};

export default CustomDashboardWidget;
