import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const repo=resolve(import.meta.dirname,'..');
const builder=(name)=>join(repo,'tools',name);
const sha=(text)=>createHash('sha256').update(text).digest('hex');
const oldSource='a'.repeat(40),newSource='b'.repeat(40),engineSource='c'.repeat(40);
const fixture=()=>{
  const cwd=mkdtempSync(join(tmpdir(),'orbitfs-base-update-'));
  mkdirSync(join(cwd,'updates/base/overlay/src/routes/admin/addons'),{recursive:true});
  mkdirSync(join(cwd,'supabase/migrations/base'),{recursive:true});
  writeFileSync(join(cwd,'updates/base/overlay/src/routes/admin/addons/+page.svelte'),'<p>Test Base update</p>');
  const sql='create table if not exists public.base_update_test (id bigint primary key);\n';
  writeFileSync(join(cwd,'supabase/migrations/base/20261009000000_forward_update_test.sql'),sql);
  return {cwd,sql};
};
const args=[
  '--version','1.1.0','--commit',engineSource,
  '--base-source-repo','lucaskerim123/V1-vercel-base',
  '--base-source-ref','base-release','--base-source-sha',newSource,
  '--base-previous-source-commit',oldSource,
  '--base-baseline-release-id','published-base-1',
  '--base-baseline-version','1.0.0'
];
function build(cwd){
  execFileSync(process.execPath,[builder('build-base-patch.mjs'),...args,'--output','patch.json.gz'],{cwd});
  execFileSync(process.execPath,[
    builder('build-update-bundle.mjs'),'--version','1.1.0',
    '--components','base','--commit',engineSource,'--minimum-base-version','1.0.0',
    '--base-patch-artifact','patch.json.gz','--output','bundle.json.gz'
  ],{cwd});
  return {
    patch:JSON.parse(gunzipSync(readFileSync(join(cwd,'patch.json.gz')))),
    bundle:JSON.parse(gunzipSync(readFileSync(join(cwd,'bundle.json.gz'))))
  };
}
test('Base-only patch includes exact Base source and published baseline, with forward migrations bridged to update contract',()=>{
  const {cwd,sql}=fixture();
  try {
    const {patch,bundle}=build(cwd);
    assert.deepEqual(patch.baseSource,{
      repository:'lucaskerim123/V1-vercel-base',ref:'base-release',commit:newSource,
      baselineReleaseId:'published-base-1',baselineVersion:'1.0.0',baselineSourceCommit:oldSource
    });
    assert.equal(bundle.updateScope,'deployed-system-v2');
    assert.equal(bundle.executor,'orbitfs-updater-v2');
    assert.deepEqual(bundle.components,['base']);
    assert.equal(bundle.payloads.engine,null);
    assert.equal(bundle.payloads.panel.fileCount,1);
    assert.equal(bundle.payloads.panel.databaseMigrationCount,1);
    assert.equal(bundle.databaseMigrationCount,1);
    const m=bundle.database.migrations[0];
    assert.equal(m.id,'20261009000000');
    assert.equal(m.file,'supabase/migrations/20261009000000_forward_update_test.sql');
    assert.equal(m.component,'base');
    assert.equal(m.sha256,sha(sql));
    assert.deepEqual(bundle.payloads.panel.databaseMigrations,[m]);
    assert.equal(bundle.fileCount,1);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('Base patch build rejects missing approved Base baseline release information',()=>{
  const {cwd}=fixture();
  try {
    assert.throws(()=>execFileSync(process.execPath,[builder('build-base-patch.mjs'),...args.slice(0,-2),'--output','patch.json.gz'],{cwd,stdio:'pipe'}));
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
