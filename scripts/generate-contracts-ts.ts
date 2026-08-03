import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

interface ContractTarget {
  schema: string;
  output: string;
  rootTypeName: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : null;
const contracts: ContractTarget[] = [
  {
    schema: 'contracts/device/v1/control-message.schema.json',
    output: 'packages/protocol-ts/src/generated/device-v1.ts',
    rootTypeName: 'DeviceV1ControlMessage',
  },
  {
    schema: 'contracts/scene/v1/scene-manifest.schema.json',
    output: 'packages/protocol-ts/src/generated/scene-v1.ts',
    rootTypeName: 'SceneManifestV1',
  },
];

if (!mode) {
  throw new Error('Usage: generate-contracts-ts.ts --write|--check');
}

async function generateContract(contract: ContractTarget): Promise<string> {
  const schemaPath = path.join(repositoryRoot, contract.schema);
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<string, unknown>;
  const generated = await compile(schema, contract.rootTypeName, {
    additionalProperties: true,
    bannerComment: [
      '/*',
      ' * GENERATED FILE — DO NOT EDIT.',
      ` * Source: ${contract.schema}`,
      ' * Regenerate with: npm run contracts:generate:ts',
      ' */',
    ].join('\n'),
    cwd: path.dirname(schemaPath),
    declareExternallyReferenced: true,
    enableConstEnums: false,
    format: true,
    strictIndexSignatures: true,
    style: {
      bracketSpacing: true,
      printWidth: 120,
      semi: true,
      singleQuote: true,
      tabWidth: 2,
      trailingComma: 'all',
      useTabs: false,
    },
    unreachableDefinitions: false,
  });
  return generated.replace(/\r\n/g, '\n');
}

for (const contract of contracts) {
  const outputPath = path.join(repositoryRoot, contract.output);
  const generated = await generateContract(contract);

  if (mode === 'write') {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, generated, 'utf8');
    console.log(`Generated ${contract.output}.`);
    continue;
  }

  let existing: string;
  try {
    existing = (await readFile(outputPath, 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    throw new Error(`${contract.output} is missing; run npm run contracts:generate:ts`);
  }

  if (existing !== generated) {
    throw new Error(`${contract.output} is stale; run npm run contracts:generate:ts`);
  }
}

if (mode === 'check') {
  console.log('Generated TypeScript contracts are current.');
}
