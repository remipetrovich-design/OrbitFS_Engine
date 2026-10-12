import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
const builder=resolve(import.meta.dirname,'../tools/build-engine-release.mjs');
function fixture(){
 const cwd=mkdtempSync(join(tmpdir(),'orbitfs-engine-target-'));
 mkdirSync(join(cwd,'src/addons/mcp'),{recursive:true});
 writeFileSync(join(cwd,'src/addons/mcp/example.ts'),'export const value=true;');
 writeFileSync(join(cwd,'package.json'),JSON.stringify({name:'test-engine',version:'1.1.0'}));
 writeFileSync(join(cwd,'release-analysis.json'),JSON.stringify({detectedComponents:['base','mcp'],files:[],flags:{schemaChanged:false}}));
 return cwd;
}
test('Engine-only artifact accepts separately detected Base patch without including Base',()=>{
 const cwd=fixture();
 try{
  execFileSync(process.execPath,[builder,'--version','1.1.0','--components','mcp','--minimum-base-version','1.1.0','--minimum-updater-protocol','2','--commit','a'.repeat(40),'--release-analysis','release-analysis.json','--output','out.json.gz'],{cwd,stdio:'pipe'});
  const artifact=JSON.parse(gunzipSync(readFileSync(join(cwd,'out.json.gz'))));
  assert.deepEqual(artifact.components,['mcp']);
  assert.ok(artifact.changedComponents.includes('base'));
  assert.ok(!artifact.components.includes('base'));
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('Engine artifact permits an APEX-only release despite detected MCP changes',()=>{
 const cwd=fixture();
 try{
  execFileSync(process.execPath,[builder,'--version','1.1.0','--components','apex','--minimum-base-version','1.1.0','--release-analysis','release-analysis.json','--output','out.json.gz'],{cwd,stdio:'pipe'});
  const artifact=JSON.parse(gunzipSync(readFileSync(join(cwd,'out.json.gz'))));
  assert.deepEqual(artifact.components,['apex']);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
