import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const workflow=readFileSync(new URL('../.github/workflows/publish-engine-release.yml',import.meta.url),'utf8');
const section=workflow.slice(workflow.indexOf('      - name: Resolve Master Database packages'),workflow.indexOf('      - name: Validate Master Database migration material'));
const inlineStart=section.indexOf('          const fs=require("fs"),path=require("path"),crypto=require("crypto");');
const inlineEnd=section.indexOf('\n          NODE',inlineStart);
assert.ok(inlineStart>=0&&inlineEnd>inlineStart,'Database package validation program is present');
const materialize=section.slice(inlineStart,inlineEnd).split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');

test('database payload uses file transport, never a large environment variable or shell argv',()=>{
 assert.match(section,/--output "\$response_file"/);
 assert.match(section,/--output "\$list_file"/);
 assert.match(section,/PACKAGE_RESPONSE_FILE="\$response_file"/);
 assert.match(section,/fs\.readFileSync\(process\.env\.PACKAGE_RESPONSE_FILE,"utf8"\)/);
 assert.match(section,/trap 'rm -rf "\$package_dir"' EXIT/);
 assert.doesNotMatch(section,/PACKAGE_RESPONSE="\$response"/);
 assert.doesNotMatch(section,/<<<"\$response"/);
});

test('materializes a database response larger than OS argv limits without expanding environment variables',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orbitfs-db-transport-test-'));
 try{
  const sourceCommit='a'.repeat(40);
  const payload={package:{payload:{format:'orbitfs-customer-database-package-v1',sourceRepo:'lucaskerim123/Master-Database-System',sourceCommit,component:'base',migrationCount:0,migrations:[],padding:'x'.repeat(300*1024)}}};
  const response=join(dir,'response.json');
  writeFileSync(response,JSON.stringify(payload));
  const env={...process.env,PACKAGE_RESPONSE_FILE:response,SELECTED_COMPONENTS:'base',PINNED_SOURCE_COMMIT:sourceCommit};
  const executed=spawnSync(process.execPath,['-e',materialize],{cwd:dir,env,encoding:'utf8',timeout:10000});
  assert.equal(executed.status,0,executed.stderr||executed.error?.message);
  assert.equal(executed.error,undefined);
  const refused=spawnSync(process.execPath,['-e',materialize],{cwd:dir,env:{...env,PINNED_SOURCE_COMMIT:'b'.repeat(40)},encoding:'utf8',timeout:10000});
  assert.notEqual(refused.status,0,'Source pinning must still reject tampered packages');
  assert.match(refused.stderr,/different from the Dev Panel/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});


const pinnedCommit='a'.repeat(40);
function migration(file,component,id='20260923072442'){
 const data=Buffer.from('create table if not exists public.orbitfs_package_transport_check (id bigint primary key);');
 return {id,file,component,encoding:'base64',data:data.toString('base64'),size:data.length,sha256:createHash('sha256').update(data).digest('hex')};
}
function runPayload(dir,component,migrations,extra={}){
 const response=join(dir,'package-response.json');
 writeFileSync(response,JSON.stringify({package:{payload:{format:'orbitfs-customer-database-package-v1',sourceRepo:'lucaskerim123/Master-Database-System',sourceCommit:pinnedCommit,component,migrationCount:migrations.length,migrations,...extra}}}));
 return spawnSync(process.execPath,['-e',materialize],{cwd:dir,env:{...process.env,PACKAGE_RESPONSE_FILE:response,SELECTED_COMPONENTS:component,PINNED_SOURCE_COMMIT:pinnedCommit},encoding:'utf8',timeout:10000});
}
test('flat Base migrations are verified but not copied into the Engine build',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orbitfs-base-package-layout-'));
 try{
  const file='supabase/migrations/20260923072442_orbitfs_base_core_schema.sql';
  const run=runPayload(dir,'base',[migration(file,'base')]);
  assert.equal(run.status,0,run.stderr||run.error?.message);
  assert.equal(existsSync(join(dir,file)),false,'Immutable Base migrations must remain License Manager-owned, not bundled into Engine files');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('scoped shared Engine migrations are verified and materialized with original bytes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orbitfs-shared-package-layout-'));
 try{
  const file='supabase/migrations/shared/20260923072442_shared_engine.sql';
  const m=migration(file,'shared','shared.20260923072442_shared_engine');
  const run=runPayload(dir,'engine-shared',[m]);
  assert.equal(run.status,0,run.stderr||run.error?.message);
  assert.deepEqual(readFileSync(join(dir,file)),Buffer.from(m.data,'base64'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('invalid Base migration scopes and modified checksums fail closed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orbitfs-base-scope-rejection-'));
 try{
  const file='supabase/migrations/20260923072442_orbitfs_base_core_schema.sql';
  const invalidScope=migration('supabase/migrations/base/20260923072442_orbitfs_base_core_schema.sql','base');
  const wrongScope=runPayload(dir,'base',[invalidScope]);
  assert.notEqual(wrongScope.status,0);
  assert.match(wrongScope.stderr,/Invalid central migration scope/);
  const tampered={...migration(file,'base'),sha256:'0'.repeat(64)};
  const wrongChecksum=runPayload(dir,'base',[tampered]);
  assert.notEqual(wrongChecksum.status,0);
  assert.match(wrongChecksum.stderr,/Central migration integrity failed/);
  const spoofed=migration(file,'shared');
  const wrongComponent=runPayload(dir,'base',[spoofed]);
  assert.notEqual(wrongComponent.status,0);
  assert.match(wrongComponent.stderr,/Invalid central migration scope/);
  assert.equal(existsSync(join(dir,file)),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
