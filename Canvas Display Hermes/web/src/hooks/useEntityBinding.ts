import { useEffect, useState } from 'react';
import { entitySubscriptionManager } from '../widgets/managers/EntitySubscriptionManager';
import { useWebSocket } from '../widgets/providers/WebSocketProvider';
import { BindingEvaluator } from '../widgets/utils/BindingEvaluator';

export function useEntityBinding<T = any>(expression: any, defaultValue?: T): T {
  const { entities } = useWebSocket();
  const [value, setValue] = useState<T>(() => {
    if (!BindingEvaluator.hasBinding(expression)) {
      return (expression ?? defaultValue) as T;
    }
    return BindingEvaluator.evaluate(expression, entities) as T;
  });

  useEffect(() => {
    if (!BindingEvaluator.hasBinding(expression)) {
      setValue((expression ?? defaultValue) as T);
      return;
    }
    const entityIds = BindingEvaluator.extractEntityIds(expression);
    if (entityIds.length === 0) {
      setValue((expression ?? defaultValue) as T);
      return;
    }
    entitySubscriptionManager.connect(() => entities);
    const unsubscribe = entitySubscriptionManager.subscribe(entityIds, (updatedEntities) => {
      const newValue = BindingEvaluator.evaluate(expression, updatedEntities);
      setValue(newValue as T);
    });
    setValue(BindingEvaluator.evaluate(expression, entities) as T);
    return unsubscribe;
  }, [expression, entities, defaultValue]);
  return value;
}

export function useHasBinding(value: any): boolean {
  return BindingEvaluator.hasBinding(value);
}

export function useBindingDisplay(expression: string): string {
  return BindingEvaluator.formatBindingDisplay(expression);
}