import { error, type Handle } from '@sveltejs/kit';
import { assertAddonEngineLicensed } from '$lib/server/addon-engine';
import { ensureInstallationIdentity, recordLicenseManagerCheckIn } from '$lib/server/license';

const CHECK_IN_INTERVAL_MS=60_000;
const checkInCache=new Map<string,number>();

export const handle: Handle = async ({ event, resolve }) => {
	const match=event.url.pathname.match(/^\/engines\/([^/]+)(?:\/|$)/);
	if(match?.[1]){
		try{
			await assertAddonEngineLicensed(decodeURIComponent(match[1]));
			const installationId=await ensureInstallationIdentity();
			const now=Date.now();
			if(now-(checkInCache.get(installationId)||0)>=CHECK_IN_INTERVAL_MS){
				checkInCache.set(installationId,now);
				void recordLicenseManagerCheckIn({action:'check_in',phase:'completed',product:'orbitfs_base',productVersion:null,provider:'vercel',region:process.env.VERCEL_REGION||null,platform:'vercel',client:'orbitfs-engine',clientVersion:process.env.ORBITFS_APP_VERSION||null,details:{deploymentProduct:'orbitfs_engine',engineVersion:process.env.ORBITFS_APP_VERSION||'unknown',engineReleaseId:process.env.ORBITFS_ENGINE_RELEASE_ID||null,engineReleaseChannel:process.env.ORBITFS_RELEASE_CHANNEL||null,path:event.url.pathname}}).catch(()=>undefined);
			}
		}catch(cause:any){throw error(Number(cause?.status||403),String(cause?.message||'This OrbitFS engine is not licensed.'));}
	}
	return resolve(event);
};
