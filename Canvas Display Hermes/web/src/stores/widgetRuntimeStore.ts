import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WidgetRuntimeState {
  value?: any;
  timestamp?: number;
  type?: string;
  metadata?: Record<string, any>;
}

interface WidgetRuntimeStore {
  widgetStates: Record<string, WidgetRuntimeState>;
  setWidgetState: (widgetId: string, state: Partial<WidgetRuntimeState>) => void;
  getWidgetState: (widgetId: string) => WidgetRuntimeState | null;
  clearWidgetState: (widgetId: string) => void;
  clearAllStates: () => void;
  subscribeToWidget: (widgetId: string, callback: (state: WidgetRuntimeState | null) => void) => () => void;
}

export const useWidgetRuntimeStore = create<WidgetRuntimeStore>()(
  persist(
    (set, get) => ({
      widgetStates: {},
      setWidgetState: (widgetId, state) => {
        set((prev) => ({
          widgetStates: {
            ...prev.widgetStates,
            [widgetId]: {
              ...prev.widgetStates[widgetId],
              ...state,
              timestamp: Date.now(),
            },
          },
        }));
      },
      getWidgetState: (widgetId) => {
        const state = get().widgetStates[widgetId];
        return state !== undefined ? state : null;
      },
      clearWidgetState: (widgetId) => {
        set((prev) => {
          const { [widgetId]: _, ...rest } = prev.widgetStates;
          return { widgetStates: rest };
        });
      },
      clearAllStates: () => {
        set({ widgetStates: {} });
      },
      subscribeToWidget: (_widgetId: string, callback: (state: WidgetRuntimeState | null) => void): (() => void) => {
        const currentState = get().widgetStates[_widgetId];
        callback(currentState !== undefined ? currentState : null);
        return () => {};
      },
    }),
    {
      name: 'canvas-ui-widget-runtime',
      partialize: (state) => ({
        widgetStates: state.widgetStates,
      }),
    }
  )
);