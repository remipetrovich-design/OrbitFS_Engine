import type { RequestHandler } from './$types';
import { handleMcpAddonRequest } from '../../addons/mcp/server/mcp-server';
import { noteAddonRequest } from '$lib/server/addon-engine';
import { getMcpEngineSettings } from '$lib/server/mcp-engine-settings';
import { sha256 } from '$lib/server/mcp-oauth';
import { getSupabaseAdmin } from '$lib/server/supabase';

function transportError(message: string, code: string, status: number) {
	return new Response(JSON.stringify({ error: message, code }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

type ToolAudit = { name:string; args:Record<string,any>; conversationId:string|null; sessionId:string|null };
type InspectedRequest = { toolCall:ToolAudit|null; bytes:number|null };
type AuditIdentity = { expiresAt:number; userId:string; clientId:string; workspaceId:string|null };
const AUDIT_IDENTITY_TTL_MS=15_000;
const auditIdentityCache=new Map<string,AuditIdentity>();
const UI_STATE_TOOLS=new Set(['orbitfs','orbitfs_ui_state','refresh_ui']);

function short(value:unknown){
	if(value===null||value===undefined)return null;
	const text=String(value).trim();
	return text ? text.slice(0,220) : null;
}

function safeTarget(args:Record<string,any>){
	const allowed=['workspaceId','path','sourcePath','targetPath','fileName','name','itemId','sourceId','recordId','profileId','projectId','bundleId','action','kind','type','view'];
	const target:Record<string,string>={};
	for(const key of allowed){const value=short(args?.[key]);if(value)target[key]=value;}
	return target;
}

function toolCategory(name:string){
	const value=name.toLowerCase();
	if(value.includes('upload'))return'upload';
	if(value.includes('download')||value.includes('export'))return'download';
	if(/(^|_)(delete|purge|remove)/.test(value))return'delete';
	if(/(^|_)(write|edit|update|create|append|move|import|restore|set)/.test(value))return'write';
	if(/(^|_)(read|get|list|search|load|view|browse|inspect|resolve)/.test(value))return'read';
	return'action';
}

async function inspectRequest(request:Request):Promise<InspectedRequest>{
	if(request.method!=='POST')return{toolCall:null,bytes:null};
	const text=await request.clone().text();
	const bytes=Buffer.byteLength(text,'utf8');
	let body:any=null;
	try{body=JSON.parse(text);}catch{return{toolCall:null,bytes};}
	try{(request as any).__orbitfsParsedBody=body;}catch{}
	if(body?.method!=='tools/call'||!body?.params?.name)return{toolCall:null,bytes};
	const meta=body.params?._meta||body._meta||{};
	return{bytes,toolCall:{
		name:String(body.params.name),
		args:body.params.arguments&&typeof body.params.arguments==='object'?body.params.arguments:{},
		conversationId:short(request.headers.get('x-openai-conversation-id')||request.headers.get('openai-conversation-id')||request.headers.get('chatgpt-conversation-id')||meta?.['openai/conversationId']||meta?.conversationId),
		sessionId:short(request.headers.get('mcp-session-id'))
	}};
}

function validateTransportRequest(request: Request, settings: Awaited<ReturnType<typeof getMcpEngineSettings>>, inspected:InspectedRequest) {
	if (request.method === 'DELETE' && !settings.allowDeleteTransport) {
		return transportError('MCP DELETE/session termination is disabled by Engine configuration.', 'MCP_DELETE_DISABLED', 405);
	}
	if (request.method === 'POST' && settings.requireJsonContentType) {
		const contentType = String(request.headers.get('content-type') || '').toLowerCase();
		if (!contentType.includes('application/json') && !contentType.includes('+json')) {
			return transportError('MCP POST requests must use a JSON content type.', 'MCP_JSON_REQUIRED', 415);
		}
	}
	if (request.method === 'POST') {
		const limit = settings.maxRequestKb * 1024;
		const declared = Number(request.headers.get('content-length') || 0);
		const actual = declared || inspected.bytes || 0;
		if (Number.isFinite(actual) && actual > limit) {
			return transportError(`MCP request exceeds the configured ${settings.maxRequestKb} KB limit.`, 'MCP_REQUEST_TOO_LARGE', 413);
		}
	}
	return null;
}

async function auditIdentity(request:Request){
	const header=request.headers.get('authorization')||'';
	const match=/^Bearer\s+(.+)$/i.exec(header);
	if(!match)return null;
	const tokenHash=sha256(match[1]);
	const cached=auditIdentityCache.get(tokenHash);
	if(cached&&cached.expiresAt>Date.now())return cached;
	const db=getSupabaseAdmin();
	const token=await db.from('mcp_oauth_tokens').select('user_id,client_id').eq('access_token_hash',tokenHash).maybeSingle();
	if(token.error||!token.data?.user_id)return null;
	const userId=String(token.data.user_id),clientId=String(token.data.client_id||'chatgpt');
	const session=await db.from('mcp_sessions').select('workspace_id').eq('user_id',userId).eq('client_id',clientId).order('last_seen_at',{ascending:false}).limit(1).maybeSingle();
	const identity:AuditIdentity={expiresAt:Date.now()+AUDIT_IDENTITY_TTL_MS,userId,clientId,workspaceId:session.error?null:(session.data?.workspace_id?String(session.data.workspace_id):null)};
	auditIdentityCache.set(tokenHash,identity);
	return identity;
}

async function responseWorkspaceId(response:Response){
	try{
		const contentType=String(response.headers.get('content-type')||'');
		if(!contentType.includes('application/json'))return null;
		const payload:any=await response.clone().json();
		return short(payload?.result?.structuredContent?.workspaceId||payload?.result?.workspaceId||payload?.structuredContent?.workspaceId||payload?.workspaceId);
	}catch{return null;}
}

async function auditToolCall(request:Request,call:ToolAudit,response:Response,durationMs:number){
	try{
		const identity=await auditIdentity(request);
		if(!identity)return;
		const db=getSupabaseAdmin();
		const target=safeTarget(call.args);
		const responseWorkspace=await responseWorkspaceId(response);
		const workspaceId=target.workspaceId||responseWorkspace||identity.workspaceId||'global';
		if(workspaceId!=='global')identity.workspaceId=workspaceId;
		await db.from('mcp_audit_log').insert({
			scope_id:workspaceId,
			actor_user_id:identity.userId,
			event_type:`tool.${call.name}.${response.status<400?'success':'error'}`,
			details:{
				tool:call.name,
				category:toolCategory(call.name),
				clientId:identity.clientId,
				workspaceId:workspaceId==='global'?null:workspaceId,
				conversationId:call.conversationId,
				sessionId:call.sessionId,
				durationMs,
				httpStatus:response.status,
				target
			}
		});
	}catch{
		// Observability must never make the MCP request fail.
	}
}

function stripContextPayload(value:any){
	if(!value||typeof value!=='object')return value;
	const files=Array.isArray(value.files)?value.files.map((file:any)=>{
		if(!file||typeof file!=='object')return file;
		const next={...file};
		for(const key of ['content','data','raw','body','text','base64','blob','bytesData'])delete next[key];
		return next;
	}):value.files;
	return files===undefined?value:{...value,files};
}

async function compactUiResponse(response:Response,toolName:string|null){
	if(!toolName||(!UI_STATE_TOOLS.has(toolName)&&toolName!=='get_active_context'))return response;
	const contentType=response.headers.get('content-type')||'';
	if(!contentType.includes('application/json')||response.status===204)return response;
	const text=await response.text();
	if(!text)return response;
	let payload:any;
	try{payload=JSON.parse(text);}catch{return new Response(text,{status:response.status,statusText:response.statusText,headers:response.headers});}
	const result=payload?.result;
	if(result&&typeof result==='object'){
		if(toolName==='get_active_context'){
			if(result._meta&&typeof result._meta==='object'&&'orbitfsUiState' in result._meta)delete result._meta.orbitfsUiState;
		}else{
			const ui=result?._meta?.orbitfsUiState;
			if(ui&&typeof ui==='object'){
				if(ui.activeContext!==undefined)ui.activeContext=stripContextPayload(ui.activeContext);
				if(ui.receipt!==undefined)ui.receipt=stripContextPayload(ui.receipt);
				delete ui.activeFiles;
			}
		}
	}
	const headers=new Headers(response.headers);
	headers.set('content-type','application/json; charset=utf-8');
	headers.delete('content-length');
	return new Response(JSON.stringify(payload),{status:response.status,statusText:response.statusText,headers});
}

async function handle(request: Request) {
	const settings = await getMcpEngineSettings();
	try {
		const inspected=await inspectRequest(request);
		const transportFailure = validateTransportRequest(request, settings, inspected);
		if (transportFailure) return transportFailure;
		const started=Date.now();
		let response = await handleMcpAddonRequest(request);
		if (response.status < 500) void noteAddonRequest('mcp');
		if(inspected.toolCall)await auditToolCall(request,inspected.toolCall,response,Date.now()-started);
		response=await compactUiResponse(response,inspected.toolCall?.name||null);

		if (settings.logRejectedRequests && response.status >= 400) {
			console.warn('[orbitfs-mcp] request rejected', { method: request.method, status: response.status });
		}
		return response;
	} catch (error:any) {
		if (settings.logRejectedRequests) {
			console.warn('[orbitfs-mcp] transport unavailable', {
				method: request.method,
				status: Number(error?.status || 503),
				code: String(error?.code || 'MCP_UNAVAILABLE'),
				error: String(error?.message || 'MCP unavailable')
			});
		}
		return transportError(String(error?.message || 'MCP unavailable'), String(error?.code || 'MCP_UNAVAILABLE'), Number(error?.status || 503));
	}
}

export const GET: RequestHandler = async ({ request }) => handle(request);
export const POST: RequestHandler = async ({ request }) => handle(request);
export const DELETE: RequestHandler = async ({ request }) => handle(request);
