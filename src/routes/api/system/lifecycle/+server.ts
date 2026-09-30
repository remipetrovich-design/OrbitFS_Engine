import {json} from '@sveltejs/kit';
import {authorizeEngineHostRequest} from '$lib/server/engine-host-link';
import {ensureInstallationIdentity} from '$lib/server/license';
import {listEngineHubEngines} from '$lib/server/engine-hub';
import {getSupabaseAdmin} from '$lib/server/supabase';

async function snapshot(){
  const [installationId,engines]=await Promise.all([ensureInstallationIdentity(),listEngineHubEngines()]);
  return {
    ok:true,
    service:'orbitfs-engine-host',
    installationId,
    engines:engines.map((engine:any)=>({
      id:engine.id,
      installed:engine.installed,
      attached:engine.attached,
      linked:engine.linked,
      configured:engine.configured,
      engineState:engine.engineState,
      workspaceId:engine.workspaceId||null
    })),
    statelessRuntime:true,
    databaseOwnedExternally:true
  };
}

export async function GET({request}:any){
  if(!authorizeEngineHostRequest(request))return json({ok:false,error:'Unauthorized',code:'ENGINE_HOST_UNAUTHORIZED'},{status:401});
  try{return json(await snapshot(),{headers:{'cache-control':'no-store'}})}
  catch(error:any){return json({ok:false,error:error?.message||'Lifecycle status failed',code:error?.code||'ENGINE_LIFECYCLE_FAILED'},{status:Number(error?.status||500)})}
}

export async function POST({request}:any){
  const raw=await request.text();
  if(!authorizeEngineHostRequest(request,raw))return json({ok:false,error:'Unauthorized',code:'ENGINE_HOST_UNAUTHORIZED'},{status:401});
  try{
    const body=raw?JSON.parse(raw):{};
    if(String(body.action||'').toLowerCase()!=='prepare')return json({ok:false,error:'Unsupported lifecycle action',code:'LIFECYCLE_ACTION_REQUIRED'},{status:400});
    const mode=String(body.mode||'').toLowerCase();
    if(!['undeploy','uninstall'].includes(mode))return json({ok:false,error:'Lifecycle mode must be undeploy or uninstall',code:'LIFECYCLE_MODE_INVALID'},{status:400});
    const state=await snapshot();
    const stamp=new Date().toISOString();
    const db=getSupabaseAdmin();
    const saved=await db.from('orbitfs_settings').upsert({
      scope_type:'global',
      scope_id:'',
      key:'installation.engine_lifecycle',
      value:{version:1,mode,state:'prepared',preparedAt:stamp,installationId:state.installationId,engines:state.engines},
      updated_at:stamp
    },{onConflict:'scope_type,scope_id,key'});
    if(saved.error)throw saved.error;
    return json({...state,prepared:true,mode},{headers:{'cache-control':'no-store'}});
  }catch(error:any){
    return json({ok:false,error:error?.message||'Lifecycle preparation failed',code:error?.code||'ENGINE_LIFECYCLE_FAILED'},{status:Number(error?.status||500)});
  }
}
