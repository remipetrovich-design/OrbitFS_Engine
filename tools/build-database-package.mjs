import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT=resolve(process.cwd());
const args=process.argv.slice(2);
const arg=(name,fallback='')=>{const i=args.indexOf('--'+name);return i>=0?String(args[i+1]||fallback):fallback;};
const requested=arg('component').trim().toLowerCase();
const sourceCommit=arg('commit',process.env.GITHUB_SHA||'').trim().toLowerCase();
const minimumBaseVersion=arg('minimum-base-version',process.env.ORBITFS_MINIMUM_BASE_VERSION||'1.0.0').trim()||null;
const minimumBaseSchemaRaw=arg('minimum-base-schema-version',process.env.ORBITFS_MINIMUM_BASE_SCHEMA_VERSION||'2').trim();
const output=resolve(ROOT,arg('output',requested?'database-package-'+requested+'.json':'database-package.json'));

const mapping={
  shared:{component:'engine-shared',migrationComponent:'shared',dir:'shared'},
  'engine-shared':{component:'engine-shared',migrationComponent:'shared',dir:'shared'},
  mcp:{component:'mcp',migrationComponent:'mcp',dir:'mcp'},
  apex:{component:'apex',migrationComponent:'apex',dir:'apex'},
  studio:{component:'studio',migrationComponent:'studio',dir:'studio'}
};
const selected=mapping[requested];
if(!selected)throw new Error('Component must be one of engine-shared, mcp, apex, studio');
if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw new Error('A full 40-character source commit is required');
const minimumBaseSchemaVersion=Number(minimumBaseSchemaRaw);
if(!Number.isInteger(minimumBaseSchemaVersion)||minimumBaseSchemaVersion<1)throw new Error('minimum Base schema version must be a positive integer');

const rootDir=resolve(ROOT,'supabase/migrations',selected.dir);
if(!existsSync(rootDir)||!statSync(rootDir).isDirectory())throw new Error('Migration directory not found: '+relative(ROOT,rootDir).replaceAll('\\','/'));

const files=readdirSync(rootDir)
  .filter((name)=>/^\d{14}_[A-Za-z0-9._-]+\.sql$/.test(name))
  .sort((a,b)=>a.localeCompare(b));

if(!files.length&&selected.component!=='apex')throw new Error('No database migrations exist for '+selected.component);

const migrations=files.map((name)=>{
  const full=join(rootDir,name);
  const bytes=readFileSync(full);
  if(bytes.length<1||bytes.length>2*1024*1024)throw new Error('Invalid migration size: '+name);
  const sql=bytes.toString('utf8');
  if(/\b(?:begin|commit|rollback)\s*;/i.test(sql))throw new Error('Explicit transaction control is not allowed: '+name);
  if(/\b(?:drop\s+table|drop\s+schema|truncate\s+(?:table\s+)?|alter\s+table[\s\S]{0,300}?drop\s+column)\b/i.test(sql))throw new Error('Destructive migration is not allowed: '+name);
  const stem=name.slice(0,-4);
  return {
    id:selected.migrationComponent+'.'+stem,
    file:'supabase/migrations/'+selected.dir+'/'+name,
    component:selected.migrationComponent,
    encoding:'base64',
    data:bytes.toString('base64'),
    size:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex')
  };
});

const payload={
  format:'orbitfs-customer-database-package-v1',
  packageVersion:1,
  component:selected.component,
  databaseTarget:'customer',
  sourceRepo:'lucaskerim123/V1-vercel-engine',
  sourceCommit,
  databaseSchemaVersion:Math.max(1,migrations.length),
  minimumBaseSchemaVersion,
  minimumBaseVersion,
  migrationCount:migrations.length,
  migrations
};

writeFileSync(output,JSON.stringify(payload,null,2)+'\n');
console.log(JSON.stringify({
  ok:true,
  component:payload.component,
  databaseSchemaVersion:payload.databaseSchemaVersion,
  migrationCount:migrations.length,
  output:relative(ROOT,output).replaceAll('\\','/')
},null,2));