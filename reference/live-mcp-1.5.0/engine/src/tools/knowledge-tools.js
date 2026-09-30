import { z } from 'zod';
import { callWorkspaceApi } from '../services/workspace-client.js';

const outputSchema = z.object({
  ok: z.boolean(), message: z.string(), workspaceId: z.string()
}).passthrough();
const knowledgePath = (workspaceId, suffix = '') => `/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/library${suffix}`;
function itemLabel(item = {}) {
  const source = item.source?.provider === 'base.files' ? item.source?.locator?.path : item.source?.provider === 'base.profiles' ? `profile:${item.source?.locator?.profileId}` : item.source?.provider;
  return `${item.name || item.id}${item.category ? ` · ${item.category}` : ''}${source ? ` · ${source}` : ''}`;
}
function relationLabel(relation = {}) {
  if (relation.relation === 'contradicts') return 'possible contradiction';
  if (relation.relation === 'supports') return 'supporting claim';
  if (relation.relation === 'duplicate_of') return 'duplicate claim';
  return relation.relation || 'related claim';
}
export function registerKnowledgeTools(server, { requireLicence, identity, meta, sessionInfo = {}, clientId = 'chatgpt' }) {
  server.registerTool('knowledge_overview', {
    title: 'OrbitFS knowledge overview',
    description: 'Read the current Base Library knowledge map for a workspace: canonical Knowledge Items, records, indexed sections, recognised entities, claim candidates and relationship counts. CCS remains the separate context-grouping system.',
    inputSchema: { workspaceId: z.string() },
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: meta
  }, async ({ workspaceId }) => {
    requireLicence();
    const data = await callWorkspaceApi(identity, knowledgePath(workspaceId));
    const items = (data.items || []).map((item) => ({ id: item.id, name: item.name, kind: item.kind, category: item.knowledgeArchitecture?.policy?.category || item.category || '', purposes: item.purposes || [], aliases: item.aliases || [], roles: item.roles || [], lifecycleState: item.effectiveLifecycleState || item.lifecycleState || 'unclassified', loadMode: item.loadMode || 'smart', currentTarget: item.currentTarget === true, targetPriority: Number(item.targetPriority || 0), importance: item.importance ?? 0.5, versionLabel: item.versionLabel || '', status: item.status || 'active', recordCount: item.recordCount || 0, sectionCount: item.sectionCount || 0, factCount: item.factCount || 0, entityMentionCount: item.entityMentionCount || 0, relationCount: item.relationCount || 0, source: item.source }));
    const lines = [`OrbitFS Base Library · ${items.length} knowledge item${items.length === 1 ? '' : 's'}`];
    if (items.length) lines.push('', ...items.map((item) => `- ${itemLabel(item)} · ${item.recordCount} records · ${item.sectionCount} sections`));
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ok: true, message: lines[0], workspaceId, stats: data.stats || {}, items }, _meta: meta };
  });
  server.registerTool('search_knowledge', {
    title: 'Search OrbitFS knowledge',
    description: 'Query the central Base Library and return only relevant indexed sections under a strict character budget. Prefer this over loading whole source files when the user asks about known workspace material. Retrieval follows current Library ranking and Knowledge Setup policy.',
    inputSchema: {
      workspaceId: z.string(), query: z.string().max(500),
      itemIds: z.array(z.string()).max(100).optional(), sectionIds: z.array(z.string()).max(250).optional(),
      limit: z.number().int().positive().max(50).optional(), maxCharacters: z.number().int().min(500).max(50000).optional()
    },
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: meta
  }, async ({ workspaceId, query, itemIds, sectionIds, limit = 12, maxCharacters = 12000 }) => {
    requireLicence();
    const data = await callWorkspaceApi(identity, knowledgePath(workspaceId, '/retrieve'), { method: 'POST', body: { query, itemIds, sectionIds, limit, maxChars: maxCharacters, consumerType: 'mcp_conversation', consumerId: sessionInfo.conversationId || sessionInfo.sessionId || `${clientId}:${identity.userId || identity.username || 'user'}`, consumerLabel: 'MCP conversation' } });
    const results = data.results || [];
    const content = results.map((result) => ({ type: 'text', text: `===== ${result.itemName} > ${result.sectionTitle} =====\n${result.content}` }));
    if (!content.length) content.push({ type: 'text', text: 'No matching Base Library knowledge was found.' });
    return { content, structuredContent: { ok: true, message: `${results.length} knowledge section${results.length === 1 ? '' : 's'} returned (${data.returnedChars || 0} chars).`, workspaceId, query, resultCount: results.length, returnedChars: data.returnedChars || 0, results: results.map(({ content: _content, ...result }) => result) }, _meta: meta };
  });
  server.registerTool('get_knowledge_section', {
    title: 'Read OrbitFS knowledge section',
    description: 'Read one exact indexed Base Library section by stable Knowledge Item ID and Section ID, including its visible entity, event and claim-candidate context.',
    inputSchema: { workspaceId: z.string(), itemId: z.string(), sectionId: z.string() },
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: meta
  }, async ({ workspaceId, itemId, sectionId }) => {
    requireLicence();
    const data = await callWorkspaceApi(identity, knowledgePath(workspaceId, `/items/${encodeURIComponent(itemId)}/sections/${encodeURIComponent(sectionId)}`));
    const facts = (data.facts || []).map((fact) => ({ id: fact.id, text: fact.text, status: fact.status, confidence: fact.confidence, importance: fact.importance, date: fact.date || null }));
    const relations = (data.factRelations || []).map((relation) => ({ id: relation.id, relation: relation.relation, label: relationLabel(relation), status: relation.status, confidence: relation.confidence }));
    const label = `${data.item?.name || itemId} > ${data.section?.title || sectionId}`;
    return { content: [{ type: 'text', text: `===== ${label} =====\n${data.content || ''}` }], structuredContent: { ok: true, message: `Read ${label}.`, workspaceId, itemId, sectionId, section: data.section, entities: data.entities || [], events: data.events || [], facts, relations }, _meta: meta };
  });
  server.registerTool('load_knowledge_item', {
    title: 'Load canonical OrbitFS knowledge item',
    description: 'Load one Base Library Knowledge Item directly from its current canonical source. Use this when full context is required, especially for Core File/Core Profile items whose Library load mode is full.',
    inputSchema: { workspaceId: z.string(), itemId: z.string() }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, itemId }) => { requireLicence(); const data=await callWorkspaceApi(identity, knowledgePath(workspaceId, `/items/${encodeURIComponent(itemId)}/content`)); const warning=data.warning?`\nWARNING: ${data.warning}`:''; return { content:[{type:'text',text:`===== ${data.itemName || itemId} =====${warning}\n${data.content || ''}`}], structuredContent:{ok:true,message:`Loaded ${data.itemName || itemId} from the Base Library.`,workspaceId,itemId,itemName:data.itemName,lifecycleState:data.lifecycleState,roles:data.roles || [],loadMode:data.loadMode || 'smart',warning:data.warning || '',characterCount:data.characterCount || 0}, _meta:meta }; });
  server.registerTool('resolve_knowledge_target', {
    title: 'Resolve OrbitFS knowledge destination',
    description: 'Resolve a configured Base Library destination role such as knowledge_target, reference_target, profile_record_target or general_record_target. Legacy role IDs remain supported for compatibility. This is read-only and does not apply a change.',
    inputSchema: { workspaceId: z.string(), role: z.string().max(64) }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, role }) => { requireLicence(); const data=await callWorkspaceApi(identity, knowledgePath(workspaceId, `/targets?role=${encodeURIComponent(role)}`)); const target=data.recommended; const text=target?`${data.definition?.label || role}: ${target.name} · ${target.lifecycleState || 'unclassified'}${data.ambiguousCurrent?' · WARNING: multiple Current targets':''}`:`No writable Base Library target is configured for ${role}.`; return { content:[{type:'text',text}], structuredContent:{ok:true,message:text,workspaceId,role,definition:data.definition || null,recommended:target || null,targets:data.targets || [],ambiguousCurrent:data.ambiguousCurrent===true,currentCount:data.currentCount || 0}, _meta:meta }; });
  server.registerTool('get_knowledge_lineage', {
    title: 'Read OrbitFS knowledge lineage',
    description: 'Resolve the visible version chain, current version, original/root item and derived-from relationships for one Base Knowledge Item.',
    inputSchema: { workspaceId: z.string(), itemId: z.string() }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, itemId }) => { requireLicence(); const data=await callWorkspaceApi(identity, knowledgePath(workspaceId, `/items/${encodeURIComponent(itemId)}/lineage`)); const current=(data.current||[]).map((item)=>`${item.name}${item.versionLabel?` · ${item.versionLabel}`:''}`).join(', ')||'None'; return { content:[{type:'text',text:`Current: ${current}\nVisible version nodes: ${(data.nodes||[]).length}\nDerived from: ${(data.derivedFrom||[]).map((item)=>item.name).join(', ')||'None'}`}], structuredContent:{ok:true,message:`Resolved lineage for ${itemId}.`,workspaceId,...data}, _meta:meta }; });
  server.registerTool('get_knowledge_impact', {
    title: 'Read OrbitFS knowledge impact',
    description: 'Show which visible linked Knowledge Items and addon/runtime consumers would be affected by changing, superseding, archiving or removing a Base Knowledge Item.',
    inputSchema: { workspaceId: z.string(), itemId: z.string() }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, itemId }) => { requireLicence(); const data=await callWorkspaceApi(identity, knowledgePath(workspaceId, `/items/${encodeURIComponent(itemId)}/impact`)); const text=`${data.item?.name||itemId}: ${data.affectedCount||0} visible dependencies · ${(data.usage||[]).length} consumers · ${(data.linkedItems||[]).length} linked items.`; return { content:[{type:'text',text}], structuredContent:{ok:true,message:text,workspaceId,...data}, _meta:meta }; });
}
