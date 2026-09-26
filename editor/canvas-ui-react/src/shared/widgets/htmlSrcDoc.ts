export function isTransparentCssColor(value: unknown): boolean {
  const color = String(value ?? '').replace(/\s+/g, '').toLowerCase();
  return !color || color === 'transparent' || color === 'rgba(0,0,0,0)' || color === '#0000' || color === '#00000000';
}

// HTML is trusted content; this builder is not a sanitizer or security boundary.
export function buildHtmlSrcDoc(effectiveHtml: string, cssContent: unknown, jsContent: unknown, backgroundColor: unknown): string {
  const safeCss = String(cssContent).replace(/<\/style>/gi, '<\\/style>');
  const safeJs = String(jsContent).replace(/<\/script(?=[\t\n\f\r />])/gi, match => '<\\/' + match.slice(2));
  const forceTransparent = isTransparentCssColor(backgroundColor)
    ? '<style>html, body, #root { background: transparent !important; background-color: transparent !important; background-image: none !important; }</style>'
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<style>html, body { margin: 0; padding: 0; width: 100%; height: 100%; box-sizing: border-box; background: transparent; } *, *::before, *::after { box-sizing: border-box; }</style>
<style>${safeCss}</style>${forceTransparent}</head><body>${effectiveHtml}
<script>(function(){var E={};var S=new Set();function n(){S.forEach(function(cb){try{cb(E)}catch(e){}})}window.CanvasHermes={getState:function(id){var e=E[id];return e?{state:e.state,attributes:e.attributes,last_changed:e.last_changed,last_updated:e.last_updated}:undefined},getAllStates:function(){return E},subscribe:function(cb){if(typeof cb==='function'){S.add(cb);cb(E);parent.postMessage({__canvasHermes:true,type:'requestEntities'},'*')}return function(){S.delete(cb)}},callService:function(domain,service,data){return new Promise(function(resolve,reject){var id='call_'+Math.random().toString(36).slice(2);function h(ev){if(ev.data&&ev.data.__canvasHermes&&ev.data.type==='callResult'&&ev.data.id===id){removeEventListener('message',h);ev.data.error?reject(new Error(ev.data.error)):resolve(ev.data.result)}}addEventListener('message',h);parent.postMessage({__canvasHermes:true,type:'callService',id:id,domain:domain,service:service,data:data||{}},'*')})}};addEventListener('message',function(ev){if(ev.data&&ev.data.__canvasHermes&&ev.data.type==='entities'){E=ev.data.entities||{};n()}});parent.postMessage({__canvasHermes:true,type:'ready'},'*')})();</script>
<script>${safeJs}</script></body></html>`;
}
