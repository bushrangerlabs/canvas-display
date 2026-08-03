import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnySchema } from 'ajv';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

interface FixtureEntry {
  path: string;
  valid: boolean;
  schema_valid?: boolean;
}

interface FixtureManifest {
  schema: string;
  fixtures: FixtureEntry[];
}

interface ContractDefinition {
  label: string;
  manifest: string;
  assertSemanticRules: (value: unknown, fixturePath: string) => void;
}

const MAX_SCENE_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_SCENE_TOTAL_BYTES = 1024 * 1024 * 1024;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const contracts: ContractDefinition[] = [
  {
    label: 'Canvas Routine v1',
    manifest: 'contracts/routine/v1/fixtures/manifest.json',
    assertSemanticRules: () => {},
  },
  {
    label: 'Device Protocol v1',
    manifest: 'contracts/device/v1/fixtures/manifest.json',
    assertSemanticRules: assertDeviceSemanticRules,
  },
  {
    label: 'Scene Manifest v1',
    manifest: 'contracts/scene/v1/fixtures/manifest.json',
    assertSemanticRules: assertSceneSemanticRules,
  },
];

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'no AJV errors were reported';
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
    .join('; ');
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertDeviceSemanticRules(value: unknown, fixturePath: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;

  if (message.type === 'edge.hello') {
    const protocol = message.protocol as { minimum?: number; maximum?: number } | undefined;
    if (protocol && protocol.minimum !== undefined && protocol.maximum !== undefined && protocol.minimum > protocol.maximum) {
      throw new Error(`${fixturePath}: protocol.minimum must not exceed protocol.maximum`);
    }
  }

  if (message.type === 'state.reported') {
    const payload = message.payload as Record<string, unknown> | undefined;
    const desired = Number(payload?.desired_revision);
    const processed = Number(payload?.processed_desired_revision);
    const applied = Number(payload?.applied_revision);
    if (applied > processed || processed > desired) {
      throw new Error(`${fixturePath}: expected applied_revision <= processed_desired_revision <= desired_revision`);
    }
  }

  if (message.type === 'command.issue') {
    const payload = message.payload as Record<string, unknown> | undefined;
    const createdAt = Date.parse(String(payload?.created_at));
    const notBefore = Date.parse(String(payload?.not_before));
    const expiresAt = Date.parse(String(message.expires_at));
    if (!(createdAt <= notBefore && notBefore < expiresAt)) {
      throw new Error(`${fixturePath}: expected created_at <= not_before < expires_at`);
    }
  }
}

function assertCanonicalLogicalPath(logicalPath: string, fixturePath: string): void {
  const segments = logicalPath.split('/');
  if (
    logicalPath.startsWith('/') ||
    logicalPath.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${fixturePath}: logical path must be relative and contain no empty, '.' or '..' segments: ${logicalPath}`);
  }
}

function assertSceneSemanticRules(value: unknown, fixturePath: string): void {
  const manifest = asObject(value, `${fixturePath}: manifest`);
  const document = asObject(manifest.document, `${fixturePath}: document`);
  const assets = manifest.assets as unknown[];

  if (document.logical_path !== 'scene.json') {
    throw new Error(`${fixturePath}: document.logical_path must be scene.json`);
  }
  if (document.media_type !== 'application/vnd.canvas.scene+json') {
    throw new Error(`${fixturePath}: document.media_type must be application/vnd.canvas.scene+json`);
  }

  const references = [document, ...assets.map((asset, index) => asObject(asset, `${fixturePath}: assets[${index}]`))];
  const logicalPaths = new Set<string>();
  const hashSizes = new Map<string, number>();
  let totalBytes = 0;

  for (const reference of references) {
    const logicalPath = String(reference.logical_path);
    const hash = String(reference.hash);
    const size = Number(reference.size);

    assertCanonicalLogicalPath(logicalPath, fixturePath);
    if (logicalPaths.has(logicalPath)) {
      throw new Error(`${fixturePath}: duplicate logical path: ${logicalPath}`);
    }
    logicalPaths.add(logicalPath);

    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SCENE_OBJECT_BYTES) {
      throw new Error(`${fixturePath}: object ${logicalPath} exceeds the ${MAX_SCENE_OBJECT_BYTES}-byte limit`);
    }

    const priorSize = hashSizes.get(hash);
    if (priorSize !== undefined && priorSize !== size) {
      throw new Error(`${fixturePath}: hash ${hash} has conflicting declared sizes`);
    }
    hashSizes.set(hash, size);

    totalBytes += size;
    if (totalBytes > MAX_SCENE_TOTAL_BYTES) {
      throw new Error(`${fixturePath}: scene exceeds the ${MAX_SCENE_TOTAL_BYTES}-byte aggregate limit`);
    }
  }

  const security = asObject(manifest.security, `${fixturePath}: security`);
  const allowedOrigins = security.allowed_origins as unknown[];
  for (const candidate of allowedOrigins) {
    const origin = String(candidate);
    const authority = origin.startsWith('https://')
      ? origin.slice('https://'.length)
      : origin.startsWith('http://')
        ? origin.slice('http://'.length)
        : null;
    if (!authority || /[/@?#]/.test(authority)) {
      throw new Error(
        `${fixturePath}: allowed origin must be HTTP(S) without credentials, a path, query, or fragment: ${origin}`,
      );
    }
  }
}

function captureSemanticError(
  assertion: ContractDefinition['assertSemanticRules'],
  value: unknown,
  fixturePath: string,
): Error | null {
  try {
    assertion(value, fixturePath);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function validateContract(contract: ContractDefinition): Promise<void> {
  const manifestPath = path.join(repositoryRoot, contract.manifest);
  const manifest = (await readJson(manifestPath)) as FixtureManifest;
  const schemaPath = path.join(repositoryRoot, manifest.schema);
  const schema = (await readJson(schemaPath)) as AnySchema;

  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: false,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  let validCount = 0;
  let invalidCount = 0;

  for (const fixture of manifest.fixtures) {
    const fixturePath = path.join(repositoryRoot, fixture.path);
    const value = await readJson(fixturePath);
    const schemaValid = validate(value);
    const expectedSchemaValid = fixture.schema_valid ?? fixture.valid;
    const schemaErrors = formatErrors(validate.errors);

    if (schemaValid !== expectedSchemaValid) {
      const expectation = expectedSchemaValid ? 'schema-valid' : 'schema-invalid';
      throw new Error(`${fixture.path}: expected ${expectation}; ${schemaErrors}`);
    }

    const semanticError = schemaValid
      ? captureSemanticError(contract.assertSemanticRules, value, fixture.path)
      : null;
    const contractValid = schemaValid && semanticError === null;

    if (contractValid !== fixture.valid) {
      const expectation = fixture.valid ? 'valid' : 'invalid';
      const detail = semanticError?.message ?? schemaErrors;
      throw new Error(`${fixture.path}: expected contract-${expectation}; ${detail}`);
    }

    if (fixture.valid) validCount += 1;
    else invalidCount += 1;
  }

  console.log(`Validated ${contract.label} with ${validCount} positive and ${invalidCount} negative fixtures.`);
}

async function main(): Promise<void> {
  for (const contract of contracts) {
    await validateContract(contract);
  }
}

await main();
