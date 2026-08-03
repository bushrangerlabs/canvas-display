import { EventEmitter } from 'node:events';
import { format } from 'node:util';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_NUM: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = 'info';
let currentNum = 2;
const MAX_LINES = 2000;
const lines: string[] = [];
export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function appendLog(level: LogLevel, values: unknown[]): void {
  const rendered = typeof values[0] === 'string'
    ? format(values[0], ...values.slice(1))
    : values.map(formatValue).join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${rendered}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  logEmitter.emit('line', line);
}

export function getLogHistory(): string[] {
  return [...lines];
}

export function setLevel(level: LogLevel): void {
  currentLevel = level;
  currentNum = LEVEL_NUM[level];
}

export function getLevel(): LogLevel {
  return currentLevel;
}

const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;

export function installLogger(level: LogLevel): void {
  setLevel(level);
  console.log = (...args: unknown[]) => {
    if (currentNum >= 2) {
      _origLog(...args);
      appendLog('info', args);
    }
  };
  console.warn = (...args: unknown[]) => {
    if (currentNum >= 1) {
      _origWarn(...args);
      appendLog('warn', args);
    }
  };
  console.error = (...args: unknown[]) => {
    if (currentNum >= 0) {
      _origError(...args);
      appendLog('error', args);
    }
  };
}
