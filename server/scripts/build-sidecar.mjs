import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('../', import.meta.url));
const linuxBinariesDir = resolve(serverDir, '../browser/linux/src-tauri/binaries');

const targets = {
  x64: {
    nodeArch: 'x64',
    pkgTarget: 'node20-linux-x64',
    rustTriple: 'x86_64-unknown-linux-gnu',
    elfMachine: 62,
  },
  arm64: {
    nodeArch: 'arm64',
    pkgTarget: 'node20-linux-arm64',
    rustTriple: 'aarch64-unknown-linux-gnu',
    elfMachine: 183,
  },
};

function fail(message) {
  console.error(`[sidecar] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: serverDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readElfMachine(path) {
  const header = readFileSync(path).subarray(0, 20);
  if (header.length < 20 || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
    fail(`${path} is not an ELF binary`);
  }
  if (header[5] === 1) return header.readUInt16LE(18);
  if (header[5] === 2) return header.readUInt16BE(18);
  fail(`${path} has an unsupported ELF byte order`);
}

function assertArchitecture(path, expectedMachine, label) {
  const actualMachine = readElfMachine(path);
  if (actualMachine !== expectedMachine) {
    fail(`${label} has ELF machine ${actualMachine}; expected ${expectedMachine} for ${process.arch}`);
  }
  console.log(`[sidecar] ${label} architecture verified`);
}

if (process.platform !== 'linux') fail(`Linux sidecars must be built on Linux, not ${process.platform}`);

const requested = process.argv[2] ?? 'host';
const targetName = requested === 'host' ? process.arch : requested;
if (!(targetName in targets)) fail(`Unsupported target "${requested}"; expected host, x64, or arm64`);

const target = targets[targetName];
if (process.arch !== target.nodeArch) {
  fail(`Refusing to build ${targetName} on ${process.arch}; better-sqlite3 must be built natively for the target`);
}

const nativeAddon = resolve(serverDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const bundledAddon = resolve(linuxBinariesDir, 'better_sqlite3.node');
const bundledPublicDir = resolve(linuxBinariesDir, 'public');
const sidecarOutput = resolve(linuxBinariesDir, `canvas-display-server-${target.rustTriple}`);

run('npm', ['run', 'build']);
run('npx', [
  '--no-install',
  'esbuild',
  'dist/index.js',
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  '--outfile=dist/bundle.js',
  '--alias:bindings=./dist/bindings-shim.js',
]);
assertArchitecture(nativeAddon, target.elfMachine, 'better_sqlite3.node');

mkdirSync(dirname(bundledAddon), { recursive: true });
rmSync(bundledPublicDir, { recursive: true, force: true });
cpSync(resolve(serverDir, 'public'), bundledPublicDir, { recursive: true });
cpSync(nativeAddon, bundledAddon);

run('npx', [
  '--no-install',
  'pkg',
  'dist/bundle.js',
  '--target', target.pkgTarget,
  '--compress', 'GZip',
  '--no-bytecode',
  '--public',
  '--public-packages', '*',
  '--output', sidecarOutput,
]);

assertArchitecture(sidecarOutput, target.elfMachine, 'canvas-display-server sidecar');
console.log(`[sidecar] Built ${sidecarOutput}`);
