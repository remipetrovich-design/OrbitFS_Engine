import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getWorkspaceConfig,listWorkspaces,listStartupFiles,workspaceRoot,resolveWorkspaceId,pingStore } from "./store.js";
import { COMPONENTS,getComponentStatus,startLicenseHeartbeat } from "../../../../panel-backend/license-client.js";
import { loadDocumentItems } from "./context-document-loader.js";
import { mergeContextItems, normalizeContextItem, releaseBundleOwners } from "./context-ownership.js";
import { loadContextState,getActiveContext,setActiveContext,mergeActiveContext,removeActiveContextFile,clearActiveContext,runWithContextScope } from "./context-store.js";
import { filterWorkspaces } from "./identity.js";
import { oauthMetadata,oidcMetadata,protectedResourceMetadata,authChallenge,registerClient,beginAuthorization,completeAuthorization,tokenEndpoint,bearerIdentity,listOAuthClients,updateOAuthClient,revokeOAuthClientSessions,refreshOAuthIdentity,synchronizeOAuthAccess } from "./oauth.js";
import { ensureContextLibrarySchema,listContextBundles,resolveContextBundle,resolveAssignedBundles } from "./context-library.js";
import { registerProfileTools } from "./tools/profile-tools.js";
import { registerFileTools } from "./tools/file-tools.js";
import { registerAdvancedFileTools } from "./tools/advanced-file-tools.js";
import { registerSystemTools } from "./tools/system-tools.js";
import { registerStudioTools, buildStudioUiState } from "./tools/studio-tools.js";
import { registerKnowledgeTools } from './tools/knowledge-tools.js';
import { installToolDefaults } from "./tools/tool-runtime.js";
import { requireToolAuthorization } from "./tools/tool-security.js";
import { requireFilePermission } from "./services/file-permission-service.js";
import { callWorkspaceApi } from "./services/workspace-client.js";
import { touchSession, listSessions, disconnectSession, unblockSession, disconnectClientSessions, updateSessionWorkspace } from "./services/session-registry-service.js";
import { buildDashboardSnapshot } from "./services/dashboard-service.js";
import { listWorkspaceEntries, listWorkspaceProfiles, loadWorkspaceProfile, profileContextItem, resolveWorkspaceProfile } from "./services/ui-data-service.js";
import { collectFolderFiles } from "./folder-collector.js";
const here=path.dirname(fileURLToPath(import.meta.url));
const widgetTemplate=await fs.readFile(path.join(here,"widget.html"),"utf8");
const widgetHtml=widgetTemplate;
const studioWidgetHtml=await fs.readFile(path.join(here,"studio-widget.html"),"utf8");
const contextToolOutputSchema=z.object({ok:z.boolean(),message:z.string().optional(),workspaceId:z.string().optional()}).passthrough();

const port=Number(process.env.PORT||3939),app=express();
const controlToken=String(process.env.ORBITFS_CONTROL_TOKEN||"");
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:false,limit:"64kb"}));
const requestTracePath=path.resolve(here,"..","..","..","..","system-data","mcp","request-trace.jsonl");
app.use((req,res,next)=>{
  const started=Date.now(),entry={at:new Date().toISOString(),method:req.method,path:req.path,mcpMethod:req.body?.method||null,protocolVersion:req.get("mcp-protocol-version")||null,userAgent:req.get("user-agent")||null,hasSession:Boolean(req.get("mcp-session-id"))};
  res.on("finish",()=>fs.appendFile(requestTracePath,JSON.stringify({...entry,status:res.statusCode,durationMs:Date.now()-started})+"\n").catch(()=>{}));
  next();
});
const clients=new Map();let httpServer=null,shutdownScheduled=false;
let adminPolicy={oss:{enabled:true,allowedStrengths:['low','medium','high','custom1','custom2'],maxFilesPerStartup:250,maxCharactersPerStartup:5000000,maxLoadSeconds:60},ccs:{enabled:true,maxFileBytes:52428800,maxDocumentFileBytes:52428800,maxMediaFileBytes:524288000,maxMediaOutputBytes:25165824,maxBundleCharacters:5000000,maxFolderDepth:15,allowProfiles:true},registry:{maxActiveSessionsPerClient:10,sessionIdleMinutes:60,recentConnectionDays:30,historyRetentionDays:90}};
async function loadAdminPolicy(){try{const config=JSON.parse(await fs.readFile(path.resolve(here,'..','..','.orbitfs-config.json'),'utf8'));if(config.adminPolicy){const ccs=config.adminPolicy.ccs||{},legacyDocumentBytes=ccs.maxDocumentFileBytes??ccs.maxFileBytes;adminPolicy={...adminPolicy,...config.adminPolicy,oss:{...adminPolicy.oss,...(config.adminPolicy.oss||{})},ccs:{...adminPolicy.ccs,...ccs,...(legacyDocumentBytes!==undefined?{maxDocumentFileBytes:legacyDocumentBytes,maxFileBytes:legacyDocumentBytes}:{})},registry:{...adminPolicy.registry,...(config.adminPolicy.registry||{})}};}}catch{}}
let currentLicence={licensed:false,component:COMPONENTS.MCP,reason:"startup_validation_pending",lastCheckedAt:null};
function status(){return{...currentLicence};}
function warning(s=currentLicence){return`OrbitFS MCP is unlicensed or unauthorized (${s.reason||"licence_required"}). All MCP functions are disabled.`;}
async function refreshLicence(force=false){const s=await getComponentStatus(COMPONENTS.MCP,{refresh:force});currentLicence={...s,component:COMPONENTS.MCP,lastCheckedAt:s.lastCheckedAt||new Date().toISOString()};if(!s.licensed)scheduleShutdown(s);return currentLicence;}
function scheduleShutdown(s){if(shutdownScheduled)return;shutdownScheduled=true;console.warn(JSON.stringify({event:"orbitfs.mcp.unlicensed_runtime",severity:"warning",reason:s.reason||"licence_required",installationId:s.installationId||null,message:warning(s)}));}
function requireLicence(){if(!currentLicence.licensed)throw Object.assign(new Error(warning()),{code:"LICENSE_REQUIRED",status:403});}
function requireControl(req,res,next){if(!controlToken||req.headers.authorization!==`Bearer ${controlToken}`)return res.status(401).json({error:"Control authorization required"});next();}
async function gracefulShutdown(code=0){if(httpServer)await new Promise(r=>httpServer.close(r));process.exit(code);}
function effectiveAdminPolicy(workspaceId){
  const override=adminPolicy.workspaceOverrides?.[workspaceId]||{},overrideCcs=override.ccs||{};
  const ccs={...adminPolicy.ccs,...overrideCcs};
  if(overrideCcs.maxDocumentFileBytes===undefined&&overrideCcs.maxFileBytes!==undefined){ccs.maxDocumentFileBytes=overrideCcs.maxFileBytes;ccs.maxFileBytes=overrideCcs.maxFileBytes;}
  return {
    ...adminPolicy,
    oss:{...adminPolicy.oss,...(override.oss||{})},
    ccs,
    registry:{...adminPolicy.registry,...(override.registry||{})}
  };
}
function caps(p,policy=adminPolicy){return Math.min(({low:500000,medium:1500000,high:5000000,custom1:2000000,custom2:2000000})[p]||1500000,Number(policy.oss?.maxCharactersPerStartup||5000000));}
function contextLoadLimits(policy){return{documentMaxBytes:Number(policy.ccs?.maxDocumentFileBytes??policy.ccs?.maxFileBytes??20971520),mediaMaxBytes:Number(policy.ccs?.maxMediaFileBytes??262144000),mediaOutputMaxBytes:Number(policy.ccs?.maxMediaOutputBytes??12582912)};}
async function runStartup(workspaceId, strength, clientId, identity = {}, projectId = null) {
  requireLicence();
  identity.currentWorkspaceId = workspaceId;
  const policy=effectiveAdminPolicy(workspaceId);
  if (policy.oss?.enabled === false) throw Object.assign(new Error('OrbitFS Startup System is disabled by MCP Admin policy'),{status:403,code:'OSS_DISABLED'});
  const config = await getWorkspaceConfig(workspaceId, strength, projectId);
  if (Array.isArray(policy.oss?.allowedStrengths) && !policy.oss.allowedStrengths.includes(config.strength)) throw Object.assign(new Error(`Startup strength ${config.strength} is disabled`),{status:403,code:'OSS_STRENGTH_DISABLED'});
  const startedAt = new Date().toISOString();
  const contextId = `ctx-${crypto.randomUUID()}`;
  const root = await workspaceRoot(workspaceId);
  const max = caps(config.strength,policy);
  const maxFiles = Math.min(Number(process.env.ORBITFS_MAX_STARTUP_FILES || 250),Number(policy.oss?.maxFilesPerStartup||250));
  const selected = (await listStartupFiles(workspaceId, config)).map((relativePath) => ({ path: relativePath, source: 'startup' }));
  const selectedProfiles = [...(config.defaultProfileIds || []).map((profileId) => ({ profileId: String(profileId), path: `Profiles/${profileId}`, source: 'default-profile', required: false, priority: 0 })), ...(config.presetProfileIds || []).map((profileId) => ({ profileId: String(profileId), path: `Profiles/${profileId}`, source: 'preset-profile', required: false, priority: 0 }))];
  const knowledgeEntries = [];
  const startupProfileBundleIds = [...(config.defaultProfileBundleIds || []), ...(config.presetProfileBundleIds || [])];
  if (startupProfileBundleIds.length) { const catalog = await listWorkspaceProfiles(workspaceId, identity); const byBundle = new Map((catalog.profileBundles || []).map((bundle) => [String(bundle.id), bundle])); for (const bundleId of startupProfileBundleIds) { const bundle = byBundle.get(String(bundleId)); if (!bundle) continue; const isPreset = (config.presetProfileBundleIds || []).map(String).includes(String(bundleId)); for (const profileId of bundle.profileIds || []) selectedProfiles.push({ profileId: String(profileId), path: `Profiles/${profileId}`, source: isPreset ? 'preset-profile-bundle' : 'default-profile-bundle', profileBundleId: bundle.id, profileBundleName: bundle.name, required: false, priority: 0 }); } }
  const assigned = await resolveAssignedBundles(workspaceId, config.strength, config.project?.id || null);
  if (assigned.bundles.length && policy.ccs?.enabled === false) throw Object.assign(new Error('Complex Context System is disabled by MCP Admin policy'),{status:403,code:'CCS_DISABLED'});
  if (policy.ccs?.allowProfiles === false && (selectedProfiles.length || assigned.entries.some((entry)=>entry.attachmentType==='profile'))) throw Object.assign(new Error('Profile attachments are disabled by MCP Admin policy'),{status:403,code:'CCS_PROFILES_DISABLED'});

  for (const entry of assigned.entries) {
    if (entry.attachmentType === 'profile' && entry.profileId) {
      selectedProfiles.push(entry);
      continue;
    }
    if (entry.attachmentType === 'knowledge' && entry.knowledgeItemId) {
      knowledgeEntries.push(entry);
      continue;
    }
    const resolved = await resolveWorkspacePath(workspaceId, entry.path);
    const info = await fs.stat(resolved.absolute).catch(() => null);
    if (!info) {
      if (entry.required) throw Object.assign(new Error(`Required bundle entry is missing: ${entry.path}`), { status: 409, code: 'BUNDLE_REQUIRED_ENTRY_MISSING' });
      continue;
    }
    if (entry.type === 'file' && info.isFile()) selected.push({ path: resolved.clean, source: 'bundle', bundleId: entry.bundleId, bundleName: entry.bundleName, required: entry.required });
    else if (entry.type === 'folder' && info.isDirectory()) {
      const files = await collectFolderFiles(resolved.root, resolved.absolute, maxFiles, entry.recursive, Number(policy.ccs?.maxFolderDepth ?? 10));
      for (const file of files) selected.push({ path: file.path, source: 'bundle', bundleId: entry.bundleId, bundleName: entry.bundleName, required: entry.required });
    } else if (entry.required) {
      throw Object.assign(new Error(`Required bundle entry has the wrong type: ${entry.path}`), { status: 409, code: 'BUNDLE_ENTRY_TYPE_MISMATCH' });
    }
  }

  const byPath = new Map();
  for (const item of selected) {
    const key = item.path.toLowerCase();
    byPath.set(key, byPath.has(key) ? mergeContextItems(byPath.get(key), item) : normalizeContextItem(item));
  }
  const unique = [...byPath.values()];

  const physicalContextPaths=new Set(unique.map((item)=>String(item.path||'').replace(/\\/g,'/').toLowerCase()));
  const knowledgeResult = await loadKnowledgeEntries(workspaceId, knowledgeEntries, maxFiles, max, identity, physicalContextPaths);
  const profileResult = await loadProfileEntries(workspaceId, selectedProfiles, Math.max(0,maxFiles-knowledgeResult.loaded.length), Math.max(0,max-knowledgeResult.characters), identity);
  const loaded = [...knowledgeResult.loaded, ...profileResult.loaded], errors = [...knowledgeResult.errors, ...profileResult.errors];
  let total = knowledgeResult.characters + profileResult.characters;
  const documentItems = [];
  for (const item of unique.slice(0, Math.max(0, maxFiles - loaded.length))) {
    const absolute = path.resolve(root, item.path);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      errors.push({ path: item.path, status: 'rejected', error: 'Path escaped workspace root' });
      continue;
    }
    documentItems.push({ ...item, absolute });
  }
  const permittedDocumentItems = await filterContextReadItems(workspaceId, documentItems, identity, errors);
  const documentResult = await loadDocumentItems(permittedDocumentItems, Math.max(0, max - total), contextLoadLimits(policy));
  loaded.push(...documentResult.loaded);
  errors.push(...documentResult.errors);
  total += documentResult.characters;
  const files = mergePersistentDefaults(workspaceId,loaded.map(({ mcpContent, ...item }) => normalizeContextItem(item)));
  const profileSelectedCount = new Set(selectedProfiles.map((entry) => entry.profileId).filter(Boolean)).size;
  const receipt = {
    contextId, clientId, workspaceId, preset: config.strength, strength: config.strength,
    presetDisplayName: config.presetDisplayName || config.presetMetadata?.[config.strength]?.displayName || config.strength,
    projectId: config.project?.id || null, projectName: config.project?.name || null,
    bundles: assigned.loads.map((load) => ({ ...load, source: 'startup', loadedAt: startedAt })),
    startedAt, completedAt: new Date().toISOString(), selectedCount: unique.length + profileSelectedCount + knowledgeEntries.length,
    openedCount: loaded.length, extractedCount: loaded.length, transferredCount: loaded.length,
    failedCount: errors.length, charactersTransferred: files.reduce((sum,item)=>sum+Number(item.characters||0),0), limitCharacters: max,
    truncatedCount: files.filter((item) => item.truncated).length, files, errors
  };
  await setActiveContext(workspaceId, receipt);
  return { config, loaded, receipt, total };
}

async function resolveWorkspacePath(workspaceId,relativePath){const root=await workspaceRoot(workspaceId),clean=String(relativePath||"").replace(/\\/g,"/").replace(/^\/+/,""),absolute=path.resolve(root,clean);if(absolute!==root&&!absolute.startsWith(root+path.sep))throw Object.assign(new Error("Path escaped workspace root"),{status:400,code:"INVALID_PATH"});return{root,clean,absolute};}
function persistentDefaultFiles(workspaceId){
  const current=getActiveContext(workspaceId);
  return (current?.files||[]).filter((item)=>item?.defaultLoaded===true).map((item)=>normalizeContextItem(item));
}
function mergePersistentDefaults(workspaceId,files){
  const byPath=new Map(persistentDefaultFiles(workspaceId).map((item)=>[String(item.path||"").toLowerCase(),item]));
  for(const item of files){
    const key=String(item.path||"").toLowerCase();
    byPath.set(key,byPath.has(key)?mergeContextItems(byPath.get(key),item):normalizeContextItem(item));
  }
  return [...byPath.values()];
}
const libraryApiPath=(workspaceId,suffix='')=>`/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/library${suffix}`;
function knowledgeLifecycleWarning(item={}) {
  const state=String(item.effectiveLifecycleState || item.lifecycleState || 'unclassified');
  if(state==='old') return 'Historical/old Library source — may be outdated.';
  if(state==='deprecated') return 'Deprecated Library source — use only when explicitly required.';
  if(state==='archived') return 'Archived Library source — retained for historical context.';
  if(state==='draft') return 'Draft Library source — not authoritative.';
  return '';
}
async function loadKnowledgeEntries(workspaceId,entries,maxItems,maxCharacters,identity={},excludeFilePaths=new Set()) {
  const loaded=[],errors=[],grouped=new Map();
  for(const raw of entries || []) { const id=String(raw.knowledgeItemId || ''); if(!id) continue; const entry=normalizeContextItem({...raw,path:`Library/${id}`,source:'knowledge'}); if(grouped.has(id)) grouped.set(id,mergeContextItems(grouped.get(id),entry)); else grouped.set(id,entry); }
  let remaining=maxCharacters;
  for(const entry of grouped.values()) {
    if(loaded.length>=maxItems || remaining<=0) break;
    const id=String(entry.knowledgeItemId || '');
    try {
      const resolved=await callWorkspaceApi(identity,libraryApiPath(workspaceId,`/items/${encodeURIComponent(id)}/resolve`));
      const item=resolved.item || {};
      const sourcePath=item.source?.provider==='base.files'?String(item.source?.locator?.path||'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'').toLowerCase():'';
      if(sourcePath&&excludeFilePaths.has(sourcePath))continue;
      const mode=entry.loadMode || item.effectiveLoadMode || item.loadMode || ((item.roles || []).some((role)=>role==='core_file'||role==='core_profile')?'full':'smart');
      let content='', sections=[];
      if(mode==='full') {
        const full=await callWorkspaceApi(identity,libraryApiPath(workspaceId,`/items/${encodeURIComponent(id)}/content`));
        content=String(full.content || '').slice(0,remaining);
      } else {
        const budget=Math.min(remaining,mode==='summary'?4000:Math.max(6000,Math.min(24000,remaining)));
        const result=await callWorkspaceApi(identity,libraryApiPath(workspaceId,'/retrieve'),{method:'POST',body:{query:'',itemIds:[id],limit:mode==='summary'?4:12,maxChars:budget,consumerType:'mcp_context_bundle',consumerId:String(entry.bundleId || 'startup'),consumerLabel:entry.bundleName || 'MCP context'}});
        sections=result.results || []; content=sections.map((section)=>`## ${section.sectionTitle || item.name || id}\n${section.content || ''}`).join('\n\n').slice(0,remaining);
      }
      const contextItem=normalizeContextItem({ path:`Library/${id}`, source:'knowledge', knowledgeItemId:id, knowledgeItemName:item.name || entry.knowledgeItemName || id, lifecycleState:item.effectiveLifecycleState || item.lifecycleState || 'unclassified', libraryRoles:item.roles || [], loadMode:mode, knowledgeArchitecture:item.knowledgeArchitecture || null, warning:knowledgeLifecycleWarning(item), characters:content.length, opened:true, extracted:true, transferred:true, required:entry.required, priority:entry.priority, bundleId:entry.bundleId, bundleName:entry.bundleName, content });
      remaining-=content.length; loaded.push(contextItem);
    } catch(error) { const failure={path:`Library/${id}`,knowledgeItemId:id,status:'failed',required:entry.required,error:error?.message || String(error),code:error?.code || null}; if(entry.required) throw Object.assign(new Error(`Required Library knowledge failed: ${entry.knowledgeItemName || id}: ${failure.error}`),{status:error?.status || 409,code:error?.code || 'LIBRARY_KNOWLEDGE_LOAD_FAILED',details:failure}); errors.push(failure); }
  }
  return { loaded, errors, characters:loaded.reduce((sum,item)=>sum+Number(item.characters || 0),0) };
}

async function loadProfileEntries(workspaceId,entries,maxProfiles,maxCharacters,identity){
  const loaded=[],errors=[],available=await listWorkspaceProfiles(workspaceId,identity),allowed=new Set(available.profiles.map((profile)=>profile.id)),grouped=new Map();
  for(const rawEntry of entries){
    const profileId=String(rawEntry.profileId||''); if(!profileId)continue;
    const entry=normalizeContextItem({...rawEntry,source:'profile'});
    if(grouped.has(profileId)){const merged=mergeContextItems(grouped.get(profileId),entry);merged.required=Boolean(grouped.get(profileId).required||entry.required);grouped.set(profileId,merged);}
    else grouped.set(profileId,entry);
  }
  let remaining=maxCharacters;
  for(const entry of grouped.values()){
    if(loaded.length>=maxProfiles||remaining<=0)break;
    const profileId=String(entry.profileId||'');
    if(!allowed.has(profileId)){const failure={path:entry.path,profileId,status:'rejected',error:'Profile is unavailable or access is denied'};if(entry.required)throw Object.assign(new Error(`Required profile is unavailable: ${entry.profileName||profileId}`),{status:403,code:'PROFILE_ACCESS_DENIED'});errors.push(failure);continue;}
    try{const result=await loadWorkspaceProfile(workspaceId,profileId,'standard',identity),item=normalizeContextItem(profileContextItem(result,{profileId,detail:'standard',sourceEntry:entry,maxCharacters:remaining}));remaining-=Number(item.characters||0);loaded.push(item);}
    catch(error){const failure={path:entry.path,profileId,status:'failed',error:error.message};if(entry.required)throw error;errors.push(failure);}
  }
  return{loaded,errors,characters:loaded.reduce((sum,item)=>sum+item.characters,0)};
}
async function filterContextReadItems(workspaceId, items, identity, errors = []) {
  if (!identity?.userId && !identity?.username) return items || [];
  const permitted = [];
  for (const item of items || []) {
    try {
      await requireFilePermission(identity, workspaceId, item.path, "read");
      permitted.push(item);
    } catch (error) {
      const failure = { path: item.path, status: "rejected", code: error?.code || "READ_PERMISSION_DENIED", error: error?.message || "Read permission denied" };
      if (item.required) throw Object.assign(new Error(`Required context item is not readable: ${item.path}`), { status: 403, code: "CONTEXT_REQUIRED_READ_DENIED" });
      errors.push(failure);
    }
  }
  return permitted;
}
async function loadPathsIntoContext(workspaceId,clientId,items,maxCharacters,policy=effectiveAdminPolicy(workspaceId),identity=null){const permissionErrors=[],permitted=await filterContextReadItems(workspaceId,items,identity,permissionErrors),result=await loadDocumentItems(permitted,maxCharacters,contextLoadLimits(policy)),allErrors=[...permissionErrors,...result.errors];const persisted=result.loaded.map(({content,mcpContent,...item})=>item);const receipt=await mergeActiveContext(workspaceId,{contextId:getActiveContext(workspaceId)?.contextId||`ctx-${crypto.randomUUID()}`,clientId,workspaceId,files:persisted,errors:allErrors,completedAt:new Date().toISOString()});return{loaded:result.loaded,errors:allErrors,receipt};}
async function loadDefaultsIntoContext(workspaceId,clientId,maxFiles,maxCharacters,identity={},projectId=null,policy=effectiveAdminPolicy(workspaceId)){
  const config=await getWorkspaceConfig(workspaceId,'medium',projectId),root=await workspaceRoot(workspaceId),errors=[],profileEntries=[];
  const selected=(await listStartupFiles(workspaceId,{...config,items:config.defaultItems||[]})).map((relativePath)=>({path:relativePath,source:'default',defaultLoaded:true,required:false,priority:0}));
  if(policy.ccs?.allowProfiles!==false)for(const profileId of config.defaultProfileIds||[])profileEntries.push({profileId:String(profileId),path:`Profiles/${profileId}`,source:'default-profile',defaultLoaded:true,required:false,priority:0});
  if(policy.ccs?.allowProfiles!==false&&(config.defaultProfileBundleIds||[]).length){
    const catalog=await listWorkspaceProfiles(workspaceId,identity),byBundle=new Map((catalog.profileBundles||[]).map((bundle)=>[String(bundle.id),bundle]));
    for(const bundleId of config.defaultProfileBundleIds||[]){
      const bundle=byBundle.get(String(bundleId)); if(!bundle)continue;
      for(const profileId of bundle.profileIds||[])profileEntries.push({profileId:String(profileId),path:`Profiles/${profileId}`,source:'default-profile-bundle',defaultLoaded:true,profileBundleId:bundle.id,profileBundleName:bundle.name,required:false,priority:0});
    }
  }
  await appendArchitectureAutomatic(workspaceId,config,identity,selected,maxFiles,policy);
  const profileResult=await loadProfileEntries(workspaceId,profileEntries,maxFiles,maxCharacters,identity),documentItems=[];
  let total=profileResult.characters;
  for(const item of selected.slice(0,Math.max(0,maxFiles-profileResult.loaded.length))){
    const absolute=path.resolve(root,item.path);
    if(absolute!==root&&!absolute.startsWith(root+path.sep)){errors.push({path:item.path,status:'rejected',error:'Path escaped workspace root'});continue;}
    documentItems.push({...item,absolute});
  }
  const permittedDocumentItems=await filterContextReadItems(workspaceId,documentItems,identity,errors);
  const documentResult=await loadDocumentItems(permittedDocumentItems,Math.max(0,maxCharacters-total),contextLoadLimits(policy));
  total+=documentResult.characters;
  const profileFiles=profileResult.loaded,documentFiles=documentResult.loaded.map(({content,mcpContent,...item})=>item);
  const receipt=await mergeActiveContext(workspaceId,{contextId:getActiveContext(workspaceId)?.contextId||`ctx-${crypto.randomUUID()}`,clientId,workspaceId,files:[...profileFiles,...documentFiles],errors:[...errors,...profileResult.errors,...documentResult.errors],defaultLoadedAt:new Date().toISOString(),completedAt:new Date().toISOString()});
  return{config,loaded:[...profileResult.loaded,...documentResult.loaded],errors:[...errors,...profileResult.errors,...documentResult.errors],receipt,total};
}
async function loadBundleIntoContext(workspaceId,bundleId,clientId,maxFiles,maxCharacters,identity={},policy=effectiveAdminPolicy(workspaceId)){
  if(policy.ccs?.enabled===false)throw Object.assign(new Error('Complex Context System is disabled by MCP Admin policy'),{status:403,code:'CCS_DISABLED'});
  const resolved=await resolveContextBundle(workspaceId,bundleId),root=await workspaceRoot(workspaceId),items=[],profileEntries=[],knowledgeEntries=[],errors=[];
  if(policy.ccs?.allowProfiles===false&&resolved.entries.some((entry)=>entry.attachmentType==='profile'))throw Object.assign(new Error('Profile attachments are disabled by MCP Admin policy'),{status:403,code:'CCS_PROFILES_DISABLED'});
  for(const entry of resolved.entries){
    if(items.length+profileEntries.length+knowledgeEntries.length>=maxFiles)break;
    if(entry.attachmentType==="profile"&&entry.profileId){profileEntries.push(entry);continue;}
    if(entry.attachmentType==="knowledge"&&entry.knowledgeItemId){knowledgeEntries.push(entry);continue;}
    try{
      const target=await resolveWorkspacePath(workspaceId,entry.path),info=await fs.stat(target.absolute).catch(()=>null);
      if(entry.type==="file"){
        if(!info?.isFile())throw new Error("File not found");
        items.push({absolute:target.absolute,path:target.clean,bundleId:entry.bundleId,bundleName:entry.bundleName,required:entry.required,priority:entry.priority});
      }else{
        if(!info?.isDirectory())throw new Error("Folder not found");
        const found=await collectFolderFiles(root,target.absolute,maxFiles-items.length-profileEntries.length-knowledgeEntries.length,entry.recursive,Number(policy.ccs?.maxFolderDepth ?? 10));
        for(const file of found)items.push({...file,bundleId:entry.bundleId,bundleName:entry.bundleName,required:entry.required,priority:entry.priority});
      }
    }catch(error){
      errors.push({path:entry.path,bundleId:entry.bundleId,bundleName:entry.bundleName,required:entry.required,error:error.message});
      if(entry.required)throw Object.assign(new Error(`Required bundle entry failed: ${entry.path}: ${error.message}`),{status:409,code:"BUNDLE_REQUIRED_ENTRY_FAILED",details:errors});
    }
  }
  const physicalContextPaths=new Set(items.map((item)=>String(item.path||'').replace(/\\/g,'/').toLowerCase()));
  const knowledgeResult=await loadKnowledgeEntries(workspaceId,knowledgeEntries,maxFiles,maxCharacters,identity,physicalContextPaths);
  const profileResult=await loadProfileEntries(workspaceId,profileEntries,Math.max(0,maxFiles-knowledgeResult.loaded.length),Math.max(0,maxCharacters-knowledgeResult.characters),identity);
  const uniqueByPath=new Map();
  for(const item of items){const key=item.path.toLowerCase();uniqueByPath.set(key,uniqueByPath.has(key)?mergeContextItems(uniqueByPath.get(key),item):normalizeContextItem(item));}
  const unique=[...uniqueByPath.values()].slice(0,Math.max(0,maxFiles-profileResult.loaded.length-knowledgeResult.loaded.length));
  const loadedResult=await loadPathsIntoContext(workspaceId,clientId,unique,Math.max(0,maxCharacters-profileResult.characters-knowledgeResult.characters),policy,identity);
  const profileFiles=profileResult.loaded, knowledgeFiles=knowledgeResult.loaded.map(({content,...item})=>item);
  let receipt=await mergeActiveContext(workspaceId,{
    contextId:loadedResult.receipt?.contextId||getActiveContext(workspaceId)?.contextId||`ctx-${crypto.randomUUID()}`,
    clientId,workspaceId,files:[...knowledgeFiles,...profileFiles],errors:[...errors,...knowledgeResult.errors,...profileResult.errors],completedAt:new Date().toISOString()
  });
  receipt.bundles=[...(receipt.bundles||[]).filter((item)=>item.rootBundleId!==bundleId),{rootBundleId:bundleId,bundleIds:resolved.bundles.map((item)=>item.id),bundleNames:resolved.bundles.map((item)=>item.name),loadedAt:new Date().toISOString()}];
  await setActiveContext(workspaceId,receipt);
  return{resolved,loaded:[...knowledgeResult.loaded,...profileResult.loaded,...loadedResult.loaded],errors:[...errors,...knowledgeResult.errors,...profileResult.errors,...loadedResult.errors],receipt};
}
async function unloadBundleFromContext(workspaceId,bundleId){
  const current=getActiveContext(workspaceId); if(!current)return null;
  const target=(current.bundles||[]).find((bundle)=>String(bundle.rootBundleId||bundle.id||'')===String(bundleId));
  const removedBundleIds=(target?.bundleIds?.length?target.bundleIds:[target?.id||bundleId]).map(String);
  const remainingBundles=(current.bundles||[]).filter((bundle)=>String(bundle.rootBundleId||bundle.id||'')!==String(bundleId));
  const stillNeededBundleIds=remainingBundles.flatMap((bundle)=>bundle.bundleIds || (bundle.id ? [bundle.id] : [])).map(String);
  const files=[];
  for(const item of current.files||[]){const released=releaseBundleOwners(item,removedBundleIds,stillNeededBundleIds);if(released.keep)files.push(released.item);}
  return setActiveContext(workspaceId,{...current,bundles:remainingBundles,files,transferredCount:files.filter(i=>i.transferred).length,openedCount:files.filter(i=>i.opened).length,extractedCount:files.filter(i=>i.extracted).length,charactersTransferred:files.reduce((n,i)=>n+Number(i.characters||0),0),truncatedCount:files.filter(i=>i.truncated).length,completedAt:new Date().toISOString()});
}
async function inspectContextChanges(workspaceId,receipt){if(!receipt?.files?.length)return{outdated:false,changedFiles:[]};const root=await workspaceRoot(workspaceId),changedFiles=[];for(const item of receipt.files){if(item.source==="profile"||item.source==="knowledge")continue;const absolute=path.resolve(root,item.path);if(absolute!==root&&!absolute.startsWith(root+path.sep)){changedFiles.push({path:item.path,status:"invalid_path"});continue;}const info=await fs.stat(absolute).catch(()=>null);if(!info){changedFiles.push({path:item.path,status:"missing"});continue;}const currentModifiedAt=info.mtime.toISOString();if(currentModifiedAt!==item.modifiedAt)changedFiles.push({path:item.path,status:"modified",loadedModifiedAt:item.modifiedAt,currentModifiedAt});}return{outdated:changedFiles.length>0,changedFiles};}
function loadedToolContent(items,emptyText){const content=[];for(const item of items||[]){if(item.content)content.push({type:"text",text:`===== ${item.path} =====\n${item.content}`});if(Array.isArray(item.mcpContent)&&item.mcpContent.length){content.push({type:"text",text:`===== ${item.path} (${item.mediaKind||"media"}) =====`});content.push(...item.mcpContent);}}return content.length?content:[{type:"text",text:emptyText}];}
function compactNumber(value){const n=Number(value||0);if(n>=1000000)return `${(n/1000000).toFixed(n>=10000000?0:1)}m`;if(n>=1000)return `${(n/1000).toFixed(n>=10000?0:1)}k`;return String(n);}
function readableBytes(value){const n=Number(value||0);if(n<1024)return `${n} B`;if(n<1024**2)return `${(n/1024).toFixed(1)} KB`;if(n<1024**3)return `${(n/1024**2).toFixed(1)} MB`;return `${(n/1024**3).toFixed(1)} GB`;}
function compactContext(receipt,changeStatus={outdated:false,changedFiles:[]}){if(!receipt)return{state:"Empty",progress:"[----------] 0%",files:0,parsed:0,characters:0,charactersLabel:"0",bytes:0,bytesLabel:"0 B",changedFiles:0,items:[]};const files=Array.isArray(receipt.files)?receipt.files:[];const parsed=files.filter((f)=>f.opened||f.extracted||f.transferred).length;const total=files.length;const pct=total?Math.round(parsed/total*100):100;const bars=Math.max(0,Math.min(10,Math.round(pct/10)));const chars=Number(receipt.charactersTransferred||files.reduce((n,f)=>n+Number(f.characters||0),0));const bytes=files.reduce((n,f)=>n+Number(f.bytes||f.mediaBytesTransferred||0),0);return{state:changeStatus?.outdated?"Loaded - changes detected":"Ready",progress:`[${"#".repeat(bars)}${"-".repeat(10-bars)}] ${pct}%`,files:total,parsed,characters:chars,charactersLabel:compactNumber(chars),bytes,bytesLabel:readableBytes(bytes),changedFiles:Array.isArray(changeStatus?.changedFiles)?changeStatus.changedFiles.length:0,items:files.slice(0,8).map(f=>({path:f.path,status:f.status||"loaded",characters:Number(f.characters||0)})),moreItems:Math.max(0,total-8)};}
function contextStatusText(summary){if(summary.state==="Empty")return "OrbitFS Context\n[----------] 0%\n\nNo active context is loaded.";const lines=["OrbitFS Context",summary.progress,"",`Files:       ${summary.files}`,`Parsed:      ${summary.parsed}`,`Characters:  ${summary.charactersLabel}`,`Data:        ${summary.bytesLabel}`,`Changed:     ${summary.changedFiles}`,`Status:      ${summary.state}`];if(summary.items.length){lines.push("","Loaded items:",...summary.items.map((item)=>`- ${item.path}`));if(summary.moreItems)lines.push(`- +${summary.moreItems} more`);}return lines.join("\n");}
async function buildUiState(workspaceId,strength,identity,clientId,sessionInfo={},projectId=null){
  requireLicence();
  const freshIdentity=await refreshOAuthIdentity(identity);
  Object.assign(identity,freshIdentity);
  const workspaces=filterWorkspaces(await listWorkspaces(),freshIdentity);
  const resolved=await resolveWorkspaceId(workspaceId,workspaces);if(resolved)identity.currentWorkspaceId=resolved;
  let config=null,configError=null;
  if(resolved)try{
    config=await getWorkspaceConfig(resolved,strength,projectId);
    if(config?.strength){
      const catalog=await listWorkspaceProfiles(resolved,freshIdentity);
      const profileById=new Map((catalog.profiles||[]).map((p)=>[String(p.id),p])); const bundleById=new Map((catalog.profileBundles||[]).map((b)=>[String(b.id),b]));
      const profilesFor=(ids=[])=>ids.map((id)=>profileById.get(String(id))).filter(Boolean).map((p)=>({id:String(p.id),name:p.name,type:p.type||'master'}));
      const groupsFor=(ids=[])=>ids.map((id)=>bundleById.get(String(id))).filter(Boolean).map((b)=>({id:String(b.id),name:b.name,description:b.description||'',profileIds:(b.profileIds||[]).map(String),profiles:profilesFor(b.profileIds||[])}));
      config={...config,startupSelection:{defaultItems:config.defaultItems||[],projectItems:config.projectItems||[],presetItems:config.presetItems||[],defaultProfiles:profilesFor(config.defaultProfileIds),presetProfiles:profilesFor(config.presetProfileIds),defaultProfileBundles:groupsFor(config.defaultProfileBundleIds),presetProfileBundles:groupsFor(config.presetProfileBundleIds),assignedContextBundles:config.assignedBundles||[]}};
    }
  }catch(e){configError=e.message;}
  const activeContext=resolved?getActiveContext(resolved):null;
  const changeStatus=activeContext?await inspectContextChanges(resolved,activeContext):{outdated:false,changedFiles:[]};
  const workspace=workspaces.find((item)=>item.id===resolved)||null;
  const policy=effectiveAdminPolicy(resolved);
  const dashboard=buildDashboardSnapshot({workspaceId:resolved,workspace,identity,config,activeContext,changeStatus,license:status(),sessionIdleMinutes:Number(policy.registry?.sessionIdleMinutes||60)});
  touchSession({sessionId:sessionInfo.sessionId,clientId,identity,workspaceId:resolved,conversationId:sessionInfo.conversationId,maxActiveSessionsPerClient:Number(policy.registry?.maxActiveSessionsPerClient||10),idleMinutes:Number(policy.registry?.sessionIdleMinutes||60)});
  return {licensed:true,initialView:'home',workspaceId:resolved,workspaces,config,configError,activeContext,activeFiles:activeContext?.files||[],changeStatus,dashboard,canWrite:identity.clientPermissions?.write!==false,clients:listSessions({workspaceId:resolved,includeInactive:true,idleMinutes:Number(policy.registry?.sessionIdleMinutes||60)})};
}
function buildServer(clientId="chatgpt",identity,sessionInfo={}){const server=new McpServer({name:"OrbitFS MCP",version:"1.5.0"});const rememberedWorkspace=listSessions({includeInactive:true}).find((item)=>item.id===sessionInfo.sessionId)?.workspaceId||null;identity.currentWorkspaceId=rememberedWorkspace||identity.currentWorkspaceId||identity.workspaceIds?.[0]||null;installToolDefaults(server,async()=>({currentWorkspaceId:identity.currentWorkspaceId||null,systemRole:identity.role||null,accessibleWorkspaceIds:Array.isArray(identity.workspaceIds)?identity.workspaceIds:[],activeContextId:identity.currentWorkspaceId?getActiveContext(identity.currentWorkspaceId)?.contextId||null:null,conversationId:sessionInfo.conversationId||null}),(name)=>requireToolAuthorization(identity,name,authChallenge));touchSession({sessionId:sessionInfo.sessionId,clientId,identity,conversationId:sessionInfo.conversationId,maxActiveSessionsPerClient:Number(adminPolicy.registry?.maxActiveSessionsPerClient||10),idleMinutes:Number(adminPolicy.registry?.sessionIdleMinutes||60)});clients.set(clientId,{id:clientId,connectedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()});const resourceUri="ui://orbitfs/home-v7.html",legacyResourceUris=[];const widgetResourceMeta={ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},"openai/widgetDescription":"OrbitFS workspace files, context and upload controls","openai/widgetPrefersBorder":true};const registerWidgetResource=(uri)=>registerAppResource(server,"OrbitFS Home",uri,{description:"OrbitFS workspace files, context and upload controls",mimeType:RESOURCE_MIME_TYPE,_meta:widgetResourceMeta},async()=>({contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:widgetHtml,_meta:widgetResourceMeta}]}));registerWidgetResource(resourceUri);const uiMeta={ui:{resourceUri},"openai/outputTemplate":resourceUri,"openai/widgetAccessible":true,"openai/widgetPrefersBorder":true,"openai/widgetDescription":"OrbitFS workspace files, context and upload controls"};const studioResourceUri='ui://orbitfs/studio-v8.html';const studioLegacyUris=['ui://orbitfs/studio-v7.html','ui://orbitfs/studio-v6.html','ui://orbitfs/studio-v5.html','ui://orbitfs/studio-v4.html'];const studioResourceMeta={ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetDescription':'OrbitFS Studio chat-first writing and documentation','openai/widgetPrefersBorder':true};registerAppResource(server,'OrbitFS Studio',studioResourceUri,{description:'OrbitFS Studio chat-first writing and documentation',mimeType:RESOURCE_MIME_TYPE,_meta:studioResourceMeta},async()=>({contents:[{uri:studioResourceUri,mimeType:RESOURCE_MIME_TYPE,text:studioWidgetHtml,_meta:studioResourceMeta}]}));for(const legacyUri of studioLegacyUris)registerAppResource(server,'OrbitFS Studio',legacyUri,{description:'OrbitFS Studio chat-first writing and documentation',mimeType:RESOURCE_MIME_TYPE,_meta:studioResourceMeta},async()=>({contents:[{uri:legacyUri,mimeType:RESOURCE_MIME_TYPE,text:studioWidgetHtml,_meta:studioResourceMeta}]}));const studioUiMeta={ui:{resourceUri:studioResourceUri},'openai/outputTemplate':studioResourceUri,'openai/widgetAccessible':true,'openai/widgetPrefersBorder':true,'openai/widgetDescription':'OrbitFS Studio chat-first writing and documentation'};const meta={"openai/widgetAccessible":true};const appOnlyMeta={...meta,ui:{visibility:["app"]}};registerProfileTools(server,{requireLicence,identity,clientId,meta,listWorkspaces,filterWorkspaces});registerFileTools(server,{requireLicence,identity,meta,listWorkspaces,filterWorkspaces,resolveWorkspacePath,workspaceRoot});registerAdvancedFileTools(server,{requireLicence,identity,meta,listWorkspaces,filterWorkspaces,resolveWorkspacePath});registerSystemTools(server,{requireLicence,identity,meta,refreshLicence,pingStore,loadContextState,ensureContextLibrarySchema});server.registerTool('workspace',{title:'Current OrbitFS workspace',description:'Show the currently selected OrbitFS workspace.',inputSchema:{},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async()=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);const resolved=identity.currentWorkspaceId||allowed[0]?.id;if(!resolved)throw Object.assign(new Error('No accessible workspace'),{status:404,code:'WORKSPACE_NOT_FOUND'});const ws=allowed.find(w=>w.id===resolved)||allowed[0];return{content:[{type:'text',text:'Workspace: '+(ws?.name||resolved)}],structuredContent:{ok:true,workspaceId:ws?.id||resolved,workspaceName:ws?.name||resolved}};});server.registerTool('loadworkspace',{title:'Load OrbitFS workspace',description:'Switch the current OrbitFS workspace by name, id, or visible workspace number.',inputSchema:{name:z.string().min(1)},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({name})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);const q=String(name||'').trim().toLowerCase();let matches=[];const n=Number(q);if(Number.isInteger(n)&&n>=1&&n<=allowed.length)matches=[allowed[n-1]];else{matches=allowed.filter(w=>String(w.id).toLowerCase()===q||String(w.name).toLowerCase()===q);if(!matches.length)matches=allowed.filter(w=>String(w.id).toLowerCase().includes(q)||String(w.name).toLowerCase().includes(q));}if(!matches.length)throw Object.assign(new Error('No accessible workspace matched'),{status:404,code:'WORKSPACE_NOT_FOUND'});if(matches.length>1)return{content:[{type:'text',text:matches.map((w,i)=>(i+1)+'. '+w.name).join('\n')}],structuredContent:{ok:true,matches:matches.map(w=>({id:w.id,name:w.name}))}};identity.currentWorkspaceId=matches[0].id;if(sessionInfo.sessionId)updateSessionWorkspace(sessionInfo.sessionId,matches[0].id);return{content:[{type:'text',text:'Workspace loaded: '+matches[0].name}],structuredContent:{ok:true,workspaceId:matches[0].id,workspaceName:matches[0].name}};});registerStudioTools(server,{identity,meta,uiMeta:studioUiMeta,listWorkspaces,filterWorkspaces});registerKnowledgeTools(server,{requireLicence,identity,meta,sessionInfo,clientId});registerAppTool(server,'studio',{title:'Open Studio',description:'Open the OrbitFS Studio ChatGPT UI when the user asks to open, browse, journal in, or work with Studio.',inputSchema:{workspaceId:z.string().optional(),view:z.enum(['home','journals','documents','library']).optional()},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:studioUiMeta},async({workspaceId,view='home'})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);const resolved=workspaceId||identity.currentWorkspaceId||allowed.find(w=>w.status==='active')?.id||allowed[0]?.id;if(!resolved||!allowed.some(w=>w.id===resolved))throw Object.assign(new Error('Workspace access denied'),{status:403,code:'WORKSPACE_ACCESS_DENIED'});identity.currentWorkspaceId=resolved;const uiState=await buildStudioUiState(identity,resolved);uiState.initialView=view;uiState.workspaces=allowed.map(w=>({id:String(w.id),name:w.name||w.id,status:w.status||'active'}));return{content:[{type:'text',text:'Studio opened.'}],structuredContent:{ok:true,message:'Studio opened.',workspaceId:resolved},_meta:{...studioUiMeta,studioUiState:uiState}};});registerAppTool(server,'ventmode',{title:'Open Studio Vent Mode',description:'Compatibility command: ventmode. Open OrbitFS Studio with Vent Mode enabled for the current or selected workspace. This is Studio Vent Mode, not a separate Vent system.',inputSchema:{workspaceId:z.string().optional()},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:studioUiMeta},async({workspaceId})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);const resolved=workspaceId||identity.currentWorkspaceId||allowed.find(w=>w.status==='active')?.id||allowed[0]?.id;if(!resolved||!allowed.some(w=>w.id===resolved))throw Object.assign(new Error('Workspace access denied'),{status:403,code:'WORKSPACE_ACCESS_DENIED'});identity.currentWorkspaceId=resolved;identity.studioModes={...(identity.studioModes||{}),[String(resolved)]:'vent'};const uiState=await buildStudioUiState(identity,resolved);uiState.initialView='journals';uiState.workspaces=allowed.map(w=>({id:String(w.id),name:w.name||w.id,status:w.status||'active'}));return{content:[{type:'text',text:'Studio opened in Vent Mode.'}],structuredContent:{ok:true,message:'Studio opened in Vent Mode.',workspaceId:resolved},_meta:{...studioUiMeta,studioUiState:uiState}};});registerAppTool(server,"orbitfs",{title:"Open OrbitFS",description:"Open the OrbitFS embedded UI. Only call when the user explicitly asks to open OrbitFS.",inputSchema:{workspaceId:z.string().optional(),strength:z.enum(["low","medium","high","custom1","custom2"]).optional(),projectId:z.string().optional()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:uiMeta},async({workspaceId="default",strength,projectId})=>{const uiState=await buildUiState(workspaceId,strength,identity,clientId,sessionInfo,projectId);return {content:[{type:"text",text:"OrbitFS opened."}],structuredContent:{ok:true,message:"OrbitFS opened."},_meta:{...uiMeta,orbitfsUiState:uiState}}});server.registerTool("orbitfs_ui_state",{title:"OrbitFS internal UI state",description:"Internal app-only state endpoint for the embedded OrbitFS widget.",inputSchema:{workspaceId:z.string().optional(),strength:z.enum(["low","medium","high","custom1","custom2"]).optional(),projectId:z.string().optional()},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:appOnlyMeta},async({workspaceId="default",strength,projectId})=>{const uiState=await buildUiState(workspaceId,strength,identity,clientId,sessionInfo,projectId);return {content:[{type:"text",text:"OrbitFS UI state refreshed."}],structuredContent:{ok:true,message:"OrbitFS UI state refreshed."},_meta:{...appOnlyMeta,orbitfsUiState:uiState}}});server.registerTool("refresh_ui",{title:"Refresh OrbitFS UI",description:"Refresh OrbitFS workspace access and rehydrate the embedded UI. Use when the user asks to refresh OrbitFS or when newly added workspaces need to appear without reconnecting ChatGPT.",inputSchema:{workspaceId:z.string().optional(),strength:z.enum(["low","medium","high","custom1","custom2"]).optional(),projectId:z.string().optional()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId="default",strength,projectId})=>{await synchronizeOAuthAccess();const freshIdentity=await refreshOAuthIdentity(identity);Object.assign(identity,freshIdentity);const uiState=await buildUiState(workspaceId,strength,identity,clientId,sessionInfo,projectId);const count=uiState.workspaces.length;return{content:[{type:"text",text:`OrbitFS refreshed. ${count} workspace${count===1?"":"s"} available.`}],structuredContent:{ok:true,message:`OrbitFS refreshed. ${count} workspace${count===1?"":"s"} available.`,workspaceCount:count},_meta:{...meta,orbitfsUiState:uiState}}});server.registerTool("load_defaults",{title:"Load OrbitFS defaults",description:"Load the selected workspace default files and default profiles into active ChatGPT context. Use from the Home tab after a workspace is selected; these default-loaded items persist through later startup runs.",inputSchema:{workspaceId:z.string(),projectId:z.string().optional(),maxFiles:z.number().int().positive().max(500).optional(),maxCharacters:z.number().int().positive().max(5000000).optional()},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,projectId,maxFiles=250,maxCharacters=1500000})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const policy=effectiveAdminPolicy(workspaceId);if(policy.ccs?.allowProfiles===false)maxFiles=Math.max(0,maxFiles);const cappedCharacters=Math.min(maxCharacters,Number(policy.oss?.maxCharactersPerStartup||5000000));const r=await loadDefaultsIntoContext(workspaceId,clientId,maxFiles,cappedCharacters,identity,projectId||null,policy);const loadedCount=(r.loaded||[]).length,errorCount=(r.errors||[]).length;const text=loadedCount?`Loaded ${loadedCount} default item${loadedCount===1?"":"s"} into OrbitFS context.`:"No default items are configured for this workspace.";const uiState={workspaceId,projectId:projectId||null,config:r.config,context:compactContext(r.receipt),activeContext:r.receipt,activeFiles:r.receipt.files||[],loadedCount,charactersLoaded:r.total,errorCount};return{content:[{type:"text",text}],structuredContent:{ok:loadedCount>0,message:text,loadedCount,charactersLoaded:r.total,errorCount},_meta:{...meta,orbitfsUiState:uiState}};});server.registerTool("run_startup",{title:"Run OrbitFS workspace startup",description:"Manual startup action. Load always-loaded and selected preset content only when the user explicitly requests startup or presses the Run startup control. Do not call automatically when opening the UI, connecting, refreshing the dashboard, selecting a preset, or when the user enters another OrbitFS command; command tools take priority.",inputSchema:{workspaceId:z.string(),strength:z.enum(["low","medium","high","custom1","custom2"]),projectId:z.string().optional()},annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,strength,projectId})=>{const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const r=await runStartup(workspaceId,strength,clientId,identity,projectId);const loadedCount=r.receipt.transferredCount||0,errorCount=(r.receipt.errors||[]).length;const text=`Startup loaded ${loadedCount} item${loadedCount===1?"":"s"} (${compactNumber(r.total)} chars)${errorCount?`, ${errorCount} failed`:""}.`;const uiState={workspaceId,projectId:r.receipt.projectId||projectId||null,config:r.config,context:compactContext(r.receipt),activeContext:r.receipt,activeFiles:r.receipt.files||[],loadedCount,charactersLoaded:r.total,errorCount};return{content:[{type:"text",text}],structuredContent:{ok:true,message:text,loadedCount,charactersLoaded:r.total,errorCount},_meta:{...meta,orbitfsUiState:uiState}};});server.registerTool("context_status",{
  title:"OrbitFS context status",
  description:"Return a compact active-context status including project, startup strength, loaded bundles, failed files and files changed since load. Uses the current OrbitFS workspace when workspaceId is omitted.",
  inputSchema:{workspaceId:z.string().optional()},
  annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta
},async({workspaceId})=>{
  requireLicence();
  const allowed=filterWorkspaces(await listWorkspaces(),identity);
  const resolved=workspaceId||identity.currentWorkspaceId||allowed.find(w=>w.status==="active")?.id||allowed[0]?.id;
  if(!resolved||!allowed.some(w=>w.id===resolved))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});
  identity.currentWorkspaceId=resolved;
  const receipt=getActiveContext(resolved);
  const changes=await inspectContextChanges(resolved,receipt);
  let config=null;try{config=await getWorkspaceConfig(resolved);}catch{}
  const summary=compactContext(receipt,changes);
  const failedFiles=Array.isArray(receipt?.errors)?receipt.errors:[];
  const bundles=Array.isArray(receipt?.bundles)?receipt.bundles:[];
  const text=contextStatusText(summary)+(failedFiles.length?`\nFailed:      ${failedFiles.length}\n${failedFiles.slice(0,20).map(f=>`- ${f.path||f.profileName||"unknown"}: ${f.error||f.status||"failed"}`).join("\n")}`:"");
  const uiState={workspaceId:resolved,project:config?.project?{id:config.project.id||null,name:config.project.name||null}:null,startupStrength:config?.strength||null,bundles,context:summary,failedFiles,failedCount:failedFiles.length,changedFiles:changes.changedFiles||[]};return{content:[{type:"text",text}],structuredContent:{ok:true,message:text,loadedCount:summary.files,failedCount:failedFiles.length,changedCount:(changes.changedFiles||[]).length},_meta:{...meta,orbitfsUiState:uiState}};
});
server.registerTool("context_explain",{
  title:"Explain OrbitFS context item",
  description:"Explain why a loaded file/profile or context bundle is present, or why a requested context item failed to load.",
  inputSchema:{workspaceId:z.string().optional(),path:z.string().optional(),bundleId:z.string().optional()},
  annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta
},async({workspaceId,path:targetPath,bundleId})=>{
  requireLicence();
  if(!targetPath&&!bundleId)throw Object.assign(new Error("Provide path or bundleId"),{status:400,code:"CONTEXT_EXPLAIN_TARGET_REQUIRED"});
  const allowed=filterWorkspaces(await listWorkspaces(),identity);
  const resolved=workspaceId||identity.currentWorkspaceId||allowed.find(w=>w.status==="active")?.id||allowed[0]?.id;
  if(!resolved||!allowed.some(w=>w.id===resolved))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});
  identity.currentWorkspaceId=resolved;
  const receipt=getActiveContext(resolved);
  if(!receipt)throw Object.assign(new Error("No active context"),{status:404,code:"NO_ACTIVE_CONTEXT"});
  let item=null,bundle=null,failure=null;
  if(targetPath){item=(receipt.files||[]).find(f=>String(f.path||"").toLowerCase()===String(targetPath).toLowerCase())||null;failure=(receipt.errors||[]).find(f=>String(f.path||"").toLowerCase()===String(targetPath).toLowerCase())||null;}
  if(bundleId)bundle=(receipt.bundles||[]).find(b=>String(b.rootBundleId||b.id||"")===String(bundleId))||null;
  if(!item&&!bundle&&!failure)throw Object.assign(new Error("Context item not found"),{status:404,code:"CONTEXT_ITEM_NOT_FOUND"});
  const reasons=[];  if(item){
    for(const owner of item.contextOwners||[]){
      if(owner==="source:startup")reasons.push("Loaded by workspace Startup");
      else if(owner==="source:profile")reasons.push("Loaded as a Profile");
      else if(owner==="source:manual")reasons.push("Loaded manually");
      else if(owner.startsWith("bundle:"))reasons.push(`Loaded by context bundle ${owner.slice(7)}`);
      else reasons.push(`Loaded by ${owner}`);
    }
    if(item.required)reasons.push("Marked required");
    if(item.bundleName)reasons.push(`Bundle: ${item.bundleName}`);
  }
  if(bundle){
    const names=bundle.bundleNames||[];
    reasons.push(names.length?`Loaded bundle chain: ${names.join(" -> ")}`:`Loaded context bundle ${bundleId}`);
    if(bundle.loadedAt)reasons.push(`Loaded at ${bundle.loadedAt}`);
  }
  if(failure)reasons.push(`Failed during context load: ${failure.error||failure.status||"unknown failure"}`);
  const details={workspaceId:resolved,path:item?.path||failure?.path||null,item,bundle,failure,reasons};
  return{content:[{type:"text",text:reasons.length?reasons.join("\n"):"No additional ownership reason is recorded."}],structuredContent:details,_meta:meta};
});
server.registerTool("get_active_context",{title:"Get active OrbitFS context",description:"Return the exact context receipt currently active for a workspace.",inputSchema:{workspaceId:z.string()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const receipt=getActiveContext(workspaceId),changeStatus=await inspectContextChanges(workspaceId,receipt),summary=compactContext(receipt,changeStatus);const text=contextStatusText(summary);return{content:[{type:"text",text}],structuredContent:{ok:true,message:text},_meta:{...meta,orbitfsUiState:{workspaceId,context:summary}}};});server.registerTool("load_file",{title:"Load OrbitFS file",description:"Read one permitted workspace file and append its actual contents to active context.",inputSchema:{workspaceId:z.string(),path:z.string(),maxCharacters:z.number().int().positive().max(1500000).optional()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,path:relativePath,maxCharacters=500000})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const policy=effectiveAdminPolicy(workspaceId);if(policy.ccs?.enabled===false)throw Object.assign(new Error("Complex Context System is disabled by MCP Admin policy"),{status:403,code:"CCS_DISABLED"});const resolved=await resolveWorkspacePath(workspaceId,relativePath),info=await fs.stat(resolved.absolute).catch(()=>null);if(!info?.isFile())throw Object.assign(new Error("File not found"),{status:404,code:"FILE_NOT_FOUND"});const r=await loadPathsIntoContext(workspaceId,clientId,[{absolute:resolved.absolute,path:resolved.clean}],maxCharacters,policy,identity);const loadedCount=(r.loaded||[]).length,errorCount=(r.errors||[]).length,text=loadedCount?`Loaded ${loadedCount} file into OrbitFS context.`:"File could not be loaded.";return{content:[{type:"text",text}],structuredContent:{ok:loadedCount>0,message:text,loadedCount,errorCount},_meta:{...meta,orbitfsUiState:{workspaceId,context:compactContext(r.receipt),loadedCount,errorCount}}};});server.registerTool("load_folder",{title:"Load OrbitFS folder",description:"Recursively read permitted files from a workspace folder and append their contents to active context.",inputSchema:{workspaceId:z.string(),path:z.string(),maxFiles:z.number().int().positive().max(500).optional(),maxCharacters:z.number().int().positive().max(5000000).optional()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,path:relativePath,maxFiles=100,maxCharacters=1500000})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const policy=effectiveAdminPolicy(workspaceId);if(policy.ccs?.enabled===false)throw Object.assign(new Error("Complex Context System is disabled by MCP Admin policy"),{status:403,code:"CCS_DISABLED"});const resolved=await resolveWorkspacePath(workspaceId,relativePath),info=await fs.stat(resolved.absolute).catch(()=>null);if(!info?.isDirectory())throw Object.assign(new Error("Folder not found"),{status:404,code:"FOLDER_NOT_FOUND"});const items=await collectFolderFiles(resolved.root,resolved.absolute,maxFiles,true,Number(policy.ccs?.maxFolderDepth??10)),r=await loadPathsIntoContext(workspaceId,clientId,items,maxCharacters,policy,identity);const loadedCount=(r.loaded||[]).length,errorCount=(r.errors||[]).length,text=loadedCount?`Loaded ${loadedCount} folder item${loadedCount===1?"":"s"} into OrbitFS context.`:"No readable files were loaded.";return{content:[{type:"text",text}],structuredContent:{ok:loadedCount>0,message:text,loadedCount,errorCount,discoveredCount:items.length},_meta:{...meta,orbitfsUiState:{workspaceId,context:compactContext(r.receipt),loadedCount,errorCount,discoveredCount:items.length}}};});server.registerTool("list_context_bundles",{title:"List OrbitFS context bundles",description:"List reusable context bundles available in a workspace.",inputSchema:{workspaceId:z.string()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const policy=effectiveAdminPolicy(workspaceId);if(policy.ccs?.enabled===false)throw Object.assign(new Error("Complex Context System is disabled by MCP Admin policy"),{status:403,code:"CCS_DISABLED"});const bundles=await listContextBundles(workspaceId);const text=bundles.length?`${bundles.length} context bundle${bundles.length===1?"":"s"} available.`:"No context bundles configured.";return{content:[{type:"text",text}],structuredContent:{ok:true,message:text,bundleCount:bundles.length},_meta:{...meta,orbitfsUiState:{workspaceId,bundles}}};});server.registerTool("load_context_bundle",{title:"Load OrbitFS context bundle",description:"Resolve a named context bundle and its dependencies, read the actual documents, and merge them into active context.",inputSchema:{workspaceId:z.string(),bundleId:z.string(),maxFiles:z.number().int().positive().max(500).optional(),maxCharacters:z.number().int().positive().max(5000000).optional()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,bundleId,maxFiles=250,maxCharacters=1500000})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const policy=effectiveAdminPolicy(workspaceId);const cappedCharacters=Math.min(maxCharacters,Number(policy.ccs?.maxBundleCharacters||5000000));const r=await loadBundleIntoContext(workspaceId,bundleId,clientId,maxFiles,cappedCharacters,identity,policy);const loadedCount=(r.loaded||[]).length,errorCount=(r.errors||[]).length,text=loadedCount?`Loaded context bundle (${loadedCount} item${loadedCount===1?"":"s"}).`:"Context bundle contained no readable files.";return{content:[{type:"text",text}],structuredContent:{ok:loadedCount>0,message:text,loadedCount,errorCount},_meta:{...meta,orbitfsUiState:{workspaceId,bundleId,resolvedBundles:r.resolved.bundles.map(b=>({id:b.id,name:b.name,version:b.version})),context:compactContext(r.receipt),errorCount}}};});server.registerTool("unload_context_bundle",{title:"Unload OrbitFS context bundle",description:"Remove a loaded context bundle and its files/profiles from active context.",inputSchema:{workspaceId:z.string(),bundleId:z.string()},annotations:{destructiveHint:true,readOnlyHint:false,idempotentHint:true,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,bundleId})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const receipt=await unloadBundleFromContext(workspaceId,bundleId);return{content:[{type:"text",text:"Context bundle unloaded."}],structuredContent:{ok:true,message:"Context bundle unloaded."},_meta:{...meta,orbitfsUiState:{workspaceId,bundleId,context:compactContext(receipt)}}};});server.registerTool("list_workspace_entries",{title:"Browse OrbitFS workspace",description:"Internal app-only file/folder browser for the embedded picker.",inputSchema:{workspaceId:z.string(),path:z.string().optional()},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:appOnlyMeta},async({workspaceId,path=""})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403});const entries=await listWorkspaceEntries(workspaceId,path),permitted=[];for(const entry of entries){try{await requireFilePermission(identity,workspaceId,entry.path,"read");permitted.push(entry);}catch{}}const text=`${permitted.length} item${permitted.length===1?"":"s"}`;return{content:[{type:"text",text}],structuredContent:{ok:true,message:text,itemCount:permitted.length},_meta:{...meta,orbitfsUiState:{workspaceId,path,entries:permitted}}};});
server.registerTool("view_profile",{title:"View OrbitFS profile",description:"Display a permitted OrbitFS profile by profileId, profile name, or loaded active-context path such as Profiles/MASTER PROFILE - ZOE SHEDDAN. Prefers profiles already loaded into active context, then falls back to allowed workspace lookup. Return and display the readable profile sections, not just a load receipt.",inputSchema:{workspaceId:z.string(),profileId:z.string().optional(),profileName:z.string().optional(),path:z.string().optional()},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,profileId,profileName,path:profilePath})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const reference=profileId||profileName||profilePath;const viewed=await resolveWorkspaceProfile(workspaceId,reference,identity,getActiveContext(workspaceId));const receipt=`Profile ${viewed.profileName} loaded from ${viewed.source}.`;return{content:[{type:"text",text:viewed.content}],structuredContent:{ok:true,message:receipt,receipt,profileText:viewed.content,displayText:viewed.content,profile:{id:viewed.profileId||null,name:viewed.profileName,path:viewed.path,source:viewed.source,detail:viewed.detail},characters:viewed.content.length},_meta:{...meta,orbitfsUiState:{workspaceId,profile:{id:viewed.profileId||null,name:viewed.profileName,path:viewed.path},detail:viewed.detail,source:viewed.source}}};});server.registerTool("list_profiles",{title:"List OrbitFS profiles",description:"List profiles available to the current user in a workspace.",inputSchema:{workspaceId:z.string()},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403});const result=await listWorkspaceProfiles(workspaceId,identity);const profiles=(result.profiles||[]).map((profile)=>({id:profile.id,name:profile.name,type:profile.type,status:profile.status,restricted:profile.restricted,srestricted:profile.srestricted,sectionCount:profile.sectionCount,relationshipCount:profile.relationshipCount,updatedAt:profile.updatedAt}));const text=profiles.length?profiles.map((profile,i)=>`${i+1}. ${profile.name} (${profile.type || "profile"})`).join("\n"):"No profiles available.";return{content:[{type:"text",text}],structuredContent:{ok:true,message:text,profileCount:profiles.length,profiles},_meta:{...meta,orbitfsUiState:{workspaceId,...result}}};});
server.registerTool("load_profile",{title:"Load OrbitFS profile",description:"Load a permitted profile into the active ChatGPT context.",inputSchema:{workspaceId:z.string(),profileId:z.string(),detail:z.enum(["summary","standard","full"]).optional()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,profileId,detail="standard"})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403});const visible=await listWorkspaceProfiles(workspaceId,identity);if(!visible.profiles.some((profile)=>profile.id===profileId))throw Object.assign(new Error("Profile is unavailable or access is denied"),{status:403,code:"PROFILE_ACCESS_DENIED"});const result=await loadWorkspaceProfile(workspaceId,profileId,detail,identity);const item=profileContextItem(result,{profileId,detail});let receipt=await mergeActiveContext(workspaceId,{contextId:getActiveContext(workspaceId)?.contextId||`ctx-${crypto.randomUUID()}`,clientId,workspaceId,files:[item],errors:[],completedAt:new Date().toISOString()});let referenceLoaded=0;const policy=effectiveAdminPolicy(workspaceId);if(result.followReferences&&Array.isArray(result.references)){for(const ref of result.references.slice(0,12)){try{const resolved=await resolveWorkspacePath(workspaceId,ref.path),info=await fs.stat(resolved.absolute).catch(()=>null);if(info?.isFile()){const loaded=await loadPathsIntoContext(workspaceId,clientId,[{absolute:resolved.absolute,path:resolved.clean}],250000,policy,identity);receipt=loaded.receipt;referenceLoaded+=(loaded.loaded||[]).length;}}catch{}}}const text=`Loaded profile ${result.profile.name}${referenceLoaded?` plus ${referenceLoaded} approved reference${referenceLoaded===1?"":"s"}`:""}.`;return{content:[{type:"text",text}],structuredContent:{ok:true,message:text,profile:{id:result.profile.id,name:result.profile.name}},_meta:{...meta,orbitfsUiState:{workspaceId,profile:{id:result.profile.id,name:result.profile.name},detail,context:compactContext(receipt)}}};});
server.registerTool("remove_context_file",{title:"Remove item from OrbitFS context",description:"Remove one loaded file or profile from active context.",inputSchema:{workspaceId:z.string(),path:z.string()},annotations:{destructiveHint:true,readOnlyHint:false,idempotentHint:true,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId,path})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const receipt=await removeActiveContextFile(workspaceId,path);const text=`Removed ${path} from active context.`;return{content:[{type:"text",text}],structuredContent:{ok:true,message:text},_meta:{...meta,orbitfsUiState:{workspaceId,context:compactContext(receipt)}}};});
server.registerTool("reload_changed_context",{title:"Reload changed OrbitFS context",description:"Reload source files changed since the active context was created.",inputSchema:{workspaceId:z.string()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});const receipt=getActiveContext(workspaceId);if(!receipt)return{content:[{type:"text",text:"No active context."}],structuredContent:{ok:true,message:"No active context."},_meta:{...meta,orbitfsUiState:{workspaceId,activeContext:null}}};const changes=await inspectContextChanges(workspaceId,receipt),root=await workspaceRoot(workspaceId),items=[];for(const change of changes.changedFiles){if(change.status!=="modified")continue;const absolute=path.resolve(root,change.path);if(absolute===root||absolute.startsWith(root+path.sep))items.push({absolute,path:change.path});}const result=items.length?await loadPathsIntoContext(workspaceId,clientId,items,receipt.limitCharacters||500000,effectiveAdminPolicy(workspaceId),identity):{receipt,loaded:[],errors:[]};const text=`Reloaded ${result.loaded.length} changed item${result.loaded.length===1?"":"s"}.`,context=compactContext(result.receipt,await inspectContextChanges(workspaceId,result.receipt));return{content:[{type:"text",text}],structuredContent:{ok:true,message:text,reloadedCount:result.loaded.length},_meta:{...meta,orbitfsUiState:{workspaceId,context,reloadedCount:result.loaded.length}}};});
server.registerTool("clear_context",{title:"Clear OrbitFS context",description:"Clear active context metadata for a workspace.",inputSchema:{workspaceId:z.string()},annotations:{destructiveHint:true,readOnlyHint:false,idempotentHint:true,openWorldHint:false},outputSchema:contextToolOutputSchema,_meta:meta},async({workspaceId})=>{requireLicence();const allowed=filterWorkspaces(await listWorkspaces(),identity);if(!allowed.some(w=>w.id===workspaceId))throw Object.assign(new Error("Workspace access denied"),{status:403,code:"WORKSPACE_ACCESS_DENIED"});await clearActiveContext(workspaceId);return{content:[{type:"text",text:"OrbitFS context cleared."}],structuredContent:{ok:true,message:"OrbitFS context cleared."},_meta:{...meta,orbitfsUiState:{workspaceId,context:compactContext(null)}}};});return server;}
app.get("/mcp/.well-known/oauth-protected-resource",(_req,res)=>res.json(protectedResourceMetadata()));
app.get("/mcp/oauth/.well-known/openid-configuration",(_req,res)=>res.json(oidcMetadata()));
app.get("/mcp/oauth/.well-known/oauth-authorization-server",(_req,res)=>res.json(oauthMetadata()));
app.get("/.well-known/oauth-authorization-server/mcp/oauth",(_req,res)=>res.json(oauthMetadata()));
app.get("/.well-known/openid-configuration/mcp/oauth",(_req,res)=>res.json(oidcMetadata()));
app.get("/mcp/oauth/jwks",(_req,res)=>res.json({keys:[]}));
app.post("/mcp/oauth/register",async(req,res)=>{try{res.status(201).json(await registerClient(req.body));}catch(e){res.status(e.status||400).json({error:e.code||"invalid_client_metadata",error_description:e.message});}});
app.get("/mcp/oauth/authorize",(req,res)=>beginAuthorization(req,res).catch(e=>res.status(e.status||500).send(e.message)));
app.post("/mcp/oauth/authorize",(req,res)=>completeAuthorization(req,res).catch(e=>res.status(e.status||500).send(e.message)));
app.post("/mcp/oauth/token",(req,res)=>tokenEndpoint(req,res).catch(e=>res.status(e.status||500).json({error:"server_error",error_description:e.message})));
app.get("/.well-known/oauth-protected-resource",(_req,res)=>res.json(protectedResourceMetadata()));
app.get("/.well-known/oauth-protected-resource/mcp",(_req,res)=>res.json(protectedResourceMetadata()));
app.get("/.well-known/oauth-authorization-server",(_req,res)=>res.json(oauthMetadata()));
app.get("/.well-known/openid-configuration",(_req,res)=>res.json(oidcMetadata()));
app.post("/register",async(req,res)=>{try{res.status(201).json(await registerClient(req.body));}catch(e){res.status(e.status||400).json({error:e.code||"invalid_client_metadata",error_description:e.message});}});
app.get("/authorize",(req,res)=>beginAuthorization(req,res).catch(e=>res.status(e.status||500).send(e.message)));
app.post("/authorize",(req,res)=>completeAuthorization(req,res).catch(e=>res.status(e.status||500).send(e.message)));
app.post("/token",(req,res)=>tokenEndpoint(req,res).catch(e=>res.status(e.status||500).json({error:"server_error",error_description:e.message})));
app.get("/health",async(_req,res)=>{let store={mysql:false,state:false};try{store=await pingStore();}catch(e){store={mysql:false,state:false,error:e.message};}res.status(currentLicence.licensed?200:503).json({ok:currentLicence.licensed,service:"orbitfs-mcp",version:"1.5.0",license:status(),store,clients:clients.size,uptimeSeconds:Math.round(process.uptime())});});
app.put("/control/policy",requireControl,(req,res)=>{adminPolicy={...adminPolicy,...(req.body?.policy||{}),oss:{...adminPolicy.oss,...(req.body?.policy?.oss||{})},ccs:{...adminPolicy.ccs,...(req.body?.policy?.ccs||{})},registry:{...adminPolicy.registry,...(req.body?.policy?.registry||{})}};res.json({applied:true,policy:adminPolicy});});
app.get("/control/status",requireControl,async(_req,res)=>res.json({running:true,license:status(),store:await pingStore().catch(e=>({error:e.message})),clients:listSessions({includeInactive:true,idleMinutes:Number(adminPolicy.registry?.sessionIdleMinutes||60)}),appUi:{enabled:true,resourceUri:"ui://orbitfs/home-v6.html",mimeType:RESOURCE_MIME_TYPE,tools:["orbitfs"],initialView:"home"},oauth:{issuer:oauthMetadata().issuer,resource:protectedResourceMetadata().resource,authorizationServerDiscovery:`${oauthMetadata().issuer}/.well-known/oauth-authorization-server`}}));
app.get("/control/registry",requireControl,async(_req,res)=>{try{const allClients=await listOAuthClients(),cutoff=Date.now()-Number(adminPolicy.registry?.historyRetentionDays||90)*86400000,sessions=listSessions({includeInactive:true,idleMinutes:Number(adminPolicy.registry?.sessionIdleMinutes||60)}).filter(item=>!item.connectedAt||new Date(item.connectedAt).getTime()>=cutoff),recentCutoff=Date.now()-Number(adminPolicy.registry?.recentConnectionDays||30)*86400000,recent=sessions.filter(item=>(item.status!=="active"||item.idle)&&(!item.lastSeenAt||new Date(item.lastSeenAt).getTime()>=recentCutoff));res.json({clients:allClients.filter(item=>item.status!=="disconnected"),connected:sessions.filter(item=>item.status==="active"&&!item.idle),sessions,recent});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"REGISTRY_LIST_FAILED"});}});
app.patch("/control/registry/clients/:clientId",requireControl,async(req,res)=>{try{const result=await updateOAuthClient(req.params.clientId,req.body||{});if(result.client.status!=="active")disconnectClientSessions(req.params.clientId,result.client.status);res.json(result);}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"REGISTRY_UPDATE_FAILED"});}});
app.post("/control/registry/clients/:clientId/disconnect",requireControl,async(req,res)=>{try{const reason=String(req.body?.reason||"admin_disconnect"),oauth=await revokeOAuthClientSessions(req.params.clientId),result=await updateOAuthClient(req.params.clientId,{status:"disconnected"}),sessions=disconnectClientSessions(req.params.clientId,reason);res.json({...oauth,client:result.client,sessions});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"REGISTRY_DISCONNECT_FAILED"});}});
app.post("/control/registry/sessions/:sessionId/disconnect",requireControl,async(req,res)=>{const session=disconnectSession(req.params.sessionId,String(req.body?.reason||"admin_disconnect"));if(!session)return res.status(404).json({error:"Session not found",code:"SESSION_NOT_FOUND"});res.json({session});});
app.post("/control/registry/sessions/:sessionId/unblock",requireControl,async(req,res)=>{const session=unblockSession(req.params.sessionId);if(!session)return res.status(404).json({error:"Session not found",code:"SESSION_NOT_FOUND"});res.json({session});});
app.get("/control/context/:workspaceId",requireControl,async(req,res)=>{try{const receipt=getActiveContext(req.params.workspaceId),changeStatus=await inspectContextChanges(req.params.workspaceId,receipt);res.json({workspaceId:req.params.workspaceId,activeContext:receipt,changeStatus});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"CONTEXT_STATUS_FAILED"});}});
app.delete("/control/context/:workspaceId",requireControl,async(req,res)=>{await clearActiveContext(req.params.workspaceId);res.json({workspaceId:req.params.workspaceId,activeContext:null});});
app.delete("/control/context/:workspaceId/file",requireControl,async(req,res)=>{try{const receipt=await removeActiveContextFile(req.params.workspaceId,String(req.body?.path||""));res.json({workspaceId:req.params.workspaceId,activeContext:receipt});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"CONTEXT_REMOVE_FAILED"});}});
app.post("/control/context/:workspaceId/remove-file",requireControl,async(req,res)=>{try{const receipt=await removeActiveContextFile(req.params.workspaceId,String(req.body?.path||""));res.json({workspaceId:req.params.workspaceId,activeContext:receipt});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"CONTEXT_REMOVE_FAILED"});}});
app.post("/control/context/:workspaceId/reload-changed",requireControl,async(req,res)=>{try{const workspaceId=req.params.workspaceId,policy=effectiveAdminPolicy(workspaceId);if(policy.ccs?.enabled===false)return res.status(403).json({error:"Complex Context System is disabled by MCP Admin policy",code:"CCS_DISABLED"});const receipt=getActiveContext(workspaceId);if(!receipt)return res.status(404).json({error:"No active context",code:"NO_ACTIVE_CONTEXT"});const changes=await inspectContextChanges(workspaceId,receipt),root=await workspaceRoot(workspaceId),items=[];for(const change of changes.changedFiles){if(change.status!=="modified")continue;const absolute=path.resolve(root,change.path);if(absolute===root||absolute.startsWith(root+path.sep))items.push({absolute,path:change.path});}const result=items.length?await loadPathsIntoContext(workspaceId,receipt.clientId||"panel",items,Number(req.body?.maxCharacters||receipt.limitCharacters||500000),policy):{receipt,loaded:[],errors:[]};res.json({workspaceId,reloaded:result.loaded.map(item=>item.path),errors:result.errors,activeContext:result.receipt,changeStatus:await inspectContextChanges(workspaceId,result.receipt)});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"CONTEXT_RELOAD_FAILED"});}});
app.post("/control/context/:workspaceId/load-file",requireControl,async(req,res)=>{try{const workspaceId=req.params.workspaceId,policy=effectiveAdminPolicy(workspaceId);if(policy.ccs?.enabled===false)return res.status(403).json({error:"Complex Context System is disabled by MCP Admin policy",code:"CCS_DISABLED"});const resolved=await resolveWorkspacePath(workspaceId,String(req.body?.path||"")),info=await fs.stat(resolved.absolute).catch(()=>null);if(!info?.isFile())return res.status(404).json({error:"File not found",code:"FILE_NOT_FOUND"});const result=await loadPathsIntoContext(workspaceId,"panel",[{absolute:resolved.absolute,path:resolved.clean}],Number(req.body?.maxCharacters||500000),policy);res.json({workspaceId,loaded:result.loaded.map(item=>item.path),errors:result.errors,activeContext:result.receipt});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"CONTEXT_LOAD_FILE_FAILED"});}});
app.post("/control/context/:workspaceId/load-folder",requireControl,async(req,res)=>{try{const workspaceId=req.params.workspaceId,policy=effectiveAdminPolicy(workspaceId);if(policy.ccs?.enabled===false)return res.status(403).json({error:"Complex Context System is disabled by MCP Admin policy",code:"CCS_DISABLED"});const resolved=await resolveWorkspacePath(workspaceId,String(req.body?.path||"")),info=await fs.stat(resolved.absolute).catch(()=>null);if(!info?.isDirectory())return res.status(404).json({error:"Folder not found",code:"FOLDER_NOT_FOUND"});const items=await collectFolderFiles(resolved.root,resolved.absolute,Number(req.body?.maxFiles||50),true,Number(policy.ccs?.maxFolderDepth??10)),result=await loadPathsIntoContext(workspaceId,"panel",items,Number(req.body?.maxCharacters||500000),policy);res.json({workspaceId,discoveredCount:items.length,loaded:result.loaded.map(item=>item.path),errors:result.errors,activeContext:result.receipt});}catch(error){res.status(error.status||500).json({error:error.message,code:error.code||"CONTEXT_LOAD_FOLDER_FAILED"});}});

app.post("/control/recheck-license",requireControl,async(_req,res)=>res.json({license:await refreshLicence(true)}));
app.post("/control/shutdown",requireControl,(_req,res)=>{res.json({accepted:true});setTimeout(()=>gracefulShutdown(0),100).unref?.();});
function requestConversationId(req,identity){const meta=req.body?.params?._meta||req.body?._meta||{};return String(req.get("x-openai-conversation-id")||req.get("openai-conversation-id")||req.get("chatgpt-conversation-id")||meta["openai/conversationId"]||meta.conversationId||identity.clientId||"client");}
function requestContextScope(req,identity){const conversationId=requestConversationId(req,identity);return `${identity.userId||identity.username||"user"}:${identity.clientId||"client"}:${conversationId}`;}
function requestSessionId(scope){return `mcp-${crypto.createHash('sha256').update(String(scope)).digest('hex').slice(0,24)}`;}

const mcpHttpHandler=createMcpHandler((ctx)=>{
  const identity=ctx.authInfo||{};
  const clientId=String(identity.clientId||identity.userId||"chatgpt");
  const conversationId=String(identity.__orbitfsConversationId||identity.clientId||"client");
  const scope=String(identity.__orbitfsContextScope||`${identity.userId||identity.username||"user"}:${clientId}:${conversationId}`);
  return runWithContextScope(scope,async()=>buildServer(clientId,identity,{sessionId:requestSessionId(scope),conversationId}));
},{legacy:"stateless",onerror:(error)=>fs.appendFile(requestTracePath,JSON.stringify({at:new Date().toISOString(),event:"mcp_handler_error",message:error?.message||String(error)})+"\n").catch(()=>{})});
const nodeMcpHandler=toNodeHandler(mcpHttpHandler,{onerror:(error)=>fs.appendFile(requestTracePath,JSON.stringify({at:new Date().toISOString(),event:"mcp_node_adapter_error",message:error?.message||String(error)})+"\n").catch(()=>{})});
app.all("/mcp",async(req,res)=>{try{const identity=await bearerIdentity(req);if(!identity){res.setHeader("WWW-Authenticate",authChallenge());return res.status(401).json({error:"authorization_required",code:"OAUTH_REQUIRED"});}requireLicence();const conversationId=requestConversationId(req,identity),scope=requestContextScope(req,identity);req.auth={...identity,__orbitfsConversationId:conversationId,__orbitfsContextScope:scope};await runWithContextScope(scope,async()=>nodeMcpHandler(req,res,req.body));}catch(e){if(!res.headersSent)res.status(e.status||500).json({error:e.message,code:e.code||"MCP_ERROR",restricted:e.code==="LICENSE_REQUIRED"});}});
async function bootstrap(){await loadAdminPolicy();await loadContextState();await ensureContextLibrarySchema();try{await refreshLicence(true);}catch(e){currentLicence={licensed:false,component:COMPONENTS.MCP,reason:e.code||"licence_validation_failed",message:e.message,lastCheckedAt:new Date().toISOString()};}if(!currentLicence.licensed){console.warn(JSON.stringify({event:"orbitfs.mcp.started_unlicensed",message:warning()}));}await pingStore();startLicenseHeartbeat({onUpdate:s=>{const i=s.components?.[COMPONENTS.MCP]||{};currentLicence={...i,licensed:s.valid===true&&i.state==="locked"&&i.allowed===true&&i.lockedToThisInstallation===true,reason:i.reason||s.reason,lastCheckedAt:s.lastCheckedAt};if(!currentLicence.licensed)scheduleShutdown(currentLicence);},onError:e=>console.error(JSON.stringify({event:"orbitfs.mcp.licence_check_failed",severity:"warning",message:e.message}))});httpServer=app.listen(port,"127.0.0.1",()=>console.log(JSON.stringify({event:"orbitfs.mcp.started",port,licensed:true,installationId:currentLicence.installationId||null})));}
process.on("SIGTERM",()=>gracefulShutdown(0));process.on("SIGINT",()=>gracefulShutdown(0));await bootstrap();




