import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {isOrbitReleaseVersion} from './release-version.mjs';

const ROOT=resolve(process.cwd());
const args=process.argv.slice(2);
const arg=(name,fallback='')=>{const i=args.indexOf('--'+name);return i>=0?String(args[i+1]||fallback):fallback;};
const version=arg('version').trim();
const sourceCommit=arg('commit',process.env.GITHUB_SHA||'').trim()||null;
const output=resolve(ROOT,arg('output','base-patch.json.gz'));
const baseSource={
  repository:arg('base-source-repo').trim(),
  ref:arg('base-source-ref').trim(),
  commit:arg('base-source-sha').trim().toLowerCase(),
  baselineReleaseId:arg('base-baseline-release-id').trim(),
  baselineVersion:arg('base-baseline-version').trim(),
  baselineSourceCommit:arg('base-previous-source-commit').trim().toLowerCase()
};
if(baseSource.repository!=='lucaskerim123/V1-vercel-base')throw new Error('Base patch source must identify the MAIN Base repository');
if(!/^[a-zA-Z0-9._/-]+$/.test(baseSource.ref)||baseSource.ref.includes('..'))throw new Error('Base patch source ref is invalid');
if(!/^[a-f0-9]{40}$/.test(baseSource.commit)||!/^[a-f0-9]{40}$/.test(baseSource.baselineSourceCommit)||baseSource.commit===baseSource.baselineSourceCommit)throw new Error('Base patch source commits must identify a valid changed source and approved baseline');
if(!baseSource.baselineReleaseId||!isOrbitReleaseVersion(baseSource.baselineVersion))throw new Error('Base patch requires the approved published Base release identity and version');
const overlayRoot=resolve(ROOT,'updates/base/overlay');
const deleteFile=resolve(ROOT,'updates/base/delete.txt');
const baseMigrationsRoot=resolve(ROOT,'supabase/migrations/base');
const baseMigrationName=/^(\d{14})_[A-Za-z0-9._-]+\.sql$/;
const safePath=/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)(?:\.git|\.vercel|node_modules)(?:\/|$))(?!\.env(?:$|\.))[A-Za-z0-9._@+\-\/\[\]()=]+$/;

function walk(path,out=[]){
  if(!existsSync(path))return out;
  for(const name of readdirSync(path)){
    const full=join(path,name),stats=statSync(full);
    if(stats.isDirectory())walk(full,out);
    else if(stats.isFile())out.push(full);
  }
  return out;
}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}

const files=walk(overlayRoot).sort().map(full=>{
  const file=relative(overlayRoot,full).replaceAll('\\','/');
  if(!safePath.test(file))throw new Error('Unsafe Base patch path: '+file);
  const bytes=readFileSync(full);
  return {file,encoding:'base64',data:bytes.toString('base64'),size:bytes.length,sha256:sha256(bytes),component:'base'};
});
const deletePaths=existsSync(deleteFile)?readFileSync(deleteFile,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')):[];
for(const file of deletePaths)if(!safePath.test(file))throw new Error('Unsafe Base delete path: '+file);
if(new Set(deletePaths).size!==deletePaths.length)throw new Error('Duplicate Base delete path');
const databaseMigrations=walk(baseMigrationsRoot).sort().map(full=>{
  const filename=relative(baseMigrationsRoot,full).replaceAll('\\','/');
  const match=filename.match(baseMigrationName);
  if(!match)throw new Error('Invalid immutable Base migration: '+filename);
  const bytes=readFileSync(full);
  const sql=bytes.toString('utf8');
  if(/\b(?:begin|commit|rollback)\s*;/i.test(sql)||/\b(?:drop\s+table|drop\s+schema|truncate\s+(?:table\s+)?|alter\s+table[\s\S]{0,300}?drop\s+column)\b/i.test(sql))throw new Error('Unsafe Base forward migration: '+filename);
  return {id:match[1],file:'supabase/migrations/'+filename,component:'base',encoding:'base64',data:bytes.toString('base64'),size:bytes.length,sha256:sha256(bytes)};
});
if(new Set(databaseMigrations.map(m=>m.id)).size!==databaseMigrations.length)throw new Error('Duplicate Base migration IDs');
if(!files.length&&!deletePaths.length&&!databaseMigrations.length)throw new Error('Base target selected but the patch is empty');

const payload={
  format:'orbitfs-base-update-patch-v1',
  schemaVersion:1,
  version,
  sourceCommit,
  baseSource,
  fileCount:files.length,
  deleteCount:deletePaths.length,
  databaseMigrationCount:databaseMigrations.length,
  databaseMigrations,
  files,
  deletePaths
};
const archive=gzipSync(Buffer.from(JSON.stringify(payload)),{level:9});
writeFileSync(output,archive);
console.log(JSON.stringify({ok:true,version,sourceCommit,fileCount:files.length,deleteCount:deletePaths.length,databaseMigrationCount:databaseMigrations.length,sha256:sha256(archive),output},null,2));
