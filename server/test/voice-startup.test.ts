import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// index.ts starts the HTTP server on import. Exercise its actual voice startup
// block in isolation so this regression test does not start device services.
const source = readFileSync(path.resolve('src/index.ts'), 'utf8');
const start = source.indexOf('    let ownsDirectVoice = false;');
const end = source.indexOf('    // Start TTS broadcast poller', start);
assert.ok(start >= 0 && end > start);
const startup = new Function('dependencies', `
  const { isVoiceEnabled, useDirectCoreVoice, claimVoiceOwnership, process,
    startDirectWakeword, startVoiceServer, startAudioEndpointPoller, config, console } = dependencies;
  return (async () => { ${source.slice(start, end)} })();
`) as (dependencies: Record<string, unknown>) => Promise<void>;

for (const scenario of [
  { name: 'embedded direct owner polls assignments', enabled: true, direct: true, owned: true, services: false, expected: ['claim:core-direct', 'direct', 'poll'] },
  { name: 'embedded denied owner does not start capture or polling', enabled: true, direct: true, owned: false, services: false, expected: ['claim:core-direct'] },
  { name: 'embedded ownership held by another PID does not poll', enabled: true, direct: true, owned: true, otherPid: true, services: false, expected: ['claim:core-direct'] },
  { name: 'direct device-services owner starts polling only once', enabled: true, direct: true, owned: true, services: true, expected: ['claim:core-direct', 'direct', 'poll'] },
  { name: 'HA device-services startup retains assignment polling', enabled: true, direct: false, owned: true, services: true, expected: ['claim:ha-satellite', 'satellite', 'poll'] },
  { name: 'embedded disabled voice does not start assignment polling', enabled: false, direct: true, owned: true, services: false, expected: [] },
]) {
  test(scenario.name, async () => {
    const calls: string[] = [];
    await startup({
      isVoiceEnabled: () => scenario.enabled,
      useDirectCoreVoice: () => scenario.direct,
      claimVoiceOwnership: (mode: string) => { calls.push(`claim:${mode}`); return { owned: scenario.owned, pid: scenario.otherPid ? 2 : 1 }; },
      process: { pid: 1 },
      startDirectWakeword: async () => { calls.push('direct'); },
      startVoiceServer: async () => { calls.push('satellite'); },
      startAudioEndpointPoller: () => { calls.push('poll'); },
      config: { deviceServicesEnabled: scenario.services },
      console: { error: () => undefined },
    });
    assert.deepEqual(calls, scenario.expected);
  });
}

test('broadcast, audio arbiter and DLNA remain gated by device services', () => {
  const services = source.slice(end, source.indexOf('  } catch (err)', end));
  assert.match(services, /if \(config\.deviceServicesEnabled\) \{\s*startBroadcastDeliveryPoller\(config\.port\);\s*await initAudioArbiter\(\);\s*await startDlnaRenderer\(\);/);
  assert.equal(services.includes('startAudioEndpointPoller()'), false);
});
