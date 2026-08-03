import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOCK_PATH = process.env.CANVAS_VOICE_OWNER_LOCK
  ?? join(process.env.XDG_RUNTIME_DIR || '/run/user/1000', 'canvas-display-voice-owner.json');
let owned = false;
let mode = '';

export interface VoiceOwnerStatus {
  owned: boolean;
  mode?: string;
  pid?: number;
  lockPath: string;
  error?: string;
}

function readOwner(): VoiceOwnerStatus {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { pid?: number; mode?: string };
    return { owned: true, pid: parsed.pid, mode: parsed.mode, lockPath: LOCK_PATH };
  } catch (error) {
    return { owned: false, lockPath: LOCK_PATH, error: (error as Error).message };
  }
}

function pidAlive(pid?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function claimVoiceOwnership(requestedMode: string): VoiceOwnerStatus {
  if (owned) return { owned: true, pid: process.pid, mode, lockPath: LOCK_PATH };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, mode: requestedMode, claimedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      owned = true;
      mode = requestedMode;
      return { owned: true, pid: process.pid, mode, lockPath: LOCK_PATH };
    } catch (error) {
      const current = readOwner();
      if (attempt === 0 && existsSync(LOCK_PATH) && !pidAlive(current.pid)) {
        try { unlinkSync(LOCK_PATH); continue; } catch { /* report below */ }
      }
      return { ...current, error: current.owned
        ? `microphone already owned by pid ${current.pid ?? 'unknown'} (${current.mode ?? 'unknown'})`
        : (error as Error).message };
    }
  }
  return { owned: false, lockPath: LOCK_PATH, error: 'unable to claim microphone ownership' };
}

export function releaseVoiceOwnership(): void {
  if (!owned) return;
  const current = readOwner();
  if (current.pid === process.pid) {
    try { unlinkSync(LOCK_PATH); } catch { /* already removed */ }
  }
  owned = false;
  mode = '';
}

export function getVoiceOwnerStatus(): VoiceOwnerStatus {
  const current = readOwner();
  if (current.owned && !pidAlive(current.pid)) return { ...current, owned: false, error: 'stale owner lock' };
  return current;
}
