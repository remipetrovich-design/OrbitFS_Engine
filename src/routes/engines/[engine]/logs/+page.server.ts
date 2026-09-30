import { requireAdmin } from '$lib/server/auth';
import { getEngineHubEngine } from '$lib/server/engine-hub';
import { getSupabaseAdmin } from '$lib/server/supabase';

const SENSITIVE_KEY=/(token|secret|password|authorization|license[_-]?key|entitlement|credential)/i;
const LOG_LIMIT=75;

function safeDetail(value:any,depth=0):any{
	if(depth>3)return'[nested data]';
	if(value===null||value===undefined||typeof value==='boolean'||typeof value==='number')return value;
	if(typeof value==='string')return value.length>1000?`${value.slice(0,1000)}…`:value;
	if(Array.isArray(value))return value.slice(0,25).map((item)=>safeDetail(item,depth+1));
	if(typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,50).map(([key,item])=>[key,SENSITIVE_KEY.test(key)?'[redacted]':safeDetail(item,depth+1)]));
	return String(value);
}

export async function load({cookies,params}){
	const user=await requireAdmin(cookies);
	const engine=await getEngineHubEngine(params.engine);
	const db=getSupabaseAdmin();
	let logs:any[]=[];
	if(engine.id==='mcp'){
		const result=await db.from('mcp_audit_log').select('id,scope_id,actor_user_id,event_type,details,created_at').order('created_at',{ascending:false}).limit(LOG_LIMIT);
		if(result.error)throw result.error;
		logs=(result.data||[]).map((row:any)=>({id:row.id,type:row.event_type,scope:row.scope_id,actor:row.actor_user_id,detail:safeDetail(row.details||{}),createdAt:row.created_at}));
	}else{
		const result=await db.from('orbitfs_audit_log').select('id,actor_user_id,workspace_id,action,target_type,target_id,detail,created_at').eq('target_id',engine.id).order('created_at',{ascending:false}).limit(LOG_LIMIT);
		if(result.error)throw result.error;
		logs=(result.data||[]).map((row:any)=>({id:row.id,type:row.action,scope:row.workspace_id,actor:row.actor_user_id,detail:safeDetail(row.detail||{}),createdAt:row.created_at}));
	}
	const actorIds=[...new Set(logs.map((row:any)=>String(row.actor||'')).filter(Boolean))];
	const workspaceIds=[...new Set(logs.map((row:any)=>String(row.scope||'')).filter(Boolean))];
	const [usersResult,workspacesResult]=await Promise.all([
		actorIds.length?db.from('orbitfs_users').select('id,username,display_name').in('id',actorIds):Promise.resolve({data:[],error:null} as any),
		workspaceIds.length?db.from('orbitfs_workspaces').select('id,name').in('id',workspaceIds):Promise.resolve({data:[],error:null} as any)
	]);
	if(usersResult.error)throw usersResult.error;if(workspacesResult.error)throw workspacesResult.error;
	const users=new Map((usersResult.data||[]).map((row:any)=>[String(row.id),row.display_name||row.username||row.id]));
	const workspaces=new Map((workspacesResult.data||[]).map((row:any)=>[String(row.id),row.name||row.id]));
	logs=logs.map((row:any)=>({...row,actorName:row.actor?users.get(String(row.actor))||'OrbitFS user':'System',scopeName:row.scope?workspaces.get(String(row.scope))||'Workspace':'Global'}));
	return {user,engine,logs,limit:LOG_LIMIT};
}
