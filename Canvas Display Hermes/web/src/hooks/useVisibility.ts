import { useEffect, useState } from 'react';
import type { EntityState } from '../widgets/types/index';
import type { Condition, VisibilityConfig } from '../widgets/types/visibility';

interface WindowSize { width: number; height: number; }

function useWindowSize(): WindowSize {
  const [windowSize, setWindowSize] = useState<WindowSize>({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return windowSize;
}

export function useVisibility(config: VisibilityConfig | undefined, entities: Record<string, EntityState>): boolean {
  const [isVisible, setIsVisible] = useState(true);
  const windowSize = useWindowSize();
  useEffect(() => {
    if (!config?.conditions?.length) { setIsVisible(true); return; }
    const result = evaluateConditions(config.conditions, entities, windowSize, config.mode);
    setIsVisible(result);
  }, [config, entities, windowSize]);
  return isVisible;
}

function evaluateConditions(conditions: Condition[], entities: Record<string, EntityState>, windowSize: WindowSize, mode: 'all' | 'any' = 'all'): boolean {
  if (conditions.length === 0) return true;
  return mode === 'all'
    ? conditions.every(c => evaluateCondition(c, entities, windowSize))
    : conditions.some(c => evaluateCondition(c, entities, windowSize));
}

function evaluateCondition(condition: Condition, entities: Record<string, EntityState>, windowSize: WindowSize): boolean {
  switch (condition.type) {
    case 'state': {
      const e = entities[condition.entity];
      if (!e) return false;
      const m = e.state?.toString() === condition.state;
      return condition.not ? !m : m;
    }
    case 'numeric_state': {
      const e = entities[condition.entity];
      if (!e) return false;
      const v = parseFloat(e.state);
      if (isNaN(v)) return false;
      if (condition.above !== undefined && v <= condition.above) return false;
      if (condition.below !== undefined && v >= condition.below) return false;
      return true;
    }
    case 'screen': {
      if (condition.minWidth !== undefined && windowSize.width < condition.minWidth) return false;
      if (condition.maxWidth !== undefined && windowSize.width > condition.maxWidth) return false;
      if (condition.minHeight !== undefined && windowSize.height < condition.minHeight) return false;
      if (condition.maxHeight !== undefined && windowSize.height > condition.maxHeight) return false;
      return true;
    }
    case 'time': {
      const now = new Date();
      const t = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
      const d = now.getDay();
      if (condition.after && t < condition.after) return false;
      if (condition.before && t > condition.before) return false;
      if (condition.weekday && !condition.weekday.includes(d)) return false;
      return true;
    }
    case 'and': return condition.conditions.every(c => evaluateCondition(c, entities, windowSize));
    case 'or': return condition.conditions.some(c => evaluateCondition(c, entities, windowSize));
    default: return true;
  }
}