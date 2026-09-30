import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDocumentItems } from '../src/context-document-loader.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbitfs-required-smoke-'));
const good = path.join(root, 'good.txt');
const bad = path.join(root, 'bad.xyz');
await fs.writeFile(good, 'hello');
await fs.writeFile(bad, 'unsupported');

try {
  const valid = await loadDocumentItems([{ absolute: good, path: 'good.txt' }], 1000);
  assert.equal(valid.loaded.length, 1);

  const optional = await loadDocumentItems([{ absolute: bad, path: 'bad.xyz', required: false }], 1000);
  assert.equal(optional.loaded.length, 0);
  assert.equal(optional.errors.length, 1);

  await assert.rejects(
    () => loadDocumentItems([{ absolute: bad, path: 'bad.xyz', required: true }], 1000),
    (error) => error?.code === 'BUNDLE_REQUIRED_ENTRY_FAILED'
  );
  console.log(JSON.stringify({ ok: true, checks: 3, coverage: ['valid-load', 'optional-failure', 'required-failure'] }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
