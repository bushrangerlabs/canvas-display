/**
 * useVisibility - React hook for evaluating visibility conditions
 * Determines if a widget should be visible based on entity states
 */

import { useEffect, useState } from 'react';
import { useWebSocket } from '../widgets/providers/WebSocketProvider';
import { BindingEvaluator } from '../widgets/utils/BindingEvaluator';

/**
 * Hook to evaluate visibility conditions and subscribe to entity changes
 * @param visibilityCondition - Expression like "{light.living_room.state} == 'on'"
 * @returns boolean - true if widget should be visible
 */
export function useVisibility(visibilityCondition?: string): boolean {
  const { entities } = useWebSocket();
  const [isVisible, setIsVisible] = useState(true);

  // The provider only swaps `entities` when an entity actually changed, so this
  // effect is the single, event-driven update path. The old
  // EntitySubscriptionManager polled every second on top of this, which was
  // redundant work on the Pi.
  useEffect(() => {
    if (!visibilityCondition || visibilityCondition.trim() === '') {
      setIsVisible(true);
      return;
    }
    try {
      setIsVisible(Boolean(BindingEvaluator.evaluate(visibilityCondition, entities)));
    } catch (error) {
      console.error('Visibility evaluation error:', error, visibilityCondition);
      setIsVisible(true); // Show widget on error
    }
  }, [visibilityCondition, entities]);

  return isVisible;
}
