const base = process.env.CANVAS_DEMO_BASE || 'http://127.0.0.1:3100';
const token = process.env.CANVAS_CORE_AUTOMATION_TOKEN;
if (!token) throw new Error('CANVAS_CORE_AUTOMATION_TOKEN is required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const post = async (path, body) => { const r = await fetch(base + path, { method:'POST', headers, body:JSON.stringify(body) }); const d = await r.json(); if(!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(d)}`); return d; };
const existing = await fetch(base + '/api/pages').then(r => r.json());
const found = existing.find(page => page.name === 'Media Routing & Search Demo');
if (found) { console.log(JSON.stringify({ pageId:found.id, existing:true })); process.exit(0); }
const widget=(id,type,x,y,w,h,config={})=>({id,type,x,y,w,h,zIndex:1,hidden:false,locked:false,config:{width:w,height:h,backgroundColor:'#12161f',textColor:'#e6edf3',accentColor:'#8b5cf6',borderRadius:12,...config}});
const widgets=[
 widget('route_list','playbackdevicelist',20,20,360,320,{mediaType:'youtube',title:'YouTube output'}),
 widget('route_now','playbackdeviceindicator',400,20,360,100,{mediaType:'youtube'}),
 widget('route_button','playbackdevicebutton',400,140,360,80,{mediaType:'youtube',label:'Play on this display'}),
 widget('yt_search','youtubesearch',780,20,520,430,{resultLimit:25,rowHeight:64,iconSize:48,fontSize:14}),
 widget('yt_presets','youtubepresets',1320,20,580,210,{presets:'Home Assistant|https://www.youtube.com/@home_assistant\nABC News|ABC News Australia live',columns:2}),
 widget('yt_play','youtubeplaybutton',1320,250,580,80,{value:'ABC News Australia live',label:'Play ABC News'}),
 widget('yt_now','youtubenowplaying',1320,350,580,100,{}),
 widget('yt_controls','youtubecontrols',20,370,360,90,{}),
 widget('yt_volume','youtubevolume',400,370,360,90,{}),
 widget('ma_browse','mabrowse',20,490,450,550,{title:'Music Assistant Library',rowHeight:58,iconSize:42}),
 widget('ma_search','masearch',490,490,450,550,{resultLimit:30,rowHeight:58,iconSize:42,fontSize:13}),
 widget('ma_queue','maqueue',960,490,450,550,{title:'Current Queue',rowHeight:58,iconSize:42}),
 widget('ytm_search','youtubemusicsearch',1430,490,470,330,{resultLimit:25,rowHeight:56,iconSize:40}),
 widget('ytm_controls','youtubemusiccontrols',1430,840,300,90,{}),
 widget('ytm_volume','youtubemusicvolume',1430,950,470,70,{}),
];
const created=await post('/api/admin/scenes',{name:'Media Routing & Search Demo',manifest:{width:1920,height:1080,widgets}});
const sceneId=created.scene.id;
await post(`/api/admin/scenes/${sceneId}/publish`,{});
const page=await post('/api/pages',{name:'Media Routing & Search Demo',panels:[{name:'Main',x:0,y:0,w:100,h:100,content_type:'scene',scene_id:sceneId,visible:true,opacity:1,z_index:0}]});
console.log(JSON.stringify({pageId:page.id,sceneId,widgets:widgets.length}));
