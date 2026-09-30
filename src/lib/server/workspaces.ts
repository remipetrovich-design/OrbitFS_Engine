import type { OrbitUser } from '$lib/server/auth';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { ensureCoreFolders } from '$lib/server/base-compat';
import { REGISTERED_USER_PERMISSION_DEFAULTS, USER_CAPABILITIES } from '$lib/server/registration';

export const FILE_ACTIONS = ['read','write','download','move','delete','create','share'] as const;
export const MANAGEMENT_ACTIONS = [
	'view_settings','edit_settings','manage_members','manage_permissions','manage_library',
	'view_protected_folders','manage_protected_folders','mcp_use','manage_mcp_startup',
	'manage_mcp_preset_names','manage_mcp_projects','manage_mcp_settings',
	'ventmode_use','ventmode_configure','ventmode_read','ventmode_load','ventmode_create',
	'ventmode_draft','ventmode_upload','ventmode_discard','ventmode_read_others','ventmode_manage_others',
	'send_messages','sorter_view','sorter_scan','sorter_add_to_queue','sorter_review_queue',
	'sorter_manage_rules','sorter_apply','sorter_undo','sorter_auto_apply',
	'converter_view','converter_run','converter_manage_settings',
	'studio_view','studio_create','studio_edit','studio_finalize','studio_archive',
	'studio_manage_sessions','studio_manage_events','studio_manage_links','studio_manage_templates',
	'studio_import_export','studio_manage_settings','delete_workspace'
] as const;

export const BASE_MANAGEMENT_ACTIONS = ['view_settings','edit_settings','manage_members','manage_permissions','manage_library','view_protected_folders','manage_protected_folders','ventmode_use','ventmode_configure','ventmode_read','ventmode_load','ventmode_create','ventmode_draft','ventmode_upload','ventmode_discard','ventmode_read_others','ventmode_manage_others','send_messages','studio_view','studio_create','studio_edit','studio_finalize','studio_archive','studio_manage_sessions','studio_manage_events','studio_manage_links','studio_manage_templates','studio_import_export','studio_manage_settings','delete_workspace'] as const;
export const MANAGEMENT_LABELS: Record<string,string> = { view_settings:'View workspace settings',edit_settings:'Edit workspace settings',manage_members:'Manage members',manage_permissions:'Manage permissions',manage_library:'Manage Library / Knowledge',view_protected_folders:'View protected folders',manage_protected_folders:'Manage protected folders',ventmode_use:'Use Vent Mode',ventmode_configure:'Configure Vent Mode',ventmode_read:'View Vent Mode vents',ventmode_load:'Load Vent Mode vents',ventmode_create:'Create Vent Mode vents',ventmode_draft:'Save Vent Mode drafts',ventmode_upload:'Upload/finalise Vent Mode vents',ventmode_discard:'Discard Vent Mode working vents',ventmode_read_others:'View other users Vent Mode vents',ventmode_manage_others:'Manage other users Vent Mode vents',send_messages:'Send workspace messages',mcp_use:'Use MCP',manage_mcp_startup:'Manage MCP startup',manage_mcp_preset_names:'Manage MCP preset names',manage_mcp_projects:'Manage MCP projects',manage_mcp_settings:'Manage MCP settings',sorter_view:'View APEX sorter',sorter_scan:'Scan with APEX sorter',sorter_add_to_queue:'Add to APEX queue',sorter_review_queue:'Review APEX queue',sorter_manage_rules:'Manage APEX sorter rules',sorter_apply:'Apply APEX changes',sorter_undo:'Undo APEX changes',sorter_auto_apply:'Use APEX auto-apply',converter_view:'View converter',converter_run:'Run converter',converter_manage_settings:'Manage converter settings',studio_view:'View Studio',studio_create:'Create Studio entries',studio_edit:'Edit Studio entries',studio_finalize:'Finalize Studio entries',studio_archive:'Archive Studio entries',studio_manage_sessions:'Manage Studio sessions',studio_manage_events:'Manage Studio timeline events',studio_manage_links:'Manage Studio references and sharing',studio_manage_templates:'Manage Studio templates',studio_import_export:'Import/export Studio',studio_manage_settings:'Manage Studio workspace settings',delete_workspace:'Delete workspace' };

export const DEFAULT_WORKSPACE_SETTINGS = {
	publicWorkspaceVisible:false, apexAccessMode:'workspace_owners', maxWorkspacesPerUser:2,
	inactiveBeforeOfflineDays:30, offlineWarningDays:7, deleteAfterOfflineDays:30,
	deletionWarningDays:7, defaultMaxProfiles:20, defaultMaxProfileSizeMB:50,
	defaultMaxTotalProfileStorageMB:0
};
const OWNER_MANAGEMENT = Object.fromEntries(MANAGEMENT_ACTIONS.map((key) => [key,true]));
const MANAGEMENT_DEFAULTS: Record<string,Record<string,boolean>> = {
	editor: {
		...OWNER_MANAGEMENT,
		delete_workspace:false
	},
	contributor: {
		view_settings:false, edit_settings:false, manage_members:false, manage_permissions:false, manage_library:false,
		view_protected_folders:false, manage_protected_folders:false, mcp_use:true,
		manage_mcp_startup:false, manage_mcp_preset_names:false, manage_mcp_projects:false,
		manage_mcp_settings:false, ventmode_use:true, ventmode_configure:false, ventmode_read:true,
		ventmode_load:true, ventmode_create:true, ventmode_draft:true, ventmode_upload:true,		ventmode_discard:true, ventmode_read_others:false, ventmode_manage_others:false,
		send_messages:false, sorter_view:true, sorter_scan:false, sorter_add_to_queue:true,
		sorter_review_queue:false, sorter_manage_rules:false, sorter_apply:false, sorter_undo:false,
		sorter_auto_apply:false, converter_view:true, converter_run:false,
		converter_manage_settings:false, studio_view:true, studio_create:true, studio_edit:true,
		studio_finalize:false, studio_archive:false, studio_manage_sessions:true, studio_manage_events:false,
		studio_manage_links:true, studio_manage_templates:false, studio_import_export:false, studio_manage_settings:false, delete_workspace:false
	},
	viewer: { ...Object.fromEntries(MANAGEMENT_ACTIONS.map((key) => [key,false])), studio_view:true }
};

export const isSystemAdmin = (user: OrbitUser) => user.role === 'owner' || user.role === 'admin';
export const cleanWorkspaceSlug = (value: unknown) => String(value ?? '').toLowerCase().trim()
	.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64) || 'workspace';

export async function effectiveUserPermissions(user: OrbitUser) {
	if (isSystemAdmin(user)) return Object.fromEntries(USER_CAPABILITIES.map((key) => [key,true]));
	const supabase = getSupabaseAdmin();
	const memberships = await supabase.from('orbitfs_group_members').select('group_id').eq('user_id',user.id);
	if (memberships.error) throw memberships.error;
	let groupPermissions: Record<string,boolean> = {};
	const ids = (memberships.data ?? []).map((row) => row.group_id);
	if (ids.length) {
		const groups = await supabase.from('orbitfs_groups').select('permissions').in('id',ids);
		if (groups.error) throw groups.error;
		for (const group of groups.data ?? []) groupPermissions = { ...groupPermissions, ...(group.permissions || {}) };
	}
	return Object.fromEntries(USER_CAPABILITIES.map((key) => [key,Boolean(groupPermissions[key] ?? user.permissions?.[key] ?? REGISTERED_USER_PERMISSION_DEFAULTS[key])]));
}
export async function readWorkspaceSettings() {
	const supabase = getSupabaseAdmin();
	const result = await supabase.from('orbitfs_settings').select('value')
		.eq('scope_type','global').eq('scope_id','').eq('key','workspaces').maybeSingle();
	if (result.error) throw result.error;
	const stored = result.data?.value && typeof result.data.value === 'object' ? result.data.value as Record<string,any> : {};
	return { ...DEFAULT_WORKSPACE_SETTINGS, ...stored, workspaceModeEnabled:true };
}

export async function saveWorkspaceSettings(input: Record<string,any>) {
	const next: Record<string,any> = { ...(await readWorkspaceSettings()) };
	for (const key of Object.keys(DEFAULT_WORKSPACE_SETTINGS)) {
		if (input[key] === undefined) continue;
		if (key === 'apexAccessMode') {
			const mode = String(input[key]);
			if (!['admins_only','workspace_owners','workspace_permissions'].includes(mode))
				throw Object.assign(new Error('Unknown APEX access mode'), { status:400 });
			next[key] = mode;
		} else if (key === 'publicWorkspaceVisible') next[key] = input[key] !== false;
		else next[key] = Math.max(0,Math.round(Number(input[key]) || 0));
	}
	delete next.workspaceModeEnabled;
	const supabase = getSupabaseAdmin();
	const saved = await supabase.from('orbitfs_settings').upsert(
		{ scope_type:'global',scope_id:'',key:'workspaces',value:next },
		{ onConflict:'scope_type,scope_id,key' }
	);
	if (saved.error) throw saved.error;
	return { ...next,workspaceModeEnabled:true };
}
export async function getWorkspace(workspaceId: string) {
	const supabase = getSupabaseAdmin();
	const result = await supabase.from('orbitfs_workspaces').select('*').eq('id',workspaceId).maybeSingle();
	if (result.error) throw result.error;
	if (!result.data) throw Object.assign(new Error('Workspace not found'), { status:404 });
	return result.data;
}

export async function workspaceRole(user: OrbitUser, workspace: any) {
	if (isSystemAdmin(user)) return 'owner';
	if (workspace.owner_id === user.id || workspace.created_by === user.id) return 'owner';
	const supabase = getSupabaseAdmin();
	const result = await supabase.from('orbitfs_workspace_members').select('role')
		.eq('workspace_id',workspace.id).eq('user_id',user.id).maybeSingle();
	if (result.error) throw result.error;
	if (result.data?.role) return String(result.data.role);
	const permissions = await effectiveUserPermissions(user);
	if (workspace.visibility === 'public' && permissions.access_public_workspace) return 'viewer';
	return null;
}

async function readManagementOverrides(workspaceId: string) {
	const supabase = getSupabaseAdmin();
	const result = await supabase.from('orbitfs_settings').select('value')
		.eq('scope_type','workspace').eq('scope_id',workspaceId).eq('key','management_permissions').maybeSingle();
	if (result.error) throw result.error;
	return result.data?.value && typeof result.data.value === 'object' ? result.data.value as Record<string,Record<string,boolean>> : {};
}
export async function managementPermissions(user: OrbitUser, workspace: any, role?: string | null) {
	const resolved = role ?? await workspaceRole(user,workspace) ?? 'viewer';
	if (isSystemAdmin(user) || resolved === 'owner') return { ...OWNER_MANAGEMENT };
	const overrides = await readManagementOverrides(workspace.id);
	const defaults = MANAGEMENT_DEFAULTS[resolved] ?? MANAGEMENT_DEFAULTS.viewer;
	const permissions = Object.fromEntries(MANAGEMENT_ACTIONS.map((key) => [key,Boolean(overrides?.[resolved]?.[key] ?? defaults[key])]));
	const settings = await readWorkspaceSettings();
	if (workspace.apex_system_enabled === false || settings.apexAccessMode === 'admins_only' ||
		(settings.apexAccessMode === 'workspace_owners' && resolved !== 'owner')) {
		for (const key of MANAGEMENT_ACTIONS.filter((item) => item.startsWith('sorter_') || item.startsWith('converter_'))) permissions[key] = false;
	}
	if (resolved !== 'owner') {
		permissions.ventmode_configure = false;
		permissions.ventmode_read_others = false;
		permissions.ventmode_manage_others = false;
	}
	return permissions;
}

export async function requireWorkspaceAccess(user: OrbitUser, workspace: any) {
	if (workspace.status === 'suspended' && !isSystemAdmin(user))
		throw Object.assign(new Error(workspace.suspension_reason || 'Workspace is suspended'), { status:423 });
	const role = await workspaceRole(user,workspace);
	if (!role) throw Object.assign(new Error('Workspace access denied'), { status:403 });
	return role;
}

export async function requireWorkspacePermission(user: OrbitUser, workspace: any, action: string) {
	const role = await requireWorkspaceAccess(user,workspace);
	const permissions = await managementPermissions(user,workspace,role);
	if (!permissions[action]) throw Object.assign(new Error(`Workspace permission required: ${action}`), { status:403,code:'WORKSPACE_PERMISSION_REQUIRED' });
	return role;
}
export async function workspaceStats(workspaceId: string) {
	const supabase = getSupabaseAdmin();
	const [filesResult,profileResult] = await Promise.all([
		supabase.from('orbitfs_files').select('path,kind,size_bytes').eq('workspace_id',workspaceId).is('deleted_at',null),
		supabase.from('orbitfs_profile_state').select('state').eq('workspace_id',workspaceId).maybeSingle()
	]);
	if (filesResult.error) throw filesResult.error;
	if (profileResult.error) throw profileResult.error;
	let quota=0,trash=0,media=0,system=0,files=0,folders=0;
	for (const row of filesResult.data ?? []) {
		if (row.kind === 'folder') { folders += 1; continue; }
		files += 1;
		const size = Number(row.size_bytes || 0);
		const root = String(row.path || '').split('/')[0];
		if (root === '_trash') trash += size;
		else if (root === '_media') media += size;
		else if (root === '_sorter' || root === '_archive') system += size;
		else quota += size;
	}
	const profileBytes = profileResult.data?.state ? Buffer.byteLength(JSON.stringify(profileResult.data.state),'utf8') : 0;
	return { quota,trash,media,system,profileBytes,files,folders,total:quota+trash+media+system+profileBytes };
}

export async function presentWorkspace(user: OrbitUser, workspace: any, role?: string | null) {
	const supabase = getSupabaseAdmin();
	const resolved = role ?? await workspaceRole(user,workspace) ?? 'viewer';
	const ownerId = workspace.visibility === 'public' ? null : (workspace.owner_id || workspace.created_by || null);
	let ownerUsername = 'System';	if (ownerId) {
		const owner = await supabase.from('orbitfs_users').select('username').eq('id',ownerId).maybeSingle();
		if (owner.error) throw owner.error;
		ownerUsername = owner.data?.username || 'System';
	}
	const stats = await workspaceStats(workspace.id);
	return {
		...workspace,
		owner_id:ownerId, owner_username:ownerUsername, permission:resolved,
		is_public:workspace.visibility === 'public',
		auto_delete_immune:Boolean(workspace.auto_delete_immune || workspace.delete_protected),
		drive_state:workspace.status === 'active' ? 'online':'offline',
		storage_used_bytes:stats.quota, quota_used_bytes:stats.quota,
		trash_used_bytes:stats.trash, media_used_bytes:stats.media,
		system_used_bytes:stats.system + stats.profileBytes,
		profile_storage_used_bytes:stats.profileBytes,
		total_physical_used_bytes:stats.total,
		file_count:stats.files, folder_count:stats.folders,
		filesystem_root:`supabase://${workspace.id}`,
		management_permissions:await managementPermissions(user,workspace,resolved)
	};
}

export async function visibleWorkspaces(user: OrbitUser) {
	const supabase = getSupabaseAdmin();
	const [workspaceResult,memberResult,settingResult,permissions,globalSettings] = await Promise.all([
		supabase.from('orbitfs_workspaces').select('*').neq('status','archived').order('is_main',{ascending:false}).order('name'),
		supabase.from('orbitfs_workspace_members').select('workspace_id,role').eq('user_id',user.id),
		supabase.from('orbitfs_settings').select('scope_id,value').eq('scope_type','workspace').eq('key','management_permissions'),
		effectiveUserPermissions(user),
		readWorkspaceSettings()
	]);
	for (const result of [workspaceResult,memberResult,settingResult]) if (result.error) throw result.error;
	const workspaces = workspaceResult.data ?? [];
	const ownerIds = [...new Set(workspaces.map((ws:any) => ws.owner_id || ws.created_by).filter(Boolean))];
	const ownerResult = ownerIds.length ? await supabase.from('orbitfs_users').select('id,username').in('id',ownerIds) : { data:[],error:null } as any;
	if (ownerResult.error) throw ownerResult.error;
	const ownerNames = new Map((ownerResult.data ?? []).map((row:any) => [row.id,row.username]));
	const memberRoles = new Map((memberResult.data ?? []).map((row:any) => [row.workspace_id,row.role]));
	const managementOverrides = new Map((settingResult.data ?? []).map((row:any) => [row.scope_id,row.value || {}]));
	const visible:any[] = [];
	for (const workspace of workspaces) {
		let role:string|null = isSystemAdmin(user) ? 'owner' : (workspace.owner_id===user.id || workspace.created_by===user.id ? 'owner' : String(memberRoles.get(workspace.id) || '') || null);
		if (!role && workspace.visibility==='public' && permissions.access_public_workspace) role='viewer';
		if (!role) continue;
		const overrides:any = managementOverrides.get(workspace.id) || {};
		const management = isSystemAdmin(user) || role==='owner' ? { ...OWNER_MANAGEMENT } : Object.fromEntries(MANAGEMENT_ACTIONS.map((key)=>[key,Boolean(overrides?.[role]?.[key] ?? MANAGEMENT_DEFAULTS[role]?.[key])]));
		if (workspace.apex_system_enabled===false || globalSettings.apexAccessMode==='admins_only' || (globalSettings.apexAccessMode==='workspace_owners' && role!=='owner')) for (const key of MANAGEMENT_ACTIONS.filter((item)=>item.startsWith('sorter_')||item.startsWith('converter_'))) management[key]=false;
		if (role!=='owner') { management.ventmode_configure=false; management.ventmode_read_others=false; management.ventmode_manage_others=false; }
		const ownerId=workspace.visibility==='public' ? null : (workspace.owner_id || workspace.created_by || null);
		visible.push({ ...workspace,owner_id:ownerId,owner_username:ownerNames.get(ownerId)||'System',permission:role,is_public:workspace.visibility==='public',auto_delete_immune:Boolean(workspace.auto_delete_immune||workspace.delete_protected),drive_state:workspace.status==='active'?'online':'offline',management_permissions:management });
	}
	return visible;
}

export async function workspaceMembers(workspaceId: string) {
	const supabase = getSupabaseAdmin();
	const result = await supabase.from('orbitfs_workspace_members')
		.select('workspace_id,user_id,role,mcp_enabled,orbitfs_users!inner(username,role)')
		.eq('workspace_id',workspaceId).order('created_at');
	if (result.error) throw result.error;
	return (result.data ?? []).map((row:any) => ({
		user_id:row.user_id,
		username:row.orbitfs_users?.username || row.user_id,
		permission:row.role,
		system_role:row.orbitfs_users?.role || 'user',
		mcp_enabled:Boolean(row.mcp_enabled)
	}));
}

export async function fileRoleOverrides(workspaceId: string) {
	const supabase = getSupabaseAdmin();
	const result = await supabase.from('orbitfs_file_permissions').select('*')
		.eq('workspace_id',workspaceId).eq('principal_type','role')
		.in('principal_id',['editor','contributor','viewer']).order('path_prefix');
	if (result.error) throw result.error;
	return (result.data ?? []).map((row:any) => ({
		path:row.path_prefix, role:row.principal_id,
		permissions:{ read:row.can_view===true, write:row.can_edit===true,
			download:row.can_download===true, move:row.can_move===true,
			delete:row.can_delete===true, create:row.can_create===true, share:row.can_share===true }
	}));
}
export async function managementPermissionResponse(workspaceId: string) {
	const overrides = await readManagementOverrides(workspaceId);
	const effective: Record<string,Record<string,boolean>> = {};
	for (const role of ['owner','editor','contributor','viewer']) {
		effective[role] = role === 'owner' ? { ...OWNER_MANAGEMENT } :
			Object.fromEntries(MANAGEMENT_ACTIONS.map((key) => [key,Boolean(overrides?.[role]?.[key] ?? MANAGEMENT_DEFAULTS[role]?.[key])]));
	}
	return { overrides,effective };
}

export async function saveManagementPermissions(workspaceId: string, role: string, input: Record<string,any>) {
	if (!['editor','contributor','viewer'].includes(role)) throw Object.assign(new Error('Invalid workspace role'), { status:400 });
	const overrides = await readManagementOverrides(workspaceId);
	overrides[role] = Object.fromEntries(MANAGEMENT_ACTIONS.map((key) => [key,Boolean(input?.[key])]));
	const supabase = getSupabaseAdmin();
	const saved = await supabase.from('orbitfs_settings').upsert(
		{ scope_type:'workspace',scope_id:workspaceId,key:'management_permissions',value:overrides },
		{ onConflict:'scope_type,scope_id,key' }
	);
	if (saved.error) throw saved.error;
	return overrides[role];
}

export async function resetManagementPermissions(workspaceId: string, role: string) {
	const overrides = await readManagementOverrides(workspaceId);
	delete overrides[role];
	const supabase = getSupabaseAdmin();
	const saved = await supabase.from('orbitfs_settings').upsert(
		{ scope_type:'workspace',scope_id:workspaceId,key:'management_permissions',value:overrides },
		{ onConflict:'scope_type,scope_id,key' }
	);
	if (saved.error) throw saved.error;
}
export async function createWorkspace(user: OrbitUser, input: Record<string,any>) {
	const permissions = await effectiveUserPermissions(user);
	if (!permissions.create_workspaces) throw Object.assign(new Error('User permission required: create_workspaces'), { status:403 });
	const settings = await readWorkspaceSettings();
	const supabase = getSupabaseAdmin();
	if (!isSystemAdmin(user) && Number(settings.maxWorkspacesPerUser) > 0) {
		const count = await supabase.from('orbitfs_workspaces').select('*',{count:'exact',head:true})
			.eq('owner_id',user.id).neq('is_main',true).neq('status','archived');
		if (count.error) throw count.error;
		if ((count.count ?? 0) >= Number(settings.maxWorkspacesPerUser))
			throw Object.assign(new Error('Workspace limit reached'), { status:409 });
	}
	let owner = user;
	if (input.ownerUsername && isSystemAdmin(user)) {
		const requestedOwner = await supabase.from('orbitfs_users').select('*').ilike('username',String(input.ownerUsername).trim()).maybeSingle();
		if (requestedOwner.error) throw requestedOwner.error;
		if (!requestedOwner.data) throw Object.assign(new Error('Workspace owner user not found'), { status:404 });
		owner = requestedOwner.data as OrbitUser;
	}
	const name = String(input.name ?? '').trim().slice(0,80);
	if (name.length < 2) throw Object.assign(new Error('Workspace name must be at least 2 characters'), { status:400 });
	let slug = cleanWorkspaceSlug(name);
	const existing = await supabase.from('orbitfs_workspaces').select('id').like('slug',`${slug}%`);
	if (existing.error) throw existing.error;
	if ((existing.data ?? []).length) slug = `${slug}-${Date.now().toString(36)}`;
	const created = await supabase.from('orbitfs_workspaces').insert({
		name,slug,description:String(input.description ?? '').slice(0,500),status:'active',visibility:'private',
		owner_id:owner.id,created_by:user.id,storage_quota_bytes:5*1024**3,trash_limit_bytes:200*1024**2,
		mcp_ui_enabled:false,mcp_system_enabled:true,apex_system_enabled:true
	}).select('*').single();
	if (created.error || !created.data) throw created.error ?? new Error('Workspace creation failed');
	const member = await supabase.from('orbitfs_workspace_members').insert({ workspace_id:created.data.id,user_id:owner.id,role:'owner',mcp_enabled:false });
	if (member.error) throw member.error;
	await ensureCoreFolders(created.data.id,owner.id);
	return presentWorkspace(user,created.data,owner.id === user.id || isSystemAdmin(user) ? 'owner' : null);
}