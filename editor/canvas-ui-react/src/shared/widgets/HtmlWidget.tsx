/**
 * HTML Widget - Display custom HTML content
 * Migrated to Phase 44 standards (Feb 15, 2026)
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { useWebSocket } from '../providers/WebSocketProvider';
import type { WidgetProps } from '../types';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';
import { buildHtmlSrcDoc, isTransparentCssColor } from './htmlSrcDoc';

const BRIDGE_TAG = '__canvasHermes';

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
  } = config.config;

  const { entities, callService } = useWebSocket();
  const universalStyle = useResolvedUniversalStyle(config.config.style || config.config as any);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Get HTML from entity attribute, entity state, or static config
  const getHtml = (): string => {
    if (useEntityHtml && htmlEntity) {
      const entity = entities?.[htmlEntity];
      if (entity) {
        // Prefer named attribute (no 255-char state limit) when htmlAttribute is set
        if (htmlAttribute && entity.attributes?.[htmlAttribute] != null) {
          return String(entity.attributes[htmlAttribute]);
        }
        return String(entity.state || '');
      }
    }
    return htmlContent;
  };

  const effectiveHtml = getHtml();
  const srcDoc = useMemo(
    () => buildHtmlSrcDoc(effectiveHtml, cssContent, jsContent, backgroundColor),
    [effectiveHtml, cssContent, jsContent, backgroundColor],
  );

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow || !ev.data?.[BRIDGE_TAG]) return;
      if (ev.data.type === 'ready' || ev.data.type === 'requestEntities') {
        iframeRef.current?.contentWindow?.postMessage({ [BRIDGE_TAG]: true, type: 'entities', entities }, '*');
      } else if (ev.data.type === 'callService') {
        const respond = (result: unknown, error?: string) => iframeRef.current?.contentWindow?.postMessage({ [BRIDGE_TAG]: true, type: 'callResult', id: ev.data.id, result, error }, '*');
        if (!callService) return respond(null, 'Entity service not available');
        Promise.resolve(callService(ev.data.domain, ev.data.service, ev.data.data)).then(result => respond(result)).catch(error => respond(null, error?.message || 'Service call failed'));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [entities, callService]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ [BRIDGE_TAG]: true, type: 'entities', entities }, '*');
  }, [entities]);

  const baseStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    backgroundColor,
    padding: `${padding}px`,
    overflow,
    boxSizing: 'border-box',
  };
  const finalStyle = applyUniversalStyles(universalStyle, baseStyle);

  return (
    <iframe
      ref={iframeRef}
      title="HTML Widget"
      srcDoc={srcDoc}
      style={{
        ...finalStyle,
        width: '100%',
        height: '100%',
        border: 'none',
        display: 'block',
        background: isTransparentCssColor(backgroundColor) ? 'transparent' : backgroundColor,
        backgroundColor: isTransparentCssColor(backgroundColor) ? 'transparent' : backgroundColor,
        pointerEvents: isEditMode ? 'none' : 'auto',
      }}
    />
  );
};

export const htmlWidgetMetadata: WidgetMetadata = {
  name: 'HTML',
  description: 'Display custom HTML content',
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
      label: 'Use Entity HTML', 
      default: false, 
      category: 'behavior',
      description: 'Use entity state as HTML instead of static HTML'
    },
    { 
      name: 'htmlEntity', 
      type: 'entity', 
      label: 'HTML Entity', 
      default: '', 
      category: 'behavior',
      description: 'Entity whose state or attribute contains the HTML'
    },
    { 
      name: 'htmlAttribute', 
      type: 'text', 
      label: 'HTML Attribute', 
      default: '', 
      category: 'behavior',
      description: 'Entity attribute name containing HTML (bypasses 255-char state limit). Leave blank to use state.'
    },
    { 
      name: 'html', 
      type: 'textarea', 
      label: 'HTML Content', 
      default: '<div>Enter HTML here</div>', 
      category: 'behavior',
      description: 'Custom HTML content'
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
        { value: 'visible', label: 'Visible' }
      ]
    },

    // Style
    { name: 'backgroundColor', type: 'color', label: 'Background Color', default: 'transparent', category: 'style' },
    { name: 'padding', type: 'number', label: 'Padding', default: 8, min: 0, max: 50, category: 'style' },
  ],
};

export default HtmlWidget;
