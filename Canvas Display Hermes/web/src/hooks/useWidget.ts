import { useCallback, useMemo } from 'react';
import { useWebSocket } from '../providers/WebSocketProvider';
import type { WidgetConfig } from '../types';

export interface UseWidgetReturn {
  entityData: Record<string, any>;
  updateConfig: (changes: Partial<WidgetConfig>) => void;
  getEntity: (fieldName: string) => any;
  getEntityState: (fieldName: string) => string | undefined;
  isEntityAvailable: (fieldName: string) => boolean;
}

export function useWidget(config: WidgetConfig): UseWidgetReturn {
  const { entities } = useWebSocket();

  const entityData = useMemo(() => {
    const entityFields = Object.entries(config.config).filter(([key, value]) =>
      key.toLowerCase().includes('entity') && typeof value === 'string' && value.length > 0
    );
    return Object.fromEntries(
      entityFields.map(([fieldName, entityId]) => [
        fieldName,
        entities?.[entityId as string] || null
      ])
    );
  }, [config, entities]);

  const updateConfig = useCallback((_changes: Partial<WidgetConfig>) => {
    console.warn('updateConfig called but not implemented - widgets should manage their own state');
  }, []);

  const getEntity = useCallback((fieldName: string) => {
    return entityData[fieldName] || null;
  }, [entityData]);

  const getEntityState = useCallback((fieldName: string) => {
    return entityData[fieldName]?.state;
  }, [entityData]);

  const isEntityAvailable = useCallback((fieldName: string) => {
    const entity = entityData[fieldName];
    return entity && entity.state !== 'unavailable' && entity.state !== 'unknown';
  }, [entityData]);

  return {
    entityData,
    updateConfig,
    getEntity,
    getEntityState,
    isEntityAvailable,
  };
}