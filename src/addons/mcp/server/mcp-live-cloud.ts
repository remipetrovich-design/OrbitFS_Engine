import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { requireCapability } from '$lib/server/base-compat';
import {
  getMcpAdminPolicy,getMcpWorkspaceConfig,getStartup,getPresets,getPresetMetadata,getPresetBundles,
  listMcpProjects,projectBundleAssignments,getContextBundle
} from '$lib/server/mcp-workspace-state';
import * as legacy from './mcp-live-cloud-legacy';
import type { CloudMcpIdentity } from './mcp-live-cloud-legacy';

export * from './mcp-live-cloud-legacy';

const PRESET_CAPS:Record<string,number>={low:500000,medium:1500000,high:5000000,custom1:2000000,custom2:2000000};
const fail=(message:string,status=400,code='MCP_RUNTIME_POLICY')=>Object.assign(new Error(message),{status,code});
const clean=(value:unknown)=>String(value??'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'').replace(/\/{2,}/g,'/');
const unique=(values:any[])=>[...new Set(values.map(String).filter(Boolean))];

async function runtimeConfig(workspaceId:string){return getMcpWorkspaceConfig(workspaceId);}
async function assertSearch(workspaceId:string){
  const config=await runtimeConfig(workspaceId);
  if(config.master.allowSearch===false)throw fail('MCP search is disabled for this workspace.',403,'MCP_SEARCH_DISABLED');
  return config;
}
async function assertContext(workspaceId:string){
  const config=await runtimeConfig(workspaceId);
  if(config.master.allowContextLoad===false)throw fail('MCP context loading is disabled for this workspace.',403,'MCP_CONTEXT_LOAD_DISABLED');
  return config;
}
async function profilesAllowed(workspaceId:string){
  const [config,policy]=await Promise.all([runtimeConfig(workspaceId),getMcpAdminPolicy()]);
  return config.master.includeProfiles!==false&&policy.ccs.allowProfiles!==false;
}

export async function searchFilesCloud(identity:CloudMcpIdentity,workspaceId:string,query:string,basePath='',includeContent=false,maxResults=50){
  await legacy.chooseWorkspace(identity,workspaceId);
  const config=await assertSearch(workspaceId);
  const q=String(query||'').trim();
  if(!q)throw fail('Search query is required.',400,'MCP_SEARCH_QUERY_REQUIRED');
  const base=clean(basePath);
  await requireCapability(identity.user,workspaceId,base,'read');
  const effectiveIncludeContent=includeContent&&config.settings.searchMode!=='keyword';
  const limit=Math.max(1,Math.min(100,Number(maxResults||50)));
  const db=getSupabaseAdmin();
  let result=await db.rpc('orbitfs_mcp_search_files',{
    p_workspace_id:workspaceId,p_query:q,p_base_path:base,p_include_content:effectiveIncludeContent,p_limit:Math.min(250,Math.max(limit*3,limit))
  });
  if(result.error){
    const term=q.replace(/[,*()]/g,' ').trim().slice(0,120);
    let fallback:any=db.from('orbitfs_files').select('id,name,path,kind,mime_type,size_bytes,updated_at,content_text').eq('workspace_id',workspaceId).is('deleted_at',null);
    if(base)fallback=fallback.like('path',`${base}/%`);
    const pattern=`%${term}%`;
    fallback=fallback.or(effectiveIncludeContent?`name.ilike.${pattern},path.ilike.${pattern},content_text.ilike.${pattern}`:`name.ilike.${pattern},path.ilike.${pattern}`).limit(Math.min(250,Math.max(limit*3,limit)));
    result=await fallback;
  }
  if(result.error)throw result.error;
  const matches:any[]=[],failedFiles:any[]=[];
  for(const row of result.data||[]){
    const p=clean(row.path);
    try{
      await requireCapability(identity.user,workspaceId,p,'read');
      matches.push({path:p,name:row.name,type:row.kind==='folder'?'dir':'file',bytes:Number(row.size_bytes||0),modifiedAt:row.updated_at,score:Number(row.score??row.match_score??0),excerpt:String(row.excerpt||'').slice(0,420)});
      if(matches.length>=limit)break;
    }catch(error:any){failedFiles.push({path:p,code:error?.code||'READ_PERMISSION_DENIED',error:error?.message||String(error)});}
  }
  matches.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));
  return{matches:matches.slice(0,limit),failedFiles,failedCount:failedFiles.length,searchMode:config.settings.searchMode,contentSearch:effectiveIncludeContent};
}

export async function searchKnowledgeCloud(identity:CloudMcpIdentity,workspaceId:string,input:any){await assertSearch(workspaceId);return legacy.searchKnowledgeCloud(identity,workspaceId,input);}
export async function loadFileIntoContext(identity:CloudMcpIdentity,workspaceId:string,filePath:string,maxCharacters=500000,extras:any={}){await assertContext(workspaceId);return legacy.loadFileIntoContext(identity,workspaceId,filePath,maxCharacters,extras);}
export async function loadKnowledgeIntoContext(identity:CloudMcpIdentity,workspaceId:string,itemId:string,maxCharacters=500000,mode?:string,extras:any={}){await assertContext(workspaceId);return legacy.loadKnowledgeIntoContext(identity,workspaceId,itemId,maxCharacters,mode,extras);}
export async function loadProfileIntoContext(identity:CloudMcpIdentity,workspaceId:string,profileId:string,detail='standard',extras:any={}){
  await assertContext(workspaceId);if(!(await profilesAllowed(workspaceId)))throw fail('Profile context loading is disabled for this workspace.',403,'MCP_PROFILE_CONTEXT_DISABLED');
  return legacy.loadProfileIntoContext(identity,workspaceId,profileId,detail,extras);
}

function contextItemFromRead(path:string,result:any,extras:any={}){
  const content=String(result?.content||'');
  const document=result?.document||{};
  return{
    path,source:extras.source||'manual',content,characters:content.length,
    fullCharacters:Number(document.fullCharacters??content.length),truncated:Boolean(document.truncated),documentKind:document.kind||'text',
    bytes:Number(result?.metadata?.bytes||0),sha256:result?.metadata?.sha256||null,modifiedAt:result?.metadata?.modifiedAt||null,
    opened:true,extracted:true,transferred:true,status:'loaded',...extras
  };
}

async function folderPaths(workspaceId:string,folderPath:string,recursive=true,maxFiles=100,maxDepth=10){
  const db=getSupabaseAdmin(),base=clean(folderPath),limit=Math.max(1,Math.min(1000,Number(maxFiles||100)));
  let result=await db.rpc('orbitfs_mcp_folder_files',{p_workspace_id:workspaceId,p_base_path:base,p_recursive:recursive,p_max_files:limit,p_max_depth:Math.max(0,Math.min(50,Number(maxDepth||10)))});
  if(result.error){
    let q:any=db.from('orbitfs_files').select('path,kind').eq('workspace_id',workspaceId).eq('kind','file').is('deleted_at',null).order('path').limit(Math.min(1000,limit*4));
    if(base)q=q.like('path',`${base}/%`);
    result=await q;
    if(result.error)throw result.error;
    const prefix=base?`${base}/`:'';
    result.data=(result.data||[]).filter((row:any)=>{
      const p=clean(row.path);if(p.toLowerCase().startsWith('_trash/'))return false;
      const rel=prefix?p.slice(prefix.length):p,depth=Math.max(0,rel.split('/').filter(Boolean).length-1);
      return recursive?depth<=maxDepth:depth===0;
    }).slice(0,limit);
  }
  return(result.data||[]).map((row:any)=>clean(row.path)).filter(Boolean).slice(0,limit);
}

async function readFolderItems(identity:CloudMcpIdentity,workspaceId:string,folderPath:string,recursive:boolean,maxFiles:number,maxCharacters:number,extras:any={}){
  const base=clean(folderPath);
  if(base){const info:any=await legacy.fileInfoCloud(identity,workspaceId,base);if(info.type!=='dir')throw fail('Folder not found.',404,'FOLDER_NOT_FOUND');}
  else await requireCapability(identity.user,workspaceId,'','read');
  const paths=await folderPaths(workspaceId,base,recursive,maxFiles,10),loaded:any[]=[],errors:any[]=[];
  let remaining=maxCharacters;
  for(const p of paths){
    if(remaining<=0||loaded.length>=maxFiles)break;
    try{const result=await legacy.readFileCloud(identity,workspaceId,p,'text',remaining);const item=contextItemFromRead(p,result,extras);loaded.push(item);remaining-=item.characters;}
    catch(error:any){errors.push({path:p,status:'failed',code:error?.code||'FILE_LOAD_FAILED',error:error?.message||String(error)});}
  }
  return{loaded,errors,total:loaded.reduce((n,i)=>n+Number(i.characters||0),0),discoveredCount:paths.length};
}

export async function loadFolderIntoContext(identity:CloudMcpIdentity,workspaceId:string,folderPath:string,maxFiles=100,maxCharacters=1500000,extras:any={}){
  await assertContext(workspaceId);await legacy.chooseWorkspace(identity,workspaceId);
  const result=await readFolderItems(identity,workspaceId,folderPath,true,Math.max(1,Math.min(500,maxFiles)),Math.max(1,maxCharacters),extras);
  const receipt=await legacy.mergeActiveContext(identity,workspaceId,{files:result.loaded,errors:result.errors});
  return{...result,receipt};
}

async function resolveBundleTree(workspaceId:string,bundleId:string,policy:any){
  const visited=new Set<string>(),stack=new Set<string>(),bundles:any[]=[],entries:any[]=[];
  async function visit(id:string,depth:number){
    if(depth>policy.ccs.maxDependencyDepth)throw fail(`CCS dependency depth exceeds the administrator limit of ${policy.ccs.maxDependencyDepth}.`,409,'CCS_DEPENDENCY_DEPTH_LIMIT');
    if(stack.has(id))throw fail('CCS dependency cycle detected.',409,'CCS_DEPENDENCY_CYCLE');
    if(visited.has(id))return;
    stack.add(id);const bundle=await getContextBundle(workspaceId,id),bundleEntries=Array.isArray(bundle.entries)?bundle.entries:[],deps=Array.isArray(bundle.dependencies)?bundle.dependencies:[];
    if(bundleEntries.length>policy.ccs.maxEntriesPerBundle)throw fail(`CCS bundle ${bundle.name||id} exceeds the ${policy.ccs.maxEntriesPerBundle} entry limit.`,409,'CCS_ENTRY_LIMIT');
    if(deps.length>policy.ccs.maxDependenciesPerBundle)throw fail(`CCS bundle ${bundle.name||id} exceeds the ${policy.ccs.maxDependenciesPerBundle} dependency limit.`,409,'CCS_DEPENDENCY_LIMIT');
    if(policy.ccs.allowProfiles===false&&bundleEntries.some((entry:any)=>entry.attachmentType==='profile'))throw fail('Profile entries are disabled by MCP admin policy.',403,'CCS_PROFILES_DISABLED');
    for(const dep of deps){try{await visit(String(dep.bundleId),depth+1);}catch(error){if(dep.required!==false)throw error;}}
    stack.delete(id);visited.add(id);bundles.push(bundle);
    for(const entry of bundleEntries)entries.push({...entry,bundleId:String(bundle.id),bundleName:bundle.name,required:entry.required!==false,priority:Number(entry.priority||100)});
  }
  await visit(String(bundleId),1);return{rootBundleId:String(bundleId),bundles,entries};
}

export async function loadContextBundleCloud(identity:CloudMcpIdentity,workspaceId:string,bundleId:string,maxFiles=250,maxCharacters=1500000){
  await assertContext(workspaceId);await legacy.chooseWorkspace(identity,workspaceId);
  const policy=await getMcpAdminPolicy();if(!policy.ccs.enabled)throw fail('MCP CCS is disabled by the system administrator.',403,'MCP_CCS_DISABLED');
  const resolved=await resolveBundleTree(workspaceId,bundleId,policy),loaded:any[]=[],errors:any[]=[];
  const canProfiles=await profilesAllowed(workspaceId);let remaining=maxCharacters;
  for(const entry of resolved.entries.sort((a:any,b:any)=>Number(a.priority||100)-Number(b.priority||100))){
    if(loaded.length>=maxFiles||remaining<=0)break;
    try{
      if(entry.attachmentType==='profile'&&entry.profileId){
        if(!canProfiles)throw fail('Profile context loading is disabled for this workspace.',403,'MCP_PROFILE_CONTEXT_DISABLED');
        const result=await legacy.loadProfileIntoContext(identity,workspaceId,String(entry.profileId),'standard',{source:'profile',bundleId:entry.bundleId,bundleName:entry.bundleName,required:entry.required});loaded.push(result.item);remaining-=Number(result.item?.characters||0);
      }else if(entry.attachmentType==='knowledge'&&entry.knowledgeItemId){
        const result=await legacy.loadKnowledgeCloud(identity,workspaceId,String(entry.knowledgeItemId),remaining,entry.loadMode,{source:'knowledge',bundleId:entry.bundleId,bundleName:entry.bundleName,required:entry.required});loaded.push(result.contextItem);remaining-=Number(result.contextItem?.characters||0);
      }else if((entry.type||entry.entryType)==='folder'){
        const result=await readFolderItems(identity,workspaceId,String(entry.path||''),entry.recursive!==false,Math.max(1,maxFiles-loaded.length),remaining,{source:'bundle',bundleId:entry.bundleId,bundleName:entry.bundleName,required:entry.required});loaded.push(...result.loaded);errors.push(...result.errors);remaining-=result.total;
      }else{
        const p=String(entry.path||'');const result=await legacy.readFileCloud(identity,workspaceId,p,'text',remaining);const item=contextItemFromRead(p,result,{source:'bundle',bundleId:entry.bundleId,bundleName:entry.bundleName,required:entry.required});loaded.push(item);remaining-=item.characters;
      }
    }catch(error:any){const failure={path:entry.path||`Library/${entry.knowledgeItemId||''}`||`Profiles/${entry.profileId||''}`,bundleId:entry.bundleId,required:entry.required,code:error?.code||'CCS_ENTRY_LOAD_FAILED',error:error?.message||String(error)};errors.push(failure);if(entry.required)throw fail(`Required bundle entry failed: ${failure.path}: ${failure.error}`,409,'BUNDLE_REQUIRED_ENTRY_FAILED');}
  }
  let receipt=await legacy.mergeActiveContext(identity,workspaceId,{files:loaded,errors});
  const bundleLoad={rootBundleId:String(bundleId),bundleIds:resolved.bundles.map((b:any)=>String(b.id)),bundleNames:resolved.bundles.map((b:any)=>b.name),loadedAt:new Date().toISOString()};
  receipt=await legacy.saveActiveContext(identity,workspaceId,{...receipt,bundles:[...(receipt?.bundles||[]).filter((x:any)=>String(x.rootBundleId||x.id)!==String(bundleId)),bundleLoad]});
  return{resolved,loaded,errors,receipt};
}

function instructionOrder(config:any){
  const raw=[...(Array.isArray(config.master.loadOrder)?config.master.loadOrder:[]),...String(config.loadOrderText||'').split(/\r?\n|→|->/g)].map((x:string)=>x.trim().toLowerCase()).filter(Boolean),keys:string[]=[];
  for(const value of raw){if(value.includes('mcp')||value.includes('chatgpt'))keys.push('mcp');else if(value.includes('project'))keys.push('project');else if(value.includes('oss')||value.includes('startup'))keys.push('oss');}
  return unique([...keys,'mcp','project','oss']);
}
function combinedInstructions(config:any,startup:any,projects:any[]){
  const layers:Record<string,string>={
    mcp:config.settings.autoLoad===false?'':[String(config.chatgptInstructions||''),String(config.startupInstructions||'')].filter(Boolean).join('\n\n'),
    project:projects.map((p:any)=>[p.name?`Project: ${p.name}`:'',p.ai_behaviour||'',p.instructions||''].filter(Boolean).join('\n')).filter(Boolean).join('\n\n'),
    oss:String(startup.instructions||'')
  };
  return instructionOrder(config).map((key)=>layers[key]).filter(Boolean).join('\n\n').trim();
}

export async function runStartupCloud(identity:CloudMcpIdentity,workspaceId:string,strength:string,projectId?:string|null,defaultsOnly=false,maxFiles=250,maxCharacters?:number){
  await legacy.chooseWorkspace(identity,workspaceId);
  const [config,policy,startup,projects,workspacePresets]=await Promise.all([assertContext(workspaceId),getMcpAdminPolicy(),getStartup(workspaceId),listMcpProjects(workspaceId),getPresets(workspaceId,null)]);
  if(!policy.oss.enabled)throw fail('MCP OSS is disabled by the system administrator.',403,'MCP_OSS_DISABLED');
  const preset=String(strength||startup.strength||'medium');if(!policy.oss.allowedStrengths.includes(preset))throw fail(`Startup strength ${preset} is not allowed by MCP admin policy.`,403,'MCP_OSS_STRENGTH_DISABLED');
  const workspacePreset=workspacePresets?.[preset]||{},explicit=String(projectId||workspacePreset.projectId||'').trim(),selectedIds=explicit?[explicit]:unique(startup.projectIds||[]);
  const selectedProjects=selectedIds.map((id)=>projects.find((p:any)=>String(p.id)===id)).filter((p:any)=>p&&p.enabled!==false),primary=selectedProjects[0]||null,scopeId=primary?.id||null;
  const [presets,presetMetadata,presetBundles]=await Promise.all([getPresets(workspaceId,scopeId),getPresetMetadata(workspaceId,scopeId),getPresetBundles(workspaceId,scopeId)]),selectedPreset=presets?.[preset]||workspacePreset||{};
  const cap=Math.min(Number(maxCharacters||PRESET_CAPS[preset]||1500000),PRESET_CAPS[preset]||1500000,5000000),fileLimit=Math.max(1,Math.min(500,Number(maxFiles||250)));
  await legacy.clearActiveContext(identity,workspaceId);const loaded:any[]=[],errors:any[]=[];const pushResult=(result:any)=>{if(result?.item)loaded.push(result.item);for(const item of result?.loaded||[])loaded.push(item);for(const item of result?.errors||[])errors.push(item);};let remaining=cap;
  const canProfiles=config.master.includeProfiles!==false&&policy.ccs.allowProfiles!==false;

  if(canProfiles){
    const catalog:any=await legacy.listProfilesCloud(identity,workspaceId).catch(()=>({profiles:[],profileBundles:[]})),byProfile=new Map((catalog.profiles||[]).map((p:any)=>[String(p.id),p])),byBundle=new Map((catalog.profileBundles||[]).map((b:any)=>[String(b.id),b]));
    const profileIds=unique([...(startup.defaultProfileIds||[]),...(!defaultsOnly?(selectedPreset.profileIds||[]):[])]),profileBundleIds=unique([...(startup.defaultProfileBundleIds||[]),...(!defaultsOnly?(selectedPreset.profileBundleIds||[]):[])]);
    for(const bundleId of profileBundleIds){const bundle:any=byBundle.get(bundleId);for(const id of bundle?.profileIds||[])profileIds.push(String(id));}
    for(const id of unique(profileIds)){if(loaded.length>=fileLimit||remaining<=0)break;if(!byProfile.has(id))continue;try{const result=await legacy.loadProfileIntoContext(identity,workspaceId,id,'standard',{source:'startup-profile',defaultLoaded:true});pushResult(result);remaining=Math.max(0,cap-loaded.reduce((n,i)=>n+Number(i.characters||0),0));}catch(error:any){errors.push({path:`Profiles/${id}`,status:'failed',code:error?.code||'PROFILE_LOAD_FAILED',error:error?.message||String(error)});}}
  }

  const pathItems:any[]=[];for(const item of startup.defaultItems||[])pathItems.push({...item,source:'default',defaultLoaded:true});
  if(!defaultsOnly){for(const project of selectedProjects)for(const item of project.items||[])pathItems.push({path:item.item_path||item.path,type:item.item_type||item.type||'file',recursive:Boolean(item.recursive_flag??item.recursive),source:'project',projectId:project.id,projectName:project.name});for(const item of selectedPreset.items||[])pathItems.push({path:item.item_path||item.path,type:item.item_type||item.type||'file',recursive:Boolean(item.recursive_flag??item.recursive),source:'preset'});}
  for(const item of pathItems){if(loaded.length>=fileLimit||remaining<=0)break;try{const result=item.type==='folder'?await loadFolderIntoContext(identity,workspaceId,item.path,Math.max(1,fileLimit-loaded.length),remaining,item):await legacy.loadFileIntoContext(identity,workspaceId,item.path,remaining,item);pushResult(result);remaining=Math.max(0,cap-loaded.reduce((n,i)=>n+Number(i.characters||0),0));}catch(error:any){errors.push({path:item.path,status:'failed',code:error?.code||'STARTUP_PATH_LOAD_FAILED',error:error?.message||String(error)});}}

  if(!defaultsOnly){
    const bundleIds:string[]=[];for(const assignment of presetBundles?.[preset]||[])bundleIds.push(String(assignment.bundleId));for(const project of selectedProjects)for(const assignment of await projectBundleAssignments(String(project.id)))bundleIds.push(String(assignment.bundleId));const ids=unique(bundleIds);
    if(ids.length>policy.oss.maxBundlesPerPreset)throw fail(`Startup resolves ${ids.length} CCS bundles, above the administrator limit of ${policy.oss.maxBundlesPerPreset}.`,409,'MCP_PRESET_BUNDLE_LIMIT');
    for(const id of ids){if(loaded.length>=fileLimit||remaining<=0)break;try{const result=await loadContextBundleCloud(identity,workspaceId,id,Math.max(1,fileLimit-loaded.length),remaining);pushResult(result);remaining=Math.max(0,cap-loaded.reduce((n,i)=>n+Number(i.characters||0),0));}catch(error:any){errors.push({path:`Bundle/${id}`,status:'failed',code:error?.code||'BUNDLE_LOAD_FAILED',error:error?.message||String(error)});}}
  }

  const receipt:any=await legacy.getActiveContext(identity,workspaceId)||{contextId:`ctx-${randomUUID()}`,clientId:identity.clientId,workspaceId,files:[],bundles:[]},effectiveInstructions=combinedInstructions(config,startup,selectedProjects);
  const finalReceipt=await legacy.saveActiveContext(identity,workspaceId,{...receipt,preset,strength:preset,presetDisplayName:presetMetadata?.[preset]?.displayName||preset,projectId:primary?.id||null,projectName:primary?.name||null,projectIds:selectedProjects.map((p:any)=>String(p.id)),projectNames:selectedProjects.map((p:any)=>p.name),errors:[...(receipt.errors||[]),...errors].slice(-250),completedAt:new Date().toISOString(),limitCharacters:cap,runtimeInstructions:effectiveInstructions,workspaceConfigRevision:config.updatedAt||null});
  const files=Array.isArray(finalReceipt.files)?finalReceipt.files:[];
  return{config:{startup,project:primary,projects:selectedProjects,presets,presetMetadata,workspaceConfig:config,effectiveInstructions,autoLoadEnabled:config.settings.autoLoad!==false},loaded:files,errors:finalReceipt.errors||errors,receipt:finalReceipt,total:Number(finalReceipt.charactersTransferred||files.reduce((n:any,i:any)=>n+Number(i.characters||0),0))};
}
