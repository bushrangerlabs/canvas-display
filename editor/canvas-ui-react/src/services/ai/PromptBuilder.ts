/**
 * Prompt Builder - Simplified Single-Pass Version
 * 
 * Builds a simple prompt for single-pass dashboard generation.
 */

import type { ExportedView } from '../../shared/utils/viewExportImport';
import { lovelaceCardDiscovery } from './LovelaceCardDiscovery';
import { promptTemplateStore } from './PromptTemplateStore';

export interface SelectedEntity {
  entity_id: string;
  friendly_name: string;
  domain: string;
  state?: string;
}

/**
 * Stage1Output (legacy - for UI compatibility)
 */
export interface Stage1Output {
  userIntent: string;
  requestType?: string;
}

/**
 * Parse user request and extract clear requirements
 */
function buildTaskBreakdown(userRequest: string): string {
  const lower = userRequest.toLowerCase();
  const breakdown: string[] = ['=== TASK BREAKDOWN ===', ''];
  
  // Extract number of widgets
  const numberMatch = userRequest.match(/(\d+)\s+(\w+)/);
  if (numberMatch) {
    const count = parseInt(numberMatch[1]);
    const widgetType = numberMatch[2];
    breakdown.push(`CREATE: ${count} ${widgetType} widgets`);
    breakdown.push('');
    
    // Show example config based on widget type
    if (widgetType.includes('button')) {
      breakdown.push('BUTTON CONFIG EXAMPLE:');
      breakdown.push('{');
      breakdown.push('  "id": "button-1",');
      breakdown.push('  "type": "button",');
      breakdown.push('  "position": {"x": 10, "y": 10, "width": 150, "height": 80, "zIndex": 1},');
      breakdown.push('  "config": {');
      breakdown.push('    "label": "LABEL_FROM_REQUEST",');
      breakdown.push('    "backgroundColor": "COLOR_FROM_REQUEST",');
      breakdown.push('    "showIcon": true,');
      breakdown.push('    "icon": "ICON_FROM_REQUEST",');
      breakdown.push('    "iconPosition": "top",');
      breakdown.push('    "iconColor": "ICON_COLOR_FROM_REQUEST"');
      breakdown.push('  }');
      breakdown.push('}');
      breakdown.push('');
    }
  }
  
  // Extract colors
  const colorMap: Record<string, string> = {
    'red': '#ff0000',
    'blue': '#0000ff',
    'green': '#00ff00',
    'yellow': '#ffff00',
    'white': '#ffffff',
    'black': '#000000'
  };
  
  for (const [colorName, hexCode] of Object.entries(colorMap)) {
    if (lower.includes(colorName)) {
      if (lower.includes(`${colorName} button`) || (colorName === 'red' && lower.includes('button'))) {
        breakdown.push(`BUTTON BACKGROUND: "backgroundColor": "${hexCode}"`);
      }
      if (lower.includes(`${colorName} icon`) || lower.includes(`${colorName} calendar`)) {
        breakdown.push(`ICON COLOR: "iconColor": "${hexCode}"`);
      }
      if (lower.includes(`${colorName} border`)) {
        breakdown.push(`BORDER COLOR: "borderColor": "${hexCode}"`);
      }
    }
  }
  
  // Extract specific patterns
  if (lower.includes('days of the week') || lower.includes('day of the week')) {
    breakdown.push('');
    breakdown.push('BUTTON LABELS (use these exact strings):');
    breakdown.push('Button 1: "Monday"');
    breakdown.push('Button 2: "Tuesday"');
    breakdown.push('Button 3: "Wednesday"');
    breakdown.push('Button 4: "Thursday"');
    breakdown.push('Button 5: "Friday"');
    breakdown.push('Button 6: "Saturday"');
    breakdown.push('Button 7: "Sunday"');
  }
  
  if (lower.includes('calendar icon')) {
    breakdown.push('');
    breakdown.push('ICON SETUP (required for icons to show):');
    breakdown.push('"icon": "mdi:calendar"');
    breakdown.push('"showIcon": true');
    breakdown.push('"iconPosition": "top"');
  }
  
  if (lower.includes('border')) {
    breakdown.push('');
    breakdown.push('BORDER WIDGET:');
    breakdown.push('{');
    breakdown.push('  "id": "border-1",');
    breakdown.push('  "type": "border",');
    breakdown.push('  "position": {"x": 0, "y": 0, "width": 500, "height": 300, "zIndex": 999},');
    breakdown.push('  "config": {"borderWidth": 3, "borderColor": "#ffffff", "borderRadius": 3}');
    breakdown.push('}');
  }
  
  breakdown.push('');
  return breakdown.join('\n');
}

/**
 * Build simple one-shot generation prompt
 */
export function buildGenerationPrompt(
  userRequest: string,
  selectedEntities: SelectedEntity[],
  viewId: string,
  viewName: string,
  skipWidgetCatalog: boolean = false,
  currentWidgets: any[] = [],  // Current widgets on canvas for edit mode
  viewWidth: number = 1920,
  viewHeight: number = 1080
): string {
  const entityList = selectedEntities.length > 0
    ? selectedEntities.map(e => `${e.entity_id} (${e.friendly_name})`).join(', ')
    : 'No entities selected';

  const timestamp = new Date().toISOString();
  const isEditMode = currentWidgets.length > 0;

  // Extract key requirements from user request (CREATE mode only — in EDIT mode
  // the current widgets JSON is the authoritative context; the regex-based task
  // breakdown can pollute the prompt by matching unrelated words, e.g.
  // "border" in "border radius" triggers a hardcoded BORDER WIDGET template)
  const taskBreakdown = isEditMode ? '' : buildTaskBreakdown(userRequest);

  // Choose system prompt based on mode
  const systemPrompt = isEditMode 
    ? promptTemplateStore.getTemplate('systemPromptEdit')
    : promptTemplateStore.getTemplate('systemPromptCreate');

  // For Open WebUI with file attachment, skip embedded catalog to avoid conflicting context
  const widgetSection = skipWidgetCatalog
    ? 'AVAILABLE WIDGETS:\nRefer to attached CANVAS_UI_WIDGETS.md file for complete widget documentation.'
    : `AVAILABLE WIDGETS:\n${promptTemplateStore.getTemplate('widgetCatalog')}`;

  // If edit mode, show current widgets in JSON format (same format AI outputs)
  const currentWidgetsSection = isEditMode
    ? `
CURRENT WIDGETS ON CANVAS:
\`\`\`json
{
  "version": "2.0.0",
  "exportedAt": "${timestamp}",
  "view": {
    "id": "${viewId}",
    "name": "${viewName}",
    "widgets": ${JSON.stringify(currentWidgets, null, 2)}
  }
}
\`\`\`

The user wants to make changes to this dashboard. Return the COMPLETE updated view with ALL widgets (including unchanged ones).
IMPORTANT: Copy each widget's "id" field exactly as shown above — do NOT generate new IDs.
`
    : '';

  // Generate Lovelace card section (auto-detects probable cards)
  const lovelaceSection = lovelaceCardDiscovery.generateLovelaceSection(userRequest, selectedEntities);

  const canvasBoundsSection = `CANVAS BOUNDS:
The view is ${viewWidth}px wide × ${viewHeight}px tall.
All widget positions must satisfy: x + width ≤ ${viewWidth} and y + height ≤ ${viewHeight}.
Start widgets at x ≥ 10, y ≥ 10. Do not place any widget outside these bounds.`;

  return `
${systemPrompt}

USER REQUEST:
${userRequest}

${taskBreakdown}

${canvasBoundsSection}

AVAILABLE ENTITIES:
${entityList}

${lovelaceSection}

${currentWidgetsSection}

${widgetSection}

${promptTemplateStore.getTemplate('outputFormat')
  .replace('{{timestamp}}', timestamp)
  .replace('{{viewId}}', viewId)
  .replace('{{viewName}}', viewName)}
`.trim();
}

/**
 * Single-pass JSON sanitiser for LLM output.
 *
 * Handles two classes of AI-generated defects in one character-by-character
 * walk that correctly tracks string context:
 *
 *  1. Comments outside strings — `// …` (line) and `/* … *\/` (block).
 *     Regex-based stripping would corrupt URLs like https://… because the
 *     `//` in the URL sits inside a string value.
 *
 *  2. Bare control characters (0x00–0x1F) inside string values.
 *     JSON.parse rejects them; they must be escaped as \n, \t, etc.
 */
function sanitizeJson(json: string): string {
  const CTRL_ESCAPE: Record<number, string> = {
    0x08: '\\b', 0x09: '\\t', 0x0a: '\\n',
    0x0c: '\\f', 0x0d: '\\r',
  };

  let result = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < json.length) {
    const char = json[i];
    const code = json.charCodeAt(i);

    // --- inside a string literal ---
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
        i++;
        continue;
      }
      if (char === '\\') {
        result += char;
        escaped = true;
        i++;
        continue;
      }
      if (char === '"') {
        inString = false;
        result += char;
        i++;
        continue;
      }
      // Escape bare control characters that JSON.parse rejects
      if (code < 0x20) {
        result += CTRL_ESCAPE[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
        i++;
        continue;
      }
      result += char;
      i++;
      continue;
    }

    // --- outside a string literal ---

    // Opening string
    if (char === '"') {
      inString = true;
      result += char;
      i++;
      continue;
    }

    // Line comment: // …  — skip to end of line
    if (char === '/' && json[i + 1] === '/') {
      while (i < json.length && json[i] !== '\n') i++;
      continue;
    }

    // Block comment: /* … */
    if (char === '/' && json[i + 1] === '*') {
      i += 2;
      while (i < json.length - 1 && !(json[i] === '*' && json[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Build prompt for the FREE-FORM HTML mode.
 *
 * In this mode the AI generates one or more "custom_dashboard" widgets whose
 * config carries raw html/css/js. The JS uses the global `CanvasHermes` bridge
 * (injected at runtime) to read Home Assistant entity states and call services.
 * Unlike widget mode, the big structured widget catalog is omitted - the AI
 * only needs the CanvasHermes API reference below.
 */
export function buildFreeformPrompt(
  userRequest: string,
  selectedEntities: SelectedEntity[],
  viewId: string,
  viewName: string,
  currentWidgets: any[] = [],
  viewWidth: number = 1920,
  viewHeight: number = 1080
): string {
  const entityList = selectedEntities.length > 0
    ? selectedEntities.map(e => `${e.entity_id} (${e.friendly_name})`).join(', ')
    : 'No entities selected';

  const timestamp = new Date().toISOString();
  const isEditMode = currentWidgets.length > 0;

  const canvasBoundsSection = `CANVAS BOUNDS:
The view is ${viewWidth}px wide × ${viewHeight}px tall.
All widget positions must satisfy: x + width ≤ ${viewWidth} and y + height ≤ ${viewHeight}.
Start widgets at x ≥ 10, y ≥ 10.`;

  const currentWidgetsSection = isEditMode
    ? `
CURRENT WIDGETS ON CANVAS (return the COMPLETE updated view, preserving unchanged widgets):
\`\`\`json
{
  "version": "2.0.0",
  "exportedAt": "${timestamp}",
  "view": {
    "id": "${viewId}",
    "name": "${viewName}",
    "widgets": ${JSON.stringify(currentWidgets, null, 2)}
  }
}
\`\`\`
Copy each existing widget's "id" exactly - do NOT generate new IDs for them.
`
    : '';

  const canvasHermesApi = `CANVAS_HERMES API (available to your JavaScript as the global \`CanvasHermes\`):

  // Read a single entity's state + attributes
  CanvasHermes.getState('light.living_room')   // => { state, attributes, last_changed, last_updated } | undefined

  // Read every entity at once
  CanvasHermes.getAllStates()                  // => { 'entity.id': {...}, ... }

  // Subscribe to live updates (called immediately + on every state change)
  const unsubscribe = CanvasHermes.subscribe((states) => {
    console.log('light.living_room =', states['light.living_room'].state);
  });

  // Call a Home Assistant service
  await CanvasHermes.callService('light', 'turn_on', { entity_id: 'light.living_room', brightness_pct: 60 });

RULES:
- You may use any HTML/CSS/JS you like inside the widget (charts, custom layouts, animations).
- Entity states update live; re-render your UI inside the subscribe callback.
- Do NOT reference the parent page or external globals - only \`CanvasHermes\` is provided.
- Keep \`<script>\` content as valid JS (do not include the literal string </script>).`;

  const outputFormat = `=== OUTPUT FORMAT ===

STRUCTURE (one or more custom_dashboard widgets - compose a full dashboard from several):
{
  "version": "2.0.0",
  "exportedAt": "${timestamp}",
  "view": {
    "id": "${viewId}",
    "name": "${viewName}",
    "widgets": [
      {
        "id": "cd-1",
        "type": "custom_dashboard",
        "name": "Weather Panel",
        "position": { "x": 10, "y": 10, "width": 600, "height": 400, "zIndex": 1 },
        "config": {
          "html": "<div id='app'>...</div>",
          "css": "#app { color: #fff; font-family: sans-serif; }",
          "js": "CanvasHermes.subscribe((s) => { document.getElementById('app').textContent = s['sensor.temp'].state; });"
        },
        "bindings": {}
      }
    ]
  }
}

CRITICAL RULES:
1. version, exportedAt and the view wrapper are required.
2. Every widget MUST have: id, type ("custom_dashboard"), name, position {x,y,width,height,zIndex}, config {html,css,js}, bindings {}.
3. Position values are PIXELS.
4. Put the visual markup in "html", styling in "css", behaviour/entity binding in "js".
5. Use CanvasHermes (above) to connect entities - do not hardcode values that exist as entities.
6. RESPOND WITH ONLY THE JSON - no explanations, no markdown text outside the JSON.`;

  return `
You are a Home Assistant dashboard expert building a FREE-FORM dashboard using raw HTML, CSS and JavaScript.

${isEditMode
  ? 'You are EDITING an existing dashboard - preserve all widgets unless the user asks to change them.'
  : 'You are creating a NEW dashboard from scratch.'}

USER REQUEST:
${userRequest}

${canvasBoundsSection}

AVAILABLE ENTITIES:
${entityList}

${currentWidgetsSection}

${canvasHermesApi}

${outputFormat}
`.trim();
}

/**
 * Extract ExportedView JSON from AI response
 * Handles markdown code blocks and plain JSON
 */
export function extractExportedView(aiResponse: string): ExportedView | null {
  try {
    // Try to extract JSON from markdown code block
    const jsonMatch = aiResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : aiResponse;

    // Find JSON object (starts with { and ends with })
    const startIdx = jsonStr.indexOf('{');
    const lastIdx = jsonStr.lastIndexOf('}');
    
    if (startIdx === -1 || lastIdx === -1) {
      return null;
    }

    let extracted = jsonStr.substring(startIdx, lastIdx + 1);
    
    // Single-pass sanitiser: strips // and /* */ comments outside strings,
    // and escapes bare control characters inside strings.
    // (Regex-based // stripping would corrupt URLs like https://…)
    extracted = sanitizeJson(extracted);
    // Remove trailing commas before closing braces/brackets (common AI mistake)
    extracted = extracted.replace(/,(\s*[}\]])/g, '$1');

    const parsed = JSON.parse(extracted);

    // Validate basic structure
    if (!parsed.view || !parsed.view.widgets || !Array.isArray(parsed.view.widgets)) {
      console.error('[extractExportedView] Invalid structure - missing view.widgets array');
      return null;
    }

    // Merge borders array into widgets array if it exists (AI sometimes creates separate arrays)
    if (parsed.view.borders && Array.isArray(parsed.view.borders)) {
      console.log('[extractExportedView] Merging', parsed.view.borders.length, 'border widgets into widgets array');
      parsed.view.widgets = [...parsed.view.widgets, ...parsed.view.borders];
      delete parsed.view.borders;
    }

    return parsed as ExportedView;
  } catch (error) {
    console.error('[extractExportedView] Failed to parse JSON:', error);
    return null;
  }
}
