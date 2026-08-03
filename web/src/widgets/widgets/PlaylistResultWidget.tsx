import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';

export const PlaylistResultWidgetMetadata: WidgetMetadata = {
  name: 'Playlist Result',
  icon: 'QueueMusic',
  category: 'media',
  description: 'A numbered result slot populated by the assigned playlist-selection page',
  defaultSize: { w: 560, h: 650 },
  minSize: { w: 220, h: 180 },
  fields: [
    { name: 'resultSlot', type: 'number', label: 'Result slot', default: 1, min: 1, max: 8, category: 'behavior', description: 'Unique voice/touch selection number on this page' },
    { name: 'layout', type: 'select', label: 'Layout', default: 'artwork-above', category: 'style', options: [
      { value: 'artwork-above', label: 'Artwork above' },
      { value: 'artwork-left', label: 'Artwork left' },
      { value: 'artwork-background', label: 'Artwork background' },
      { value: 'compact', label: 'Compact' },
    ] },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#151b27', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Title colour', default: '#ffffff', category: 'style' },
    { name: 'metadataColor', type: 'color', label: 'Metadata colour', default: '#b9c2d0', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Number colour', default: '#287bd1', category: 'style' },
    { name: 'borderColor', type: 'color', label: 'Border colour', default: '#39465d', category: 'style' },
    { name: 'borderWidth', type: 'number', label: 'Border width', default: 2, min: 0, max: 12, category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 22, min: 0, max: 80, category: 'style' },
    { name: 'titleFont', type: 'font', label: 'Title font', default: 'system-ui', category: 'style' },
    { name: 'titleWeight', type: 'select', label: 'Title weight', default: '600', category: 'style', options: [
      { value: '400', label: 'Regular' }, { value: '600', label: 'Semi-bold' }, { value: '800', label: 'Bold' },
    ] },
    { name: 'showChannel', type: 'checkbox', label: 'Show channel', default: true, category: 'behavior' },
    { name: 'showItemCount', type: 'checkbox', label: 'Show item count', default: true, category: 'behavior' },
  ],
};

type PlaylistData = { title: string; channel: string; item_count: number; artwork_url: string; display_number: number; selection_index?: number };
type PlaylistSelection = { selection_id?: string; choices?: PlaylistData[] };

const sample = (slot: number): PlaylistData => ({
  title: slot === 1 ? '80s Greatest Hits' : `Sample playlist ${slot}`,
  channel: 'YouTube Music', item_count: 42, display_number: slot,
  artwork_url: 'https://i.ytimg.com/vi/placeholder/hqdefault.jpg',
});

export default function PlaylistResultWidget({ config, isEditMode }: WidgetProps) {
  const c = config.config;
  const slot = Math.max(1, Math.min(8, Number(c.resultSlot ?? 1)));
  const [runtime, setRuntime] = useState<PlaylistSelection | undefined>(
    () => (window as Window & { __canvasMediaSelection?: PlaylistSelection }).__canvasMediaSelection,
  );
  useEffect(() => {
    const update = (event: Event) => setRuntime((event as CustomEvent<PlaylistSelection>).detail);
    window.addEventListener('canvas:playlist-selection', update);
    return () => window.removeEventListener('canvas:playlist-selection', update);
  }, []);
  const data = runtime?.choices?.find(choice => choice.display_number === slot) ?? sample(slot);
  const layout = String(c.layout ?? 'artwork-above');
  const style = {
    '--card-bg': c.backgroundColor ?? '#151b27', '--title': c.textColor ?? '#fff',
    '--meta': c.metadataColor ?? '#b9c2d0', '--accent': c.accentColor ?? '#287bd1',
    '--border': c.borderColor ?? '#39465d', '--border-width': `${Number(c.borderWidth ?? 2)}px`,
    '--radius': `${Number(c.borderRadius ?? 22)}px`, '--title-font': c.titleFont ?? 'system-ui',
    '--title-weight': String(c.titleWeight ?? '600'),
  } as CSSProperties;
  const selectPlaylist = async () => {
    if (isEditMode || !runtime?.selection_id || data.selection_index === undefined) return;
    const response = await fetch('/api/media/youtube/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection_id: runtime.selection_id, index: data.selection_index }),
    });
    if (!response.ok) {
      console.error('[playlist] Selection failed:', await response.text());
      return;
    }
    const result = await response.json() as { url?: string };
    if (result.url) window.location.assign(result.url);
  };
  return <button className={`playlist-result ${layout}`} style={style} type="button" onClick={() => void selectPlaylist()} data-result-slot={slot} aria-label={`Select playlist ${slot}`}>
    <span className="playlist-art">{data.artwork_url && !data.artwork_url.includes('placeholder') ? <img src={data.artwork_url} alt="" /> : <span>♪</span>}</span>
    <span className="playlist-number">{data.display_number}</span>
    <span className="playlist-copy"><strong>{data.title}</strong>
      <small>{c.showChannel !== false ? data.channel : ''}{c.showChannel !== false && c.showItemCount !== false ? ' · ' : ''}{c.showItemCount !== false ? `${data.item_count} items` : ''}</small>
      {isEditMode && <em>Result slot {slot}</em>}
    </span>
    <style>{`
      .playlist-result{container-type:size;width:100%;height:100%;border:var(--border-width) solid var(--border);border-radius:var(--radius);background:var(--card-bg);color:var(--title);padding:clamp(10px,3cqw,24px);display:flex;gap:clamp(10px,3cqw,20px);overflow:hidden;text-align:left;cursor:pointer;box-sizing:border-box;position:relative}
      .playlist-art{display:grid;place-items:center;overflow:hidden;background:#090b10;color:var(--meta);font-size:clamp(36px,12cqw,80px);border-radius:calc(var(--radius) * .6)}.playlist-art img{width:100%;height:100%;object-fit:cover}
      .playlist-number{display:grid;place-items:center;flex:0 0 auto;width:clamp(38px,10cqw,58px);height:clamp(38px,10cqw,58px);border-radius:50%;background:var(--accent);font-weight:800;font-size:clamp(18px,5cqw,30px)}
      .playlist-copy{display:flex;min-width:0;flex-direction:column;gap:clamp(4px,1.5cqh,12px)}.playlist-copy strong{font:var(--title-weight) clamp(16px,5cqw,30px)/1.2 var(--title-font);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.playlist-copy small{color:var(--meta);font-size:clamp(12px,3cqw,18px)}.playlist-copy em{color:var(--accent);font-size:12px;margin-top:auto}
      .artwork-above{flex-direction:column}.artwork-above .playlist-art{width:100%;aspect-ratio:16/9;flex:0 0 auto}
      .artwork-left{align-items:center}.artwork-left .playlist-art{width:45%;height:100%;flex:0 0 auto}.artwork-left .playlist-copy{flex:1}
      .artwork-background .playlist-art{position:absolute;inset:0;border-radius:0}.artwork-background:after{content:'';position:absolute;inset:25% 0 0;background:linear-gradient(transparent,rgba(0,0,0,.92))}.artwork-background .playlist-number,.artwork-background .playlist-copy{position:relative;z-index:1;align-self:flex-end}.artwork-background{align-items:flex-end}
      .compact{align-items:center}.compact .playlist-art{width:28%;aspect-ratio:1/1;flex:0 0 auto}.compact .playlist-number{position:absolute;left:6%;bottom:8%}.compact .playlist-copy{flex:1}
      @container (max-width:360px){.artwork-left{flex-direction:column;align-items:stretch}.artwork-left .playlist-art{width:100%;height:auto;aspect-ratio:16/9}.playlist-copy strong{-webkit-line-clamp:2}}
      @container (max-height:260px){.artwork-above{flex-direction:row;align-items:center}.artwork-above .playlist-art{width:38%;height:100%;aspect-ratio:auto}.playlist-copy strong{-webkit-line-clamp:2}.playlist-copy small{display:none}}
    `}</style>
  </button>;
}
