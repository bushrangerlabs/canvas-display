/**
 * Log ring buffer — captures all console output and re-emits it
 * to SSE subscribers via logEmitter.
 *
 * Import this module BEFORE anything that calls console.log/error so that
 * every log line (including voice, db, mqtt, etc.) is captured.
 */

import { EventEmitter } from 'events';

const MAX_LINES = 1000;
const _lines: string[] = [];

export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

function fmt(args: unknown[]): string {
  return args.map(a =>
    typeof a === 'string' ? a : (a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))
  ).join(' ');
}

function push(level: string, text: string) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = `${ts} ${level}${text}`;
  _lines.push(line);
  if (_lines.length > MAX_LINES) _lines.shift();
  logEmitter.emit('line', line);
}

// ── Intercept console methods ─────────────────────────────────────────────

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

console.log = (...args: unknown[]) => {
  _log(...args);
  push('', fmt(args));
};

console.warn = (...args: unknown[]) => {
  _warn(...args);
  push('[WRN] ', fmt(args));
};

console.error = (...args: unknown[]) => {
  _error(...args);
  push('[ERR] ', fmt(args));
};

/** Returns a snapshot of recent log lines (oldest first). */
export function getLogHistory(): string[] {
  return [..._lines];
}
