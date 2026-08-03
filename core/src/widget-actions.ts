/**
 * Widget action types — the "typed actions" layer that replaces direct HA token access
 * from Canvas-native widgets (Phase 4 checklist: "Update Canvas-native widgets to use
 * filtered Core/Edge state and typed actions rather than direct HA token access").
 *
 * Each action type maps to the appropriate HA service call or Canvas internal action.
 * The renderer calls `POST /api/admin/widgets/typed-action` instead of calling HA's
 * `callService` directly.
 */

// ── Action type definitions ─────────────────────────────────────────────────

/** The canonical set of widget action types. */
export type WidgetActionType =
  | 'toggle'
  | 'turn_on'
  | 'turn_off'
  | 'set_value'
  | 'navigate'
  | 'media_play'
  | 'media_pause'
  | 'media_stop'
  | 'media_next_track'
  | 'media_previous_track'
  | 'custom';

/** A typed action request from a widget. */
export interface WidgetAction {
  /** The action type. */
  type: WidgetActionType;
  /** Arbitrary payload (entity_id, value, target, etc.). */
  payload: Record<string, unknown>;
}

/** Result of executing a typed action. */
export interface WidgetActionResult {
  ok: boolean;
  /** Human-readable description of what happened. */
  message: string;
  /** Affected entity IDs (when applicable). */
  affected?: string[];
  /** Navigation target (for navigate actions). */
  navigationTarget?: string;
}

// ── Action → HA service mapping ─────────────────────────────────────────────

/**
 * Maps a widget action type to the HA domain and service to call.
 * Returns null for Canvas-internal actions (like navigate).
 */
export function mapActionToHaService(
  actionType: WidgetActionType,
  entityId?: string,
  actionPayload?: Record<string, unknown>,
): { domain: string; service: string } | null {
  // Canvas-internal actions that don't map to HA services.
  if (actionType === 'navigate') return null;

  // Auto-detect domain from entity_id.
  const domain = entityId ? entityId.split('.')[0] : '';

  switch (actionType) {
    case 'toggle':
      return { domain: domain || 'homeassistant', service: 'toggle' };
    case 'turn_on':
      return { domain: domain || 'homeassistant', service: 'turn_on' };
    case 'turn_off':
      return { domain: domain || 'homeassistant', service: 'turn_off' };
    case 'set_value':
      return { domain: domain || 'number', service: 'set_value' };
    case 'media_play':
      return { domain: 'media_player', service: 'media_play' };
    case 'media_pause':
      return { domain: 'media_player', service: 'media_pause' };
    case 'media_stop':
      return { domain: 'media_player', service: 'media_stop' };
    case 'media_next_track':
      return { domain: 'media_player', service: 'media_next_track' };
    case 'media_previous_track':
      return { domain: 'media_player', service: 'media_previous_track' };
    case 'custom':
      return {
        domain: (actionPayload?.domain as string) || domain || 'homeassistant',
        service: (actionPayload?.service as string) || '',
      };
    default:
      return null;
  }
}