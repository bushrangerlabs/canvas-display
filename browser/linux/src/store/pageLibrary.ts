import { Store } from '@tauri-apps/plugin-store';

export interface CachedPage<TPanel = unknown, TFloating = unknown> {
  page_id: string;
  panels: TPanel[];
  floating_config: TFloating | null;
  cached_at: string;
}

let pageStore: Store | null = null;

async function getPageStore(): Promise<Store> {
  pageStore ??= await Store.load('page-library.json', {
    autoSave: true,
    defaults: { pages: {}, activePageId: null },
  });
  return pageStore;
}

export async function cachePage<TPanel, TFloating>(
  page: Omit<CachedPage<TPanel, TFloating>, 'cached_at'>,
): Promise<void> {
  const store = await getPageStore();
  const pages = (await store.get<Record<string, CachedPage<TPanel, TFloating>>>('pages')) ?? {};
  pages[page.page_id] = { ...page, cached_at: new Date().toISOString() };
  await store.set('pages', pages);
  await store.set('activePageId', page.page_id);
  await store.save();
}

export async function loadActiveCachedPage<TPanel, TFloating>(): Promise<CachedPage<TPanel, TFloating> | null> {
  const store = await getPageStore();
  const activePageId = await store.get<string>('activePageId');
  if (!activePageId) return null;
  const pages = (await store.get<Record<string, CachedPage<TPanel, TFloating>>>('pages')) ?? {};
  return pages[activePageId] ?? null;
}
