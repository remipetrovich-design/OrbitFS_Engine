import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {isOrbitReleaseVersion} from './release-version.mjs';

const ROOT=resolve(process.cwd());
const args=process.argv.slice(2);
const arg=(name,fallback='')=>{const i=args.indexOf('--'+name);return i>=0?String(args[i+1]||fallback):fallback;};
const version=arg('version').trim();
const components=[...new Set(arg('components').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean))];
const sourceCommit=arg('commit',process.env.GITHUB_SHA||'').trim()||null;
const minimumBaseVersion=arg('minimum-base-version').trim();
const baseCompatibilityChannel=arg('base-channel','stable').trim().toLowerCase();
const minimumUpdaterProtocol=Number(arg('minimum-updater-protocol',arg('minimum-deployer-protocol','2')));
const engineArtifact=resolve(ROOT,arg('engine-artifact','engine-release.json.gz'));
const basePatchArtifact=resolve(ROOT,arg('base-patch-artifact','base-patch.json.gz'));
const output=resolve(ROOT,arg('output','update-release.json.gz'));
const releaseNotesFile=resolve(ROOT,arg('release-notes','release-notes.md'));
const releaseAnalysisFile=resolve(ROOT,arg('release-analysis','release-analysis.json'));
const allowed=new Set(['base','apex','mcp','studio']);
const engineTargets=components.filter(c=>c!=='base');
const baseTarget=components.includes('base');
const safePath=/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)(?:\.git|\.vercel|node_modules)(?:\/|$))[A-Za-z0-9._@+\-\/\[\]()=]+$/;

if(!isOrbitReleaseVersion(version))throw new Error('Invalid OrbitFS update release version');
if(!components.length)throw new Error('Select at least one update target');
for(const c of components)if(!allowed.has(c))throw new Error('Unknown update target: '+c);
if(!isOrbitReleaseVersion(minimumBaseVersion))throw new Error('Invalid minimum Base version');
if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(baseCompatibilityChannel))throw new Error('Invalid Base compatibility channel');
if(!Number.isInteger(minimumUpdaterProtocol)||minimumUpdaterProtocol<1||minimumUpdaterProtocol>100)throw new Error('Invalid minimum Updater protocol');

function readGzipJson(path,label){
  if(!existsSync(path))throw new Error(label+' artifact not found: '+path);
  try{return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));}catch(error){throw new Error(label+' artifact is not valid gzip JSON: '+(error instanceof Error?error.message:String(error)));}
}
function validateFiles(files,label,{allowEmpty=false}={}){
  if(!Array.isArray(files)||(!allowEmpty&&!files.length))throw new Error(label+' has no files');
  const seen=new Set();
  for(const f of files||[]){
    const path=String(f?.file||'').replaceAll('\\','/');
    if(!safePath.test(path)||seen.has(path))throw new Error(label+' contains unsafe/duplicate path: '+path);
    seen.add(path);
    if(f.encoding!=='base64'||typeof f.data!=='string')throw new Error(label+' file is not base64 encoded: '+path);
    const data=Buffer.from(f.data,'base64');
    const sha=createHash('sha256').update(data).digest('hex');
    if(Number(f.size)!==data.length||String(f.sha256||'').toLowerCase()!==sha)throw new Error(label+' file integrity failed: '+path);
  }
}

let engineRaw=null;
let engine=null;
if(engineTargets.length){
  engineRaw=readGzipJson(engineArtifact,'Engine');
  if(!['orbitfs-engine-release-v2','orbitfs-engine-release-v3'].includes(String(engineRaw.format||''))||![2,3].includes(Number(engineRaw.schemaVersion)))throw new Error('Engine artifact must be a supported OrbitFS Engine release');
  if(String(engineRaw.version)!==version||String(engineRaw.sourceCommit||'')!==String(sourceCommit||''))throw new Error('Engine artifact identity mismatch');
  if(String(engineRaw.minimumBaseVersion)!==minimumBaseVersion)throw new Error('Engine minimum Base version mismatch');
  if(Number(engineRaw.minimumUpdaterProtocol??engineRaw.minimumEngineDeployerProtocol)!==minimumUpdaterProtocol)throw new Error('Updater protocol mismatch');
  validateFiles(engineRaw.files,'Engine source payload');
  const rawExecutionPolicy=engineRaw?.executionPolicy&&typeof engineRaw.executionPolicy==='object'?engineRaw.executionPolicy:{};
  if(rawExecutionPolicy.mode!=='per-installation-entitlement-intersection-v1'||rawExecutionPolicy.fileClassification!=='component'||rawExecutionPolicy.sharedFiles!=='always-required'||rawExecutionPolicy.componentFiles!=='apply-only-when-authorized')throw new Error('Engine artifact component execution policy is invalid');
  const rawCounts=engineRaw?.componentFileCounts&&typeof engineRaw.componentFileCounts==='object'?engineRaw.componentFileCounts:{};
  for(const key of ['shared','apex','mcp','studio']){
    const expected=engineRaw.files.filter(file=>String(file?.component||'shared').toLowerCase()===key).length;
    if(Number(rawCounts[key]||0)!==expected)throw new Error('Engine artifact component file count mismatch for '+key);
  }
  engine={
    ...engineRaw,
    components:engineTargets,
    componentVersions:Object.fromEntries(engineTargets.map(c=>[c,String(engineRaw?.componentVersions?.[c]||version)])),
    releaseId:'update-'+version+'-engine'
  };
}
let panel=null;
if(baseTarget){
  const patch=readGzipJson(basePatchArtifact,'Base patch');
  if(patch.format!=='orbitfs-base-update-patch-v1'||Number(patch.schemaVersion)!==1)throw new Error('Base patch artifact format is invalid');
  if(String(patch.version||'')!==version||String(patch.sourceCommit||'')!==String(sourceCommit||''))throw new Error('Base patch identity mismatch');
  validateFiles(patch.files||[],'Base patch',{allowEmpty:true});
  const deletePaths=Array.isArray(patch.deletePaths)?patch.deletePaths.map(v=>String(v||'').replaceAll('\\','/')):[];
  if(!patch.files?.length&&!deletePaths.length)throw new Error('Base patch is empty');
  for(const file of deletePaths)if(!safePath.test(file))throw new Error('Unsafe Base delete path: '+file);
  if(new Set(deletePaths).size!==deletePaths.length)throw new Error('Duplicate Base delete path');
  panel={...patch,component:'base',fileCount:Array.isArray(patch.files)?patch.files.length:0,deletePaths};
}

const releaseNotes=existsSync(releaseNotesFile)?readFileSync(releaseNotesFile,'utf8'):'';
const releaseAnalysis=existsSync(releaseAnalysisFile)?JSON.parse(readFileSync(releaseAnalysisFile,'utf8')):{};
const database=engineRaw?.database&&typeof engineRaw.database==='object'?engineRaw.database:{format:'orbitfs-db-migrations-v1',mode:'shared-panel',provider:'supabase',migrationCount:0,migrations:[]};
const migrations=Array.isArray(database.migrations)?database.migrations:[];
const changedMigrationCount=Number(engineRaw?.databaseChangedMigrationCount||0);
if(database.format!=='orbitfs-db-migrations-v1'||database.mode!=='shared-panel'||database.provider!=='supabase')throw new Error('Update database migration contract is invalid');
if(Number(database.migrationCount||0)!==migrations.length||Number(engineRaw.databaseMigrationCount||0)!==migrations.length)throw new Error('Update database migration count does not match its migration list');
if(!Number.isInteger(changedMigrationCount)||changedMigrationCount<0||changedMigrationCount>migrations.length)throw new Error('Changed database migration count is invalid');
if(releaseAnalysis?.flags?.schemaChanged===true&&changedMigrationCount<1)throw new Error('Database/schema changes were detected, but the artifact contains no new immutable customer database migration.');
const migrationIds=new Set();
for(const migration of migrations){
  const id=String(migration?.id||''),file=String(migration?.file||'').replaceAll('\\','/');
  const match=file.match(/^supabase\/migrations\/(shared|base|apex|mcp|studio)\/\d{14}_[A-Za-z0-9._-]+\.sql$/);
  if(!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(id)||migrationIds.has(id))throw new Error('Database migration ids must be unique and valid');
  migrationIds.add(id);
  if(!match)throw new Error('Invalid customer database migration path: '+file);
  const component=String(migration.component||'').toLowerCase();
  if(component!==match[1])throw new Error('Customer database migration component/path mismatch: '+file);
  if(component==='shared'){
    if(!components.length)throw new Error('Shared customer database migration requires an update target: '+file);
  }else if(!components.includes(component)){
    throw new Error('Customer database migration targets an unselected component: '+file);
  }
  if(migration.encoding!=='base64'||typeof migration.data!=='string')throw new Error('Invalid customer database migration encoding: '+file);
  const bytes=Buffer.from(migration.data,'base64');
  const sha=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==Number(migration.size)||sha!==String(migration.sha256||'').toLowerCase())throw new Error('Customer database migration integrity failed: '+file);
  const sql=bytes.toString('utf8');
  if(/\b(?:begin|commit|rollback)\s*;/i.test(sql))throw new Error('Customer database migration contains explicit transaction control: '+file);
  if(/\b(?:drop\s+table|drop\s+schema|truncate\s+(?:table\s+)?|alter\s+table[\s\S]{0,300}?drop\s+column)\b/i.test(sql))throw new Error('Customer database migration contains a destructive operation: '+file);
}
if(engine&&JSON.stringify(engine.database||null)!==JSON.stringify(database))throw new Error('Update Bundle database contract does not match its Engine payload');

const fileCount=(engine?.files?.length||0)+(panel?.files?.length||0);
const componentVersions=Object.fromEntries(components.map(c=>[c,c==='base'?version:String(engineRaw?.componentVersions?.[c]||version)]));
const componentFileCounts={...(engineRaw?.componentFileCounts&&typeof engineRaw.componentFileCounts==='object'?engineRaw.componentFileCounts:{}),base:panel?.files?.length||0};
const executionPolicy=engineRaw?.executionPolicy&&typeof engineRaw.executionPolicy==='object'?engineRaw.executionPolicy:{
  mode:'per-installation-entitlement-intersection-v1',
  artifact:'complete-engine-snapshot',
  fileClassification:'component',
  sharedFiles:'always-required',
  componentFiles:'apply-only-when-authorized'
};
const payload={
  schemaVersion:3,
  format:'orbitfs-update-bundle-v3',
  version,
  updateVersion:version,
  components,
  componentVersions,
  changedFiles:Array.isArray(engineRaw.changedFiles)?engineRaw.changedFiles:[],
  changedFileCount:Number(engineRaw.changedFileCount||0),
  componentFileCounts,
  executionPolicy,
  updateScope:'deployed-system-v2',
  executor:'orbitfs-updater-v2',
  checkpointRequired:true,
  minimumUpdaterProtocol,
  minimumBaseVersion,
  baseCompatibilityChannel,
  releaseId:'update-'+version,
  sourceCommit,
  createdAt:new Date().toISOString(),
  releaseNotes,
  releaseAnalysis,
  database,
  databaseMigrationCount:migrations.length,
  databaseChangedMigrationCount:changedMigrationCount,
  fileCount,
  projectSettings:engine?.projectSettings||{},
  payloads:{engine,panel}
};
const archive=gzipSync(Buffer.from(JSON.stringify(payload)),{level:9});
writeFileSync(output,archive);
console.log(JSON.stringify({ok:true,format:payload.format,version,components,componentVersions,minimumBaseVersion,baseCompatibilityChannel,minimumUpdaterProtocol,databaseMigrationCount:migrations.length,databaseChangedMigrationCount:changedMigrationCount,engineFiles:engine?.files?.length||0,basePatchFiles:panel?.files?.length||0,baseDeletes:panel?.deletePaths?.length||0,fileCount,archiveBytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')},null,2));
