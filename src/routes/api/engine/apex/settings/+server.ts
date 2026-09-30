import { json } from '@sveltejs/kit';
import { assertApexEngineAttachedRequest, apexActor } from '$lib/server/apex-request';
import { getApexWorkspaceSettings, saveApexWorkspaceSettings } from '$lib/server/apex-processing-core';

export async function GET({request,url}){
	try{
		await assertApexEngineAttachedRequest(request,'',false);const workspaceId=String(url.searchParams.get('workspaceId')||'').trim();const actorUserId=String(url.searchParams.get('actorUserId')||'').trim();
		if(!workspaceId)return json({error:'workspaceId is required'},{status:400});
		const user=await apexActor(actorUserId);return json({workspaceId,settings:await getApexWorkspaceSettings(user,workspaceId)},{headers:{'cache-control':'no-store'}});
	}catch(error:any){return json({error:String(error?.message||'APEX settings failed'),code:String(error?.code||'APEX_SETTINGS_FAILED')},{status:Number(error?.status||500)});}
}

export async function POST({request}){
	const rawBody=await request.text();
	try{
		await assertApexEngineAttachedRequest(request,rawBody,false);const body=rawBody?JSON.parse(rawBody):{};const workspaceId=String(body.workspaceId||'').trim();
		if(!workspaceId)return json({error:'workspaceId is required'},{status:400});
		const user=await apexActor(body.actorUserId);return json({workspaceId,settings:await saveApexWorkspaceSettings(user,workspaceId,body.settings||body)});
	}catch(error:any){return json({error:String(error?.message||'APEX settings failed'),code:String(error?.code||'APEX_SETTINGS_FAILED')},{status:Number(error?.status||500)});}
}
