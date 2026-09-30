import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

const LIBRARY_BUCKETS = ['items','collections','groups','categories','links','usage','sections','events','sourceHistory','autoLinks','entities','entityMentions','facts','factRelations','records','changeRequests'] as const;
type SnapshotEntry = { position:number; json:string };
type Snapshot = Map<string, SnapshotEntry>;
type CachedSnapshot = { snapshot:Snapshot; expiresAt:number };

let cached: { key: string; client: SupabaseClient } | null = null;
const libraryBaselines = new Map<string, CachedSnapshot>();
const contextBaselines = new Map<string, CachedSnapshot>();
const BASELINE_TTL_MS=120_000;
const BASELINE_MAX=256;

function cacheGet(cache:Map<string,CachedSnapshot>,key:string){
	const value=cache.get(key);
	if(!value)return undefined;
	if(value.expiresAt<=Date.now()){cache.delete(key);return undefined;}
	cache.delete(key);cache.set(key,value);
	return value.snapshot;
}
function cacheSet(cache:Map<string,CachedSnapshot>,key:string,snapshot:Snapshot){
	cache.delete(key);cache.set(key,{snapshot,expiresAt:Date.now()+BASELINE_TTL_MS});
	while(cache.size>BASELINE_MAX){const oldest=cache.keys().next().value;if(oldest===undefined)break;cache.delete(oldest);}
}

function json(value: unknown) { return JSON.stringify(value ?? null); }

function libraryObjectId(value:any, position:number) {
	return value && typeof value === 'object' && !Array.isArray(value) && value.id !== undefined && value.id !== null && String(value.id)
		? String(value.id)
		: `__pos:${position}`;
}

function contextItemKey(value:any, position:number) {
	if (value?.knowledgeItemId) return `knowledge:${String(value.knowledgeItemId)}`;
	if (value?.profileId) return `profile:${String(value.profileId)}`;
	const path = String(value?.path || '').replace(/^\/+|\/+$/g,'').toLowerCase();
	return path ? `path:${path}` : `item:${position}`;
}

function librarySnapshot(state:any):Snapshot {
	const out:Snapshot = new Map();
	for (const bucket of LIBRARY_BUCKETS) {
		const values = Array.isArray(state?.[bucket]) ? state[bucket] : [];
		values.forEach((payload:any, position:number) => out.set(`${bucket}\u0000${libraryObjectId(payload,position)}`, { position, json:json(payload) }));
	}
	return out;
}

function contextSnapshot(receipt:any):Snapshot {
	const out:Snapshot = new Map();
	const files = Array.isArray(receipt?.files) ? receipt.files : [];
	files.forEach((payload:any, position:number) => out.set(contextItemKey(payload,position), { position, json:json(payload) }));
	return out;
}

function diffLibrary(state:any, baseline:Snapshot) {
	const current = librarySnapshot(state), upserts:any[] = [], deletes:any[] = [];
	for (const bucket of LIBRARY_BUCKETS) {
		const values = Array.isArray(state?.[bucket]) ? state[bucket] : [];
		values.forEach((payload:any, position:number) => {
			const objectId=libraryObjectId(payload,position), key=`${bucket}\u0000${objectId}`, before=baseline.get(key), encoded=json(payload);
			if (!before || before.position !== position || before.json !== encoded) upserts.push({bucket,objectId,position,payload});
		});
	}
	for (const key of baseline.keys()) if (!current.has(key)) {
		const split=key.indexOf('\u0000');
		deletes.push({bucket:key.slice(0,split),objectId:key.slice(split+1)});
	}
	return {current,upserts,deletes};
}

function diffContext(receipt:any, baseline:Snapshot) {
	const current=contextSnapshot(receipt),upserts:any[]=[],deletes:string[]=[];
	const files=Array.isArray(receipt?.files)?receipt.files:[];
	files.forEach((payload:any,position:number)=>{
		const itemKey=contextItemKey(payload,position),before=baseline.get(itemKey),encoded=json(payload);
		if(!before||before.position!==position||before.json!==encoded)upserts.push({itemKey,position,payload});
	});
	for(const key of baseline.keys())if(!current.has(key))deletes.push(key);
	return{current,upserts,deletes};
}

function contextStorageKey(filters:Record<string,any>) {
	return [filters.user_id,filters.client_id,filters.workspace_id,filters.context_key].map(v=>String(v ?? '')).join('\u0000');
}

class NormalizedStateQuery {
	private mode:'select'|'delete'|'update'|'insert'|'upsert'='select';
	private filters:Record<string,any>={};
	private ops:{name:string;args:any[]}[]=[];
	private columns='*';
	private selectOptions:any=undefined;
	private payload:any;
	private writeOptions:any;
	constructor(private raw:SupabaseClient,private table:'orbitfs_library_state'|'mcp_active_contexts'){}
	select(columns='*',options?:any){this.columns=columns;this.selectOptions=options;return this;}
	eq(column:string,value:any){this.filters[column]=value;this.ops.push({name:'eq',args:[column,value]});return this;}
	neq(column:string,value:any){this.ops.push({name:'neq',args:[column,value]});return this;}
	is(column:string,value:any){this.ops.push({name:'is',args:[column,value]});return this;}
	in(column:string,value:any[]){this.ops.push({name:'in',args:[column,value]});return this;}
	gt(column:string,value:any){this.ops.push({name:'gt',args:[column,value]});return this;}
	gte(column:string,value:any){this.ops.push({name:'gte',args:[column,value]});return this;}
	lt(column:string,value:any){this.ops.push({name:'lt',args:[column,value]});return this;}
	lte(column:string,value:any){this.ops.push({name:'lte',args:[column,value]});return this;}
	contains(column:string,value:any){this.ops.push({name:'contains',args:[column,value]});return this;}
	order(column:string,options?:any){this.ops.push({name:'order',args:[column,options]});return this;}
	limit(value:number){this.ops.push({name:'limit',args:[value]});return this;}
	delete(){this.mode='delete';return this;}
	update(payload:any){this.mode='update';this.payload=payload;return this;}
	insert(payload:any,options?:any){this.mode='insert';this.payload=payload;this.writeOptions=options;return this;}
	upsert(payload:any,options?:any){this.mode='upsert';this.payload=payload;this.writeOptions=options;return this;}
	async maybeSingle(){return this.execute(true);}
	async single(){return this.execute(true);}
	then(resolve:any,reject:any){return this.execute(false).then(resolve,reject);}

	private onlyEqOps(){return this.ops.every(op=>op.name==='eq');}
	private hasContextKey(){return ['user_id','client_id','workspace_id','context_key'].every(key=>this.filters[key]!==undefined&&this.filters[key]!==null);}
	private async fallback(single:boolean){
		let query:any=this.raw.from(this.table);
		if(this.mode==='select')query=query.select(this.columns,this.selectOptions);
		else if(this.mode==='delete')query=query.delete();
		else if(this.mode==='update')query=query.update(this.payload);
		else if(this.mode==='insert')query=query.insert(this.payload,this.writeOptions);
		else query=query.upsert(this.payload,this.writeOptions);
		for(const op of this.ops){const args=op.args.filter((value,index)=>!(index===1&&value===undefined));query=query[op.name](...args);}
		return single?query.maybeSingle():query;
	}

	private async execute(single:boolean):Promise<any>{
		if(this.mode==='upsert'){
			if(this.table==='orbitfs_library_state'&&this.payload?.workspace_id&&this.payload?.state)return this.upsertLibrary(this.payload);
			if(this.table==='mcp_active_contexts'&&this.payload?.receipt&&this.payload?.user_id&&this.payload?.client_id&&this.payload?.workspace_id&&this.payload?.context_key)return this.upsertContext(this.payload);
			return this.fallback(single);
		}
		if(this.mode==='delete'&&this.table==='mcp_active_contexts'&&this.hasContextKey()&&this.onlyEqOps()){
			const key=contextStorageKey(this.filters);
			const result=await this.raw.rpc('orbitfs_mcp_context_clear',{
				p_user_id:this.filters.user_id,p_client_id:this.filters.client_id,p_workspace_id:this.filters.workspace_id,p_context_key:this.filters.context_key
			});
			if(!result.error)contextBaselines.delete(key);
			return{data:result.error?null:true,error:result.error};
		}
		if(this.mode!=='select')return this.fallback(single);
		if(this.table==='orbitfs_library_state'&&this.filters.workspace_id&&this.onlyEqOps()){
			const workspaceId=String(this.filters.workspace_id);
			const result=await this.raw.rpc('orbitfs_library_state_get',{p_workspace_id:workspaceId});
			if(result.error)return{data:null,error:result.error};
			if(result.data)cacheSet(libraryBaselines,workspaceId,librarySnapshot(result.data));
			return{data:result.data?{state:result.data,updated_at:result.data.updatedAt||null}:null,error:null};
		}
		if(this.table==='mcp_active_contexts'&&this.hasContextKey()&&this.onlyEqOps()){
			const key=contextStorageKey(this.filters);
			const result=await this.raw.rpc('orbitfs_mcp_context_get',{
				p_user_id:this.filters.user_id,p_client_id:this.filters.client_id,p_workspace_id:this.filters.workspace_id,p_context_key:this.filters.context_key
			});
			if(result.error)return{data:null,error:result.error};
			cacheSet(contextBaselines,key,contextSnapshot(result.data));
			return{data:result.data?{receipt:result.data}:null,error:null};
		}
		return this.fallback(single);
	}

	private async upsertLibrary(payload:any){
		const workspaceId=String(payload.workspace_id);
		let baseline=cacheGet(libraryBaselines,workspaceId);
		if(!baseline){
			const current=await this.raw.rpc('orbitfs_library_state_get',{p_workspace_id:workspaceId});
			if(current.error)return{data:null,error:current.error};
			baseline=librarySnapshot(current.data||{});
		}
		const change=diffLibrary(payload.state||{},baseline);
		const result=await this.raw.rpc('orbitfs_library_state_patch',{
			p_workspace_id:workspaceId,p_upserts:change.upserts,p_deletes:change.deletes,
			p_meta:{version:Number(payload.state?.version||9),settings:payload.state?.settings||{}}
		});
		if(!result.error)cacheSet(libraryBaselines,workspaceId,change.current);
		return{data:result.error?null:payload,error:result.error};
	}

	private async upsertContext(payload:any){
		const filters={user_id:payload.user_id,client_id:payload.client_id,workspace_id:payload.workspace_id,context_key:payload.context_key};
		const key=contextStorageKey(filters);
		let baseline=cacheGet(contextBaselines,key);
		if(!baseline){
			const current=await this.raw.rpc('orbitfs_mcp_context_get',{
				p_user_id:filters.user_id,p_client_id:filters.client_id,p_workspace_id:filters.workspace_id,p_context_key:filters.context_key
			});
			if(current.error)return{data:null,error:current.error};
			baseline=contextSnapshot(current.data);
		}
		const receipt=payload.receipt||{},change=diffContext(receipt,baseline);
		const header={...receipt};delete header.files;
		const result=await this.raw.rpc('orbitfs_mcp_context_patch',{
			p_user_id:filters.user_id,p_client_id:filters.client_id,p_workspace_id:filters.workspace_id,p_context_key:filters.context_key,
			p_header:header,p_upserts:change.upserts,p_deletes:change.deletes
		});
		if(!result.error)cacheSet(contextBaselines,key,change.current);
		return{data:result.error?null:payload,error:result.error};
	}
}

function normalizedClient(raw:SupabaseClient):SupabaseClient {
	return new Proxy(raw as any,{
		get(target,property,receiver){
			if(property==='from')return(table:string)=>table==='orbitfs_library_state'||table==='mcp_active_contexts'
				?new NormalizedStateQuery(raw,table as any)
				:raw.from(table);
			const value=Reflect.get(target,property,receiver);
			return typeof value==='function'?value.bind(raw):value;
		}
	}) as SupabaseClient;
}

export function getSupabaseAdmin() {
	const url = String(env.SUPABASE_URL || '').trim();
	const serviceKey = String(env.SUPABASE_SECRET_KEY || '').trim();
	const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || '').trim();
	const serverSecret = String(env.ORBITFS_DB_SECRET || '').trim();
	if (!url) throw new Error('SUPABASE_URL is required');
	if (serviceKey) {
		const key = `${url}\u0000service\u0000${serviceKey}`;
		if (cached?.key === key) return cached.client;
		const raw = createClient(url, serviceKey, {
			auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
		});
		const client=normalizedClient(raw);
		cached = { key, client };
		return client;
	}
	if (!publishableKey || !serverSecret) {
		throw new Error('SUPABASE_SECRET_KEY or SUPABASE_PUBLISHABLE_KEY + ORBITFS_DB_SECRET is required');
	}
	const key = `${url}\u0000runtime\u0000${publishableKey}\u0000${serverSecret}`;
	if (cached?.key === key) return cached.client;
	const raw = createClient(url, publishableKey, {
		auth: { persistSession: false, autoRefreshToken: false },
		global: { headers: { 'x-orbitfs-secret': serverSecret } }
	});
	const client=normalizedClient(raw);
	cached = { key, client };
	return client;
}
