import { getSupabaseAdmin } from '$lib/server/supabase';

const PRESETS=['low','medium','high','custom1','custom2'] as const;
const DEFAULTS={
  oss:{enabled:true,allowedStrengths:[...PRESETS],maxBundlesPerPreset:20},
  ccs:{enabled:true,maxBundlesPerWorkspace:100,maxEntriesPerBundle:500,maxDependenciesPerBundle:50,maxDependencyDepth:8,allowProfiles:true}
};
const obj=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const bounded=(value:any,fallback:number,min:number,max:number)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.round(n))):fallback;};
const now=()=>new Date().toISOString();

function sanitize(input:any={}){
  const raw=obj(input),oss=obj(raw.oss),ccs=obj(raw.ccs);
  let allowed=Array.isArray(oss.allowedStrengths)?oss.allowedStrengths.map(String).filter((value:string)=>PRESETS.includes(value as any)):[...DEFAULTS.oss.allowedStrengths];
  if(!allowed.length)allowed=['medium'];
  return{
    oss:{enabled:oss.enabled!==false,allowedStrengths:[...new Set(allowed)],maxBundlesPerPreset:bounded(oss.maxBundlesPerPreset,20,1,100)},
    ccs:{enabled:ccs.enabled!==false,maxBundlesPerWorkspace:bounded(ccs.maxBundlesPerWorkspace,100,1,1000),maxEntriesPerBundle:bounded(ccs.maxEntriesPerBundle,500,1,5000),maxDependenciesPerBundle:bounded(ccs.maxDependenciesPerBundle,50,0,500),maxDependencyDepth:bounded(ccs.maxDependencyDepth,8,1,32),allowProfiles:ccs.allowProfiles!==false}
  };
}

export async function getMcpAdminPolicy(){
  const db=getSupabaseAdmin();
  const result=await db.from('orbitfs_settings').select('value').eq('scope_type','global').eq('key','mcp.admin_policy').order('updated_at',{ascending:false}).limit(1).maybeSingle();
  if(result.error)throw result.error;
  return sanitize(result.data?.value||DEFAULTS);
}

export async function saveMcpAdminPolicy(input:any){
  const db=getSupabaseAdmin(),value=sanitize(input);
  const existing=await db.from('orbitfs_settings').select('id').eq('scope_type','global').eq('key','mcp.admin_policy').order('updated_at',{ascending:false}).limit(1).maybeSingle();
  if(existing.error)throw existing.error;
  if(existing.data?.id){
    const update=await db.from('orbitfs_settings').update({value,updated_at:now()}).eq('id',existing.data.id);
    if(update.error)throw update.error;
  }else{
    const insert=await db.from('orbitfs_settings').insert({scope_type:'global',scope_id:null,key:'mcp.admin_policy',value,updated_at:now()});
    if(insert.error)throw insert.error;
  }
  return value;
}
