/**
 * Canvas UI Platform — core types (platform server, not HA-specific)
 */

// ── View / Widget ─────────────────────────────────────────────────────────────

export interface ViewConfig {
  id: string;
  name: string;
  style: ViewStyle;
  widgets: WidgetConfig[];
  resolution?: string;
  sizex?: number;
  sizey?: number;
}

export interface ViewStyle {
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundImage?: string;
}

export interface WidgetConfig {
  id: string;
  type: string;
  name?: string;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex?: number;
  };
  config: Record<string, any>;
  bindings?: Record<string, string>;
  visibility?: VisibilityConfig;
  hiddenInEdit?: boolean;
  locked?: boolean;
}

export interface WidgetProps {
  config: WidgetConfig;
  isEditMode: boolean;
  /** Called by the widget when the user edits it inline */
  onUpdate?: (updates: Partial<WidgetConfig>) => void;
  /** Current resolved data-source values the widget can use instead of entities */
  dataValues?: Record<string, DataSourceValue>;
}

// ── Data Sources ──────────────────────────────────────────────────────────────

export interface DataSourceValue {
  id: string;
  key: string;           // e.g. "temperature"
  value: any;
  unit?: string;
  last_updated: string;
}

// ── Visibility ────────────────────────────────────────────────────────────────

export interface VisibilityConfig {
  conditions?: Condition[];
  logic?: 'and' | 'or';
  defaultVisible?: boolean;
}

export type Condition =
  | StateCondition
  | NumericStateCondition
  | TimeCondition
  | ScreenCondition
  | LogicCondition;

export interface StateCondition {
  type: 'state';
  source: string;
  key: string;
  operator: '==' | '!=' | 'contains' | 'starts_with' | 'ends_with';
  value: string;
}

export interface NumericStateCondition {
  type: 'numeric_state';
  source: string;
  key: string;
  operator: '>' | '>=' | '<' | '<=' | '==' | '!=';
  value: number;
}

export interface TimeCondition {
  type: 'time';
  after?: string;
  before?: string;
  weekdays?: number[];
}

export interface ScreenCondition {
  type: 'screen';
  min_width?: number;
  max_width?: number;
  min_height?: number;
  max_height?: number;
}

export interface LogicCondition {
  type: 'and' | 'or' | 'not';
  conditions: Condition[];
}

// ── Server view model (from REST API) ────────────────────────────────────────

export interface ServerView {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  view_data: ViewConfig;
  created_at: string;
  updated_at: string;
}

// ── Pages ────────────────────────────────────────────────────────────────────

export interface PagePanel {
  id: string;
  page_id: string;
  name: string;
  x: number;   // % 0-100
  y: number;
  w: number;
  h: number;
  view_id?: string;
  url?: string;
  position: number;
}

export interface FloatingConfig {
  view_id?: string;
  url?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

export interface Page {
  id: string;
  name: string;
  panels: PagePanel[];
  floating_config?: FloatingConfig | null;
  created_at: string;
  updated_at: string;
}

// ── WebSocket messages ────────────────────────────────────────────────────────

export type WsInboundMessage =
  | { type: 'hello_ack'; server_version: string }
  | { type: 'view_change'; viewId: string; viewData: ViewConfig }
  | { type: 'data_update'; sourceId: string; key: string; value: any; unit?: string }
  | { type: 'ha_state_update'; entity_id: string; state: string; attributes: Record<string, any>; last_updated?: string; last_changed?: string }
  | { type: 'command'; id: number; device_id: string; action: string; payload: Record<string, any> }
  | { type: 'load_page'; page_id: string; page_data: Page }
  | { type: 'view_updated'; view_id: string; updated_at: string }
  | { type: 'pong' };

export type WsOutboundMessage =
  | { type: 'ping' }
  | { type: 'hello'; client_type: 'browser' | 'editor' | 'api'; device_id?: string }
  | { type: 'subscribe_view'; viewId: string };
