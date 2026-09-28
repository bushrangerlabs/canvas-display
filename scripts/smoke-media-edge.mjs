const base = process.env.CANVAS_DEMO_BASE || 'http://127.0.0.1:3100';
const token = process.env.CANVAS_CORE_AUTOMATION_TOKEN;
const deviceId = process.env.CANVAS_DEMO_DEVICE_ID;
const mode = process.env.CANVAS_MEDIA_SMOKE_MODE || 'play';
if (!token || !deviceId) throw new Error('Core automation token and CANVAS_DEMO_DEVICE_ID are required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const request = mode === 'stop'
  ? ['/api/media/control', { action:'stop', source:'dab', deviceId }]
  : ['/api/dab/play', { station:'sdr1::triplem', deviceId }];
const response = await fetch(base + request[0], { method:'POST', headers, body:JSON.stringify(request[1]) });
const result = await response.json();
if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(result)}`);
console.log(JSON.stringify({ deviceId, mode, success:true }));
