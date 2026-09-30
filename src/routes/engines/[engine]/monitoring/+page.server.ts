import { requireAdmin } from '$lib/server/auth';
import { getEngineReadiness } from '$lib/server/engine-readiness';
import { getSupabaseAdmin } from '$lib/server/supabase';

function objectValue(value:unknown):Record<string,any>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};}
function unique(values:any[]){return [...new Set(values.map((value)=>String(value||'')).filter(Boolean))];}

export async function load({ cookies, params }) {
	const user=await requireAdmin(cookies);
	const readiness=await getEngineReadiness(params.engine);
	const engine:any=readiness.engine;
	const metrics:Record<string,any>={engineState:engine.engineState,setupState:engine.setupState,lastRequestAt:engine.state?.lastRequestAt||null,lastControlAt:engine.state?.lastControlAt||null,lastSyncAt:engine.lastSyncAt||null,generation:engine.state?.generation||1};
	let activity:any[]=[];
	let sessions:any[]=[];

	if(engine.id==='mcp'){
		const db=getSupabaseAdmin();
		const result=await db.rpc('orbitfs_mcp_monitoring_snapshot',{p_activity_limit:100,p_session_limit:50});
		if(result.error)throw result.error;
		const snapshot=objectValue(result.data);
		Object.assign(metrics,objectValue(snapshot.metrics));
		const auditRows=Array.isArray(snapshot.activity)?snapshot.activity:[];
		const sessionRows=Array.isArray(snapshot.sessions)?snapshot.sessions:[];
		activity=auditRows.map((row:any)=>{
			const details=objectValue(row.details),target=objectValue(details.target);
			return{
				id:row.id,
				createdAt:row.created_at,
				eventType:String(row.event_type||''),
				tool:details.tool||String(row.event_type||'').split('.')[1]||row.event_type,
				category:details.category||'system',
				status:String(row.event_type||'').endsWith('.error')?'error':'success',
				userName:details.username||row.user_name||'OrbitFS user',
				clientName:row.client_name||details.clientId||'ChatGPT',
				workspaceName:row.workspace_name||'Global',
				conversationId:details.conversationId||null,
				sessionId:details.sessionId||null,
				durationMs:Number(details.durationMs||0),
				target
			};
		});
		sessions=sessionRows.map((row:any)=>({
			id:row.id,
			userName:row.user_name||row.username||'OrbitFS user',
			clientName:row.client_name||row.client_id||'ChatGPT',
			workspaceName:row.workspace_name||row.workspace_id||'Not selected',
			provider:row.provider||'mcp',status:row.status,requestCount:Number(row.request_count||0),connectedAt:row.connected_at,lastSeenAt:row.last_seen_at,
			conversationId:objectValue(row.metadata).conversationId||null
		}));
	}

	if(engine.id==='apex'){
		const db=getSupabaseAdmin();
		const workspaceId=String(engine.workspaceId||'');
		let jobs:any[]=[];
		if(workspaceId){
			const result=await db.from('orbitfs_settings').select('value,updated_at').eq('scope_type','workspace').eq('scope_id',workspaceId).like('key','apex.processing.job.%').order('updated_at',{ascending:false}).limit(100);
			if(result.error)throw result.error;
			jobs=(result.data||[]).map((row:any)=>row.value).filter((value:any)=>value&&typeof value==='object');
		}
		const creatorIds=unique(jobs.map((job:any)=>job.createdByUserId));
		const usersResult=creatorIds.length?await db.from('orbitfs_users').select('id,username,display_name').in('id',creatorIds):({data:[],error:null} as any);
		if(usersResult.error)throw usersResult.error;
		const users=new Map((usersResult.data||[]).map((row:any)=>[String(row.id),row.display_name||row.username||row.id]));
		const queued=jobs.filter((job:any)=>job.status==='queued').length;
		const processing=jobs.filter((job:any)=>job.status==='processing').length;
		const review=jobs.filter((job:any)=>['awaiting_review','ready_to_finalize'].includes(String(job.status))).length;
		const failed=jobs.filter((job:any)=>job.status==='failed').length;
		const completed=jobs.filter((job:any)=>job.status==='completed').length;
		metrics.queue=queued;
		metrics.processing=processing;
		metrics.awaitingReview=review;
		metrics.failed=failed;
		metrics.completed=completed;
		metrics.jobs=jobs.length;
		activity=jobs.map((job:any)=>({
			id:job.id,
			type:job.type||'knowledge_import',status:job.status||'unknown',stage:job.stage||'unknown',progress:Number(job.progress||0),
			userName:job.createdBy||users.get(String(job.createdByUserId))||'OrbitFS user',
			sourceName:job.source?.name||job.source?.path||job.source?.id||'Unknown source',sourcePath:job.source?.path||null,
			createdAt:job.createdAt||null,updatedAt:job.updatedAt||null,startedAt:job.startedAt||null,completedAt:job.completedAt||null,
			attempts:Number(job.attempts||0),error:job.error||null,errorCode:job.errorCode||null,importMode:job.importMode||null
		}));
	}

	return {user,engine,readiness,metrics,activity,sessions};
}
