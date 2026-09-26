import{a as e,r as t}from"./rolldown-runtime-BYbx6iT9.js";import{t as n}from"./react-KD2OSrki.js";import{t as r}from"./jsx-runtime-CuHXjfa2.js";import{i}from"./BindingEvaluator-BdfDdHfb.js";import{r as a,t as o}from"./useResolvedUniversalStyle-83GHbP8B.js";var s=t({default:()=>f,htmlWidgetMetadata:()=>p}),c=e(n(),1),l=r(),u=`__canvasHermes`;function d(e){let t=String(e??``).replace(/\s+/g,``).toLowerCase();return!t||t===`transparent`||t===`rgba(0,0,0,0)`||t===`#0000`||t===`#00000000`}var f=({config:e,isEditMode:t})=>{let{html:n=`<div>Enter HTML here</div>`,htmlEntity:r=``,useEntityHtml:s=!1,htmlAttribute:f=``,css:p=``,js:m=``,backgroundColor:h=`transparent`,padding:g=8,overflow:_=`auto`,entities:v=[]}=e.config,{entities:y,callService:b}=i(),x=(0,c.useRef)(null),S=(0,c.useRef)(y),C=(0,c.useRef)(b);(0,c.useEffect)(()=>{S.current=y},[y]),(0,c.useEffect)(()=>{C.current=b},[b]);let w=(0,c.useMemo)(()=>{if(s&&r){let e=y?.[r];if(e)return f&&e.attributes?.[f]!=null?String(e.attributes[f]):String(e.state||``)}return String(n)},[s,r,f,n,y]),T=(0,c.useMemo)(()=>{let e=String(m).replace(/<\/script>/gi,`<\\/script>`);return`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; box-sizing: border-box; background: transparent; }
  *, *::before, *::after { box-sizing: border-box; }
  body { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
</style>
<style>${String(p).replace(/<\/style>/gi,`<\\/style>`)}</style>
${d(h)?`<style>html, body, #root, body > :first-child { background: transparent !important; background-color: transparent !important; background-image: none !important; }</style>`:``}
</head>
<body>
${w}
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
    configuredEntities: ${JSON.stringify(Array.isArray(v)?v:[])},
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
<\/script>
<script>
${e}
<\/script>
</body>
</html>`},[w,p,m,h,v]);(0,c.useEffect)(()=>{function e(e){let t=x.current;if(!t||e.source!==t.contentWindow)return;let n=e.data;if(!(!n||n[u]!==!0))if(n.type===`ready`||n.type===`requestEntities`)t.contentWindow?.postMessage({[u]:!0,type:`entities`,entities:S.current},`*`);else if(n.type===`callService`){let e=(e,r)=>{t.contentWindow?.postMessage({[u]:!0,type:`callResult`,id:n.id,result:e,error:r},`*`)};if(!C.current){e(null,`Entity service not available`);return}Promise.resolve(C.current(n.domain,n.service,n.data)).then(t=>e(t)).catch(t=>e(null,t?.message||`Service call failed`))}else n.type===`error`&&console.warn(`[canvas:html-widget] sandbox error:`,n.message)}return window.addEventListener(`message`,e),()=>window.removeEventListener(`message`,e)},[]),(0,c.useEffect)(()=>{let e=x.current;e&&e.contentWindow&&e.contentWindow.postMessage({[u]:!0,type:`entities`,entities:y},`*`)},[y]);let E=o(e.config.style||e.config),D=d(h);return(0,l.jsx)(`iframe`,{ref:x,title:`HTML Widget`,srcDoc:T,style:{...a(E,{width:`100%`,height:`100%`,backgroundColor:h,padding:`${g}px`,overflow:_,boxSizing:`border-box`}),width:`100%`,height:`100%`,border:`none`,display:`block`,background:D?`transparent`:h,backgroundColor:D?`transparent`:h,boxSizing:`border-box`,pointerEvents:t?`none`:`auto`}})},p={name:`HTML`,description:`Display custom HTML/CSS/JS with Home Assistant entity connection (AI can build inside it)`,icon:`CodeOutlined`,category:`display`,defaultSize:{w:400,h:300},fields:[{name:`width`,type:`number`,label:`Width`,default:400,min:100,category:`layout`},{name:`height`,type:`number`,label:`Height`,default:300,min:100,category:`layout`},{name:`useEntityHtml`,type:`checkbox`,label:`HTML From Entity`,default:!1,category:`behavior`,description:`Data-source mode: render an entity's state/attribute AS the whole widget HTML. Keep OFF for AI-built widgets that read entities in JS.`},{name:`htmlEntity`,type:`entity`,label:`HTML Source Entity`,default:``,category:`behavior`,description:`Only used when "HTML From Entity" is enabled — the entity whose state/attribute becomes the HTML`},{name:`htmlAttribute`,type:`text`,label:`HTML Source Attribute`,default:``,category:`behavior`,description:`Only with "HTML From Entity": attribute containing the HTML (bypasses the 255-char state limit). Leave blank to use state.`},{name:`entities`,type:`entity-list`,label:`JS Entity Bindings`,default:[],category:`behavior`,description:`Entities your widget JS reads via CanvasHermes and the AI Builder uses as context. Entities referenced by AI-generated code are bound here automatically.`},{name:`html`,type:`code-editor`,label:`HTML`,default:`<div id="root">Custom content</div>`,category:`behavior`,description:`Custom HTML markup (AI can generate this)`},{name:`css`,type:`code-editor`,label:`CSS`,default:`#root { font-family: sans-serif; color: #fff; }`,category:`behavior`,description:`CSS applied to the HTML (AI can generate this)`},{name:`js`,type:`code-editor`,label:`JavaScript`,default:`const unsub = CanvasHermes.subscribe((states) => {
  const el = document.getElementById('root');
  if (el) el.textContent = 'Entities: ' + Object.keys(states).length;
});`,category:`behavior`,description:`JavaScript executed in the widget. Use the global CanvasHermes API to connect entities.`},{name:`overflow`,type:`select`,label:`Overflow`,default:`auto`,category:`behavior`,options:[{value:`auto`,label:`Auto`},{value:`hidden`,label:`Hidden`},{value:`scroll`,label:`Scroll`},{value:`visible`,label:`Visible`}]},{name:`backgroundColor`,type:`color`,label:`Background Color`,default:`transparent`,category:`style`},{name:`padding`,type:`number`,label:`Padding`,default:8,min:0,max:50,category:`style`}]};export{p as n,s as t};