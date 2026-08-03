import { create } from 'zustand';
import type { CanvasConfig, ViewConfig, CanvasVariable } from '../types';

export type ViewMode = 'edit' | 'preview' | 'kiosk';

interface ConfigState {
  config: CanvasConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  currentViewId: string | null;
  mode: ViewMode;
  history: CanvasConfig[];
  historyIndex: number;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  setCurrentView: (viewId: string) => void;
  setMode: (mode: ViewMode) => void;
  addView: (view: ViewConfig) => void;
  deleteView: (viewId: string) => void;
  duplicateView: (viewId: string) => void;
  cloneView: (viewId: string, newName: string) => void;
  updateView: (viewId: string, updates: Partial<ViewConfig>) => void;
  addWidget: (viewId: string, widget: any) => void;
  updateWidget: (viewId: string, widgetId: string, updates: any) => void;
  deleteWidget: (viewId: string, widgetId: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  getVariable: (name: string) => any;
  setVariable: (name: string, value: any, type?: CanvasVariable['type']) => void;
  deleteVariable: (name: string) => void;
  listVariables: () => Record<string, CanvasVariable>;
  exportView: (viewId: string) => void;
  importView: (file: File) => Promise<void>;
}

export const useConfigStore = create<ConfigState>()((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  error: null,
  currentViewId: null,
  mode: 'edit' as ViewMode,
  history: [],
  historyIndex: -1,
  loadConfig: async () => {},
  saveConfig: async () => {},
  setCurrentView: (viewId) => set({ currentViewId: viewId }),
  setMode: (mode) => set({ mode }),
  addView: () => {},
  deleteView: () => {},
  duplicateView: () => {},
  cloneView: () => {},
  updateView: () => {},
  addWidget: () => {},
  updateWidget: () => {},
  deleteWidget: () => {},
  undo: () => {},
  redo: () => {},
  canUndo: () => false,
  canRedo: () => false,
  getVariable: () => undefined,
  setVariable: () => {},
  deleteVariable: () => {},
  listVariables: () => ({}),
  exportView: () => {},
  importView: async () => {},
}));