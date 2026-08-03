import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';

export const KnowledgeCardWidgetMetadata: WidgetMetadata = {
  name: 'Knowledge Card',
  icon: 'AutoStories',
  category: 'display',
  description: 'Displays AI-fetched web search or Wikipedia results pushed by Canvas Core',
  defaultSize: { w: 560, h: 400 },
  minSize: { w: 260, h: 200 },
  fields: [
    { name: 'pollInterval', type: 'number', label: 'Poll interval (s)', default: 5, min: 2, max: 60, category: 'behavior', description: 'How often to check for new knowledge card content' },
    { name: 'autoDismiss', type: 'number', label: 'Auto-dismiss (s, 0=off)', default: 30, min: 0, max: 300, category: 'behavior', description: 'Auto-clear after this many seconds (0 to keep until replaced)' },
    { name: 'showSource', type: 'checkbox', label: 'Show source URL', default: true, category: 'behavior' },
    { name: 'showDismiss', type: 'checkbox', label: 'Show dismiss button', default: true, category: 'behavior' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#1a2332', category: 'style' },
    { name: 'headerColor', type: 'color', label: 'Header background', default: '#213047', category: 'style' },
    { name: 'titleColor', type: 'color', label: 'Title colour', default: '#e8f0fe', category: 'style' },
    { name: 'bodyColor', type: 'color', label: 'Body text colour', default: '#b9c2d0', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent / link colour', default: '#4a9eff', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 16, min: 0, max: 60, category: 'style' },
    { name: 'fontSize', type: 'number', label: 'Body font size (px)', default: 15, min: 10, max: 36, category: 'style' },
  ],
};

interface KnowledgeCard {
  title: string;
  body: string;
  source_url?: string;
  source_label?: string;
  image_url?: string;
  timestamp?: string;
}

const SAMPLE_CARD: KnowledgeCard = {
  title: 'Knowledge Card',
  body: 'When Canvas Core answers a general knowledge question it will display the result here — drawn from web search or Wikipedia.',
  source_url: 'https://en.wikipedia.org',
  source_label: 'Wikipedia',
};

export default function KnowledgeCardWidget({ config, isEditMode }: WidgetProps) {
  const c = config.config ?? {};
  const width = config.position?.width ?? 560;
  const height = config.position?.height ?? 400;

  const pollInterval = Math.max(2, Number(c.pollInterval ?? 5)) * 1000;
  const autoDismissSec = Number(c.autoDismiss ?? 30);
  const showSource = c.showSource !== false;
  const showDismiss = c.showDismiss !== false;

  const [card, setCard] = useState<KnowledgeCard | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCard = async () => {
    if (isEditMode) return;
    try {
      const res = await fetch('/api/knowledge-card/latest', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as KnowledgeCard & { empty?: boolean };
      if (data.empty) {
        setCard(null);
        setDismissed(false);
      } else {
        setCard(data);
        setDismissed(false);
        if (autoDismissSec > 0) {
          if (dismissTimer.current) clearTimeout(dismissTimer.current);
          dismissTimer.current = setTimeout(() => setDismissed(true), autoDismissSec * 1000);
        }
      }
    } catch {
      // silently ignore — server may not have knowledge-card route yet
    }
  };

  useEffect(() => {
    if (isEditMode) return;
    void fetchCard();
    const timer = window.setInterval(() => void fetchCard(), pollInterval);
    return () => {
      window.clearInterval(timer);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, pollInterval, autoDismissSec]);

  // Also respond to pushed window events (e.g. from a future WebSocket push)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<KnowledgeCard>).detail;
      setCard(detail);
      setDismissed(false);
      if (autoDismissSec > 0) {
        if (dismissTimer.current) clearTimeout(dismissTimer.current);
        dismissTimer.current = setTimeout(() => setDismissed(true), autoDismissSec * 1000);
      }
    };
    window.addEventListener('canvas:knowledge-card', handler);
    return () => window.removeEventListener('canvas:knowledge-card', handler);
  }, [autoDismissSec]);

  const displayCard = isEditMode ? SAMPLE_CARD : card;

  const style: CSSProperties = {
    width,
    height,
    boxSizing: 'border-box',
    borderRadius: `${Number(c.borderRadius ?? 16)}px`,
    background: String(c.backgroundColor ?? '#1a2332'),
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'system-ui, sans-serif',
    position: 'relative',
  };

  if (!displayCard || dismissed) {
    return (
      <div style={{ ...style, alignItems: 'center', justifyContent: 'center', opacity: 0.4 }}>
        <div style={{ textAlign: 'center', color: String(c.bodyColor ?? '#b9c2d0'), fontSize: 14 }}>
          <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}>📖</span>
          Awaiting knowledge…
        </div>
      </div>
    );
  }

  return (
    <div style={style}>
      {/* Header */}
      <div style={{
        background: String(c.headerColor ?? '#213047'),
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexShrink: 0,
      }}>
        <span style={{
          color: String(c.titleColor ?? '#e8f0fe'),
          fontSize: Math.min(20, Math.max(12, Number(c.fontSize ?? 15)) + 3),
          fontWeight: 600,
          lineHeight: 1.3,
          flex: 1,
        }}>
          {displayCard.title}
        </span>
        {showDismiss && !isEditMode && (
          <button
            onClick={() => setDismissed(true)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: String(c.bodyColor ?? '#b9c2d0'),
              fontSize: 18,
              padding: '2px 4px',
              lineHeight: 1,
              flexShrink: 0,
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>

      {/* Optional image */}
      {displayCard.image_url && (
        <div style={{ flexShrink: 0, maxHeight: Math.round(height * 0.35), overflow: 'hidden' }}>
          <img
            src={displayCard.image_url}
            alt=""
            style={{ width: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
      )}

      {/* Body */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 16px',
        color: String(c.bodyColor ?? '#b9c2d0'),
        fontSize: Number(c.fontSize ?? 15),
        lineHeight: 1.6,
      }}>
        {displayCard.body}
      </div>

      {/* Source */}
      {showSource && displayCard.source_url && (
        <div style={{
          padding: '8px 16px',
          borderTop: `1px solid rgba(255,255,255,0.08)`,
          flexShrink: 0,
        }}>
          <a
            href={displayCard.source_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: String(c.accentColor ?? '#4a9eff'),
              fontSize: 12,
              textDecoration: 'none',
              wordBreak: 'break-all',
            }}
          >
            🔗 {displayCard.source_label ?? displayCard.source_url}
          </a>
        </div>
      )}
    </div>
  );
}
