/**
 * pkg binary — native addon (.node) extraction shim
 *
 * @yao-pkg/pkg bundles assets into a virtual snapshot filesystem (/snapshot/...).
 * Native .node addons cannot be dlopen()'d from inside the snapshot — they must
 * live on the real filesystem.  This module:
 *   1. Detects when we are running inside a pkg binary  (process.pkg !== undefined)
 *   2. Reads better_sqlite3.node out of the snapshot via the patched fs module
 *   3. Writes it to a real temp directory once
 *   4. Patches Module._resolveFilename so any require('...better_sqlite3.node')
 *      transparently resolves to the extracted real path
 *
 * MUST be imported before anything that imports better-sqlite3.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';

// process.pkg is injected by the pkg runtime
const isPkg = typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== 'undefined';

if (isPkg) {
  // Locate better_sqlite3.node on the real filesystem.
  // Tauri passes NATIVE_BINDING_DIR (resource_dir) when spawning the sidecar;
  // for standalone smoke-testing, fall back to the directory containing the binary.
  const searchDirs = [
    process.env.NATIVE_BINDING_DIR,
    path.dirname(process.execPath),
  ].filter((d): d is string => typeof d === 'string' && d.length > 0);

  const EXTRACTED_PATH = searchDirs
    .map((d) => path.join(d, 'better_sqlite3.node'))
    .find((p) => fs.existsSync(p)) ?? path.join(searchDirs[0] ?? os.tmpdir(), 'better_sqlite3.node');

  // (EXTRACTED_PATH now always points to a real-FS path, no extraction needed)
  try {

    // Patch Module._resolveFilename so require('…better_sqlite3.node')
    // returns the real extracted path instead of the snapshot path.
    const m = Module as unknown as {
      _resolveFilename: (
        request: string,
        parent: unknown,
        isMain: boolean,
        options?: unknown
      ) => string;
    };
    const original = m._resolveFilename;
    m._resolveFilename = function (request, parent, isMain, options) {
      if (request.endsWith('better_sqlite3.node')) {
        return EXTRACTED_PATH;
      }
      return original.call(this, request, parent, isMain, options);
    };

    console.log('[pkg-patch] better_sqlite3.node resolved to', EXTRACTED_PATH);
  } catch (err) {
    console.error('[pkg-patch] Failed to extract native binding:', err);
  }
}
