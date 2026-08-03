import { readFile } from 'node:fs/promises';

const REQUIRED_CASES = [
  'inventory', 'speaker', 'microphone', 'wakeword', 'wake_cue',
  'good_cue', 'bad_cue', 'full_voice', 'silent_voice',
] as const;

type Report = {
  schema?: unknown;
  exportedAt?: unknown;
  device?: { id?: unknown; name?: unknown };
  results?: Array<{ id?: unknown; status?: unknown; finishedAt?: unknown; apiResult?: Record<string, unknown> }>;
};

export function validatePiAcceptanceReport(
  report: Report,
  options: { expectedDevice?: string; maxAgeHours?: number; now?: Date } = {},
): string[] {
  const errors: string[] = [];
  const now = options.now ?? new Date();
  const maxAgeMs = (options.maxAgeHours ?? 24) * 60 * 60 * 1000;
  if (report.schema !== 'canvas-pi-hardware-acceptance-v1') errors.push('unsupported report schema');
  if (typeof report.device?.id !== 'string' || report.device.id.length === 0) errors.push('device.id is required');
  if (options.expectedDevice && report.device?.id !== options.expectedDevice) errors.push('report belongs to a different device');
  const exportedAt = typeof report.exportedAt === 'string' ? new Date(report.exportedAt).getTime() : Number.NaN;
  if (!Number.isFinite(exportedAt)) errors.push('exportedAt is invalid');
  else if (exportedAt > now.getTime() + 5 * 60_000) errors.push('exportedAt is in the future');
  else if (now.getTime() - exportedAt > maxAgeMs) errors.push(`report is older than ${options.maxAgeHours ?? 24} hours`);

  if (!Array.isArray(report.results)) {
    errors.push('results must be an array');
    return errors;
  }
  const ids = report.results.map(result => result.id);
  if (new Set(ids).size !== ids.length) errors.push('results contain duplicate case IDs');
  for (const id of REQUIRED_CASES) {
    const result = report.results.find(candidate => candidate.id === id);
    if (!result) { errors.push(`missing required case: ${id}`); continue; }
    if (result.status !== 'passed') errors.push(`${id} is not passed`);
    const finishedAt = typeof result.finishedAt === 'string' ? new Date(result.finishedAt).getTime() : Number.NaN;
    if (!Number.isFinite(finishedAt)) errors.push(`${id} has no valid completion timestamp`);
    else if (finishedAt > now.getTime() + 5 * 60_000) errors.push(`${id} completion is in the future`);
  }
  const unexpected = ids.filter(id => typeof id !== 'string' || !REQUIRED_CASES.includes(id as typeof REQUIRED_CASES[number]));
  if (unexpected.length > 0) errors.push(`unexpected case IDs: ${unexpected.join(', ')}`);
  const wake = report.results.find(result => result.id === 'wakeword');
  if (wake?.apiResult?.detected !== true) errors.push('wakeword API evidence does not show detection');
  const inventory = report.results.find(result => result.id === 'inventory')?.apiResult;
  for (const field of ['microphones', 'speakers', 'wakeWords']) {
    if (typeof inventory?.[field] !== 'number' || Number(inventory[field]) < 1) errors.push(`inventory has no ${field}`);
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const path = args[0];
  if (!path || path === '--help') {
    console.log('Usage: npx tsx scripts/validate-pi-acceptance.ts REPORT.json [--device DEVICE_ID] [--max-age-hours HOURS]');
    process.exit(path ? 0 : 2);
  }
  const deviceIndex = args.indexOf('--device');
  const ageIndex = args.indexOf('--max-age-hours');
  const expectedDevice = deviceIndex >= 0 ? args[deviceIndex + 1] : undefined;
  const maxAgeHours = ageIndex >= 0 ? Number(args[ageIndex + 1]) : 24;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('--max-age-hours must be positive');
  const report = JSON.parse(await readFile(path, 'utf8')) as Report;
  const errors = validatePiAcceptanceReport(report, { expectedDevice, maxAgeHours });
  if (errors.length > 0) {
    for (const error of errors) console.error(`[pi-acceptance] ${error}`);
    process.exit(1);
  }
  console.log(`[pi-acceptance] valid complete report for ${report.device?.id}; ${REQUIRED_CASES.length} checks passed`);
}

if (process.argv[1]?.endsWith('validate-pi-acceptance.ts')) {
  void main().catch(error => {
    console.error(`[pi-acceptance] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
