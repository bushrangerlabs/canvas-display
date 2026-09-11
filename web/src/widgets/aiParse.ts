/**
 * Parsing + normalisation for AI-generated HTML widget content.
 *
 * Kept free of React so it can be unit-tested in isolation. The models we use
 * are frequently non-compliant: they truncate mid-answer (odd number of code
 * fences), collapse everything into a single ```html block with inline
 * <style>/<script>, or return a full <!DOCTYPE html><html>…</html> document as
 * the "html" block. These helpers turn that mess into the canonical
 * { html, css, js } shape the HtmlWidget expects.
 */

export interface ParsedWidget {
  html?: string;
  css?: string;
  js?: string;
}

/** Pull inline <style>/<script> out of a markup blob and unwrap a full
 * document, so a self-contained html block becomes proper html/css/js. */
export function extractEmbeddedAssets(html: string): ParsedWidget {
  if (typeof html !== 'string') return { html: '' };
  let css = '';
  let js = '';
  let body = html;

  body = body.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, s: string) => {
    css += (css ? '\n' : '') + s;
    return '';
  });
  body = body.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_m, s: string) => {
    js += (js ? '\n' : '') + s;
    return '';
  });

  // Drop the <head> (its styles were already hoisted above).
  body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  // Unwrap a full document if the model returned one.
  body = body.replace(/^\s*<!doctype\s+html[^>]*>/i, '');
  body = body.replace(/<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');
  body = body.replace(/<body[^>]*>/i, '').replace(/<\/body>\s*$/i, '');

  return { html: body.trim(), css: css.trim() || undefined, js: js.trim() || undefined };
}

/** An odd number of fences means the model was cut off before closing its
 * last block. We treat it as truncated so callers can recover/report. */
export function looksTruncated(reply: string): boolean {
  return ((reply || '').match(/```/g) || []).length % 2 !== 0;
}

function parseWidgetJson(text: string): ParsedWidget | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    if (obj && (typeof obj.html === 'string' || typeof obj.css === 'string' || typeof obj.js === 'string')) {
      return obj as ParsedWidget;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract html/css/js from an AI reply.
 *
 * - Prefers fenced blocks (```html / ```css / ```js) — robust against code
 *   that is invalid as JSON string literals.
 * - Auto-recovers a truncated reply (odd fence count) by closing the last
 *   block, instead of failing outright.
 * - Normalises a single self-contained html block (inline <style>/<script> or
 *   a full document) into the canonical three-part shape.
 * - Falls back to a JSON object if no code blocks are present.
 */
export function parseAiContent(text: string): ParsedWidget | null {
  if (!text) return null;
  const fenceCount = (text.match(/```/g) || []).length;
  // Recover a reply that was cut off before its final closing fence.
  const source = fenceCount % 2 !== 0 ? text + '\n```' : text;

  const blocks: Record<string, string> = {};
  const fenceRe = /```(html|css|javascript|json|js)?\s*\n?([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(source)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const body = m[2].trim();
    if (lang === 'html' || lang === '') blocks.html = body;
    else if (lang === 'css') blocks.css = body;
    else if (lang === 'js' || lang === 'javascript') blocks.js = body;
    else if (lang === 'json') {
      try {
        const o = JSON.parse(body);
        if (o && typeof o === 'object') {
          if (typeof o.html === 'string') blocks.html = o.html;
          if (typeof o.css === 'string') blocks.css = o.css;
          if (typeof o.js === 'string') blocks.js = o.js;
        }
      } catch { /* ignore malformed json block */ }
    }
  }

  if (blocks.html || blocks.css || blocks.js) {
    if (blocks.html) {
      const isFullDoc = /^\s*<!doctype\s+html/i.test(blocks.html) || /^<html[\s>]/i.test(blocks.html);
      const hasInline = /<script[\s>]/i.test(blocks.html) || /<style[\s>]/i.test(blocks.html);
      // Only normalise when the missing parts are actually embedded inline.
      if (isFullDoc || (hasInline && (!blocks.css || !blocks.js))) {
        const ex = extractEmbeddedAssets(blocks.html);
        if (ex.html !== undefined) blocks.html = ex.html;
        if (!blocks.css && ex.css) blocks.css = ex.css;
        if (!blocks.js && ex.js) blocks.js = ex.js;
      }
    }
    return { html: blocks.html, css: blocks.css, js: blocks.js };
  }

  const json = parseWidgetJson(source);
  if (json) return json;

  // Last resort: some models (especially small ones) return a bare HTML
  // document with no code fences at all. Treat markup as the html block and
  // pull out any inline style/script so the widget still renders.
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const ex = extractEmbeddedAssets(trimmed);
    if (ex.html) return { html: ex.html, css: ex.css, js: ex.js };
  }
  return null;
}
