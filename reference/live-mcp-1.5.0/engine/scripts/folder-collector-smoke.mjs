import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectFolderFiles } from '../src/folder-collector.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbitfs-folder-smoke-'));
const folder = path.join(root, 'Bundle');
await fs.mkdir(path.join(folder, 'Nested', 'Deep'), { recursive: true });
await fs.mkdir(path.join(folder, '_Hidden'), { recursive: true });
await fs.writeFile(path.join(folder, 'direct.txt'), 'direct');
await fs.writeFile(path.join(folder, 'Nested', 'nested.txt'), 'nested');
await fs.writeFile(path.join(folder, 'Nested', 'Deep', 'deep.txt'), 'deep');
await fs.writeFile(path.join(folder, '_Hidden', 'hidden.txt'), 'hidden');

try {
  const shallow = await collectFolderFiles(root, folder, 20, false);
  const depthOne = await collectFolderFiles(root, folder, 20, true, 1);
  const deep = await collectFolderFiles(root, folder, 20, true);
  assert.deepEqual(shallow.map((item) => item.path), ['Bundle/direct.txt']);
  assert.deepEqual(depthOne.map((item) => item.path).sort(), ['Bundle/Nested/nested.txt', 'Bundle/direct.txt'].sort());
  assert.deepEqual(deep.map((item) => item.path).sort(), ['Bundle/Nested/Deep/deep.txt', 'Bundle/Nested/nested.txt', 'Bundle/direct.txt'].sort());
  console.log(JSON.stringify({ ok: true, checks: 3, shallow: shallow.length, depthOne: depthOne.length, recursive: deep.length }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
