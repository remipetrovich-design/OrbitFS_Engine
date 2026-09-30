import 'dotenv/config';
const base=process.env.PUBLIC_BASE_URL||'http://127.0.0.1:3941';
const accessToken=process.env.ORBITFS_SMOKE_ACCESS_TOKEN;
if(!accessToken)throw new Error('ORBITFS_SMOKE_ACCESS_TOKEN is required; anonymous MCP testing is forbidden');
const headers={'content-type':'application/json','accept':'application/json, text/event-stream','authorization':`Bearer ${accessToken}`,'x-orbitfs-client-id':'orbitfs-smoke'};
async function rpc(id,method,params={}){
  const response=await fetch(`${base}/mcp`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const text=await response.text();
  if(!response.ok)throw new Error(`${method} HTTP ${response.status}: ${text}`);
  const line=text.split('\n').find((item)=>item.startsWith('data: '));
  const payload=JSON.parse(line?line.slice(6):text);
  if(payload.error)throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}
const initialized=await rpc(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'orbitfs-smoke',version:'1.0.0'}});
const tools=await rpc(2,'tools/list',{}),names=tools.tools.map((tool)=>tool.name);
for(const required of ['orbitfs_mcp_dashboard','run_startup','clear_context'])if(!names.includes(required))throw new Error(`Missing tool ${required}`);
const dashboard=await rpc(3,'tools/call',{name:'orbitfs_mcp_dashboard',arguments:{workspaceId:'default'}}),d=dashboard.structuredContent||{};
if(d.licensed!==true)throw new Error('Dashboard did not report licensed');
let startup=null,cleared=null;
if(d.workspaceId){startup=await rpc(4,'tools/call',{name:'run_startup',arguments:{workspaceId:d.workspaceId}});cleared=await rpc(5,'tools/call',{name:'clear_context',arguments:{workspaceId:d.workspaceId}});}
console.log(JSON.stringify({ok:true,protocolVersion:initialized.protocolVersion,tools:names,workspaceId:d.workspaceId,workspaces:d.workspaces?.length||0,loadedCount:startup?.structuredContent?.loadedCount??null,charactersLoaded:startup?.structuredContent?.charactersLoaded??null,loadErrors:startup?.structuredContent?.errors?.length??null,contextCleared:Array.isArray(cleared?.structuredContent?.activeFiles)&&cleared.structuredContent.activeFiles.length===0},null,2));