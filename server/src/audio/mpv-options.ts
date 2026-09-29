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
