import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

const ROOT=resolve(process.cwd());
const args=process.argv.slice(2);
const arg=(name,fallback='')=>{const i=args.indexOf('--'+name);return i>=0?String(args[i+1]||fallback):fallback;};
const version=arg('version').trim();
const sourceCommit=arg('commit',process.env.GITHUB_SHA||'').trim()||null;
const output=resolve(ROOT,arg('output','base-patch.json.gz'));
const overlayRoot=resolve(ROOT,'updates/base/overlay');
const deleteFile=resolve(ROOT,'updates/base/delete.txt');
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
if(!files.length&&!deletePaths.length)throw new Error('Base target selected but updates/base contains no overlay files or delete entries');

const payload={
  format:'orbitfs-base-update-patch-v1',
  schemaVersion:1,
  version,
  sourceCommit,
  fileCount:files.length,
  deleteCount:deletePaths.length,
  files,
  deletePaths
};
const archive=gzipSync(Buffer.from(JSON.stringify(payload)),{level:9});
writeFileSync(output,archive);
console.log(JSON.stringify({ok:true,version,sourceCommit,fileCount:files.length,deleteCount:deletePaths.length,sha256:sha256(archive),output},null,2));
