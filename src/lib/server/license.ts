import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getSupabaseAdmin } from '$lib/server/supabase';

export const PANEL_COMPONENT='orbitfs_base';
export const STABLE_LICENSE_COMPONENTS=['orbitfs_base','orbitfs_mcp','orbitfs_apex','orbitfs_studio'] as const;
const LICENSE_ID='primary';
const ROW_CACHE_MS=5000, SUMMARY_CACHE_MS=3000;
type LicenseRow={id:string;license_key:string|null;status:string;plan:string|null;licensed_to:string|null;expires_at:string|null;metadata:Record<string,any>|null};
type PulseDirective={id:string;revision:number;action:string;scope:string;license_id?:string|null;installation_id?:string|null;product?:string|null;component?:string|null;reason?:string|null;payload?:Record<string,any>;requires_ack?:boolean};
export type PanelLicenseSummary={valid:boolean;licensed:boolean;enforcement:true;reason:string|null;status:string;keyHint:string|null;installationId:string;lastCheckedAt:string|null;lastRevisionCheckedAt:string|null;masterRevision:string|number|null;nextValidationAt:string|null;nextRevisionCheckAt:string|null;offlineGrace:boolean;refreshError:string|null;component:Record<string,any>;components:Record<string,any>;plan:string|null;licensedTo:string|null;expiresAt:string|null};
const TRUSTED_LICENSE_REGISTRY_ROOT='https://incendiarynetworks.cc/api/v1';
const TRUSTED_LICENSE_RUNTIME_URL='https://incendiarynetworks.cc/api/v1/license';
let officialProviderCache:{expires:number;connections:any[]}|null=null;
const token=()=>'';
const timeoutMs=()=>Math.max(1000,Number(env.ORBITFS_LICENSE_TIMEOUT_MS||8000));
function identityMetadata(installationId:string,extra:Record<string,any>={}){let supabaseProjectRef:string|null=null;try{supabaseProjectRef=new URL(String(env.SUPABASE_URL||"")).hostname.split(".")[0]||null}catch{}return{installationId,product:"orbitfs_base",appVersion:String(env.ORBITFS_BASE_VERSION||env.ORBITFS_APP_VERSION||"unknown"),panelUrl:String(env.ORBITFS_PANEL_URL||""),deploymentUrl:String(env.VERCEL_URL||""),vercelEnvironment:String(env.VERCEL_ENV||"production"),vercelRegion:String(env.VERCEL_REGION||""),supabaseProjectRef,...extra};}
const keyHint=(k:string)=>k.length>4?`****${k.slice(-4)}`:'****';
let rowCache:{value:LicenseRow|null;expires:number}|null=null;let summaryCache:{value:PanelLicenseSummary;expires:number}|null=null;
function normalizeProviderBase(value:string){
  const raw=String(value||'').trim().replace(/\/+$/,'');
  if(!raw)throw Object.assign(new Error('OrbitFS licence API URL is not configured'),{code:'LICENSE_MASTER_URL_MISSING',status:503});
  try{
    const u=new URL(raw);
    const path=u.pathname.replace(/\/+$/,'');
    const host=u.hostname.toLowerCase();
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||(host!=='incendiarynetworks.cc'&&!host.endsWith('.incendiarynetworks.cc'))||path!=='/api/v1/license')throw new Error();
    return `${u.origin}/api/v1/license`;
  }catch{
    throw Object.assign(new Error('Licence API must be an official OrbitFS HTTPS /api/v1/license endpoint'),{code:'LICENSE_PROVIDER_INVALID',status:503});
  }
}
async function officialLicenseProviders(force=false){
  if(!force&&officialProviderCache&&officialProviderCache.expires>Date.now())return officialProviderCache.connections;
  let connections:any[]=[];
  try{
    const url=new URL(TRUSTED_LICENSE_REGISTRY_ROOT+'/api-connections');
    url.searchParams.set('client','v1_engine');url.searchParams.set('service','license_runtime');
    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(response.ok){
      const body=await response.json().catch(()=>({}));
      connections=(Array.isArray(body?.connections)?body.connections:[])
        .filter((row:any)=>row?.enabled!==false)
        .map((row:any)=>({...row,base_url:normalizeProviderBase(String(row.base_url||''))}))
        .filter((row:any)=>Boolean(row.base_url));
    }
  }catch{}
  if(!connections.length)connections=[{service_key:'license_runtime',label:'Primary OrbitFS licence runtime API',base_url:TRUSTED_LICENSE_RUNTIME_URL,enabled:true,priority:10,settings:{bootstrap:true}}];
  connections.sort((a:any,b:any)=>Number(a.priority||100)-Number(b.priority||100));
  officialProviderCache={expires:Date.now()+30000,connections};
  return connections;
}
async function requireOfficialProviderBase(value:string){
  const normalized=normalizeProviderBase(value);
  const official=await officialLicenseProviders(true);
  if(!official.some((row:any)=>String(row.base_url)===normalized))throw Object.assign(new Error('That URL is not an enabled official OrbitFS licence API.'),{status:400,code:'LICENSE_PROVIDER_NOT_OFFICIAL'});
  return normalized;
}
async function configuredProvider(){
  const official=await officialLicenseProviders();
  const allowed=new Set(official.map((row:any)=>String(row.base_url)));
  let selected=allowed.has(TRUSTED_LICENSE_RUNTIME_URL)?TRUSTED_LICENSE_RUNTIME_URL:String(official[0]?.base_url||TRUSTED_LICENSE_RUNTIME_URL);
  try{
    const row=await getRow();
    const saved=String(row?.metadata?.officialLicenseProviderBase||'').trim();
    if(saved){
      const normalized=normalizeProviderBase(saved);
      if(allowed.has(normalized))selected=normalized;
    }
  }catch{}
  return selected;
}
async function masterRequest(path:string,init:RequestInit={}){const h:Record<string,string>={accept:'application/json','content-type':'application/json'};const base=await configuredProvider();const r=await fetch(`${base}${path}`,{...init,headers:{...h,...(init.headers||{})},cache:'no-store',signal:AbortSignal.timeout(timeoutMs())});const text=await r.text();let body:any={};try{body=text?JSON.parse(text):{}}catch{body={error:text||'License Master returned invalid JSON'}}if(!r.ok)throw Object.assign(new Error(body?.error||`License Master returned ${r.status}`),{status:r.status,code:body?.code});return body;}
function isAuthoritativeHttpError(error:any){
  const status=Number(error?.status||0);
  return status>=400&&status<500&&![408,425,429].includes(status);
}
function authorityStateFromError(error:any){
  return normalizedState(error?.code)||'license_invalid';
}
const BLOCKING_STATES=new Set(['suspended','revoked','expired','installation_locked','installation_terminated','installation_released','terminated','authority_disabled','disabled','blocked']);
function finiteSeconds(...values:any[]){for(const value of values){const n=Number(value);if(Number.isFinite(n)&&n>=0)return n;}return null;}
function finiteCount(...values:any[]){const n=finiteSeconds(...values);return n===null?null:Math.floor(n);}
function policyValue(result:any,key:string,camel:string){
  const runtime=objectValue(result?.runtime_policy??result?.runtimePolicy);
  return runtime?.[key] ?? runtime?.[camel] ?? result?.[key] ?? result?.[camel] ?? result?.policy?.[key] ?? result?.policy?.[camel] ?? result?.metadata?.[key] ?? result?.metadata?.[camel];
}
function validationPolicy(result:any){
  return {
    validationTtlSeconds:finiteSeconds(
      policyValue(result,'validation_ttl_seconds','validationTtlSeconds'),
      policyValue(result,'entitlement_ttl_seconds','entitlementTtlSeconds'),
      policyValue(result,'ttl_seconds','ttlSeconds')
    ),
    offlineGraceSeconds:finiteSeconds(
      policyValue(result,'offline_grace_seconds','offlineGraceSeconds'),
      policyValue(result,'grace_seconds','graceSeconds')
    ),
    maxFailedValidations:finiteCount(policyValue(result,'max_failed_validations','maxFailedValidations')),
    allowOfflineGrace:policyValue(result,'allow_offline_grace','allowOfflineGrace')===true,
    pulseRevision:policyValue(result,'pulse_revision','pulseRevision') ?? null,
    pulsePollSeconds:finiteSeconds(policyValue(result,'pulse_poll_seconds','pulsePollSeconds')),
    authorityEnabled:policyValue(result,'authority_enabled','authorityEnabled')
  };
}
function pulseInfo(result:any){
  return {
    revision:result?.applicable_revision ?? result?.applicableRevision ?? policyValue(result,'pulse_revision','pulseRevision') ?? null,
    at:result?.pulse_at ?? result?.pulseAt ?? null,
    reason:result?.pulse_reason ?? result?.pulseReason ?? null
  };
}
function pulseDirectives(result:any):PulseDirective[]{
  const rows=Array.isArray(result?.directives)?result.directives:[];
  return rows
    .filter((item:any)=>item&&typeof item==='object'&&item.id&&Number.isFinite(Number(item.revision))&&item.action)
    .map((item:any)=>({
      id:String(item.id),revision:Number(item.revision),action:normalizedState(item.action),scope:normalizedState(item.scope||'global'),
      license_id:item.license_id?String(item.license_id):null,installation_id:item.installation_id?String(item.installation_id):null,
      product:item.product?String(item.product):null,component:item.component?String(item.component):null,
      reason:item.reason?String(item.reason):null,payload:objectValue(item.payload),requires_ack:item.requires_ack!==false
    }));
}
function pendingPulseDirectives(value:any){return pulseDirectives({directives:Array.isArray(value)?value:[]});}
async function acknowledgePulseDirective(row:LicenseRow,installationId:string,directive:PulseDirective,status:'received'|'applied'|'failed',resultCode:string|null=null,resultingState:string|null=null,error:string|null=null){
  if(directive.requires_ack===false)return;
  const metadata=objectValue(row.metadata);
  try{
    await masterRequest('/pulse',{method:'POST',body:JSON.stringify({
      action:'ack',pulse_id:directive.id,revision:directive.revision,
      license_id:metadata.masterLicenseId||directive.license_id||null,installation_id:installationId,
      product:'orbitfs_base',component:PANEL_COMPONENT,client:'orbitfs-engine',
      client_version:env.ORBITFS_APP_VERSION||env.ORBITFS_BASE_VERSION||'unknown',
      status,result_code:resultCode,resulting_license_state:resultingState,resulting_revision:directive.revision,error,
      details:{pulse_action:directive.action,pulse_scope:directive.scope}
    })});
  }catch{}
}
async function acknowledgePulseDirectives(row:LicenseRow,installationId:string,directives:PulseDirective[],status:'received'|'applied'|'failed',resultCode:string|null=null,resultingState:string|null=null,error:string|null=null){
  await Promise.all(directives.map((directive)=>acknowledgePulseDirective(row,installationId,directive,status,resultCode,resultingState,error)));
}

function normalizedState(value:any){return String(value||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_');}
function objectValue(value:any){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function authorityState(result:any){
  const installation=objectValue(result?.installation);
  const license=objectValue(result?.license);
  const candidates=[
    result?.code,result?.status,result?.state,result?.license_status,result?.licenseStatus,
    result?.authority_state,result?.authorityState,result?.installation_state,result?.installationState,
    installation?.state,installation?.status,license?.state,license?.status
  ].map(normalizedState).filter(Boolean);
  if(result?.authority_enabled===false||result?.authorityEnabled===false)return 'authority_disabled';
  if(result?.suspended===true||license?.suspended===true)return 'suspended';
  if(result?.revoked===true||license?.revoked===true)return 'revoked';
  if(result?.expired===true||license?.expired===true)return 'expired';
  // installation.locked=true is the successful binding state, not a denial.
  if(result?.installation_locked===true||result?.installationLocked===true)return 'installation_locked';
  if(result?.installation_terminated===true||result?.installationTerminated===true||installation?.terminated===true)return 'installation_terminated';
  return candidates.find((value)=>BLOCKING_STATES.has(value))||candidates[0]||null;
}
function normalizedLicenseComponents(result:any,valid:boolean){
  const direct=objectValue(result?.components??result?.metadata?.components);
  if(!Object.keys(direct).length)return null;
  const installation=objectValue(result?.installation);
  const installationState=normalizedState(installation.state??installation.status);
  const bound=!['released','unlocked'].includes(installationState)&&(
    installation.locked===true||
    installation.locked_to_this_installation===true||
    installation.lockedToThisInstallation===true||
    installationState==='locked'
  );
  const out:Record<string,any>={};
  for(const id of STABLE_LICENSE_COMPONENTS){
    const raw=direct[id];
    if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
      const allowed=raw.allowed===true||raw.entitled===true||['active','enabled','locked'].includes(normalizedState(raw.state||raw.status));
      const locked=raw.lockedToThisInstallation===true||raw.locked_to_this_installation===true||raw.installation_locked===true||
        (allowed&&bound&&!['released','unlocked','activation_required'].includes(normalizedState(raw.state||raw.status||raw.reason)));
      out[id]={...raw,state:String(raw.state||raw.status||(allowed?(locked?(id===PANEL_COMPONENT?'active':'locked'):'enabled'):'blocked')),allowed,lockedToThisInstallation:locked,reason:allowed?(locked?null:String(raw.reason||'activation_required')):String(raw.reason||'not_included')};
    }else{
      const allowed=id===PANEL_COMPONENT?valid:raw===true;
      out[id]=allowed?{state:bound?(id===PANEL_COMPONENT?'active':'locked'):'enabled',allowed:true,lockedToThisInstallation:bound,reason:bound?null:'activation_required'}:{state:'blocked',allowed:false,lockedToThisInstallation:false,reason:'not_included'};
    }
  }
  return out;
}
function resultValid(result:any){
  const state=authorityState(result);
  if(state&&BLOCKING_STATES.has(state))return false;
  if(result?.authority_enabled===false||result?.authorityEnabled===false)return false;
  return result?.valid===true;
}
function metadataPolicy(m:Record<string,any>){
  return {
    validationTtlSeconds:finiteSeconds(m.validationTtlSeconds),
    offlineGraceSeconds:finiteSeconds(m.offlineGraceSeconds,m.graceSeconds),
    maxFailedValidations:finiteCount(m.maxFailedValidations),
    allowOfflineGrace:m.allowOfflineGrace===true,
    pulseRevision:m.pulseRevision ?? null,
    pulsePollSeconds:finiteSeconds(m.pulsePollSeconds),
    lastRevisionCheckedAt:typeof m.lastRevisionCheckedAt==='string'?m.lastRevisionCheckedAt:null,
    lastAuthorityState:typeof m.lastAuthorityState==='string'?m.lastAuthorityState:null,
    lastAuthoritativeValid:m.lastAuthoritativeValid===true,
    failedValidationCount:Number.isFinite(Number(m.failedValidationCount))?Math.max(0,Number(m.failedValidationCount)):0,
    pulseValidationRequired:m.pulseValidationRequired===true,
    pendingPulseRevision:m.pendingPulseRevision??null,
    pendingPulseAuthorityState:typeof m.pendingPulseAuthorityState==='string'?m.pendingPulseAuthorityState:null,
    pendingPulseDirectives:pendingPulseDirectives(m.pendingPulseDirectives),
    lastValidationAttemptAt:typeof m.lastValidationAttemptAt==='string'?m.lastValidationAttemptAt:null
  };
}

function deadline(iso:string|null,seconds:number|null){if(!iso||seconds===null)return null;const t=Date.parse(iso);return Number.isFinite(t)?t+seconds*1000:null;}
function isoAt(ms:number|null){return ms===null?null:new Date(ms).toISOString();}
function knownDenied(m:Record<string,any>){const state=normalizedState(m.lastAuthorityState),pending=normalizedState(m.pendingPulseAuthorityState);return m.lastAuthoritativeValid===false||BLOCKING_STATES.has(state)||BLOCKING_STATES.has(pending);}
async function pollPulse(row:LicenseRow,installationId:string){
  const m={...(row.metadata||{})},policy=metadataPolicy(m);
  if(policy.pulseValidationRequired)return {changed:true,row};
  if(policy.pulsePollSeconds===null)return {changed:false,row};
  const checked=policy.lastRevisionCheckedAt?Date.parse(policy.lastRevisionCheckedAt):NaN;
  if(Number.isFinite(checked)&&Date.now()-checked<policy.pulsePollSeconds*1000)return {changed:false,row};
  const checkedAt=new Date().toISOString();
  try{
    const params=new URLSearchParams({installation_id:installationId,product:'orbitfs_base',component:PANEL_COMPONENT,since_revision:String(policy.pulseRevision??0)});
    const licenseId=String(m.masterLicenseId||'').trim();
    if(licenseId)params.set('license_id',licenseId);
    const pulse=await masterRequest('/pulse?'+params.toString(),{method:'GET'});
    const revision=pulseInfo(pulse).revision ?? policy.pulseRevision;
    const pulsePolicy=validationPolicy(pulse);
    const pulseState=authorityState(pulse);
    const directives=pulseDirectives(pulse);
    const changed=directives.length>0||(revision!==null&&(policy.pulseRevision===null||String(revision)!==String(policy.pulseRevision)))||Boolean(pulseState&&BLOCKING_STATES.has(pulseState));
    if(directives.length)await acknowledgePulseDirectives(row,installationId,directives,'received');
    const nextMetadata={...m,lastRevisionCheckedAt:checkedAt,
      ...(pulsePolicy.pulsePollSeconds!==null?{pulsePollSeconds:pulsePolicy.pulsePollSeconds}:{}),
      ...(pulsePolicy.validationTtlSeconds!==null?{validationTtlSeconds:pulsePolicy.validationTtlSeconds}:{}),
      ...(pulsePolicy.offlineGraceSeconds!==null?{offlineGraceSeconds:pulsePolicy.offlineGraceSeconds}:{ }),
      ...(pulsePolicy.maxFailedValidations!==null?{maxFailedValidations:pulsePolicy.maxFailedValidations}:{}),
      ...(changed?{pulseValidationRequired:true,pendingPulseRevision:revision,pendingPulseAuthorityState:pulseState&&BLOCKING_STATES.has(pulseState)?pulseState:null,pendingPulseDirectives:directives}
        :{pulseRevision:revision,pulseValidationRequired:false,pendingPulseRevision:null,pendingPulseAuthorityState:null,pendingPulseDirectives:[]})};
    const saved=await saveRow({metadata:nextMetadata},row);
    return {changed,row:saved};
  }catch{
    const saved=await saveRow({metadata:{...m,lastRevisionCheckedAt:checkedAt}},row);
    return {changed:true,row:saved};
  }
}

async function saveValidationResult(row:LicenseRow,installationId:string,result:any,licenseKey:string){
  const now=new Date().toISOString(),policy=validationPolicy(result),state=authorityState(result),pulse=pulseInfo(result),previous=metadataPolicy(row.metadata||{});
  const valid=resultValid(result);
  const installation=objectValue(result?.installation);
  const installationState=normalizedState(installation.state??installation.status);
  const installationLocked=
    installation.locked===true||
    installation.locked_to_this_installation===true||
    installation.lockedToThisInstallation===true||
    installationState==='locked';
  const m={...(row.metadata||{}),...(result?.metadata||{}),
    installationId,installationLockedToThisInstallation:installationLocked,masterLicenseId:result?.license_id||row.metadata?.masterLicenseId||null,
    lastCheckedAt:now,lastRevisionCheckedAt:now,keyHint:keyHint(licenseKey),
    validationTtlSeconds:policy.validationTtlSeconds??previous.validationTtlSeconds,
    offlineGraceSeconds:policy.offlineGraceSeconds??previous.offlineGraceSeconds,
    maxFailedValidations:policy.maxFailedValidations??previous.maxFailedValidations,
    allowOfflineGrace:policy.allowOfflineGrace,pulseRevision:pulse.revision??previous.pendingPulseRevision??previous.pulseRevision,
    pulsePollSeconds:policy.pulsePollSeconds??previous.pulsePollSeconds,components:normalizedLicenseComponents(result,valid)??row.metadata?.components,
    lastAuthorityState:state||(valid?'active':'invalid'),lastAuthoritativeValid:valid,failedValidationCount:0,lastValidationAttemptAt:now,
    pulseValidationRequired:false,pendingPulseRevision:null,pendingPulseAuthorityState:null,pendingPulseDirectives:[]
  };
  return saveRow({status:valid?'active':String(state||result?.code||'invalid').toLowerCase(),
    plan:m.plan||row.plan||null,licensed_to:m.licensedTo||row.licensed_to||null,
    expires_at:result?.expires_at||result?.expiresAt||row.expires_at||null,metadata:m},row);
}
async function saveTransportFailure(row:LicenseRow){
  const policy=metadataPolicy(row.metadata||{});
  return saveRow({metadata:{...(row.metadata||{}),failedValidationCount:policy.failedValidationCount+1,lastValidationAttemptAt:new Date().toISOString()}},row);
}

async function getRow(force=false){if(!force&&rowCache&&rowCache.expires>Date.now())return rowCache.value;const {data,error}=await getSupabaseAdmin().from('orbitfs_license').select('id,license_key,status,plan,licensed_to,expires_at,metadata').eq('id',LICENSE_ID).maybeSingle();if(error)throw error;rowCache={value:data as LicenseRow|null,expires:Date.now()+ROW_CACHE_MS};return rowCache.value;}
async function saveRow(patch:Record<string,any>,row?:LicenseRow|null):Promise<LicenseRow>{const s=getSupabaseAdmin();const current=row===undefined?await getRow():row;const payload={...patch,updated_at:new Date().toISOString()};if(current){const {error}=await s.from('orbitfs_license').update(payload).eq('id',LICENSE_ID);if(error)throw error;rowCache={value:{...current,...patch,id:LICENSE_ID} as LicenseRow,expires:Date.now()+ROW_CACHE_MS};}else{const inserted={id:LICENSE_ID,license_key:null,status:'unconfigured',plan:null,licensed_to:null,expires_at:null,metadata:{},...patch};const {error}=await s.from('orbitfs_license').insert(inserted);if(error)throw error;rowCache={value:inserted as LicenseRow,expires:Date.now()+ROW_CACHE_MS};}summaryCache=null;return rowCache.value as LicenseRow;}
async function installation(row:LicenseRow|null){
  const m={...(row?.metadata||{})};
  const configured=String(env.ORBITFS_INSTALLATION_ID||'').trim();
  const stored=String(m.installationId||'').trim();
  if(configured&&stored&&configured!==stored)throw Object.assign(new Error('Engine Host installation identity does not match the Base installation.'),{status:409,code:'INSTALLATION_ID_MISMATCH'});
  if(stored)return {id:stored,row};
  const id=configured||`ofs-${randomUUID()}`;
  return {id,row:await saveRow({metadata:{...m,installationId:id,installationCreatedAt:new Date().toISOString(),installationIdentitySource:configured?'deployment':'generated'}},row)};
}
export async function ensureInstallationIdentity(){return (await installation(await getRow())).id;}
function components(valid:boolean,m:Record<string,any>){const supplied=m.components&&typeof m.components==='object'?m.components:{};const out:Record<string,any>={};for(const id of STABLE_LICENSE_COMPONENTS){const x=supplied[id];const locked=m.installationLockedToThisInstallation===true;out[id]=x&&typeof x==='object'?x:{state:id===PANEL_COMPONENT&&valid?(locked?'active':'enabled'):'blocked',allowed:id===PANEL_COMPONENT&&valid,lockedToThisInstallation:id===PANEL_COMPONENT&&valid&&locked,reason:id===PANEL_COMPONENT&&valid?(locked?null:'activation_required'):'not_included'};}return out;}
export function componentLicensed(c:Record<string,any>){return c?.allowed===true&&c?.lockedToThisInstallation===true&&['active','enabled','locked'].includes(String(c?.state||''));}
function makeSummary(row:LicenseRow|null,valid:boolean,reason:string|null,extra:any={}):PanelLicenseSummary{
  const m={...(row?.metadata||{})},policy=metadataPolicy(m);
  const checked=typeof m.lastCheckedAt==='string'?m.lastCheckedAt:null;
  const ttlDeadline=deadline(checked,policy.validationTtlSeconds);
  const revisionChecked=policy.lastRevisionCheckedAt;
  const nextRevision=deadline(revisionChecked,policy.pulsePollSeconds);
  const cs=components(valid,m),component=cs[PANEL_COMPONENT];
  return {valid,licensed:valid&&componentLicensed(component),enforcement:true,
    reason:valid&&componentLicensed(component)?null:reason||component.reason||'LICENSE_REQUIRED',
    status:valid?'active':row?.status||'unconfigured',keyHint:typeof m.keyHint==='string'?m.keyHint:null,
    installationId:String(m.installationId||''),lastCheckedAt:checked,lastRevisionCheckedAt:revisionChecked,
    masterRevision:policy.pulseRevision,nextValidationAt:isoAt(ttlDeadline),nextRevisionCheckAt:isoAt(nextRevision),
    offlineGrace:false,refreshError:null,component,components:cs,plan:row?.plan||null,
    licensedTo:row?.licensed_to||null,expiresAt:row?.expires_at||null,...extra};
}
export async function getPanelLicenseSummary(options:{refresh?:boolean}={}):Promise<PanelLicenseSummary>{
  if(!options.refresh&&summaryCache&&summaryCache.expires>Date.now())return summaryCache.value;
  const row=await getRow(Boolean(options.refresh));const i=await installation(row);let current=i.row||row;
  if(!current?.license_key){
    const out=makeSummary(current,false,'not_activated');summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;
  }

  let pulseChanged=false;
  if(!options.refresh){
    const pulse=await pollPulse(current,i.id);
    current=pulse.row;pulseChanged=pulse.changed;
  }

  const activeLicenseKey=String(current.license_key||'').trim();
  if(!activeLicenseKey){
    const out=makeSummary(current,false,'not_activated');summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;
  }

  let m={...(current.metadata||{})},policy=metadataPolicy(m);
  const checked=typeof m.lastCheckedAt==='string'?m.lastCheckedAt:null;
  const ttlUntil=deadline(checked,policy.validationTtlSeconds);
  const expiresAt=current.expires_at?Date.parse(current.expires_at):NaN;
  const locallyExpired=Number.isFinite(expiresAt)&&Date.now()>=expiresAt;
  const denied=knownDenied(m);
  const ttlValid=ttlUntil!==null&&Date.now()<ttlUntil&&!locallyExpired&&current.status==='active'&&policy.lastAuthoritativeValid&&!denied;
  let mustValidate=Boolean(options.refresh||pulseChanged||policy.pulseValidationRequired||locallyExpired||(!denied&&!ttlValid));

  if(mustValidate&&!options.refresh&&!locallyExpired&&policy.failedValidationCount>0){
    const retryMs=policy.pulsePollSeconds===null?0:policy.pulsePollSeconds*1000;
    const lastAttempt=policy.lastValidationAttemptAt?Date.parse(policy.lastValidationAttemptAt):NaN;
    if(retryMs>0&&Number.isFinite(lastAttempt)&&Date.now()-lastAttempt<retryMs)mustValidate=false;
  }

  if(!mustValidate){
    if(denied){
      const out=makeSummary(current,false,String(m.pendingPulseAuthorityState||m.lastAuthorityState||current.status||'LICENSE_INVALID'));
      summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;
    }
    if(ttlValid){const out=makeSummary(current,true,null);summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;}
    const graceUntil=ttlUntil===null||policy.offlineGraceSeconds===null?null:ttlUntil+policy.offlineGraceSeconds*1000;
    const failureBudgetOk=policy.maxFailedValidations===null?true:policy.failedValidationCount<=policy.maxFailedValidations;
    const mayGrace=policy.allowOfflineGrace&&policy.lastAuthoritativeValid&&!knownDenied(m)&&!locallyExpired&&failureBudgetOk&&graceUntil!==null&&Date.now()<graceUntil;
    const out=makeSummary(current,mayGrace,mayGrace?null:'LICENSE_MASTER_UNAVAILABLE',{offlineGrace:mayGrace});
    summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;
  }

  const pendingDirectives=policy.pendingPulseDirectives;
  try{
    const result=await masterRequest('/validate',{method:'POST',body:JSON.stringify({
      action:'validate',license_key:activeLicenseKey,product:'orbitfs_base',component:PANEL_COMPONENT,installation_id:i.id,
      product_version:env.ORBITFS_APP_VERSION||'cloud',metadata:identityMetadata(i.id)
    })});
    const saved=await saveValidationResult(current,i.id,result,activeLicenseKey);
    const valid=resultValid(result);
    const reason=valid?null:String(authorityState(result)||result?.code||'LICENSE_INVALID');
    if(valid&&pendingDirectives.some((directive)=>directive.action==='request_check_in')){
      await recordLicenseManagerCheckIn({action:'check_in',phase:'completed',product:'orbitfs_base',productVersion:env.ORBITFS_APP_VERSION||'cloud',client:'orbitfs-engine',clientVersion:env.ORBITFS_APP_VERSION||null,details:{source:'license-pulse'}});
    }
    await acknowledgePulseDirectives(saved,i.id,pendingDirectives,'applied',String(result?.code||'LICENSE_VALID'),valid?'active':reason);
    const out=makeSummary(saved,valid,reason);summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;
  }catch(error:any){
    if(isAuthoritativeHttpError(error)){
      const state=authorityStateFromError(error),now=new Date().toISOString();
      const saved=await saveRow({status:state,metadata:{...(current.metadata||{}),lastCheckedAt:now,lastRevisionCheckedAt:now,lastAuthorityState:state,lastAuthoritativeValid:false,failedValidationCount:0,lastValidationAttemptAt:now,pulseRevision:policy.pendingPulseRevision??policy.pulseRevision,pulseValidationRequired:false,pendingPulseRevision:null,pendingPulseAuthorityState:null,pendingPulseDirectives:[]}},current);
      await acknowledgePulseDirectives(saved,i.id,pendingDirectives,'applied',state,state);
      const out=makeSummary(saved,false,state,{offlineGrace:false,refreshError:String(error?.message||state)});
      summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;
    }
    const failed=await saveTransportFailure(current);
    m={...(failed.metadata||{})};policy=metadataPolicy(m);
    const baseDeadline=deadline(typeof m.lastCheckedAt==='string'?m.lastCheckedAt:null,policy.validationTtlSeconds);
    const graceUntil=baseDeadline===null||policy.offlineGraceSeconds===null?null:baseDeadline+policy.offlineGraceSeconds*1000;
    const failureBudgetOk=policy.maxFailedValidations===null?true:policy.failedValidationCount<=policy.maxFailedValidations;
    const mayGrace=policy.allowOfflineGrace&&policy.lastAuthoritativeValid&&!knownDenied(m)&&!locallyExpired&&failureBudgetOk&&graceUntil!==null&&Date.now()<graceUntil;
    const code=String(error?.code||'LICENSE_MASTER_UNAVAILABLE'),detail=String(error?.message||'License Master unavailable');
    await acknowledgePulseDirectives(failed,i.id,pendingDirectives,'failed',code,mayGrace?'offline_grace':'unavailable',detail);
    const out=makeSummary(failed,mayGrace,mayGrace?null:code,{offlineGrace:mayGrace,refreshError:detail});
    summaryCache={value:out,expires:Date.now()+SUMMARY_CACHE_MS};return out;
  }
}

export async function activatePanelLicense(licenseKey:string){
  const key=String(licenseKey||'').trim();if(!key)throw Object.assign(new Error('License key is required'),{status:400,code:'LICENSE_KEY_REQUIRED'});
  const row=await getRow();const i=await installation(row);
  const result=await masterRequest('/validate',{method:'POST',body:JSON.stringify({
    action:'activate',license_key:key,product:'orbitfs_base',component:PANEL_COMPONENT,installation_id:i.id,
    product_version:env.ORBITFS_APP_VERSION||'cloud',metadata:identityMetadata(i.id)
  })});
  if(!resultValid(result))throw Object.assign(new Error(authorityState(result)||result?.code||'LICENSE_INVALID'),{status:Number(result?.status||403),code:String(authorityState(result)||result?.code||'LICENSE_INVALID')});
  const base=i.row||{id:LICENSE_ID,license_key:key,status:'unconfigured',plan:null,licensed_to:null,expires_at:null,metadata:{}} as LicenseRow;
  const saved=await saveValidationResult({...base,license_key:key},i.id,result,key);
  const summary=makeSummary(saved,true,null);
  if(!summary.licensed||summary.component?.lockedToThisInstallation!==true)throw Object.assign(new Error('License Manager accepted the licence but did not lock it to this OrbitFS installation.'),{status:409,code:'LICENSE_INSTALLATION_LOCK_REQUIRED'});
  summaryCache=null;return summary;
}
export async function clearPanelLicense(){const row=await getRow();const i=await installation(row);const m={...(i.row?.metadata||{})};const saved=await saveRow({license_key:null,status:'unconfigured',plan:null,licensed_to:null,expires_at:null,metadata:{installationId:i.id,installationCreatedAt:m.installationCreatedAt||new Date().toISOString()}},i.row);summaryCache=null;return makeSummary(saved,false,'not_activated');}
export async function activateLicenseComponent(componentId:string){
  const component=normalizedState(componentId);
  if(!STABLE_LICENSE_COMPONENTS.includes(component as any))throw Object.assign(new Error('Unknown OrbitFS licence component'),{status:400,code:'LICENSE_COMPONENT_INVALID'});
  const row=await getRow();const i=await installation(row);if(!i.row?.license_key)return makeSummary(i.row,false,'not_activated');
  const request=(action:'activate'|'validate')=>masterRequest('/validate',{method:'POST',body:JSON.stringify({
    action,license_key:i.row!.license_key,product:'orbitfs_base',component,installation_id:i.id,
    product_version:env.ORBITFS_APP_VERSION||'cloud',metadata:identityMetadata(i.id,{requestedComponent:component})
  })});
  let result=await request('activate');
  let saved=await saveValidationResult(i.row,i.id,result,i.row.license_key);
  let valid=resultValid(result);
  let summary=makeSummary(saved,valid,valid?null:String(authorityState(result)||result?.code||'LICENSE_INVALID'));
  let requested=objectValue(summary.components?.[component]);
  if(!(componentLicensed(requested)&&requested.lockedToThisInstallation===true)){
    result=await request('validate');
    saved=await saveValidationResult(saved,i.id,result,i.row.license_key);
    valid=resultValid(result);
    summary=makeSummary(saved,valid,valid?null:String(authorityState(result)||result?.code||'LICENSE_INVALID'));
    requested=objectValue(summary.components?.[component]);
  }
  if(!valid||!componentLicensed(requested))throw Object.assign(new Error(String(requested.reason||result?.code||'Component licence activation failed')),{status:403,code:String(result?.code||'LICENSE_COMPONENT_NOT_ENTITLED')});
  return summary;
}
export async function assertPanelLicensed(){const s=await getPanelLicenseSummary();if(!s.licensed)throw Object.assign(new Error(s.reason||'Valid OrbitFS Base license required'),{status:403,code:s.reason||'LICENSE_REQUIRED'});return s;}
export async function getLicenseProviderSettings(){
 const [official,providerBase]=await Promise.all([officialLicenseProviders(true),configuredProvider()]);
 return {providerBase,allowedProviderBases:official.map((row:any)=>row.base_url),officialConnections:official,configured:true,apiConfigured:true,apiTokenConfigured:false,mode:'license-master-v2',product:PANEL_COMPONENT,registryAuthority:TRUSTED_LICENSE_REGISTRY_ROOT};
}
export async function setLicenseProviderBase(value:string){
 const providerBase=await requireOfficialProviderBase(value);
 const row=await getRow();
 const metadata={...(row?.metadata||{}),officialLicenseProviderBase:providerBase,officialLicenseProviderSelectedAt:new Date().toISOString()};
 await saveRow({metadata},row);
 summaryCache=null;
 return getLicenseProviderSettings();
}
export async function getLicenseProviderDiagnostics(candidate?:string){
 const providerBase=candidate?await requireOfficialProviderBase(candidate):await configuredProvider();
 const result:any={providerBase,apiTokenConfigured:false,database:{ok:false,error:null},master:{ok:false,status:null,error:null},installationId:null};
 try{const row=await getRow();result.database={ok:true,error:null};result.installationId=(await installation(row)).id;}catch(e:any){result.database={ok:false,error:String(e?.message||e)}}
 try{const response=await fetch(providerBase+'/health',{cache:'no-store',signal:AbortSignal.timeout(timeoutMs()),headers:{accept:'application/json'}});const text=await response.text();let health:any={};try{health=text?JSON.parse(text):{}}catch{};result.master={ok:response.ok,status:response.status,error:response.ok?null:String(health?.error||text||'Health check failed'),health};}
 catch(e:any){result.master={ok:false,status:Number(e?.status||503),error:String(e?.message||e),code:String(e?.code||'LICENSE_MASTER_UNAVAILABLE')}}
 return result;
}

export async function recordLicenseManagerCheckIn(input:{
  action:'deploy'|'update'|'redeploy'|'rollback'|'check_in';
  phase:'started'|'completed'|'failed';
  product?:string;
  productVersion?:string|null;
  previousVersion?:string|null;
  releaseId?:string|null;
  deploymentId?:string|null;
  deploymentUrl?:string|null;
  projectId?:string|null;
  projectName?:string|null;
  provider?:string|null;
  region?:string|null;
  platform?:string|null;
  architecture?:string|null;
  hostname?:string|null;
  client?:string|null;
  clientVersion?:string|null;
  customerIdentity?:Record<string,unknown>|null;
  details?:Record<string,unknown>;
}) {
  const row=await getRow(true);
  const identity=await installation(row);
  const licenseId=String(row?.metadata?.masterLicenseId||'').trim();
  if(!licenseId)return {ok:false,skipped:true,reason:'MASTER_LICENSE_ID_NOT_CACHED'};
  try {
    return await masterRequest('/validate',{method:'POST',body:JSON.stringify({action:'check_in',
      license_id:licenseId,installation_id:identity.id,deployment_action:input.action,phase:input.phase,
      product:input.product||PANEL_COMPONENT,product_version:input.productVersion||env.ORBITFS_APP_VERSION||'unknown',
      previous_version:input.previousVersion||null,release_id:input.releaseId||null,deployment_id:input.deploymentId||null,
      deployment_url:input.deploymentUrl||env.VERCEL_URL||null,project_id:input.projectId||null,project_name:input.projectName||null,
      provider:input.provider||'vercel',region:input.region||env.VERCEL_REGION||null,platform:input.platform||'vercel',
      architecture:input.architecture||null,hostname:input.hostname||null,client:input.client||'orbitfs-base-deployer',
      client_version:input.clientVersion||env.ORBITFS_APP_VERSION||null,customer_identity:input.customerIdentity||null,
      details:input.details||{}
    })});
  } catch(error:any) {
    return {ok:false,skipped:false,error:String(error?.message||error)};
  }
}
