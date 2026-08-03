import fs from 'fs';
import path from 'path';

type BindingsOptions =
  | string
  | {
      bindings?: string;
      module_root?: string;
      path?: boolean;
    };

function resolveBindingPath(bindingName: string): string {
  const fileName = path.basename(bindingName);
  const cwd = process.cwd();
  const isPkg = typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== 'undefined';

  const candidates = [
    process.env.NATIVE_BINDING_DIR ? path.join(process.env.NATIVE_BINDING_DIR, fileName) : null,
    path.join(cwd, 'node_modules', 'better-sqlite3', 'build', 'Release', fileName),
    path.join(cwd, 'build', 'Release', fileName),
    isPkg ? path.join(path.dirname(process.execPath), fileName) : null,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(
      `Could not locate native binding "${fileName}". Searched:\n${candidates.join('\n')}`
    );
  }

  return resolved;
}

function bindings(options: BindingsOptions): unknown {
  const bindingName = typeof options === 'string'
    ? options
    : (options.bindings ?? 'better_sqlite3.node');

  const resolvedPath = resolveBindingPath(bindingName);
  if (typeof options === 'object' && options?.path) {
    return resolvedPath;
  }

  return require(resolvedPath);
}

(bindings as typeof bindings & { getRoot: (file: string) => string }).getRoot = (file: string) =>
  path.dirname(file);

export = bindings;