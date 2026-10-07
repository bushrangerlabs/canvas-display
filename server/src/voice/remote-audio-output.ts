import { spawn } from 'child_process';

/** Decode a cue/container to bounded mono PCM16; ffmpeg never opens a local sink. */
export function decodeRemoteAudio(input: string | Buffer, signal: AbortSignal, rate = 22050): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Audio decode cancelled')); return; }
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', typeof input === 'string' ? input : 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(rate), 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let error: Error | undefined;
    const cancel = () => { error = new Error('Audio decode cancelled'); proc.kill('SIGKILL'); };
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { error = new Error('Audio decode timeout'); proc.kill('SIGKILL'); }, 15000);
    proc.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { error = new Error('Audio decode limit exceeded'); proc.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    proc.stderr.resume();
    proc.stdin.on('error', () => undefined);
    proc.on('error', err => { error = err; });
    proc.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (error || code !== 0) reject(error ?? new Error(`ffmpeg decode exited ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.end(typeof input === 'string' ? undefined : input);
  });
}
