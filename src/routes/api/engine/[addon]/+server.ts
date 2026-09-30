import { json } from '@sveltejs/kit';
import { assertAddonEngineLicensed,setAddonEngineMode } from '$lib/server/addon-engine';
import { authorizeEngineHostRequest } from '$lib/server/engine-host-link';

const deny=()=>json({error:'Not found'},{status:404});

export async function GET({params,request}){
	if(!authorizeEngineHostRequest(request)) return deny();
	try{return json(await assertAddonEngineLicensed(String(params.addon||'')),{headers:{'cache-control':'no-store'}});}
	catch(error:any){return json({error:String(error?.message||'Engine status failed'),code:String(error?.code||'ENGINE_STATUS_FAILED')},{status:Number(error?.status||500)});}
}
export async function POST({params,request}){
	const rawBody=await request.text();
	if(!authorizeEngineHostRequest(request,rawBody)) return deny();
	try{
		const body=rawBody?JSON.parse(rawBody):{};
		const action=String(body.action||'').toLowerCase();
		if(!['running','standby','stopped','restart'].includes(action)) return json({error:'Invalid engine action'},{status:400});
		return json(await setAddonEngineMode(String(params.addon||''),action as any,String(body.actor||'main-site')),{headers:{'cache-control':'no-store'}});
	}catch(error:any){return json({error:String(error?.message||'Engine control failed'),code:String(error?.code||'ENGINE_CONTROL_FAILED')},{status:Number(error?.status||500)});}
}
