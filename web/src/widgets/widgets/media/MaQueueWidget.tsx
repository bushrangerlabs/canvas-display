import React, { useCallback, useEffect, useState } from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { targetDeviceId } from './mediaSource';

type QueueItem = { queueItemId: string; uri: string; name: string; artist: string; artwork?: string };
const token = (import.meta.env as { VITE_CORE_AUTOMATION_TOKEN?: string }).VITE_CORE_AUTOMATION_TOKEN;

const MaQueueWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const [items, setItems] = useState<QueueItem[]>([]);
  const [error, setError] = useState('');
  const isVisible = useVisibility(cfg.visibilityCondition);
  const style = useResolvedUniversalStyle(config.config.style);
  const mediaType = cfg.mediaType === 'youtube_music' ? 'youtube_music' : 'music_assistant';
  const controllerDeviceId = targetDeviceId();
  const params = new URLSearchParams({ mediaType });
  if (controllerDeviceId) params.set('controllerDeviceId', controllerDeviceId);
  if (cfg.playerId) params.set('playerId', String(cfg.playerId));
  const load = useCallback(async () => {
    try { const r = await fetch(`/api/ma/queue?${params}`, { cache: 'no-store' }); const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); setItems(d.items || []); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [params.toString()]);
  useEffect(() => { void load(); const id = window.setInterval(load, Math.max(3, Number(cfg.pollInterval ?? 8)) * 1000); return () => clearInterval(id); }, [load, cfg.pollInterval]);
  if (!isVisible) return null;
  const mutate = async (action: 'clear'|'remove', queueItemId?: string) => { if (isEditMode) return; await fetch('/api/ma/queue', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})}, body:JSON.stringify({ action, queueItemId, mediaType, playerId:cfg.playerId || '', ...(controllerDeviceId ? {controllerDeviceId} : {}) }) }); await load(); };
  const rowHeight = Math.max(28, Number(cfg.rowHeight ?? 52)); const iconSize = Math.max(16, Number(cfg.iconSize ?? 36)); const fontSize = Math.max(8, Number(cfg.fontSize ?? 12));
  return <div style={applyUniversalStyles(style,{width:config.position?.width??cfg.width??330,height:config.position?.height??cfg.height??320,backgroundColor:cfg.backgroundColor??'#12161f',color:cfg.textColor??'#e6edf3',borderRadius:cfg.borderRadius??12,padding:12,boxSizing:'border-box',display:'flex',flexDirection:'column',gap:8,overflow:'hidden'})}>
    <div style={{display:'flex',alignItems:'center'}}><strong style={{flex:1}}>{cfg.title || 'Queue'}</strong><button disabled={isEditMode||!items.length} onClick={()=>void mutate('clear')} style={{color:'#fff',background:cfg.accentColor??'#ab47bc',border:0,borderRadius:6,padding:'5px 9px'}}>Clear</button></div>
    <div style={{overflowY:'auto',display:'flex',flexDirection:'column',gap:4}}>{items.slice(0,Math.max(1,Number(cfg.maxItems??100))).map(item=><div key={item.queueItemId||item.uri} style={{minHeight:rowHeight,display:'flex',alignItems:'center',gap:8,background:'rgba(255,255,255,.06)',borderRadius:6,padding:'4px 8px',fontSize}}>{item.artwork?<img src={item.artwork} alt="" style={{width:iconSize,height:iconSize,objectFit:'cover',borderRadius:4}}/>:<span>♪</span>}<span style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.name}<small style={{display:'block',opacity:.55}}>{item.artist}</small></span><button disabled={isEditMode} onClick={()=>void mutate('remove',item.queueItemId)} style={{background:'transparent',border:0,color:'inherit'}}>×</button></div>)}</div>
    {error&&<small style={{color:'#f85149'}}>{error}</small>}
  </div>;
};
export default MaQueueWidget;
