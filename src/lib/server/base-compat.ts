import { getSupabaseAdmin } from '$lib/server/supabase';
import type { OrbitUser } from '$lib/server/auth';

export type WorkspaceRole = 'owner' | 'editor' | 'contributor' | 'viewer';
export type FileCapability = 'read' | 'write' | 'download' | 'move' | 'delete' | 'create' | 'share' | 'manage';

export type FolderPermissions = {
	read: boolean;
	write: boolean;
	download: boolean;
	move: boolean;
	delete: boolean;
	create: boolean;
	share: boolean;
};

const rank: Record<WorkspaceRole, number> = { viewer: 0, contributor: 1, editor: 2, owner: 3 };
export const STORAGE_BUCKET = 'orbitfs-files';
export const CORE_ROOTS = new Set(['_sorter', '_trash', '_archive', '_media']);

export function normalizePath(value: unknown) {
	return String(value ?? '')
		.replace(/\\/g, '/')
		.split('/')
		.filter((part) => part && part !== '.' && part !== '..')
		.join('/');
}

export function basename(value: string) {
	const clean = normalizePath(value);
	return clean.split('/').pop() ?? clean;
}

export function dirname(value: string) {
	const clean = normalizePath(value);
	const parts = clean.split('/').filter(Boolean);
	parts.pop();
	return parts.join('/');
}

export function storagePath(workspaceId: string, path: string) {
	return `${workspaceId}/${normalizePath(path)}`;
}

export function fixedCoreRoot(path: string) {
	return CORE_ROOTS.has(normalizePath(path));
}

export function protectedWorkspacePath(path: string) {
	const clean = normalizePath(path);
	const root = clean.split('/')[0] ?? '';
	return CORE_ROOTS.has(root);
}

export async function workspaceRole(user: OrbitUser, workspaceId: string): Promise<WorkspaceRole | null> {
	if (user.role === 'owner' || user.role === 'admin') return 'owner';
	const supabase = getSupabaseAdmin();
	const { data: member } = await supabase
		.from('orbitfs_workspace_members')
		.select('role')
		.eq('workspace_id', workspaceId)
		.eq('user_id', user.id)
		.maybeSingle();
	if (member?.role && member.role in rank) return member.role as WorkspaceRole;
	const { data: workspace } = await supabase
		.from('orbitfs_workspaces')
		.select('visibility')
		.eq('id', workspaceId)
		.maybeSingle();
	return workspace?.visibility === 'public' ? 'viewer' : null;
}

export async function accessibleWorkspaces(user: OrbitUser) {
	const supabase = getSupabaseAdmin();
	if (user.role === 'owner' || user.role === 'admin') {
		const { data, error } = await supabase.from('orbitfs_workspaces').select('*').order('is_main', { ascending: false }).order('name');
		if (error) throw error;
		return (data ?? []).map((row) => ({ ...row, permission: 'owner' as WorkspaceRole, drive_state: 'cloud' }));
	}
	const [{ data: memberships, error: memberError }, { data: publicRows, error: publicError }] = await Promise.all([
		supabase.from('orbitfs_workspace_members').select('workspace_id,role').eq('user_id', user.id),
		supabase.from('orbitfs_workspaces').select('*').eq('visibility', 'public')
	]);
	if (memberError) throw memberError;
	if (publicError) throw publicError;
	const memberMap = new Map((memberships ?? []).map((item) => [item.workspace_id, item.role as WorkspaceRole]));
	let memberRows: any[] = [];
	const ids = [...memberMap.keys()];
	if (ids.length) {
		const result = await supabase.from('orbitfs_workspaces').select('*').in('id', ids);
		if (result.error) throw result.error;
		memberRows = result.data ?? [];
	}
	const combined = new Map<string, any>();
	for (const row of publicRows ?? []) combined.set(row.id, { ...row, permission: memberMap.get(row.id) ?? 'viewer', drive_state: 'cloud' });
	for (const row of memberRows) combined.set(row.id, { ...row, permission: memberMap.get(row.id) ?? 'viewer', drive_state: 'cloud' });
	return [...combined.values()].sort((a, b) => Number(b.is_main) - Number(a.is_main) || a.name.localeCompare(b.name));
}

export async function selectedWorkspace(request: Request, user: OrbitUser) {
	const workspaces = await accessibleWorkspaces(user);
	if (!workspaces.length) throw Object.assign(new Error('No workspace is available'), { status: 404 });
	const requested = request.headers.get('x-workspace-id')?.trim();
	const selected = (requested ? workspaces.find((row) => row.id === requested) : null) ?? workspaces.find((row) => row.is_main) ?? workspaces[0];
	if (!selected) throw Object.assign(new Error('Workspace access denied'), { status: 403 });
	return selected;
}

function defaultPermissions(role: WorkspaceRole): FolderPermissions & { manage: boolean } {
	if (role === 'owner') return { read: true, write: true, download: true, move: true, delete: true, create: true, share: true, manage: true };
	if (role === 'editor') return { read: true, write: true, download: true, move: true, delete: true, create: true, share: true, manage: false };
	if (role === 'contributor') return { read: true, write: true, download: true, move: false, delete: false, create: true, share: false, manage: false };
	return { read: true, write: false, download: false, move: false, delete: false, create: false, share: false, manage: false };
}

export async function permissionsForPath(user: OrbitUser, workspaceId: string, path: string) {
	const role = await workspaceRole(user, workspaceId);
	if (!role) throw Object.assign(new Error('Workspace access denied'), { status: 403 });
	if (user.role === 'owner' || user.role === 'admin' || role === 'owner') return defaultPermissions('owner');
	const supabase = getSupabaseAdmin();
	const [{ data: groups }, { data: rows, error }] = await Promise.all([
		supabase.from('orbitfs_group_members').select('group_id').eq('user_id', user.id),
		supabase.from('orbitfs_file_permissions').select('*').eq('workspace_id', workspaceId)
	]);
	if (error) throw error;
	const groupIds = new Set((groups ?? []).map((item) => String(item.group_id)));
	const clean = normalizePath(path);
	const matches = (rows ?? []).filter((row) => {
		const prefix = normalizePath(row.path_prefix);
		const pathMatch = !prefix || clean === prefix || clean.startsWith(`${prefix}/`);
		if (!pathMatch) return false;
		if (row.principal_type === 'user') return row.principal_id === user.id;
		if (row.principal_type === 'group') return groupIds.has(String(row.principal_id));
		if (row.principal_type === 'role') return row.principal_id === role || row.principal_id === user.role;
		return row.principal_type === 'everyone' || row.principal_id === '*';
	});
	matches.sort((a, b) => {
		const pathDelta = normalizePath(b.path_prefix).length - normalizePath(a.path_prefix).length;
		if (pathDelta) return pathDelta;
		const priority: Record<string, number> = { user: 4, group: 3, role: 2, everyone: 1 };
		return (priority[b.principal_type] ?? 0) - (priority[a.principal_type] ?? 0);
	});
	const row = matches[0];
	if (!row) return defaultPermissions(role);
	return {
		read: row.can_view === true,
		write: row.can_edit === true,
		download: row.can_download === true,
		move: row.can_move === true,
		delete: row.can_delete === true,
		create: row.can_create === true,
		share: row.can_share === true,
		manage: row.can_manage_permissions === true
	};
}

export async function requireCapability(user: OrbitUser, workspaceId: string, path: string, capability: FileCapability) {
	const permissions = await permissionsForPath(user, workspaceId, path);
	const key = capability === 'manage' ? 'manage' : capability;
	if (!permissions[key as keyof typeof permissions]) {
		throw Object.assign(new Error(`File ${capability} permission required`), { status: 403, code: 'FILE_PERMISSION_REQUIRED' });
	}
	return permissions;
}

export async function ensureCoreFolders(workspaceId: string, userId?: string | null) {
	const supabase = getSupabaseAdmin();
	const { data } = await supabase.from('orbitfs_files').select('path').eq('workspace_id', workspaceId).in('path', [...CORE_ROOTS]).is('deleted_at', null);
	const existing = new Set((data ?? []).map((row) => row.path));
	const missing = [...CORE_ROOTS].filter((path) => !existing.has(path));
	if (missing.length) {
		const { error } = await supabase.from('orbitfs_files').insert(missing.map((path) => ({ workspace_id: workspaceId, name: path, path, kind: 'folder', created_by: userId ?? null })));
		if (error && error.code !== '23505') throw error;
	}
}

export async function findEntry(workspaceId: string, path: string, includeDeleted = false) {
	const supabase = getSupabaseAdmin();
	let query = supabase.from('orbitfs_files').select('*').eq('workspace_id', workspaceId).eq('path', normalizePath(path));
	if (!includeDeleted) query = query.is('deleted_at', null);
	const { data, error } = await query.maybeSingle();
	if (error) throw error;
	return data;
}

export async function listEntries(workspaceId: string, subpath: string) {
	const supabase = getSupabaseAdmin();
	const clean = normalizePath(subpath);
	const { data, error } = await supabase.from('orbitfs_files').select('*').eq('workspace_id', workspaceId).is('deleted_at', null).order('kind').order('name');
	if (error) throw error;
	return (data ?? [])
		.filter((entry) => dirname(entry.path) === clean)
		.map((entry) => ({
			id: entry.id,
			path: entry.path,
			name: entry.name,
			type: entry.kind === 'folder' ? 'dir' : 'file',
			size: Number(entry.size_bytes || 0),
			mtime: entry.updated_at,
			system: fixedCoreRoot(entry.path),
			protected: fixedCoreRoot(entry.path),
			hidden: false,
			mimeType: entry.mime_type ?? null
		}));
}

export async function readEntryBytes(entry: any): Promise<Buffer> {
	if (entry.storage_path) {
		const supabase = getSupabaseAdmin();
		const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(entry.storage_path);
		if (error || !data) throw Object.assign(new Error(error?.message || 'File storage read failed'), { status: 500 });
		return Buffer.from(await data.arrayBuffer());
	}
	return Buffer.from(String(entry.content_text ?? ''), 'utf8');
}

export async function writeFileBytes(args: { workspaceId: string; path: string; bytes: Buffer; mimeType?: string | null; userId?: string | null; preferText?: boolean; upsert?: boolean }) {
	const supabase = getSupabaseAdmin();
	const path = normalizePath(args.path);
	const existing = await findEntry(args.workspaceId, path);
	if (existing?.kind === 'folder') throw Object.assign(new Error('A folder already exists at that path'), { status: 409 });
	const mimeType = args.mimeType || existing?.mime_type || 'application/octet-stream';
	const useText = args.preferText === true && args.bytes.length <= 5 * 1024 * 1024;
	let objectPath: string | null = existing?.storage_path ?? null;
	if (!useText) {
		objectPath = storagePath(args.workspaceId, path);
		const upload = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, args.bytes, { contentType: mimeType, upsert: true });
		if (upload.error) throw upload.error;
	} else if (objectPath) {
		await supabase.storage.from(STORAGE_BUCKET).remove([objectPath]);
		objectPath = null;
	}
	const payload = {
		workspace_id: args.workspaceId,
		name: basename(path),
		path,
		kind: 'file',
		mime_type: mimeType,
		content_text: useText ? args.bytes.toString('utf8') : '',
		storage_path: objectPath,
		size_bytes: args.bytes.length,
		created_by: existing?.created_by ?? args.userId ?? null,
		deleted_at: null,
		updated_at: new Date().toISOString()
	};
	const result = existing
		? await supabase.from('orbitfs_files').update(payload).eq('id', existing.id).select('*').single()
		: await supabase.from('orbitfs_files').insert(payload).select('*').single();
	if (result.error) throw result.error;
	return result.data;
}

export async function createFolder(workspaceId: string, path: string, userId?: string | null) {
	const supabase = getSupabaseAdmin();
	const clean = normalizePath(path);
	if (!clean) throw Object.assign(new Error('Folder path is required'), { status: 400 });
	const existing = await findEntry(workspaceId, clean);
	if (existing) return existing;
	const { data, error } = await supabase.from('orbitfs_files').insert({ workspace_id: workspaceId, name: basename(clean), path: clean, kind: 'folder', created_by: userId ?? null }).select('*').single();
	if (error) throw error;
	return data;
}

export async function moveEntry(workspaceId: string, from: string, to: string) {
	const supabase = getSupabaseAdmin();
	const source = normalizePath(from);
	const destination = normalizePath(to);
	if (!source || !destination) throw Object.assign(new Error('Source and destination are required'), { status: 400 });
	if (fixedCoreRoot(source) || fixedCoreRoot(destination)) throw Object.assign(new Error('Core workspace folders cannot be moved'), { status: 403 });
	const { data: rows, error } = await supabase.from('orbitfs_files').select('*').eq('workspace_id', workspaceId).is('deleted_at', null);
	if (error) throw error;
	const affected = (rows ?? []).filter((row) => row.path === source || row.path.startsWith(`${source}/`)).sort((a, b) => a.path.length - b.path.length);
	if (!affected.length) throw Object.assign(new Error('File or folder not found'), { status: 404 });
	if ((rows ?? []).some((row) => row.path === destination && !affected.some((item) => item.id === row.id))) throw Object.assign(new Error('Destination already exists'), { status: 409 });
	for (const row of affected) {
		const suffix = row.path === source ? '' : row.path.slice(source.length + 1);
		const nextPath = [destination, suffix].filter(Boolean).join('/');
		let nextStoragePath = row.storage_path;
		if (row.storage_path) {
			nextStoragePath = storagePath(workspaceId, nextPath);
			const moved = await supabase.storage.from(STORAGE_BUCKET).move(row.storage_path, nextStoragePath);
			if (moved.error) throw moved.error;
		}
		const patch: Record<string, unknown> = { path: nextPath, storage_path: nextStoragePath, updated_at: new Date().toISOString() };
		if (row.path === source) patch.name = basename(destination);
		const update = await supabase.from('orbitfs_files').update(patch).eq('id', row.id);
		if (update.error) throw update.error;
	}
}

export async function purgeEntry(workspaceId: string, path: string) {
	const supabase = getSupabaseAdmin();
	const clean = normalizePath(path);
	const { data: rows, error } = await supabase.from('orbitfs_files').select('*').eq('workspace_id', workspaceId);
	if (error) throw error;
	const affected = (rows ?? []).filter((row) => row.path === clean || row.path.startsWith(`${clean}/`));
	const objectPaths = affected.map((row) => row.storage_path).filter(Boolean) as string[];
	if (objectPaths.length) {
		const removed = await supabase.storage.from(STORAGE_BUCKET).remove(objectPaths);
		if (removed.error) throw removed.error;
	}
	if (affected.length) {
		const deletion = await supabase.from('orbitfs_files').delete().in('id', affected.map((row) => row.id));
		if (deletion.error) throw deletion.error;
	}
}
