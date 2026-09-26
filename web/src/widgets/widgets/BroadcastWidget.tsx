/**
 * Broadcast Widget — record a voice broadcast and play it on every display and
 * media player (Echo-style announce). Records via MediaRecorder and uploads to
 * the Display server's /api/broadcast, which forwards to Core.
 */

import React, { useRef, useState } from 'react';
import { useVisibility } from '../../hooks/useVisibility';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';

export const BroadcastWidgetMetadata: WidgetMetadata = {
  name: 'Broadcast',
  icon: 'Campaign',
  category: 'media',
  description: 'Record a voice broadcast and play it on every display and media player',
  defaultSize: { w: 320, h: 200 },
  minSize: { w: 200, h: 120 },
  requiresEntity: false,
  fields: [
    { name: 'maxSeconds', type: 'number', label: 'Max recording (s)', default: 30, min: 5, max: 120, category: 'behavior' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#1a2332', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#e8f0fe', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent colour', default: '#f0883e', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

const BroadcastWidget: React.FC<WidgetProps> = ({ config }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 320;
  const height = config.position?.height ?? cfg.height ?? 200;
  const backgroundColor = cfg.backgroundColor ?? '#1a2332';
  const textColor = cfg.textColor ?? '#e8f0fe';
  const accentColor = cfg.accentColor ?? '#f0883e';
  const borderRadius = cfg.borderRadius ?? 12;
  const maxSeconds = Math.max(5, Number(cfg.maxSeconds ?? 30));

  const isVisible = useVisibility(cfg.visibilityCondition);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const stop = () => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    recorderRef.current?.stop();
  };

  const start = async () => {
    setStatus('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) { setStatus('Nothing recorded'); return; }
        setStatus('Sending…');
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const res = await fetch('/api/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: btoa(binary), mimeType: blob.type, title: 'Broadcast' }),
          });
          const data = (await res.json().catch(() => ({}))) as { edges?: number; ha?: number; error?: string };
          setStatus(res.ok
            ? `Sent to ${data.edges ?? 0} displays, ${data.ha ?? 0} players`
            : (data.error ?? `HTTP ${res.status}`));
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setStatus('Recording…');
      timerRef.current = window.setTimeout(stop, maxSeconds * 1000);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const universalStyle = useResolvedUniversalStyle(config.config.style);
  if (!isVisible) return null;

  const containerStyle = applyUniversalStyles(universalStyle, {
    width, height, backgroundColor, borderRadius,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 10, boxSizing: 'border-box', padding: 12,
  });

  return (
    <div style={containerStyle}>
      <span style={{ fontSize: 28, color: accentColor }}>📢</span>
      <button
        onClick={() => (recording ? stop() : void start())}
        style={{
          background: recording ? '#f85149' : accentColor, border: 'none', color: '#fff',
          cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: '10px 20px', borderRadius: 8,
        }}
      >
        {recording ? 'Stop & broadcast' : 'Record broadcast'}
      </button>
      {status && <div style={{ color: textColor, fontSize: 11, opacity: 0.75, textAlign: 'center' }}>{status}</div>}
    </div>
  );
};

export default BroadcastWidget;
