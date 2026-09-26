import { Bonjour, type Service } from 'bonjour-service';
import type { CoreConfig } from './config.js';

const SERVICE_TYPE = 'canvas-core';
const SERVICE_PROTOCOL = 'tcp';

export interface CoreDiscoveryHandle {
  stop(): void;
}

/** Advertise the Core control plane on the local LAN for zero-configuration Edge clients. */
export function advertiseCore(config: CoreConfig): CoreDiscoveryHandle {
  const bonjour = new Bonjour();
  const service: Service = bonjour.publish({
    name: 'Canvas Core',
    type: SERVICE_TYPE,
    protocol: SERVICE_PROTOCOL,
    port: config.port,
    txt: {
      https: 'true',
      gateway: config.gatewayPath,
      ha_url: config.homeAssistantUrl ?? '',
      api: 'canvas-core-v1',
    },
  });
  service.on('error', (error) => {
    console.warn('[core][discovery] mDNS advertisement error:', error);
  });
  console.log(`[core][discovery] advertising _${SERVICE_TYPE}._${SERVICE_PROTOCOL} on port ${config.port}`);
  return {
    stop() {
      bonjour.destroy();
      console.log('[core][discovery] advertisement stopped');
    },
  };
}
