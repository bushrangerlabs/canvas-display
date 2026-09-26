export interface CustomIcon {
  name: string;
  svg: string;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'core-custom-icons';

// Custom icons are persisted server-side (table `custom_icons`) so every
// client — the editor browser AND any edge/kiosk display device — sees the
// same set. localStorage is kept only as an instant-paint cache; syncFromServer()
// refreshes it from the authoritative server copy.
let serverSyncPromise: Promise<void> | null = null;

export function loadCustomIcons(): CustomIcon[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(icon => icon?.name && typeof icon.svg === 'string') : [];
  } catch {
    return [];
  }
}

function writeCache(icons: CustomIcon[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(icons));
}

/** Fetch the authoritative icon list from the server and refresh the local cache.
 * Call once at app startup so every widget rendering a `custom:` icon (editor
 * or edge device) has the current set before it paints. Safe to call repeatedly —
 * concurrent calls share the same in-flight request. */
export function syncCustomIconsFromServer(): Promise<void> {
  if (serverSyncPromise) return serverSyncPromise;
  serverSyncPromise = fetch('/api/icons')
    .then(res => (res.ok ? res.json() : null))
    .then((rows: Array<{ name: string; svg: string; created_at?: string; updated_at?: string }> | null) => {
      // No route (404 on a backend without icon support, e.g. Core) or a bad
      // response must NOT wipe the local cache — only overwrite on a real 200.
      if (!Array.isArray(rows)) return;
      const icons: CustomIcon[] = rows
        .filter(r => r?.name && typeof r.svg === 'string')
        .map(r => ({ name: r.name, svg: r.svg, createdAt: r.created_at ?? '', updatedAt: r.updated_at ?? '' }));
      writeCache(icons);
    })
    .catch(() => { /* offline or server unavailable — keep existing cache */ })
    .finally(() => { serverSyncPromise = null; });
  return serverSyncPromise;
}

export function saveCustomIcon(icon: CustomIcon): CustomIcon[] {
  const icons = loadCustomIcons().filter(item => item.name !== icon.name);
  const next = [...icons, icon];
  writeCache(next);
  // Persist to the server so other clients (including edge devices) can see it.
  // Fire-and-forget: the local cache is already updated for immediate use.
  // Uses the shared api client so the session cookie + CSRF header Core
  // requires for admin mutations are sent (a raw fetch would 401/403 there).
  import('../../api/client').then(({ api }) =>
    api.put(`/api/icons/${encodeURIComponent(icon.name)}`, { svg: icon.svg }),
  ).catch(() => { /* offline — icon stays local-only until next successful save */ });
  return next;
}

export function deleteCustomIcon(name: string): CustomIcon[] {
  const next = loadCustomIcons().filter(item => item.name !== name);
  writeCache(next);
  import('../../api/client').then(({ api }) =>
    api.delete(`/api/icons/${encodeURIComponent(name)}`),
  ).catch(() => { /* offline — icon is removed locally regardless */ });
  return next;
}

export function customIconId(name: string): string {
  return `custom:${name}`;
}

export function customIconName(id: string): string {
  return id.startsWith('custom:') ? id.slice('custom:'.length) : id;
}

export function customIconSvg(icon: CustomIcon, color = 'currentColor'): string {
  return icon.svg
    .replace(/currentColor/g, color)
    .replace(/<svg\b([^>]*)>/i, '<svg$1 style="width:100%;height:100%;display:block">');
}
