import { json } from '@sveltejs/kit';
import { assertApexEngineAttachedRequest, assertApexEngineExecutionRequest, apexActor } from '$lib/server/apex-request';
import { cancelApexJob, getApexJob, markApexJobFinalized, retryApexJob } from '$lib/server/apex-job-engine';
import { processApexJob } from '$lib/server/apex-processors';

export async function GET({request,url,params}){
	try{
		await assertApexEngineAttachedRequest(request);const workspaceId=String(url.searchParams.get('workspaceId')||'').trim();const actorUserId=String(url.searchParams.get('actorUserId')||'').trim();
		if(!workspaceId)return json({error:'workspaceId is required'},{status:400});
		const user=await apexActor(actorUserId);return json(await getApexJob(user,workspaceId,String(params.jobId)),{headers:{'cache-control':'no-store'}});
	}catch(error:any){return json({error:String(error?.message||'APEX job failed'),code:String(error?.code||'APEX_JOB_FAILED')},{status:Number(error?.status||500)});}
}

export async function POST({request,params}){
	const rawBody=await request.text();
	try{
		await assertApexEngineAttachedRequest(request,rawBody);const body=rawBody?JSON.parse(rawBody):{};const workspaceId=String(body.workspaceId||'').trim();if(!workspaceId)return json({error:'workspaceId is required'},{status:400});
		const user=await apexActor(body.actorUserId),jobId=String(params.jobId),action=String(body.action||'').toLowerCase();
		if(action==='cancel')return json(await cancelApexJob(user,workspaceId,jobId));
		if(action==='finalized')return json(await markApexJobFinalized(user,workspaceId,jobId,body));
		if(action==='retry'){
			await assertApexEngineExecutionRequest(request,rawBody);
			return json(await retryApexJob(user,workspaceId,jobId));
		}
		if(action==='process'){
			await assertApexEngineExecutionRequest(request,rawBody);
			const job=await getApexJob(user,workspaceId,jobId);return json(await processApexJob(user,workspaceId,jobId,job.source.id));
		}
		return json({error:'action must be process, cancel, retry or finalized'},{status:400});
	}catch(error:any){return json({error:String(error?.message||'APEX job action failed'),code:String(error?.code||'APEX_JOB_ACTION_FAILED')},{status:Number(error?.status||500)});}
}
