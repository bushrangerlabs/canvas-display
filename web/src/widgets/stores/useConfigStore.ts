import { create } from 'zustand';
import type { CanvasConfig, WidgetConfig } from '../types/index';

interface ConfigState {
  config: CanvasConfig | null;
  currentViewId: string | null;
  setConfig: (config: CanvasConfig | null) => void;
  setCurrentView: (viewId: string | null) => void;
  updateWidget: (viewId: string, widgetId: string, updates: Partial<WidgetConfig>) => void;
}

/**
 * Core editor compatibility adapter for Canvas UI widgets that persist runtime
 * settings (currently ColorPicker and Screensaver). Scene persistence remains
 * owned by Core's editor and scene APIs.
 */
export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  currentViewId: null,
  setConfig: (config) => set({ config }),
  setCurrentView: (currentViewId) => set({ currentViewId }),
  updateWidget: (viewId, widgetId, updates) => set((state) => {
    if (!state.config) return state;
    return {
      config: {
        ...state.config,
        views: state.config.views.map((view) => {
          if (view.id !== viewId) return view;
          return {
            ...view,
            widgets: view.widgets.map((widget) => {
              if (widget.id !== widgetId) return widget;
              return {
                ...widget,
                ...updates,
                config: updates.config
                  ? { ...widget.config, ...updates.config }
                  : widget.config,
              };
            }),
          };
        }),
      },
    };
  }),
}));
