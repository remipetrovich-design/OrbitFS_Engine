import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { documentLimits, hashMcpContent } from '../src/document-loader.js';
import { loadDocumentItems } from '../src/context-document-loader.js';

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbitfs-media-budget-'));
const first = path.join(root, 'first.mp3');
const second = path.join(root, 'second.mp3');

async function makeAudio(target) {
  await execFileAsync(ffmpegPath, ['-y','-loglevel','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','1200','-b:a','64k',target]);
}

try {
  await makeAudio(first);
  await makeAudio(second);
  const result = await loadDocumentItems([
    { absolute: first, path: 'first.mp3', required: false },
    { absolute: second, path: 'second.mp3', required: false }
  ], 1000);
  const limit = documentLimits().mediaOutputMaxBytes;
  assert.ok(result.mediaBytesTransferred <= limit);
  assert.ok(result.loaded.length >= 1);
  assert.ok(result.errors.length >= 1 || result.loaded.some((item) => item.mediaTruncated));
  for (const item of result.loaded.filter((entry) => entry.mediaKind)) {
    assert.equal(item.transferredHash, hashMcpContent(item.mcpContent));
  }
  console.log(JSON.stringify({
    ok: true,
    limit,
    transferred: result.mediaBytesTransferred,
    loaded: result.loaded.length,
    errors: result.errors.length
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
