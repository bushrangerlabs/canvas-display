export function buildMpvArgs(input: {
  url: string;
  volume: number;
  socketPath: string;
  video: boolean;
  touchScriptPath?: string;
}): string[] {
  const args = [
    '--really-quiet',
    `--input-ipc-server=${input.socketPath}`,
    `--volume=${input.volume}`,
  ];
  if (input.video) {
    args.push('--force-window=yes', '--fullscreen', '--ontop', '--no-border', '--osc=yes');
    if (input.touchScriptPath) args.push(`--script=${input.touchScriptPath}`);
  } else {
    args.push('--no-video');
  }
  args.push(input.url);
  return args;
}

export function findMpvSinkInputIndexes(value: unknown, processId: number): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const input = item as { index?: unknown; properties?: Record<string, unknown> };
    const pid = Number(input.properties?.['application.process.id']);
    const name = String(input.properties?.['application.name'] ?? '').toLowerCase();
    const index = Number(input.index);
    return Number.isInteger(index) && (pid === processId || (!Number.isFinite(pid) && name === 'mpv')) ? [index] : [];
  });
}
