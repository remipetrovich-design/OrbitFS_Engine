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
test('Base patch ignores .gitkeep markers while preserving valid SQL migrations',()=>{
  const {cwd}=fixture();
  try{
    writeFileSync(join(cwd,'supabase/migrations/base/.gitkeep'),'');
    mkdirSync(join(cwd,'supabase/migrations/base/placeholder'),{recursive:true});
    writeFileSync(join(cwd,'supabase/migrations/base/placeholder/.gitkeep'),'');
    const {patch,bundle}=build(cwd);
    assert.equal(patch.databaseMigrationCount,1);
    assert.deepEqual(patch.databaseMigrations.map(m=>m.id),['20261009000000']);
    assert.equal(bundle.databaseMigrationCount,1);
    assert.ok(patch.databaseMigrations.every(m=>m.file.endsWith('.sql')));
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('Base patch skips an empty migration folder placeholder without inventing migrations',()=>{
  const {cwd}=fixture();
  try{
    rmSync(join(cwd,'supabase/migrations/base/20261009000000_forward_update_test.sql'));
    writeFileSync(join(cwd,'supabase/migrations/base/.gitkeep'),'');
    const {patch,bundle}=build(cwd);
    assert.equal(patch.databaseMigrationCount,0);
    assert.deepEqual(patch.databaseMigrations,[]);
    assert.equal(bundle.databaseMigrationCount,0);
    assert.ok(patch.fileCount>0);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('Base migration validation still rejects malformed SQL filenames',()=>{
  const {cwd}=fixture();
  try{
    writeFileSync(join(cwd,'supabase/migrations/base/.gitkeep'),'');
    writeFileSync(join(cwd,'supabase/migrations/base/bad_migration.sql'),'select 1;');
    assert.throws(
      ()=>execFileSync(process.execPath,[builder('build-base-patch.mjs'),...args,'--output','patch.json.gz'],{cwd,stdio:'pipe'}),
      /Invalid immutable Base migration/
    );
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('Base patch build rejects missing approved Base baseline release information',()=>{
  const {cwd}=fixture();
  try {
    assert.throws(()=>execFileSync(process.execPath,[builder('build-base-patch.mjs'),...args.slice(0,-2),'--output','patch.json.gz'],{cwd,stdio:'pipe'}));
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('Base patch build rejects FALLBACK source provenance in MAIN mode',()=>{
  const {cwd}=fixture();
  try {
    const fallbackArgs=args.map((part,index)=>index>0&&args[index-1]==='--base-source-repo'?'remipetrovich-design/OrbitFS-Base-System':part);
    assert.throws(()=>execFileSync(process.execPath,[builder('build-base-patch.mjs'),...fallbackArgs,'--output','patch.json.gz'],{cwd,stdio:'pipe'}));
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('targeted Base credential and MCP startup patch is present in the immutable overlay',()=>{
  const overlay=(path)=>readFileSync(join(repo,'updates/base/overlay',path),'utf8');
  const account=overlay('src/routes/account/+page.svelte');
  assert.match(account,/Change password/);
  assert.match(account,/Current password/);
  assert.match(account,/Confirm password/);
  assert.match(account,/action: 'password.change'/);
  assert.doesNotMatch(account,/Change PIN|New PIN|savePin/);

  const me=overlay('src/routes/api/me/+server.ts');
  assert.match(me,/body\.pin !== undefined/);
  assert.doesNotMatch(me,/hashPassword\(pin\)/);

  const credential=overlay('src/routes/api/account/+server.ts');
  assert.match(credential,/verifyPassword\(currentPassword, row\.password_hash\)/);
  assert.match(credential,/CURRENT_PASSWORD_INCORRECT/);

  const legacy=overlay('src/routes/api/login/change-pin/+server.ts');
  assert.match(legacy,/PIN_CHANGE_RETIRED/);
  assert.match(legacy,/status: 410/);

  const panelRuntime=overlay('src/lib/server/engine-host.ts');
  assert.match(panelRuntime,/!current\.configured && !\(addonId === 'mcp' && action === 'running'\)/);
  const engineRuntime=readFileSync(join(repo,'src/lib/server/addon-engine.ts'),'utf8');
  assert.match(engineRuntime,/!current\.configured && !\(addonId==='mcp' && action==='running'\)/);
  assert.match(engineRuntime,/options\.requireSetup!==false && !state\.configured/);
});
