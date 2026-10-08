import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { assertPanelLicensed, getStoredLicenseCredential } from '$lib/server/license';
import { resolveUpdaterProviderBase } from '$lib/server/updater-connection';
import { compareOrbitVersions } from '$lib/server/orbit-version';
import { resolveInstalledBaseVersion } from '$lib/server/base-release-state';

const timeoutMs=()=>Math.max(3000,Number(env.ORBITFS_LICENSE_TIMEOUT_MS||8000));

export async function GET({ url }) {
  try {
    await assertPanelLicensed();
    const {installationId,licenseKey}=await getStoredLicenseCredential();
    const product=String(url.searchParams.get('product')||'orbitfs_base');
    const type=String(url.searchParams.get('type')||'base').trim().toLowerCase();
    const defaultChannel=type==='update'
      ? String(env.ORBITFS_UPDATE_CHANNEL||'stable')
      : String(env.ORBITFS_RELEASE_CHANNEL||'stable');
    const channel=String(url.searchParams.get('channel')||defaultChannel).trim().toLowerCase();
    const updaterApi=await resolveUpdaterProviderBase();
    const response=await fetch(`${updaterApi}?product=${encodeURIComponent(product)}&channel=${encodeURIComponent(channel)}&type=${encodeURIComponent(type)}`,{headers:{'x-license-key':licenseKey,'x-installation-id':installationId,accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(timeoutMs())});
    const body:any=await response.json().catch(()=>({}));
    if(!response.ok)return json({ok:false,code:body?.code||'RELEASE_CHECK_FAILED',error:body?.error||`License Master returned ${response.status}`},{status:response.status>=500?503:response.status});
    const rows:any[]=Array.isArray(body?.releases)?body.releases:(body?.release?[body.release]:[]);
    const candidates=rows
      .filter((release)=>!release?.status||String(release.status).toLowerCase()==='published')
      .filter((release)=>!release?.review_status||String(release.review_status).toLowerCase()==='approved')
      .sort((a,b)=>new Date(b?.published_at||b?.created_at||0).getTime()-new Date(a?.published_at||a?.created_at||0).getTime());
    const latest=body?.release||candidates[0]||null;
    const currentVersion=await resolveInstalledBaseVersion();
    // An Update has its own version stream. Never compare it against the installed Base version.
    const comparison=type==='base'&&latest?.version&&currentVersion
      ?compareOrbitVersions(latest.version,currentVersion)
      :null;
    return json({
      ok:true,
      authority:'orbitfs-license-master-v2',
      product,
      channel,
      type,
      currentVersion,
      publishedVersion:latest?.version?String(latest.version):null,
      updateAvailable:comparison===null?null:comparison>0,
      latest
    });
  } catch(error:any) {
    return json({ok:false,code:String(error?.code||'RELEASE_CHECK_FAILED'),error:String(error?.message||'Unable to check License Master releases')},{status:Number(error?.status||503)});
  }
}
