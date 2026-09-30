import crypto from "node:crypto";
const secret=String(process.env.ORBITFS_PANEL_SHARED_SECRET||"");
const devUser=String(process.env.ORBITFS_DEV_USER_ID||"");
function safeJson(value,fallback){try{return JSON.parse(value);}catch{return fallback;}}
export function requestIdentity(req){
  const raw=String(req.headers["x-orbitfs-identity"]||"");
  const sig=String(req.headers["x-orbitfs-signature"]||"");
  if(raw&&secret){
    const expected=crypto.createHmac("sha256",secret).update(raw).digest("hex");
    if(sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))
      return safeJson(Buffer.from(raw,"base64url").toString("utf8"),null);
  }
  if(devUser)return{userId:devUser,username:process.env.ORBITFS_DEV_USERNAME||"Developer",role:process.env.ORBITFS_DEV_ROLE||"owner",workspaceIds:safeJson(process.env.ORBITFS_DEV_WORKSPACE_IDS||"[]",[]),development:true};
  return null;
}
export function requireIdentity(req){const id=requestIdentity(req);if(!id)throw Object.assign(new Error("Authenticated Panel identity required"),{status:401,code:"IDENTITY_REQUIRED"});return id;}
export function filterWorkspaces(workspaces,identity){const allowed=new Set(identity.workspaceIds||[]);return workspaces.filter(w=>allowed.has(w.id)||(!allowed.size&&w.id==="public"));}
