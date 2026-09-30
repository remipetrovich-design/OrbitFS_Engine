import { json } from '@sveltejs/kit';
import { assertApexEngineAttachedRequest } from '$lib/server/apex-request';
import { apexCapabilities } from '$lib/server/apex-capabilities';

export async function GET({request}){
	try{
		await assertApexEngineAttachedRequest(request,'',false);
		return json(await apexCapabilities(),{headers:{'cache-control':'no-store'}});
	}catch(error:any){
		return json({error:String(error?.message||'APEX capabilities failed'),code:String(error?.code||'APEX_CAPABILITIES_FAILED')},{status:Number(error?.status||500)});
	}
}
