import { json } from '@sveltejs/kit';
import { assertApexEngineAttachedRequest, assertApexEngineExecutionRequest, apexActor } from '$lib/server/apex-request';
import { createApexJob, listApexJobs } from '$lib/server/apex-job-engine';

export async function GET({request,url}){
	try{
		await assertApexEngineAttachedRequest(request);const workspaceId=String(url.searchParams.get('workspaceId')||'').trim();const actorUserId=String(url.searchParams.get('actorUserId')||'').trim();
		if(!workspaceId)return json({error:'workspaceId is required'},{status:400});
		const user=await apexActor(actorUserId);return json({workspaceId,jobs:await listApexJobs(user,workspaceId)},{headers:{'cache-control':'no-store'}});
	}catch(error:any){return json({error:String(error?.message||'APEX jobs failed'),code:String(error?.code||'APEX_JOBS_FAILED')},{status:Number(error?.status||500)});}
}

export async function POST({request}){
	const rawBody=await request.text();
	try{
		await assertApexEngineExecutionRequest(request,rawBody);const body=rawBody?JSON.parse(rawBody):{};const workspaceId=String(body.workspaceId||'').trim();
		if(!workspaceId)return json({error:'workspaceId is required'},{status:400});
		const user=await apexActor(body.actorUserId);return json({accepted:true,job:await createApexJob(user,workspaceId,body)},{status:202,headers:{'cache-control':'no-store'}});
	}catch(error:any){return json({error:String(error?.message||'APEX job creation failed'),code:String(error?.code||'APEX_JOB_CREATE_FAILED')},{status:Number(error?.status||500)});}
}
