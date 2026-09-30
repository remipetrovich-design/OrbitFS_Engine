import { getSupabaseAdmin } from '$lib/server/supabase';
import { getWorkspace, requireWorkspaceAccess, requireWorkspacePermission } from '$lib/server/workspaces';
import type { OrbitUser } from '$lib/server/auth';

const PRESETS = ['low','medium','high','custom1','custom2'];
const now = () => new Date().toISOString();

export async function requireMcpWorkspace(user: OrbitUser, workspaceId: string, action?: string) {
	const workspace = await getWorkspace(workspaceId);
	if (action) await requireWorkspacePermission(user, workspace, action);
	else await requireWorkspaceAccess(user, workspace);
	return workspace;
}

export async function listMcpProjects(workspaceId: string) {
	const db = getSupabaseAdmin();
	const { data: projects, error } = await db.from('mcp_projects').select('*').eq('workspace_id', workspaceId).order('name');
	if (error) throw error;
	const ids = (projects ?? []).map((p:any) => p.id);
	const items = ids.length ? (await db.from('mcp_project_items').select('*').in('project_id', ids).order('id')).data ?? [] : [];
	return (projects ?? []).map((p:any) => ({ ...p, items: items.filter((i:any) => i.project_id === p.id) }));
}
export async function saveMcpProject(workspaceId: string, user: OrbitUser, body: any, projectId?: string) {
	const db = getSupabaseAdmin();
	const payload = {
		workspace_id: workspaceId, name: String(body.name || '').trim(),
		description: String(body.description || ''), instructions: String(body.instructions || ''),
		ai_behaviour: String(body.aiBehaviour ?? body.ai_behaviour ?? ''), enabled: body.enabled !== false,
		updated_at: now()
	};
	let id = projectId;
	if (id) {
		const r = await db.from('mcp_projects').update(payload).eq('id', id).eq('workspace_id', workspaceId).select('id').single();
		if (r.error) throw r.error;
	} else {
		const r = await db.from('mcp_projects').insert({ ...payload, created_by_user_id: user.id, created_by_username: user.username }).select('id').single();
		if (r.error) throw r.error; id = r.data.id;
	}
	await db.from('mcp_project_items').delete().eq('project_id', id!);
	const items = (body.items || []).map((item:any) => ({ project_id:id, item_type:item.type || item.item_type || 'file', item_path:String(item.path || item.item_path || '').replace(/^\/+|\/+$/g,''), missing:false }));
	if (items.length) { const r = await db.from('mcp_project_items').insert(items); if (r.error) throw r.error; }
	return (await listMcpProjects(workspaceId)).find((p:any) => p.id === id);
}

export async function deleteMcpProject(workspaceId: string, projectId: string) {
	const db = getSupabaseAdmin();
	const r = await db.from('mcp_projects').delete().eq('workspace_id', workspaceId).eq('id', projectId);
	if (r.error) throw r.error;
}
export async function projectBundleAssignments(projectId: string) {
	const db = getSupabaseAdmin();
	const { data, error } = await db.from('mcp_project_context_bundles').select('bundle_id,required_flag,sort_order,mcp_context_bundles(name)').eq('project_id', projectId).order('sort_order');
	if (error) throw error;
	return (data ?? []).map((r:any) => ({ bundleId:r.bundle_id, name:r.mcp_context_bundles?.name, required:r.required_flag !== false }));
}

export async function saveProjectBundleAssignments(projectId: string, assignments: any[]) {
	const db = getSupabaseAdmin();
	const del = await db.from('mcp_project_context_bundles').delete().eq('project_id', projectId);
	if (del.error) throw del.error;
	const rows = (assignments || []).map((a:any,i:number) => ({ project_id:projectId, bundle_id:a.bundleId, required_flag:a.required !== false, sort_order:i }));
	if (rows.length) { const r = await db.from('mcp_project_context_bundles').insert(rows); if (r.error) throw r.error; }
}

export async function listContextBundles(workspaceId: string) {
	const db = getSupabaseAdmin();
	const { data: bundles, error } = await db.from('mcp_context_bundles').select('*').eq('workspace_id', workspaceId).order('name');
	if (error) throw error;
	const ids = (bundles ?? []).map((b:any) => b.id);
	const [entries,deps] = ids.length ? await Promise.all([
		db.from('mcp_context_bundle_entries').select('bundle_id').in('bundle_id', ids),
		db.from('mcp_context_bundle_dependencies').select('bundle_id').in('bundle_id', ids)
	]) : [{data:[]},{data:[]}];
	return (bundles ?? []).map((b:any) => ({ ...b, entryCount:(entries.data ?? []).filter((x:any)=>x.bundle_id===b.id).length, dependencyCount:(deps.data ?? []).filter((x:any)=>x.bundle_id===b.id).length }));
}
export async function getContextBundle(workspaceId: string, bundleId: string) {
	const db = getSupabaseAdmin();
	const { data:bundle,error } = await db.from('mcp_context_bundles').select('*').eq('workspace_id',workspaceId).eq('id',bundleId).single();
	if (error) throw error;
	const [entries,deps] = await Promise.all([
		db.from('mcp_context_bundle_entries').select('*').eq('bundle_id',bundleId).order('sort_order'),
		db.from('mcp_context_bundle_dependencies').select('*').eq('bundle_id',bundleId).order('sort_order')
	]);
	const depIds=(deps.data??[]).map((d:any)=>d.depends_on_bundle_id);
	const depNames=depIds.length?(await db.from('mcp_context_bundles').select('id,name').in('id',depIds)).data??[]:[];
	return { ...bundle,
		entries:(entries.data ?? []).map((e:any)=>({ type:e.entry_type,path:e.item_path,attachmentType:e.attachment_type,profileId:e.profile_id,profileName:e.profile_name,knowledgeItemId:e.knowledge_item_id,knowledgeItemName:e.knowledge_item_name,loadMode:e.load_mode,recursive:e.recursive_flag,required:e.required_flag,priority:e.priority })),
		dependencies:(deps.data ?? []).map((d:any)=>({ bundleId:d.depends_on_bundle_id,name:depNames.find((n:any)=>n.id===d.depends_on_bundle_id)?.name,required:d.required_flag !== false }))
	};
}

export async function saveContextBundle(workspaceId:string,user:OrbitUser,body:any,bundleId?:string) {
	const db=getSupabaseAdmin();
	const payload={workspace_id:workspaceId,name:String(body.name||'').trim(),description:String(body.description||''),enabled:body.enabled!==false,updated_at:now()};
	let id=bundleId;
	if(id){ const r=await db.from('mcp_context_bundles').update({...payload,version:(Number(body.version)||1)+1}).eq('workspace_id',workspaceId).eq('id',id).select('id').single(); if(r.error)throw r.error; }
	else { const r=await db.from('mcp_context_bundles').insert({...payload,created_by_user_id:user.id}).select('id').single(); if(r.error)throw r.error; id=r.data.id; }
	await Promise.all([db.from('mcp_context_bundle_entries').delete().eq('bundle_id',id!),db.from('mcp_context_bundle_dependencies').delete().eq('bundle_id',id!)]);
	const entries=(body.entries||[]).map((e:any,i:number)=>{
		const attachmentType=e.attachmentType==='knowledge'?'knowledge':e.attachmentType==='profile'?'profile':'path';
		const knowledgeItemId=String(e.knowledgeItemId||'').trim(),profileId=String(e.profileId||'').trim(),path=String(e.path||'').replace(/^\/+|\/+$/g,'');
		if(attachmentType==='knowledge'&&!knowledgeItemId) throw Object.assign(new Error('Library bundle entries require a Knowledge Item ID'),{status:400,code:'CCS_KNOWLEDGE_ID_REQUIRED'});
		if(attachmentType==='profile'&&!profileId) throw Object.assign(new Error('Profile bundle entries require a Profile ID'),{status:400,code:'CCS_PROFILE_ID_REQUIRED'});
		if(attachmentType==='path'&&!path) throw Object.assign(new Error('Legacy path entries require a path'),{status:400,code:'CCS_PATH_REQUIRED'});
		return {bundle_id:id,entry_type:attachmentType==='knowledge'?'knowledge':(e.type||'file'),item_path:path,attachment_type:attachmentType,profile_id:attachmentType==='profile'?profileId:null,profile_name:attachmentType==='profile'?(e.profileName||null):null,knowledge_item_id:attachmentType==='knowledge'?knowledgeItemId:null,knowledge_item_name:attachmentType==='knowledge'?(e.knowledgeItemName||null):null,load_mode:attachmentType==='knowledge'&&['smart','full','summary'].includes(String(e.loadMode||''))?String(e.loadMode):attachmentType==='knowledge'?'smart':null,recursive_flag:attachmentType==='path'?Boolean(e.recursive):false,required_flag:e.required!==false,priority:Number(e.priority||100),sort_order:i};
	});
	const deps=(body.dependencies||[]).filter((d:any)=>d.bundleId&&d.bundleId!==id).map((d:any,i:number)=>({bundle_id:id,depends_on_bundle_id:d.bundleId,required_flag:d.required!==false,sort_order:i}));
	if(entries.length){const r=await db.from('mcp_context_bundle_entries').insert(entries);if(r.error)throw r.error;}
	if(deps.length){const r=await db.from('mcp_context_bundle_dependencies').insert(deps);if(r.error)throw r.error;}
	return getContextBundle(workspaceId,id!);
}

export async function deleteContextBundle(workspaceId:string,bundleId:string){
	const db=getSupabaseAdmin();
	const r=await db.from('mcp_context_bundles').delete().eq('workspace_id',workspaceId).eq('id',bundleId);
	if(r.error)throw r.error;
}

export async function getStartup(workspaceId:string){
	const db=getSupabaseAdmin();
	const [startup,projects,items,profiles,bundles]=await Promise.all([
		db.from('mcp_workspace_startup').select('*').eq('workspace_id',workspaceId).maybeSingle(),
		db.from('mcp_workspace_startup_projects').select('project_id').eq('workspace_id',workspaceId).order('sort_order'),
		db.from('mcp_workspace_default_items').select('*').eq('workspace_id',workspaceId).order('sort_order'),
		db.from('mcp_workspace_default_profiles').select('profile_id').eq('workspace_id',workspaceId).order('sort_order'),
		db.from('mcp_workspace_default_profile_bundles').select('profile_bundle_id').eq('workspace_id',workspaceId).order('sort_order')]);
	return { strength:startup.data?.strength||'medium',instructions:startup.data?.instructions||'',aiBehaviour:startup.data?.ai_behaviour||'',projectIds:(projects.data??[]).map((x:any)=>x.project_id),defaultItems:(items.data??[]).map((x:any)=>({type:x.item_type,path:x.item_path,recursive:x.item_type==='folder'})),defaultProfileIds:(profiles.data??[]).map((x:any)=>x.profile_id),defaultProfileBundleIds:(bundles.data??[]).map((x:any)=>x.profile_bundle_id) };
}
export async function saveStartup(workspaceId:string,user:OrbitUser,body:any){
	const db=getSupabaseAdmin();
	const r=await db.from('mcp_workspace_startup').upsert({workspace_id:workspaceId,strength:body.strength||'medium',instructions:String(body.instructions||''),ai_behaviour:String(body.aiBehaviour||''),updated_by_user_id:user.id,updated_at:now()},{onConflict:'workspace_id'});
	if(r.error)throw r.error;
	await db.from('mcp_workspace_startup_projects').delete().eq('workspace_id',workspaceId);
	const rows=(body.projectIds||[]).map((projectId:string,i:number)=>({workspace_id:workspaceId,project_id:projectId,sort_order:i}));
	if(rows.length){const q=await db.from('mcp_workspace_startup_projects').insert(rows);if(q.error)throw q.error;}
	return getStartup(workspaceId);
}

export async function saveDefaultItems(workspaceId:string,items:any[]){
	const db=getSupabaseAdmin();await db.from('mcp_workspace_default_items').delete().eq('workspace_id',workspaceId);
	const rows=(items||[]).map((x:any,i:number)=>({workspace_id:workspaceId,item_type:x.type||x.item_type||'file',item_path:String(x.path||x.item_path||'').replace(/^\/+|\/+$/g,''),missing:false,sort_order:i}));
	if(rows.length){const r=await db.from('mcp_workspace_default_items').insert(rows);if(r.error)throw r.error;}
}

export async function saveDefaultProfiles(workspaceId:string,profileIds:string[],profileBundleIds:string[]){
	const db=getSupabaseAdmin();
	await Promise.all([db.from('mcp_workspace_default_profiles').delete().eq('workspace_id',workspaceId),db.from('mcp_workspace_default_profile_bundles').delete().eq('workspace_id',workspaceId)]);
	const p=(profileIds||[]).map((id,i)=>({workspace_id:workspaceId,profile_id:id,sort_order:i}));
	const b=(profileBundleIds||[]).map((id,i)=>({workspace_id:workspaceId,profile_bundle_id:id,sort_order:i}));
	if(p.length){const r=await db.from('mcp_workspace_default_profiles').insert(p);if(r.error)throw r.error;}
	if(b.length){const r=await db.from('mcp_workspace_default_profile_bundles').insert(b);if(r.error)throw r.error;}
}
function presetTables(projectId?:string|null){
	return projectId ? {
		items:'mcp_project_preset_items',profiles:'mcp_project_preset_profiles',profileBundles:'mcp_project_preset_profile_bundles',metadata:'mcp_project_preset_metadata',bundles:'mcp_project_preset_bundles',scope:'project_id',scopeId:projectId
	} : {
		items:'mcp_workspace_preset_items',profiles:'mcp_workspace_preset_profiles',profileBundles:'mcp_workspace_preset_profile_bundles',metadata:'mcp_workspace_preset_metadata',bundles:'mcp_workspace_preset_bundles',scope:'workspace_id',scopeId:null
	};
}

export async function getPresets(workspaceId:string,projectId?:string|null){
	const db=getSupabaseAdmin(),t=presetTables(projectId); const scopeId=projectId||workspaceId;
	const [items,profiles,profileBundles,rows]=await Promise.all([
		db.from(t.items).select('*').eq(t.scope,scopeId),db.from(t.profiles).select('*').eq(t.scope,scopeId),db.from(t.profileBundles).select('*').eq(t.scope,scopeId),
		projectId?Promise.resolve({data:[]}):db.from('mcp_workspace_presets').select('*').eq('workspace_id',workspaceId)]);
	const presets:any={};
	for(const p of PRESETS){ const row=(rows.data??[]).find((x:any)=>x.preset===p); presets[p]={ projectId:projectId||row?.project_id||null, items:(items.data??[]).filter((x:any)=>x.preset===p).sort((a:any,b:any)=>a.sort_order-b.sort_order).map((x:any)=>({item_type:x.item_type,item_path:x.item_path,recursive:x.recursive_flag})), profileIds:(profiles.data??[]).filter((x:any)=>x.preset===p).sort((a:any,b:any)=>a.sort_order-b.sort_order).map((x:any)=>x.profile_id), profileBundleIds:(profileBundles.data??[]).filter((x:any)=>x.preset===p).sort((a:any,b:any)=>a.sort_order-b.sort_order).map((x:any)=>x.profile_bundle_id) }; }
	return presets;
}
export async function savePresets(workspaceId:string,user:OrbitUser,body:any,projectId?:string|null){
	const db=getSupabaseAdmin(),t=presetTables(projectId); const scopeId=projectId||workspaceId;
	await Promise.all([db.from(t.items).delete().eq(t.scope,scopeId),db.from(t.profiles).delete().eq(t.scope,scopeId),db.from(t.profileBundles).delete().eq(t.scope,scopeId)]);
	if(!projectId) await db.from('mcp_workspace_presets').delete().eq('workspace_id',workspaceId);
	const itemRows:any[]=[],profileRows:any[]=[],bundleRows:any[]=[],presetRows:any[]=[];
	for(const p of PRESETS){ const state=body.presets?.[p]||{};
		if(!projectId) presetRows.push({workspace_id:workspaceId,preset:p,project_id:state.projectId||body.projectId||null,updated_by_user_id:user.id,updated_at:now()});
		(state.items||[]).forEach((x:any,i:number)=>itemRows.push({[t.scope]:scopeId,preset:p,item_type:x.type||x.item_type||'file',item_path:String(x.path||x.item_path||'').replace(/^\/+|\/+$/g,''),recursive_flag:Boolean(x.recursive),sort_order:i}));
		(state.profileIds||[]).forEach((id:string,i:number)=>profileRows.push({[t.scope]:scopeId,preset:p,profile_id:id,sort_order:i}));
		(state.profileBundleIds||[]).forEach((id:string,i:number)=>bundleRows.push({[t.scope]:scopeId,preset:p,profile_bundle_id:id,sort_order:i}));
	}
	for(const [table,rows] of [[t.items,itemRows],[t.profiles,profileRows],[t.profileBundles,bundleRows]] as any){if(rows.length){const r=await db.from(table).insert(rows);if(r.error)throw r.error;}}
	if(presetRows.length){const r=await db.from('mcp_workspace_presets').insert(presetRows);if(r.error)throw r.error;}
	return getPresets(workspaceId,projectId);
}

export async function getPresetMetadata(workspaceId:string,projectId?:string|null){
	const db=getSupabaseAdmin(),t=presetTables(projectId),scopeId=projectId||workspaceId;
	const {data,error}=await db.from(t.metadata).select('*').eq(t.scope,scopeId);if(error)throw error;
	const result:any={}; for(const p of PRESETS){const row=(data??[]).find((x:any)=>x.preset===p);const def=p==='custom1'?'Custom 1':p==='custom2'?'Custom 2':p[0].toUpperCase()+p.slice(1);result[p]={preset:p,displayName:row?.display_name||def,defaultDisplayName:def};} return result;
}
export async function savePresetMetadata(workspaceId:string,user:OrbitUser,metadata:any,projectId?:string|null){
	const db=getSupabaseAdmin(),t=presetTables(projectId),scopeId=projectId||workspaceId;
	await db.from(t.metadata).delete().eq(t.scope,scopeId);
	const rows=PRESETS.map(p=>({[t.scope]:scopeId,preset:p,display_name:String(metadata?.[p]?.displayName||metadata?.[p]?.display_name||''),updated_by_user_id:user.id,updated_at:now()}));
	const r=await db.from(t.metadata).insert(rows);if(r.error)throw r.error;
	return getPresetMetadata(workspaceId,projectId);
}

export async function getPresetBundles(workspaceId:string,projectId?:string|null){
	const db=getSupabaseAdmin(),t=presetTables(projectId),scopeId=projectId||workspaceId;
	const {data,error}=await db.from(t.bundles).select('*').eq(t.scope,scopeId).order('sort_order');if(error)throw error;
	const bundleIds=[...new Set((data??[]).map((x:any)=>x.bundle_id))];
	const names=bundleIds.length?(await db.from('mcp_context_bundles').select('id,name').in('id',bundleIds)).data??[]:[];
	const result:any={};for(const p of PRESETS) result[p]=(data??[]).filter((x:any)=>x.preset===p).map((x:any)=>({bundleId:x.bundle_id,name:names.find((n:any)=>n.id===x.bundle_id)?.name,required:x.required_flag!==false})); return result;
}

export async function savePresetBundles(workspaceId:string,assignments:any,projectId?:string|null){
	const db=getSupabaseAdmin(),t=presetTables(projectId),scopeId=projectId||workspaceId;
	await db.from(t.bundles).delete().eq(t.scope,scopeId);
	const rows:any[]=[];for(const p of PRESETS)(assignments?.[p]||[]).forEach((a:any,i:number)=>rows.push({[t.scope]:scopeId,preset:p,bundle_id:a.bundleId,required_flag:a.required!==false,sort_order:i}));
	if(rows.length){const r=await db.from(t.bundles).insert(rows);if(r.error)throw r.error;}
	return getPresetBundles(workspaceId,projectId);
}
