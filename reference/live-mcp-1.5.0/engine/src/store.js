import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { resolveAssignedBundles } from "./context-library.js";
import { readMcpWorkspaceConfig, readPanelWorkspaceContext } from "./mcp-workspace-config.js";
const here=path.dirname(fileURLToPath(import.meta.url));
const backendRoot=path.resolve(process.env.ORBITFS_BACKEND_ROOT||path.join(here,"../../../../panel-backend"));
const configPath=path.join(backendRoot,"config.json"),statePath=path.join(backendRoot,"data","state.json");
const storageRoot=path.resolve(process.env.ORBITFS_STORAGE_ROOT||path.join(backendRoot,"../../Storage"));
const publicStorageRoot=path.resolve(process.env.ORBITFS_PUBLIC_STORAGE_ROOT||path.join(storageRoot,"Public Workspace"));
const publicMode=process.env.ORBITFS_MCP_MODE==="public"||process.env.ORBITFS_ALLOW_PUBLIC_FALLBACK==="true";
const presetKeys=["low","medium","high","custom1","custom2"];
const defaultPresetMetadata=Object.fromEntries(presetKeys.map(k=>[k,{preset:k,displayName:k==="custom1"?"Custom 1":k==="custom2"?"Custom 2":k[0].toUpperCase()+k.slice(1)}]));
let pool;
async function json(file,fallback={}){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return structuredClone(fallback);}}
function db(){pool??=mysql.createPool({host:process.env.MYSQL_HOST||"127.0.0.1",port:Number(process.env.MYSQL_PORT||3306),user:process.env.MYSQL_USER||"root",password:process.env.MYSQL_PASSWORD||"",database:process.env.MYSQL_DATABASE||"orbitfs",waitForConnections:true,connectionLimit:5});return pool;}
export async function pingStore(){await db().query("SELECT 1");const s=await json(statePath,{workspaces:[]});return {mysql:true,state:true,workspaces:(s.workspaces||[]).length};}
export async function listWorkspaces(){const s=await json(statePath,{workspaces:[]}),includeDisabled=process.env.ORBITFS_DEV_INCLUDE_DISABLED_WORKSPACES==="true";const rows=(s.workspaces||[]).filter(w=>w.status!=="archived"&&((w.mcp_system_enabled!==false&&w.mcp_ui_enabled)||includeDisabled)).map(w=>({id:w.id,name:w.name,status:w.status,mcpEnabled:w.mcp_system_enabled!==false&&w.mcp_ui_enabled===true,ownerUsername:w.owner_username}));if(publicMode&&rows.length===0)return[{id:"public",name:"Public Workspace",status:"active",mcpEnabled:true,ownerUsername:null}];return rows;}
export async function workspaceRecord(id){if(id==="public"&&publicMode)return{id:"public",name:"Public Workspace",status:"active",mcp_ui_enabled:true,storage_path:null};const s=await json(statePath,{workspaces:[]});const w=(s.workspaces||[]).find(x=>x.id===id);if(!w)throw new Error("Workspace not found");if((w.mcp_system_enabled===false||!w.mcp_ui_enabled)&&process.env.ORBITFS_DEV_INCLUDE_DISABLED_WORKSPACES!=="true")throw new Error(w.mcp_system_enabled===false?"MCP access has been revoked for this workspace by a System Owner or Admin":"MCP is disabled for this workspace");return w;}
export async function resolveWorkspaceId(requested,provided=null){const ws=provided||await listWorkspaces();const wanted=String(requested||"").trim();if(wanted&&wanted!=="default")return ws.some(w=>w.id===wanted)?wanted:null;if(publicMode&&ws.some(w=>w.id==="public"))return "public";return null;}
export async function workspaceRoot(id){const[c,w]=await Promise.all([json(configPath,{}),workspaceRecord(id)]);if(id==="public"&&publicMode)return publicStorageRoot;const root=path.resolve(process.env.ORBITFS_STORAGE_ROOT||c.storageRoot||storageRoot);if(w.storage_path)return path.resolve(root,w.storage_path);if(w.id==="admin-main")return path.resolve(c.mainWorkspaceRoot||path.join(root,"Public Workspace"));if(w.id==="user-lucas-main")return path.resolve(root,"owners","user-lucas","Lucas Workspace");return path.resolve(root,"branches",w.folder_name||w.slug||w.id);}
export async function getWorkspaceConfig(id, presetOverride, projectOverride = null) {
  const workspace = await workspaceRecord(id);
  if (workspace.status !== "active") throw new Error(`Workspace is ${workspace.status}`);
  const [[startup]] = await db().query(
    "SELECT strength,instructions,ai_behaviour FROM mcp_workspace_startup WHERE workspace_id=?",
    [id]
  );
  const strength = presetOverride ? String(presetOverride) : null;
  const [[preset]] = strength ? await db().query(
    "SELECT project_id FROM mcp_workspace_presets WHERE workspace_id=? AND preset=?",
    [id, strength]
  ) : [[null]];
  const [defaults] = strength ? await db().query(
    "SELECT item_type,item_path,1 recursive_flag FROM mcp_workspace_default_items WHERE workspace_id=? ORDER BY sort_order,id",
    [id]
  ) : [[]];
  const [defaultProfiles] = strength ? await db().query("SELECT profile_id FROM mcp_workspace_default_profiles WHERE workspace_id=? ORDER BY sort_order,id", [id]) : [[]];
  const [defaultProfileBundles] = strength ? await db().query("SELECT profile_bundle_id FROM mcp_workspace_default_profile_bundles WHERE workspace_id=? ORDER BY sort_order,id", [id]) : [[]];
  let [items] = strength ? await db().query(
    "SELECT item_type,item_path,recursive_flag FROM mcp_workspace_preset_items WHERE workspace_id=? AND preset=? ORDER BY sort_order,id",
    [id, strength]
  ) : [[]];
  let [presetProfiles] = strength ? await db().query("SELECT profile_id FROM mcp_workspace_preset_profiles WHERE workspace_id=? AND preset=? ORDER BY sort_order,id", [id,strength]) : [[]];
  let [presetProfileBundles] = strength ? await db().query("SELECT profile_bundle_id FROM mcp_workspace_preset_profile_bundles WHERE workspace_id=? AND preset=? ORDER BY sort_order,id", [id,strength]) : [[]];
  const [projects] = await db().query(
    "SELECT id,name,instructions,ai_behaviour,enabled FROM mcp_projects WHERE workspace_id=? AND enabled=1 ORDER BY updated_at DESC",
    [id]
  );
  let project = null;
  const wantedProjectId = projectOverride || preset?.project_id || null;
  if (wantedProjectId) {
    [[project]] = await db().query(
      "SELECT id,name,instructions,ai_behaviour,enabled FROM mcp_projects WHERE id=? AND workspace_id=?",
      [wantedProjectId, id]
    );
    if (project && !project.enabled) project = null;
  }
  let projectItems = [];
  if (project?.id) {
    const [rows] = await db().query(
      "SELECT item_type,item_path,1 recursive_flag FROM mcp_project_items WHERE project_id=? ORDER BY id",
      [project.id]
    );
    projectItems = rows;
    if (strength) {
      [items] = await db().query(
        "SELECT item_type,item_path,recursive_flag FROM mcp_project_preset_items WHERE project_id=? AND preset=? ORDER BY sort_order,id",
        [project.id, strength]
      );
      [presetProfiles] = await db().query("SELECT profile_id FROM mcp_project_preset_profiles WHERE project_id=? AND preset=? ORDER BY sort_order,id", [project.id,strength]);
      [presetProfileBundles] = await db().query("SELECT profile_bundle_id FROM mcp_project_preset_profile_bundles WHERE project_id=? AND preset=? ORDER BY sort_order,id", [project.id,strength]);
    }
  }
  let presetMetadata = structuredClone(defaultPresetMetadata);
  try {
    if (project?.id) {
      const [projectMetaRows] = await db().query(
        "SELECT preset,display_name FROM mcp_project_preset_metadata WHERE project_id=?",
        [project.id]
      );
      for (const row of projectMetaRows) {
        if (presetMetadata[row.preset]) presetMetadata[row.preset] = { ...presetMetadata[row.preset], displayName: row.display_name };
      }
    } else {
      const [metaRows] = await db().query(
        "SELECT preset,display_name FROM mcp_workspace_preset_metadata WHERE workspace_id=?",
        [id]
      );
      for (const row of metaRows) {
        if (presetMetadata[row.preset]) presetMetadata[row.preset] = { ...presetMetadata[row.preset], displayName: row.display_name };
      }
    }
  } catch {}
  const mcpWorkspaceConfig = await readMcpWorkspaceConfig(id);
  const usePanelWorkspaceContext = mcpWorkspaceConfig.master?.autoLoadPanelWorkspaceContext ?? mcpWorkspaceConfig.master?.autoLoadPanelWorkspaceAi ?? true;
  const workspaceContext = usePanelWorkspaceContext === false ? { workspaceId:id, enabled:false, content:"", files:{} } : await readPanelWorkspaceContext(id);
  if (workspaceContext.workspaceId !== id) throw new Error("Workspace context isolation check failed");
  const assigned = strength ? await resolveAssignedBundles(id, strength, project?.id || null) : { bundles: [] };
  const presetDisplayName = strength ? (presetMetadata[strength]?.displayName || null) : null;
  return {
    workspace, strength, presetDisplayName, presetMetadata,
    instructions: [workspaceContext.content, mcpWorkspaceConfig.startupInstructions, startup?.instructions, project?.instructions].filter(Boolean).join("\n\n"),
    aiBehaviour: [mcpWorkspaceConfig.chatgptInstructions, startup?.ai_behaviour, project?.ai_behaviour].filter(Boolean).join("\n\n"),
    mcpWorkspaceConfig, workspaceContext,
    workspaceAi: workspaceContext,
    project, projects, projectItems,
    assignedBundles: assigned.bundles.map((bundle) => ({
      id: bundle.id, bundleId: bundle.id, name: bundle.name, version: Number(bundle.version)
    })),
    defaultItems: defaults, projectItems, defaultProfileIds: defaultProfiles.map((item) => String(item.profile_id)), defaultProfileBundleIds: defaultProfileBundles.map((item) => String(item.profile_bundle_id)), presetProfileIds: presetProfiles.map((item) => String(item.profile_id)), presetProfileBundleIds: presetProfileBundles.map((item) => String(item.profile_bundle_id)), presetItems: items, items: [...defaults, ...projectItems, ...items]
  };
}async function walk(root,rel,recursive){const abs=path.resolve(root,rel);if(abs!==root&&!abs.startsWith(root+path.sep))return[];const info=await fs.stat(abs).catch(()=>null);if(!info)return[];if(info.isFile())return[rel];if(!info.isDirectory())return[];const out=[];for(const e of await fs.readdir(abs,{withFileTypes:true}).catch(()=>[])){if(e.name===".orbitfs-workspace.json"||e.name.startsWith("_"))continue;const child=path.posix.join(rel.replace(/\\/g,"/"),e.name);if(e.isFile())out.push(child);else if(e.isDirectory()&&recursive)out.push(...await walk(root,child,true));}return out;}
export async function listStartupFiles(id,config){const root=await workspaceRoot(id),files=[];for(const item of config.items||[]){const rel=String(item.item_path||"").replace(/\\/g,"/").replace(/^\/+|\/+$/g,"");if(!rel||rel.split("/")[0].startsWith("_"))continue;files.push(...await walk(root,rel,item.item_type==="folder"&&item.recursive_flag!==0));}return[...new Set(files)];}





