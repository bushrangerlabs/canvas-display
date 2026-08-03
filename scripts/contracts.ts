import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(repositoryRoot, 'contracts/device/v1/control-message.schema.json');

let validatorPromise: Promise<ValidateFunction> | undefined;

export function repositoryPath(...segments: string[]): string {
  return path.join(repositoryRoot, ...segments);
}

export async function readJsonFixture<T = unknown>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(repositoryPath(...segments), 'utf8')) as T;
}

export function getDeviceV1Validator(): Promise<ValidateFunction> {
  validatorPromise ??= (async () => {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
    addFormats(ajv);
    return ajv.compile(schema);
  })();
  return validatorPromise;
}
