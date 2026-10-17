import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
const root=resolve(import.meta.dirname,'..');
const build=(f)=>join(root,'tools',f);
const source='b'.repeat(40);
test('ENGINE HOST alone builds an actual Engine Host payload, not a Base patch or selected addon',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'orbitfs-host-only-'));
 try{
  mkdirSync(join(cwd,'src/routes'),{recursive:true});
  writeFileSync(join(cwd,'src/routes/+page.svelte'),'<h1>Shared Engine Host panel</h1>');
  writeFileSync(join(cwd,'package.json'),JSON.stringify({name:'test-shared-host',version:'1.2.0'}));
  writeFileSync(join(cwd,'release-analysis.json'),JSON.stringify({detectedComponents:['shared'],files:[],flags:{schemaChanged:false}}));
  execFileSync(process.execPath,[build('build-engine-release.mjs'),'--version','1.2.0','--components','engine-shared','--minimum-base-version','1.0.0','--minimum-updater-protocol','2','--commit',source,'--release-analysis','release-analysis.json','--output','engine.json.gz'],{cwd,stdio:'pipe'});
  const engine=JSON.parse(gunzipSync(readFileSync(join(cwd,'engine.json.gz'))));
  assert.deepEqual(engine.components,['engine-shared']);
  assert.ok(engine.files.some(f=>f.file==='src/routes/+page.svelte'&&f.component==='shared'));
  execFileSync(process.execPath,[build('build-update-bundle.mjs'),'--version','1.2.0','--components','engine-shared','--minimum-base-version','1.0.0','--minimum-updater-protocol','2','--commit',source,'--engine-artifact','engine.json.gz','--output','bundle.json.gz'],{cwd,stdio:'pipe'});
  const bundle=JSON.parse(gunzipSync(readFileSync(join(cwd,'bundle.json.gz'))));
  assert.deepEqual(bundle.components,['engine-shared']);
  assert.equal(bundle.payloads.panel,null);
  assert.deepEqual(bundle.payloads.engine.components,['engine-shared']);
  assert.equal(bundle.executor,'orbitfs-updater-v2');
  assert.equal(bundle.updateScope,'deployed-system-v2');
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
