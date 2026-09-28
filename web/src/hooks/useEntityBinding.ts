/**
 * useEntityBinding - React hook for evaluating and subscribing to entity bindings
 * Automatically re-evaluates when entity states change
 */

import { useEffect, useState } from 'react';
import { useWebSocket } from '../widgets/providers/WebSocketProvider';
import { BindingEvaluator } from '../widgets/utils/BindingEvaluator';

/**
 * Hook to evaluate a binding expression and subscribe to entity changes
 * @param expression - The binding expression (e.g., "{light.living_room.state}" or "Hello {sensor.temperature.state}°C")
 * @param defaultValue - Value to return if expression is not a binding
 * @returns Evaluated value that updates when entities change
 */
export function useEntityBinding<T = any>(expression: any, defaultValue?: T): T {
  const { entities } = useWebSocket();
  const [value, setValue] = useState<T>(() => {
    if (!BindingEvaluator.hasBinding(expression)) {
      return (expression ?? defaultValue) as T;
    }
    return BindingEvaluator.evaluate(expression, entities) as T;
  });

  // The provider only swaps `entities` when an entity actually changed, so this
  // effect is the single, event-driven update path. The old
  // EntitySubscriptionManager polled every second on top of this, which was
  // redundant work on the Pi.
  useEffect(() => {
    if (!BindingEvaluator.hasBinding(expression)) {
      setValue((expression ?? defaultValue) as T);
      return;
    }
    setValue(BindingEvaluator.evaluate(expression, entities) as T);
  }, [expression, entities, defaultValue]);

  return value;
}

/**
 * Hook to check if a value contains binding syntax
 */
export function useHasBinding(value: any): boolean {
  return BindingEvaluator.hasBinding(value);
}

/**
 * Hook to get display format of binding
 */
export function useBindingDisplay(expression: string): string {
  return BindingEvaluator.formatBindingDisplay(expression);
}
