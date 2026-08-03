import process from 'node:process';
import { ContentBridgePrototype } from './server.js';

const videoId = process.argv[2];
if (!videoId) {
  throw new Error('Usage: npm run prototype:content-bridge -- <youtube-video-id>');
}

const bridge = new ContentBridgePrototype({ port: 43121 });
await bridge.start();
const session = bridge.createYouTubeSession({ videoIds: [videoId], playbackId: 'phase0-manual' });

console.log('Phase 0 Content Bridge prototype is loopback-only.');
console.log(`Open this development-only URL in the target WebKitGTK WebView:\n${session.url}`);
console.log('Press Ctrl+C to stop.');

const stop = async () => {
  await bridge.stop();
  process.exit(0);
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
