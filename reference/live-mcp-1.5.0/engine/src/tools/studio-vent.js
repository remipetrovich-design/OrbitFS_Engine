import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const legacyDataRoot=path.resolve(here,'..','data','ventmode');
const studioVentConfigRoot=path.resolve(here,'..','..','..','..','..','system-data','studio','vent-config');
const DEFAULT_CONFIG=Object.freeze({
  folder:'Vents',organization:'month',formats:['md'],behaviour:'pure',customInstructions:'',
  titleMode:'auto',includeDateTime:true,sectionHeadings:false,retainRaw:true,summary:'none',tags:'off'
});
const safe=(value)=>String(value||'').trim().replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100)||'unknown';
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function retryWindowsFs(action,attempts=8){
  let lastError=null;
  for(let i=0;i<attempts;i+=1){
    try{return await action();}
    catch(error){
      lastError=error;
      if(!['EPERM','EBUSY','EACCES'].includes(String(error?.code||''))||i===attempts-1)throw error;
      await sleep(60*(i+1));
    }
  }
  throw lastError;
}
async function readJson(file,fallback){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}
  catch{return structuredClone(fallback);}
}
async function writeJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  await retryWindowsFs(()=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n','utf8'));
}
const configPath=(workspaceId)=>path.join(studioVentConfigRoot,`${safe(workspaceId)}.json`);
const legacyConfigPath=(workspaceId)=>path.join(legacyDataRoot,'config',`${safe(workspaceId)}.json`);

export async function getStudioVentConfig(workspaceId){
  let stored=await readJson(configPath(workspaceId),null);
  if(!stored){
    stored=await readJson(legacyConfigPath(workspaceId),null);
    if(stored)await writeJson(configPath(workspaceId),stored).catch(()=>{});
  }
  return {...DEFAULT_CONFIG,...(stored||{})};
}
function cleanFolder(value){
  const clean=String(value||'Vents').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
  if(!clean||clean.split('/').some((part)=>!part||part==='.'||part==='..'))throw new Error('Invalid Studio Vent folder');
  return clean;
}
function userFolder(identity){
  const id=safe(identity.userId||identity.username);
  const name=safe(identity.username||'user');
  return `${name}_${id.slice(0,12)}`;
}
function monthFolder(date=new Date()){
  return new Intl.DateTimeFormat('en-AU',{month:'long',year:'numeric',timeZone:'Australia/Sydney'}).format(date);
}
function relativeOutputDir(config,identity){
  const parts=[cleanFolder(config.folder),userFolder(identity)];
  if(config.organization==='month')parts.push(monthFolder());
  else if(config.organization==='year-month'){
    const d=new Date();parts.push(String(d.getFullYear()),monthFolder(d).split(' ')[0]);
  }
  return parts.join('/');
}
function ventDate(date=new Date()){
  return new Intl.DateTimeFormat('en-AU',{day:'numeric',month:'long',year:'numeric',timeZone:'Australia/Sydney'}).format(date);
}
function formatVentTitle(config,title,date=new Date()){
  const raw=String(title||'').trim().replace(/^\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+-\s+/,'');
  if(config.titleMode==='none')return config.includeDateTime?ventDate(date):'Vent';
  const clean=raw||'Untitled';
  return config.includeDateTime?`${ventDate(date)} - ${clean}`:clean;
}
function behaviourInstructions(config){
  const lines=[
    'Studio Vent Mode is ACTIVE.',
    'Treat the user\'s writing as a private Studio vent entry.',
    'Preserve the user\'s wording, profanity, tone, sequence and first-person perspective.',
    'Do not sanitize, polish, moralize, therapize or reframe unless the user explicitly asks.',
    'Studio owns the working entry, source file and revision history; do not create duplicate sidecar vent files.',
    'Do not submit or publish the vent to Library unless the user explicitly requests it.',
    'Do not change Normal/Vent mode automatically.',
    'Platform safety requirements still apply.'
  ];
  if(String(config.customInstructions||'').trim())lines.push(String(config.customInstructions).trim());
  return lines.join('\n');
}
export async function getStudioVentProfile(workspaceId,identity){
  const config=await getStudioVentConfig(workspaceId);
  return {
    config,
    saveLocation:relativeOutputDir(config,identity),
    behaviourInstructions:behaviourInstructions(config),
    formatTitle:(title,date=new Date())=>formatVentTitle(config,title,date)
  };
}
