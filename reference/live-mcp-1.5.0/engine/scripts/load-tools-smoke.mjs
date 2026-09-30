const base=process.env.PUBLIC_BASE_URL||'http://127.0.0.1:3943';
const accessToken=process.env.ORBITFS_SMOKE_ACCESS_TOKEN;
if(!accessToken)throw new Error('ORBITFS_SMOKE_ACCESS_TOKEN is required; anonymous MCP testing is forbidden');
const headers={'content-type':'application/json','accept':'application/json, text/event-stream','authorization':`Bearer ${accessToken}`,'x-orbitfs-client-id':'load-tools-smoke'};
async function rpc(id,method,params={}){
  const response=await fetch(`${base}/mcp`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const text=await response.text();
  const line=text.split('\n').find((item)=>item.startsWith('data: '));
  const payload=JSON.parse(line?line.slice(6):text);
  if(!response.ok||payload.error||payload.result?.isError)throw new Error(`${method}: ${text}`);
  return payload.result;
}
const init=await rpc(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'load-tools-smoke',version:'1.0.0'}});
const tools=await rpc(2,'tools/list',{}),names=tools.tools.map((tool)=>tool.name);
for(const name of ['load_file','load_folder','get_active_context','clear_context'])if(!names.includes(name))throw new Error(`Missing ${name}`);
const file=await rpc(3,'tools/call',{name:'load_file',arguments:{workspaceId:'public',path:'single.md'}});
if(!file.content?.[0]?.text?.includes('DIRECT-FILE-CONTEXT-9917'))throw new Error('Direct file content missing');
const folder=await rpc(4,'tools/call',{name:'load_folder',arguments:{workspaceId:'public',path:'FolderA',maxFiles:10}});
const folderText=folder.content?.[0]?.text||'';
if(!folderText.includes('FOLDER-CONTEXT-ONE-2284')||!folderText.includes('FOLDER-CONTEXT-TWO-6631'))throw new Error('Folder contents missing');
await rpc(5,'tools/call',{name:'load_file',arguments:{workspaceId:'public',path:'single.md'}});
const active=await rpc(6,'tools/call',{name:'get_active_context',arguments:{workspaceId:'public'}}),receipt=active.structuredContent?.activeContext;
if(receipt?.files?.length!==3)throw new Error(`Expected 3 unique files, got ${receipt?.files?.length}`);
let traversalRejected=false;
try{await rpc(7,'tools/call',{name:'load_file',arguments:{workspaceId:'public',path:'../outside.txt'}});}catch{traversalRejected=true;}
if(!traversalRejected)throw new Error('Path traversal was not rejected');
await rpc(8,'tools/call',{name:'clear_context',arguments:{workspaceId:'public'}});
console.log(JSON.stringify({ok:true,protocolVersion:init.protocolVersion,tools:names,uniqueFiles:receipt.files.length,characters:receipt.charactersTransferred,traversalRejected},null,2));