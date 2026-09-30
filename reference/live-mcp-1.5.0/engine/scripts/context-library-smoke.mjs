const base=process.env.PUBLIC_BASE_URL||'http://127.0.0.1:3944';
const accessToken=process.env.ORBITFS_SMOKE_ACCESS_TOKEN;
if(!accessToken)throw new Error('ORBITFS_SMOKE_ACCESS_TOKEN is required; anonymous MCP testing is forbidden');
const headers={'content-type':'application/json','accept':'application/json, text/event-stream','authorization':`Bearer ${accessToken}`,'x-orbitfs-client-id':'context-library-smoke'};
async function rpc(id,method,params={}){
  const response=await fetch(`${base}/mcp`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const text=await response.text();
  const line=text.split('\n').find((item)=>item.startsWith('data: '));
  const payload=JSON.parse(line?line.slice(6):text);
  if(!response.ok||payload.error||payload.result?.isError)throw Object.assign(new Error(`${method}: ${text}`),{payload});
  return payload.result;
}
await rpc(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'context-library-smoke',version:'1.0.0'}});
const tools=await rpc(2,'tools/list',{}),names=tools.tools.map(t=>t.name);
for(const name of ['list_context_bundles','load_context_bundle'])if(!names.includes(name))throw new Error(`Missing ${name}`);
const listed=await rpc(3,'tools/call',{name:'list_context_bundles',arguments:{workspaceId:'public'}});
if(!listed.structuredContent?.bundles?.some(b=>b.id==='ctx-test-root'))throw new Error('Root bundle not listed');
const loaded=await rpc(4,'tools/call',{name:'load_context_bundle',arguments:{workspaceId:'public',bundleId:'ctx-test-root'}});
const text=loaded.content?.[0]?.text||'';
if(!text.includes('DEPENDENCY-BUNDLE-CONTENT-4412')||!text.includes('ROOT-BUNDLE-CONTENT-8873'))throw new Error('Bundle contents were not transferred');
const receipt=loaded.structuredContent?.receipt;
if(receipt?.transferredCount!==2)throw new Error(`Expected 2 unique files, got ${receipt?.transferredCount}`);
if(!receipt?.bundles?.some(b=>b.rootBundleId==='ctx-test-root'&&b.bundleIds.includes('ctx-test-dependency')))throw new Error('Bundle chain missing from receipt');
let loopRejected=false;
try{await rpc(5,'tools/call',{name:'load_context_bundle',arguments:{workspaceId:'public',bundleId:'ctx-test-loop-a'}});}catch(error){loopRejected=String(error.message).includes('BUNDLE_DEPENDENCY_LOOP')||String(error.message).includes('dependency loop');}
if(!loopRejected)throw new Error('Dependency loop was not rejected');
let requiredRejected=false;
try{await rpc(6,'tools/call',{name:'load_context_bundle',arguments:{workspaceId:'public',bundleId:'ctx-test-missing'}});}catch(error){requiredRejected=String(error.message).includes('BUNDLE_REQUIRED_ENTRY_FAILED')||String(error.message).includes('Required bundle entry failed');}
if(!requiredRejected)throw new Error('Required missing entry was not rejected');
await rpc(7,'tools/call',{name:'clear_context',arguments:{workspaceId:'public'}});
console.log(JSON.stringify({ok:true,tools:names,bundlesListed:listed.structuredContent.bundles.length,uniqueFiles:receipt.transferredCount,bundleChain:receipt.bundles.at(-1).bundleNames,loopRejected,requiredRejected},null,2));
