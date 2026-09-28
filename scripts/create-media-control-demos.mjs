/**
 * Creates the Android-sized media control demo pages on Core.
 *
 * "DAB+ Controls Demo (Android)" and "Dispatcharr Controls Demo (Android)" mirror
 * the 1920x1080 demo scenes but are laid out for the Android tablet's 1280x800
 * landscape screen — the resolution the native Android client reports at
 * registration (see browser/android-native CoreEdgeClient.kt). Confirmed on the
 * physical tablet (A1064US260402203): 800x1280 portrait panel at 213 dpi held in
 * ROTATION_90, i.e. a 1280x800 landscape app area. Each page is a published scene
 * plus a single full-bleed panel.
 *
 * Env:
 *   CANVAS_CORE_AUTOMATION_TOKEN  admin bearer token (required)
 *   CANVAS_DEMO_BASE              Core base URL (default http://127.0.0.1:3100)
 *
 * Idempotent: a page whose name already exists is left untouched.
 */
const base = process.env.CANVAS_DEMO_BASE || 'http://127.0.0.1:3100';
const token = process.env.CANVAS_CORE_AUTOMATION_TOKEN;
if (!token) throw new Error('CANVAS_CORE_AUTOMATION_TOKEN is required');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(d)}`);
  return d;
};

// Android tablet native resolution (landscape).
const WIDTH = 1280;
const HEIGHT = 800;

const widget = (id, type, x, y, w, h, config = {}) => ({
  id, type, x, y, w, h, zIndex: 1, hidden: false, locked: false,
  config: { width: w, height: h, backgroundColor: '#12161f', textColor: '#e6edf3', borderRadius: 14, ...config },
});

function buildWidgets(kind) {
  const isDab = kind === 'dab';
  const accent = isDab ? '#4493f8' : '#39d353';
  const poll = isDab ? 5 : 10;
  const sourceLabel = isDab ? 'DAB+ station' : 'Dispatcharr channel';
  const listFilter = isDab ? '' : 'AU:';
  const presets = isDab
    ? ['sdr1::triplem', 'sdr1::tripsimple', 'sdr1::fox', 'sdr1::gold', 'sdr1::gold80s', 'sdr1::kiis', 'sdr1::kiis90s', 'sdr1::tiga']
    : ['AU: ABC news', 'AU: EWTN ASIA PACIFIC HD', 'AU: 10 SHAKE PERTH', 'AU: 7FLIX BRISBANE', 'AU: 7FLIX CANBERRA', 'AU: 7FLIX PERTH', 'AU: 7FLIX SYDNEY', 'AU: 7NOW'];
  const playItem = isDab ? 'sdr1::triplem' : 'AU: ABC news';
  const playLabel = isDab ? 'Play Triple M' : 'Play ABC News';

  // Combined picker + now-playing + controls.
  const picker = isDab ? 'dabradio' : 'dispatcharr';
  const stations = isDab ? 'dabstations' : 'dispatcharrchannels';
  const search = isDab ? 'dabsearch' : 'dispatcharrsearch';
  const nowPlaying = isDab ? 'dabnowplaying' : 'dispatcharrnowplaying';
  const controls = isDab ? 'dabcontrols' : 'dispatcharrcontrols';
  const volumeSlider = isDab ? 'dabvolumeslider' : 'dispatcharrvolumeslider';
  const volumeDial = isDab ? 'dabvolumedial' : 'dispatcharrvolumedial';
  const presetsType = isDab ? 'dabpresets' : 'dispatcharrpresets';
  const playButton = isDab ? 'dabplaybutton' : 'dispatcharrplaybutton';

  const style = { accentColor: accent, pollInterval: poll };

  return [
    // Left area — three pickers across the top.
    widget('demo_picker', picker, 16, 16, 300, 360, {
      ...style,
      ...(isDab ? { showStationList: true } : { showChannelList: true, search: listFilter }),
    }),
    widget('demo_list', stations, 332, 16, 300, 360, {
      ...style,
      title: isDab ? 'All DAB+ Stations' : 'Australian Channels',
      search: listFilter, iconSize: 40, maxItems: 200,
      showHeader: true, showIcons: true, showPrevious: true, showNext: true,
    }),
    widget('demo_search', search, 648, 16, 300, 360, {
      ...style,
      title: isDab ? 'Find a DAB+ Station' : 'Find a Dispatcharr Channel',
      placeholder: isDab ? 'Search stations…' : 'Search channels…',
      maxItems: 50, showHeader: true, showPrevious: true, showNext: true,
    }),
    // Left area — preset grid across the bottom.
    widget('demo_presets', presetsType, 16, 392, 932, 392, {
      ...style,
      columns: 4, presets, iconSize: 56, buttonHeight: 120, showIcons: true, showLabels: true,
    }),
    // Right rail — now playing, transport, volume, single-play.
    widget('demo_nowplaying', nowPlaying, 964, 16, 300, 130, {
      ...style,
      emptyText: `Choose a ${sourceLabel}`,
      showArtwork: true, showState: true, showSource: true,
    }),
    widget('demo_controls', controls, 964, 158, 300, 110, {
      ...style,
      buttonSize: 44, showPlayPause: true, showStop: true, showPrevious: true, showNext: true,
      showMute: true, showStatus: true,
    }),
    widget('demo_volumeslider', volumeSlider, 964, 280, 300, 90, {
      ...style,
      label: 'Volume', orientation: 'horizontal', showValue: true, showMute: true,
      fillColor: accent, thumbColor: accent, trackColor: '#2a3444',
    }),
    widget('demo_volumedial', volumeDial, 964, 382, 300, 250, {
      ...style,
      label: 'Volume Dial', showValue: true, showMute: true,
      fillColor: accent, knobColor: '#1f2733', trackColor: '#2a3444', angleOffset: 220, angleRange: 280,
    }),
    widget('demo_playbutton', playButton, 964, 644, 300, 140, {
      ...style,
      item: playItem, label: playLabel, fontSize: 20, iconSize: 52, showIcon: true,
    }),
  ];
}

async function createDemo(name, kind) {
  const pages = await fetch(base + '/api/pages').then(r => r.json());
  const existing = pages.find(page => page.name === name);
  if (existing) return { name, pageId: existing.id, existing: true };

  const widgets = buildWidgets(kind);
  const created = await post('/api/admin/scenes', {
    name,
    manifest: { width: WIDTH, height: HEIGHT, widgets },
  });
  const sceneId = created.scene.id;
  await post(`/api/admin/scenes/${sceneId}/publish`, {});
  const page = await post('/api/pages', {
    name,
    panels: [{ name: 'Main', x: 0, y: 0, w: 100, h: 100, content_type: 'scene', scene_id: sceneId, visible: true, opacity: 1, z_index: 0 }],
  });
  return { name, pageId: page.id, sceneId, widgets: widgets.length, existing: false };
}

const results = [
  await createDemo('DAB+ Controls Demo (Android)', 'dab'),
  await createDemo('Dispatcharr Controls Demo (Android)', 'dispatcharr'),
];
console.log(JSON.stringify({ width: WIDTH, height: HEIGHT, results }, null, 2));
