const base = process.env.CANVAS_DEMO_BASE || 'http://127.0.0.1:3100';
const token = process.env.CANVAS_CORE_AUTOMATION_TOKEN;
const deviceId = process.env.CANVAS_DEMO_DEVICE_ID;
if (!token || !deviceId) throw new Error('Core automation token and CANVAS_DEMO_DEVICE_ID are required');
const pages = await fetch(base + '/api/pages').then(response => response.json());
const page = pages.find(candidate => candidate.name === 'Media Routing & Search Demo');
if (!page) throw new Error('Media Routing & Search Demo page was not found');
const response = await fetch(`${base}/api/pages/${page.id}/display`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_id: deviceId }),
});
const result = await response.json();
if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(result)}`);
console.log(JSON.stringify({ pageId: page.id, deviceId, delivered: result.delivered, override: result.override }));
