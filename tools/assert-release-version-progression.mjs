import {compareOrbitReleaseVersions,isOrbitReleaseVersion,orbitReleaseVersionFamily} from './release-version.mjs';

let raw='';
for await (const chunk of process.stdin)raw+=chunk;
const payload=JSON.parse(raw||'{}');
const version=String(process.env.VERSION||'').trim();
if(!isOrbitReleaseVersion(version)){
  console.error('Invalid OrbitFS release version: '+version);
  process.exit(2);
}
const family=orbitReleaseVersionFamily(version);
const published=(Array.isArray(payload.releases)?payload.releases:[])
  .filter((release)=>release?.status==='published'&&release?.review_status==='approved'&&isOrbitReleaseVersion(release?.version))
  .map((release)=>String(release.version))
  .filter((candidate)=>orbitReleaseVersionFamily(candidate)===family);
for(const previous of published){
  const comparison=compareOrbitReleaseVersions(version,previous);
  if(comparison!==null&&comparison<=0){
    throw new Error('Release version '+version+' must advance beyond published '+previous);
  }
}
console.log('Release version progression accepted: '+version);
