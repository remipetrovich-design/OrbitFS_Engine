import { getSupabaseAdmin } from '$lib/server/supabase';
import type { OrbitUser } from '$lib/server/auth';
import * as legacy from './mcp-workspace-state-legacy';

export * from './mcp-workspace-state-legacy';

const PRESETS=['low','medium','high','custom1','custom2'] as const;
const POLICY_TTL_MS=15_000;
const CONFIG_TTL_MS=10_000;
let policyCache:{expiresAt:number;value:any}|null=null;
const configCache=new Map<string,{expiresAt:number;value:any}>();

const POLICY_DEFAULTS={
  oss:{enabled:true,allowedStrengths:['low','medium','high','custom1','custom2'],maxBundlesPerPreset:20},
  ccs:{enabled:true,maxBundlesPerWorkspace:100,maxEntriesPerBundle:500,maxDependenciesPerBundle:50,maxDependencyDepth:8,allowProfiles:true}
};
const CONFIG_DEFAULTS={
  master:{includeProfiles:true,allowSearch:true,allowContextLoad:true,loadOrder:[] as string[]},
  settings:{searchMode:'hybrid',autoLoad:true,defaultPaths:[] as string[],folderTemplate:[] as string[]},
  startupInstructions:'',chatgptInstructions:'',loadOrderText:''
};
const obj=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const limit=(value:any,fallback:number,min:number,max:number)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.round(n))):fallback;};
const fail=(message:string,status=400,code='MCP_POLICY_ERROR')=>Object.assign(new Error(message),{status,code});

export async function getMcpAdminPolicy(force=false){
  if(!force&&policyCache&&policyCache.expiresAt>Date.now())return policyCache.value;
  const db=getSupabaseAdmin();
  const result=await db.from('orbitfs_settings').select('value,updated_at').eq('scope_type','global').eq('key','mcp.admin_policy').order('updated_at',{ascending:false}).limit(1).maybeSingle();
  if(result.error)throw result.error;
  const raw=obj(result.data?.value),oss=obj(raw.oss),ccs=obj(raw.ccs);
  const value={
    oss:{enabled:oss.enabled!==false,allowedStrengths:Array.isArray(oss.allowedStrengths)?oss.allowedStrengths.map(String).filter((x:string)=>PRESETS.includes(x as any)):POLICY_DEFAULTS.oss.allowedStrengths,maxBundlesPerPreset:limit(oss.maxBundlesPerPreset,POLICY_DEFAULTS.oss.maxBundlesPerPreset,1,100)},
    ccs:{enabled:ccs.enabled!==false,maxBundlesPerWorkspace:limit(ccs.maxBundlesPerWorkspace,POLICY_DEFAULTS.ccs.maxBundlesPerWorkspace,1,1000),maxEntriesPerBundle:limit(ccs.maxEntriesPerBundle,POLICY_DEFAULTS.ccs.maxEntriesPerBundle,1,5000),maxDependenciesPerBundle:limit(ccs.maxDependenciesPerBundle,POLICY_DEFAULTS.ccs.maxDependenciesPerBundle,0,500),maxDependencyDepth:limit(ccs.maxDependencyDepth,POLICY_DEFAULTS.ccs.maxDependencyDepth,1,32),allowProfiles:ccs.allowProfiles!==false}
  };
  if(!value.oss.allowedStrengths.length)value.oss.allowedStrengths=[...POLICY_DEFAULTS.oss.allowedStrengths];
  policyCache={expiresAt:Date.now()+POLICY_TTL_MS,value};
  return value;
}

export async function getMcpWorkspaceConfig(workspaceId:string,force=false){
  const cached=configCache.get(workspaceId);
  if(!force&&cached&&cached.expiresAt>Date.now())return cached.value;
  const db=getSupabaseAdmin();
  const result=await db.from('orbitfs_settings').select('value,updated_at').eq('scope_type','workspace').eq('scope_id',workspaceId).eq('key','mcp.workspace_config').maybeSingle();
  if(result.error)throw result.error;
  const raw=obj(result.data?.value),master=obj(raw.master),settings=obj(raw.settings);
  const searchMode=['hybrid','keyword'].includes(String(settings.searchMode))?String(settings.searchMode):'hybrid';
  const defaultPaths=Array.isArray(settings.defaultPaths)?settings.defaultPaths.map(String).filter(Boolean).slice(0,100):[];
  const folderTemplate=Array.isArray(settings.folderTemplate)?settings.folderTemplate.map(String).filter(Boolean).slice(0,100):[];
  const mapGuidance=[
    defaultPaths.length?`Important workspace paths:\n${defaultPaths.map((path:string)=>`- ${path}`).join('\n')}`:'',
    folderTemplate.length?`Preferred workspace structure:\n${folderTemplate.join('\n')}`:''
  ].filter(Boolean).join('\n\n');
  const startupInstructions=[String(raw.startupInstructions||'').trim(),mapGuidance].filter(Boolean).join('\n\n');
  const value={master:{...CONFIG_DEFAULTS.master,...master,loadOrder:Array.isArray(master.loadOrder)?master.loadOrder.map(String).slice(0,20):[]},settings:{...CONFIG_DEFAULTS.settings,...settings,searchMode,defaultPaths,folderTemplate},startupInstructions,chatgptInstructions:String(raw.chatgptInstructions||''),loadOrderText:String(raw.loadOrderText||''),updatedAt:result.data?.updated_at||null};
  delete (value.master as any).autoLoadPanelWorkspaceAi;
  configCache.set(workspaceId,{expiresAt:Date.now()+CONFIG_TTL_MS,value});
  return value;
}

function presetHasData(presets:any){return PRESETS.some((key)=>{const p=presets?.[key]||{};return (p.items||[]).length||(p.profileIds||[]).length||(p.profileBundleIds||[]).length;});}
function bundlesHaveData(assignments:any){return PRESETS.some((key)=>(assignments?.[key]||[]).length>0);}

export async function getPresets(workspaceId:string,projectId?:string|null){const scoped=await legacy.getPresets(workspaceId,projectId);if(!projectId||presetHasData(scoped))return scoped;return legacy.getPresets(workspaceId,null);}
export async function getPresetBundles(workspaceId:string,projectId?:string|null){const scoped=await legacy.getPresetBundles(workspaceId,projectId);if(!projectId||bundlesHaveData(scoped))return scoped;return legacy.getPresetBundles(workspaceId,null);}
export async function getPresetMetadata(workspaceId:string,projectId?:string|null){
  if(!projectId)return legacy.getPresetMetadata(workspaceId,null);
  const db=getSupabaseAdmin();
  const result=await db.from('mcp_project_preset_metadata').select('preset').eq('project_id',projectId).limit(1);
  if(result.error)throw result.error;
  return result.data?.length?legacy.getPresetMetadata(workspaceId,projectId):legacy.getPresetMetadata(workspaceId,null);
}

async function dependencyDepth(workspaceId:string,bundleId:string,depth:number,seen:Set<string>,maxDepth:number):Promise<void>{
  if(depth>maxDepth)throw fail(`CCS dependency depth exceeds the administrator limit of ${maxDepth}.`,409,'CCS_DEPENDENCY_DEPTH_LIMIT');
  if(seen.has(bundleId))throw fail('CCS dependency cycle detected.',409,'CCS_DEPENDENCY_CYCLE');
  seen.add(bundleId);const bundle=await legacy.getContextBundle(workspaceId,bundleId);for(const dep of bundle.dependencies||[])await dependencyDepth(workspaceId,String(dep.bundleId),depth+1,new Set(seen),maxDepth);
}

export async function saveStartup(workspaceId:string,user:OrbitUser,body:any){
  const policy=await getMcpAdminPolicy(),strength=String(body?.strength||'medium');
  if(!policy.oss.enabled)throw fail('MCP OSS is disabled by the system administrator.',403,'MCP_OSS_DISABLED');
  if(!policy.oss.allowedStrengths.includes(strength))throw fail(`Startup strength ${strength} is not allowed by MCP admin policy.`,403,'MCP_OSS_STRENGTH_DISABLED');
  return legacy.saveStartup(workspaceId,user,body);
}

export async function saveContextBundle(workspaceId:string,user:OrbitUser,body:any,bundleId?:string){
  const policy=await getMcpAdminPolicy();
  if(!policy.ccs.enabled)throw fail('MCP CCS is disabled by the system administrator.',403,'MCP_CCS_DISABLED');
  const entries=Array.isArray(body?.entries)?body.entries:[],deps=Array.isArray(body?.dependencies)?body.dependencies.filter((x:any)=>x?.bundleId&&String(x.bundleId)!==String(bundleId||'')):[];
  if(entries.length>policy.ccs.maxEntriesPerBundle)throw fail(`CCS bundle exceeds the ${policy.ccs.maxEntriesPerBundle} entry limit.`,413,'CCS_ENTRY_LIMIT');
  if(deps.length>policy.ccs.maxDependenciesPerBundle)throw fail(`CCS bundle exceeds the ${policy.ccs.maxDependenciesPerBundle} dependency limit.`,413,'CCS_DEPENDENCY_LIMIT');
  if(!policy.ccs.allowProfiles&&entries.some((entry:any)=>entry?.attachmentType==='profile'))throw fail('Profile attachments are disabled by MCP admin policy.',403,'CCS_PROFILES_DISABLED');
  if(!bundleId){const bundles=await legacy.listContextBundles(workspaceId);if(bundles.length>=policy.ccs.maxBundlesPerWorkspace)throw fail(`Workspace has reached the ${policy.ccs.maxBundlesPerWorkspace} CCS bundle limit.`,409,'CCS_WORKSPACE_BUNDLE_LIMIT');}
  for(const dep of deps)await dependencyDepth(workspaceId,String(dep.bundleId),2,new Set(bundleId?[String(bundleId)]:[]),policy.ccs.maxDependencyDepth);
  return legacy.saveContextBundle(workspaceId,user,body,bundleId);
}

export async function savePresetBundles(workspaceId:string,assignments:any,projectId?:string|null){
  const policy=await getMcpAdminPolicy();for(const key of PRESETS){const count=Array.isArray(assignments?.[key])?assignments[key].length:0;if(count>policy.oss.maxBundlesPerPreset)throw fail(`${key} preset exceeds the ${policy.oss.maxBundlesPerPreset} bundle limit.`,413,'MCP_PRESET_BUNDLE_LIMIT');}
  return legacy.savePresetBundles(workspaceId,assignments,projectId);
}
