import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDocumentItems } from '../src/context-document-loader.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbitfs-policy-limits-'));
const txt=path.join(root,'large.txt');
const media=path.join(root,'large.mp3');
const image=path.join(root,'image.jpg');
await fs.writeFile(txt,Buffer.alloc(2048,65));
await fs.writeFile(media,Buffer.alloc(2048,1));
await fs.writeFile(image,Buffer.alloc(2048,2));
try {
  const doc=await loadDocumentItems([{absolute:txt,path:'large.txt'}],10000,{documentMaxBytes:1024,mediaMaxBytes:4096,mediaOutputMaxBytes:4096});
  assert.equal(doc.loaded.length,0); assert.equal(doc.errors.length,1);
  const aud=await loadDocumentItems([{absolute:media,path:'large.mp3'}],10000,{documentMaxBytes:4096,mediaMaxBytes:1024,mediaOutputMaxBytes:4096});
  assert.equal(aud.loaded.length,0); assert.equal(aud.errors.length,1);
  const img=await loadDocumentItems([{absolute:image,path:'image.jpg'}],10000,{documentMaxBytes:4096,mediaMaxBytes:4096,mediaOutputMaxBytes:1024});
  assert.equal(img.loaded.length,0); assert.equal(img.errors.length,1);
  console.log(JSON.stringify({ok:true,checks:3,coverage:['document-source-limit','media-source-limit','media-output-floor']}));
} finally { await fs.rm(root,{recursive:true,force:true}); }
