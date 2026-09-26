import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { buildHtmlSrcDoc } from '../../../editor/canvas-ui-react/src/shared/widgets/htmlSrcDoc.ts';

// Focused raw-text boundary scanner, not a general HTML parser/browser emulator.
function scripts(doc: string): string[] {
  const result: string[] = [];
  const opening = /<script>/gi;
  let start: RegExpExecArray | null;
  while ((start = opening.exec(doc))) {
    const closing = /<\/script[\t\n\f\r /]*>/gi;
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(doc);
    assert.ok(end, 'each generated script must have a real HTML end tag');
    result.push(doc.slice(opening.lastIndex, end.index));
    opening.lastIndex = closing.lastIndex;
  }
  return result;
}

function runtime() {
  const messages: any[] = [];
  const listeners = new Set<(event: any) => void>();
  const context = createContext({
    parent: { postMessage: (message: any, target: string) => {
      assert.equal(target, '*');
      messages.push(message);
    } },
    addEventListener: (type: string, callback: (event: any) => void) => {
      assert.equal(type, 'message');
      listeners.add(callback);
    },
    removeEventListener: (_type: string, callback: (event: any) => void) => listeners.delete(callback),
  });
  context.window = context;
  return { context, messages, listeners, send: (data: any) => {
    for (const callback of [...listeners]) callback({ data });
  } };
}

test('actual document has separate, executable bridge and custom scripts', async () => {
  const doc = buildHtmlSrcDoc('<div id="root">Trusted HTML</div>', '#root { color: red; }',
    'window.bridgePresent = !!CanvasHermes; window.updates = []; window.stop = CanvasHermes.subscribe(s => updates.push(s));', 'transparent');
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.ok(doc.includes('<style>#root { color: red; }</style>'));
  assert.ok(doc.includes('background-image: none !important;'));
  assert.ok(doc.endsWith('</script></body></html>'));
  assert.ok(!doc.includes('<\\/script>'));
  const source = scripts(doc);
  assert.equal(source.length, 2);
  const { context, messages, listeners, send } = runtime();
  source.forEach(script => runInContext(script, context, { timeout: 1000 }));
  assert.equal(context.bridgePresent, true);
  assert.deepEqual(messages.map(m => m.type), ['ready', 'requestEntities']);
  assert.equal(context.updates.length, 1);
  const entities = { 'light.desk': { state: 'on', attributes: { brightness: 100 }, last_changed: 'a', last_updated: 'b' } };
  send({ __canvasHermes: true, type: 'entities', entities });
  assert.equal(context.updates.length, 2);
  assert.equal(context.CanvasHermes.getAllStates(), entities);
  assert.equal(context.CanvasHermes.getState('light.desk').state, 'on');
  assert.equal(context.CanvasHermes.getState('missing'), undefined);
  context.stop();
  send({ __canvasHermes: true, type: 'entities', entities: {} });
  assert.equal(context.updates.length, 2);
  for (const error of [undefined, 'Service failed']) {
    const promise = context.CanvasHermes.callService('light', 'turn_on', { entity_id: 'light.desk' });
    const request = messages.at(-1);
    assert.equal(request.type, 'callService');
    assert.equal(request.domain, 'light');
    assert.equal(request.service, 'turn_on');
    assert.equal(request.data.entity_id, 'light.desk');
    assert.equal(listeners.size, 2);
    send({ __canvasHermes: true, type: 'callResult', id: request.id, result: 'ok', error });
    if (error) await assert.rejects(promise, /Service failed/);
    else assert.equal(await promise, 'ok');
    assert.equal(listeners.size, 1);
  }
});

for (const closing of ['</script>', '</ScRiPt>', '</SCRIPT >', '</script\t>', '</script\n>', '</script\r>', '</script\f>', '</script/>', '</script data-x>', '</scripture>', '< /script>', '<\\/script>']) {
  test(`embedded JS string survives: ${JSON.stringify(closing)}`, () => {
    // A template literal keeps actual whitespace in the JS source, too.
    const js = 'window.value = `' + closing.replaceAll('\\', '\\\\') + '`; window.finished = true;';
    const doc = buildHtmlSrcDoc('<p>content</p>', '', js, '#fff');
    const source = scripts(doc);
    assert.equal(source.length, 2);
    assert.ok(!source[1].includes('</body>'));
    const { context } = runtime();
    source.forEach(script => runInContext(script, context, { timeout: 1000 }));
    // JavaScript normalizes literal CR to LF in template literals.
    assert.equal(context.value, closing.replaceAll('\r', '\n'));
    assert.equal(context.finished, true);
  });
}

test('trusted HTML is unchanged, including its own executable script', () => {
  const html = '<div onclick="doSomething()">Trusted</div><script>window.fromHtml = 42;</script>';
  const doc = buildHtmlSrcDoc(html, '', '', '#fff');
  assert.ok(doc.includes(html));
  assert.ok(!doc.includes('background-image: none !important;'));
  const source = scripts(doc);
  assert.equal(source.length, 3);
  const { context } = runtime();
  source.forEach(script => runInContext(script, context, { timeout: 1000 }));
  assert.equal(context.fromHtml, 42);
  assert.ok(context.CanvasHermes);
});
