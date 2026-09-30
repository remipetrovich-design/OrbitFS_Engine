import crypto from 'node:crypto';
import path from 'node:path';
import { resolveMode, persistMode } from '../engine/mode-resolver.js';
const migrations=['001_initial.sql','002_context_library.sql','003_context_assignments.sql','004_preset_metadata.sql','005_profile_attachments.sql','006_repair_legacy_core_tables.sql','007_runtime_workspace_schema.sql'];

async function resolveCoreDatabase(context, cfg = {}) {
  const candidates = [];
  try { if (context.db?.getConnectionConfig) candidates.push(await context.db.getConnectionConfig('core')); } catch {}
  try { if (context.db?.describe) candidates.push(await context.db.describe('core')); } catch {}
  try { if (context.db?.config) candidates.push(await context.db.config('core')); } catch {}
  candidates.push(context.database?.core, context.coreConfig?.mysql, context.config?.mysql, context.mysqlConfig);
  const core = candidates.find((item) => item && typeof item === 'object') || {};
  return {
    host: String(cfg.mysqlHost || core.host || '127.0.0.1'),
    port: Number(cfg.mysqlPort || core.port || 3306),
    user: String(cfg.mysqlUser || core.user || 'root'),
    password: String(cfg.mysqlPassword ?? core.password ?? ''),
    database: String(cfg.mysqlDatabase || core.database || core.name || 'orbitfs')
  };
}

async function ensureDatabase(context){
  const detected=await context.mysql.detect();
  if(!detected?.installed)await context.mysql.install({product:'mysql-server',reason:'OrbitFS MCP requires MySQL'});
  await context.mysql.start();
  const cfg=await context.configStore.get('mcp').catch(()=>({}));
  const mysql=await resolveCoreDatabase(context,cfg||{});
  await context.db.ensureDatabase(mysql.database);
  await context.migrations.applyDirectory({addonId:'mcp',directory:context.addonRoot+'/migrations',files:migrations,connection:'core'});
  return mysql;
}

async function configureRuntime(context){
  let cfg=await context.configStore.merge('mcp',context.config||{});
  if(!cfg.controlToken){cfg=await context.configStore.merge('mcp',{controlToken:crypto.randomBytes(32).toString('hex')});}
  const mysql=await resolveCoreDatabase(context,cfg);
  const autoStart=cfg.autoStart===true;
  const persistentStorageRoot=String(context.storageRoot||cfg.publicStorageRoot||context.config?.storageRoot||'').trim();
  const systemRoot=String(context.systemRoot||context.config?.systemRoot||'').trim();
  const oauthStatePath=String(cfg.oauthStatePath||(systemRoot?path.join(systemRoot,'mcp','oauth-state.json'):'')).trim();
  cfg=await context.configStore.merge('mcp',{
    mysqlHost:mysql.host,mysqlPort:mysql.port,mysqlUser:mysql.user,
    mysqlPassword:mysql.password,mysqlDatabase:mysql.database,autoStart,
    ...(oauthStatePath?{oauthStatePath}:{})
  });
  const mode=await persistMode(context,resolveMode(context));
  const publicRoot=String(cfg.publicStorageRoot||context.storageRoot||'').trim();
  if(mode.mode==='public'&&!publicRoot)throw new Error('Public storage root is required when MCP is running in public fallback mode');
  if(publicRoot)await context.storage.ensure(publicRoot);
  const publicBaseUrl=String(cfg.publicBaseUrl||'https://mcp.orbitfs.cc/mcp').replace(/\/$/,'');
  const oauthIssuer=publicBaseUrl+'/oauth';
  const env={
    PORT:String(cfg.port||3939),
    ORBITFS_MCP_MODE:mode.mode,
    ORBITFS_ALLOW_PUBLIC_FALLBACK:String(mode.mode==='public'),
    ORBITFS_PUBLIC_STORAGE_ROOT:publicRoot,
    ORBITFS_MCP_RESOURCE:publicBaseUrl,
    ORBITFS_MCP_ISSUER:oauthIssuer,
    ORBITFS_PANEL_STATE_PATH:String(context.panelStatePath||context.statePath||''),
    ORBITFS_LICENSE_API_URL:String(context.licenseApiUrl||process.env.ORBITFS_LICENSE_API_URL||''),
    ORBITFS_CONTROL_TOKEN:String(cfg.controlToken),
    ORBITFS_MCP_OAUTH_STATE:String(cfg.oauthStatePath||''),
    ORBITFS_MAX_FILE_BYTES:String(cfg.maxDocumentFileBytes||20971520),
    ORBITFS_MAX_MEDIA_FILE_BYTES:String(cfg.maxMediaFileBytes||262144000),
    ORBITFS_MAX_MEDIA_OUTPUT_BYTES:String(cfg.maxMediaOutputBytes||12582912),
    ORBITFS_MEDIA_CHUNK_SECONDS:String(cfg.mediaChunkSeconds||600),
    ORBITFS_MEDIA_MAX_CHUNKS:String(cfg.mediaMaxChunks||12),
    ORBITFS_VIDEO_FRAME_INTERVAL_SECONDS:String(cfg.videoFrameIntervalSeconds||15),
    ORBITFS_VIDEO_MAX_FRAMES:String(cfg.videoMaxFrames||8),
    MYSQL_HOST:mysql.host,
    MYSQL_PORT:String(mysql.port),
    MYSQL_USER:mysql.user,
    MYSQL_PASSWORD:mysql.password,
    MYSQL_DATABASE:mysql.database
  };
  await context.service.install({name:cfg.serviceName||'OrbitFSMcpServer',entry:context.addonRoot+'/engine/server.js',cwd:context.addonRoot+'/engine',autoStart:cfg.autoStart!==false,env});
  await context.connector.register({addonId:'mcp',provider:'chatgpt',path:'/mcp',authMode:'oauth'});
  return {config:cfg,mode,mysql:{host:mysql.host,port:mysql.port,database:mysql.database,user:mysql.user}};
}

export async function install(context){await context.license.require('orbitfs_mcp');await ensureDatabase(context);const result=await configureRuntime(context);await context.registry.install('mcp',context.manifest);await context.router.register('mcp',context.addonRoot+'/backend/routes.js');await context.frontend.register('mcp',context.addonRoot+'/frontend');if(result.config.autoStart!==false)await context.service.start(result.config.serviceName||'OrbitFSMcpServer');return{ok:true,installed:true,...result};}
export async function configure(context){await context.license.require('orbitfs_mcp');return{ok:true,...await configureRuntime(context)};}
export async function test(context){const mode=resolveMode(context),cfg=await context.configStore.get('mcp'),service=await context.service.status(cfg.serviceName||'OrbitFSMcpServer'),database=await context.db.ping('core'),licensed=await context.license.check('orbitfs_mcp');return{ok:Boolean(database&&licensed&&service?.installed),mode:mode.mode,workspaceAddonActive:mode.workspaceAddonActive,workspaceCoreActive:mode.workspaceCoreActive,database,licensed,service,connectorUrl:String(cfg.publicBaseUrl||'https://mcp.orbitfs.cc/mcp').replace(/\/$/,''),mysqlDatabase:cfg.mysqlDatabase||null};}
export async function repair(context){await ensureDatabase(context);return install(context);}
export async function upgrade(context){await context.license.require('orbitfs_mcp');await ensureDatabase(context);return configure(context);}
export async function attach(context){await context.license.require('orbitfs_mcp');await ensureDatabase(context);const result=await configureRuntime(context);await context.registry.attach('mcp');await context.service.start(result.config.serviceName||'OrbitFSMcpServer');return{ok:true,mode:result.mode.mode,serviceInstalled:true};}
export async function detach(context){const cfg=await context.configStore.get('mcp');await context.service.stop(cfg.serviceName||'OrbitFSMcpServer');await context.registry.detach('mcp');return{ok:true,preserved:true};}
export async function uninstall(context,{purge=false}={}){const cfg=await context.configStore.get('mcp');await context.service.remove(cfg.serviceName||'OrbitFSMcpServer');await context.connector.unregister('mcp');await context.frontend.unregister('mcp');await context.router.unregister('mcp');await context.registry.uninstall('mcp');if(purge){await context.migrations.purgePrefix('mcp_');await context.configStore.delete('mcp');}return{ok:true,preserved:!purge};}
export default{install,configure,test,repair,upgrade,attach,detach,uninstall};
