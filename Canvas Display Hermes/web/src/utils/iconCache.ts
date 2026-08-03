import { addIcon } from '@iconify/react';

export interface IconData {
  body: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  rotate?: number;
  hFlip?: boolean;
  vFlip?: boolean;
}

export interface IconCache {
  [iconName: string]: IconData;
}

// Empty core icons list for standalone mode
const CORE_ICONS: string[] = [];

export async function loadCoreIcons(): Promise<void> {
  console.log('[IconCache] Loading core icons...');
  const iconsByCollection: Record<string, string[]> = {};
  CORE_ICONS.forEach((iconName: string) => {
    const [collection, icon] = iconName.split(':');
    if (!iconsByCollection[collection]) {
      iconsByCollection[collection] = [];
    }
    iconsByCollection[collection].push(icon);
  });

  const collectionPromises = Object.entries(iconsByCollection).map(async ([collection, icons]) => {
    try {
      const iconList = icons.join(',');
      const response = await fetch(`https://api.iconify.design/${collection}.json?icons=${iconList}`);
      if (!response.ok) return null;
      const data = await response.json();
      if (data.icons) {
        Object.entries(data.icons).forEach(([iconName, iconData]: [string, any]) => {
          const fullName = `${collection}:${iconName}`;
          addIcon(fullName, iconData);
        });
        return icons.length;
      }
      return null;
    } catch (error) {
      console.warn(`[IconCache] Failed to load ${collection} icons:`, error);
      return null;
    }
  });

  const results = await Promise.all(collectionPromises);
  const loadedCount = results.filter((r: any) => r !== null).reduce((sum: number, count: any) => sum + count, 0);
  console.log(`[IconCache] Loaded ${loadedCount}/${CORE_ICONS.length} core icons`);
}

export async function loadIconCache(): Promise<IconCache> {
  try {
    const response = await fetch(`/canvas-ui-static/icon-cache.json?t=${Date.now()}`);
    if (!response.ok) {
      console.log('[IconCache] No existing cache found, creating new cache');
      return {};
    }
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      console.warn('[IconCache] Invalid content type:', contentType);
      return {};
    }
    const cache: IconCache = await response.json();
    Object.entries(cache).forEach(([iconName, iconData]: [string, any]) => {
      addIcon(iconName, iconData);
    });
    console.log(`[IconCache] Loaded ${Object.keys(cache).length} icons from cache`);
    return cache;
  } catch (error) {
    console.error('[IconCache] Failed to load icon cache:', error);
    return {};
  }
}

async function fetchIconFromAPI(iconName: string): Promise<IconData | null> {
  try {
    const [collection, icon] = iconName.split(':');
    if (!collection || !icon) {
      console.warn(`[IconCache] Invalid icon name format: ${iconName}`);
      return null;
    }
    const response = await fetch(`https://api.iconify.design/${collection}.json?icons=${icon}`);
    if (!response.ok) {
      console.warn(`[IconCache] Icon not found: ${iconName}`);
      return null;
    }
    const data = await response.json();
    if (data.icons && data.icons[icon]) {
      return data.icons[icon];
    }
    console.warn(`[IconCache] Icon data not in response: ${iconName}`);
    return null;
  } catch (error) {
    console.error(`[IconCache] Failed to fetch icon ${iconName}:`, error);
    return null;
  }
}

export async function cacheIconToServer(
  websocket: WebSocket | null,
  iconName: string,
  iconData?: IconData
): Promise<boolean> {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    console.warn('[IconCache] WebSocket not connected, cannot cache icon');
    return false;
  }
  try {
    let iconDataToCache: IconData | null = iconData || null;
    if (!iconDataToCache) {
      iconDataToCache = await fetchIconFromAPI(iconName);
      if (!iconDataToCache) return false;
    }
    addIcon(iconName, iconDataToCache as any);
    const message = {
      type: 'cache_icon',
      icon_name: iconName,
      icon_data: iconDataToCache,
    };
    websocket.send(JSON.stringify(message));
    console.log(`[IconCache] Cached icon: ${iconName}`);
    return true;
  } catch (error) {
    console.error(`[IconCache] Failed to cache icon ${iconName}:`, error);
    return false;
  }
}

export async function searchIcons(
  query: string,
  collection?: string,
  limit: number = 64
): Promise<string[]> {
  try {
    const prefix = collection || 'mdi';
    const response = await fetch(
      `https://api.iconify.design/search?query=${encodeURIComponent(query)}&prefix=${prefix}&limit=${limit}`
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.icons || [];
  } catch (error) {
    console.error('[IconCache] Search failed:', error);
    return [];
  }
}

export async function listCollectionIcons(
  collection: string,
  start: number = 0,
  limit: number = 999
): Promise<string[]> {
  try {
    const response = await fetch(
      `https://api.iconify.design/collection?prefix=${collection}`
    );
    if (!response.ok) return [];
    const data = await response.json();
    const icons = data.uncategorized || [];
    return icons.slice(start, start + limit).map((icon: string) => `${collection}:${icon}`);
  } catch (error) {
    console.error(`[IconCache] Failed to list ${collection} icons:`, error);
    return [];
  }
}

export const IconPreferences = {
  getFavorites(): string[] {
    try {
      const favorites = localStorage.getItem('icon-favorites');
      return favorites ? JSON.parse(favorites) : [];
    } catch {
      return [];
    }
  },
  addFavorite(iconName: string): void {
    const favorites = this.getFavorites();
    if (!favorites.includes(iconName)) {
      favorites.push(iconName);
      localStorage.setItem('icon-favorites', JSON.stringify(favorites));
    }
  },
  removeFavorite(iconName: string): void {
    const favorites = this.getFavorites().filter(name => name !== iconName);
    localStorage.setItem('icon-favorites', JSON.stringify(favorites));
  },
  isFavorite(iconName: string): boolean {
    return this.getFavorites().includes(iconName);
  },
  getRecent(): string[] {
    try {
      const recent = localStorage.getItem('icon-recent');
      return recent ? JSON.parse(recent) : [];
    } catch {
      return [];
    }
  },
  addRecent(iconName: string): void {
    let recent = this.getRecent();
    recent = recent.filter(name => name !== iconName);
    recent.unshift(iconName);
    recent = recent.slice(0, 50);
    localStorage.setItem('icon-recent', JSON.stringify(recent));
  },
};