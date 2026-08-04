import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';

export const AnnouncementWidgetMetadata: WidgetMetadata = {
  name: 'Announcement',
  icon: 'Campaign',
  category: 'display',
  description: 'Displays timed alert or announcement pushed by Canvas Core or automation',
  defaultSize: { w: 600, h: 160 },
  minSize: { w: 280, h: 80 },
  fields: [
    { name: 'pollInterval', type: 'number', label: 'Poll interval (s)', default: 3, min: 1, max: 30, category: 'behavior' },
    { name: 'showWhenEmpty', type: 'checkbox', label: 'Show placeholder when no alert', default: false, category: 'behavior' },
    { name: 'infoColor', type: 'color', label: 'Info colour', default: '#1a4a7a', category: 'style' },
    { name: 'warningColor', type: 'color', label: 'Warning colour', default: '#6b4500', category: 'style' },
    { name: 'dangerColor', type: 'color', label: 'Danger colour', default: '#6b1a1a', category: 'style' },
    { name: 'successColor', type: 'color', label: 'Success colour', default: '#1a5c2e', category: 'style' },
    { name: 'titleColor', type: 'color', label: 'Title colour', default: '#ffffff', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Message colour', default: '#e0e0e0', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 60, category: 'style' },
    { name: 'fontSize', type: 'number', label: 'Font size (px)', default: 16, min: 10, max: 40, category: 'style' },
  ],
};

interface AlertData {
  title: string;
  message: string;
  type: 'info' | 'warning' | 'danger' | 'success';
  icon?: string;
  duration?: number;
  camera_entity?: string;
  timestamp?: string;
  empty?: boolean;
}

const TYPE_ICONS: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  danger: '🚨',
  success: '✅',
};

export default function AnnouncementWidget({ config, isEditMode }: WidgetProps) {
  const c = config.config ?? {};
  const width = config.position?.width ?? 600;
  const height = config.position?.height ?? 160;

  const pollInterval = Math.max(1, Number(c.pollInterval ?? 3)) * 1000;
  const showWhenEmpty = Boolean(c.showWhenEmpty);

  const [alert, setAlert] = useState<AlertData | null>(null);
  const lastTimestamp = useRef<string | null>(null);

  const fetchAlert = async () => {
    if (isEditMode) return;
    try {
      const res = await fetch('/api/alert/current', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as AlertData;
      if (data.empty) {
        setAlert(null);
        lastTimestamp.current = null;
      } else if (data.timestamp !== lastTimestamp.current) {
        lastTimestamp.current = data.timestamp ?? null;
        setAlert(data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (isEditMode) return;
    void fetchAlert();
    const timer = window.setInterval(() => void fetchAlert(), pollInterval);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, pollInterval]);

  useEffect(() => {
    const handler = (e: Event) => setAlert((e as CustomEvent<AlertData>).detail);
    window.addEventListener('canvas:alert', handler);
    return () => window.removeEventListener('canvas:alert', handler);
  }, []);

  const displayAlert: AlertData | null = isEditMode
    ? { title: 'Announcement', message: 'Alerts pushed by Core will appear here.', type: 'info' }
    : alert;

  if (!displayAlert) {
    if (!showWhenEmpty && !isEditMode) return <div style={{ width, height }} />;
    return (
      <div style={{
        width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px dashed rgba(255,255,255,0.2)', borderRadius: `${Number(c.borderRadius ?? 12)}px`,
        color: 'rgba(255,255,255,0.3)', fontSize: 13, fontFamily: 'system-ui',
      }}>
        No active alert
      </div>
    );
  }

  const bgMap: Record<string, string> = {
    info: String(c.infoColor ?? '#1a4a7a'),
    warning: String(c.warningColor ?? '#6b4500'),
    danger: String(c.dangerColor ?? '#6b1a1a'),
    success: String(c.successColor ?? '#1a5c2e'),
  };

  const bg = bgMap[displayAlert.type] ?? bgMap.info;
  const icon = displayAlert.icon ?? TYPE_ICONS[displayAlert.type] ?? 'ℹ️';

  const style: CSSProperties = {
    width,
    height,
    background: bg,
    borderRadius: `${Number(c.borderRadius ?? 12)}px`,
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '0 24px',
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
    overflow: 'hidden',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  };

  return (
    <div style={style}>
      <span style={{ fontSize: Math.round(Number(c.fontSize ?? 16) * 2), flexShrink: 0, lineHeight: 1 }}>
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: String(c.titleColor ?? '#ffffff'),
          fontSize: Number(c.fontSize ?? 16) + 2,
          fontWeight: 700,
          marginBottom: 4,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {displayAlert.title}
        </div>
        <div style={{
          color: String(c.textColor ?? '#e0e0e0'),
          fontSize: Number(c.fontSize ?? 16),
          lineHeight: 1.4,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        } as CSSProperties}>
          {displayAlert.message}
        </div>
        {displayAlert.camera_entity && (
          <img
            src={`/api/ha/camera_proxy/${encodeURIComponent(displayAlert.camera_entity)}?t=${displayAlert.timestamp ?? Date.now()}`}
            alt="Camera"
            style={{
              marginTop: 8,
              width: '100%',
              maxHeight: height - 80,
              objectFit: 'cover',
              borderRadius: 8,
              display: 'block',
            }}
          />
        )}
      </div>
    </div>
  );
}
