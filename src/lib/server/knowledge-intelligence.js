// @ts-nocheck
import crypto from 'node:crypto';
import { explicitSectionDate } from './knowledge-structure.js';

const now = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
const stableId = (prefix, value) => `${prefix}_${sha256(value).slice(0, 24)}`;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const short = (value, max = 500) => clean(value).slice(0, max);
const unique = (values) => [...new Set((values || []).map(clean).filter(Boolean))];
const lower = (value) => clean(value).toLocaleLowerCase();
const safeArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

const STOPWORDS = new Set('a an and are as at be been being but by for from had has have he her hers him his i if in into is it its me my of on or our ours she so than that the their them they this to was we were what when where which who will with you your'.split(' '));
const NEGATIONS = new Set(['no','not','never','none','without','denied','deny','denies','didnt','didn’t','wasnt','wasn’t','isnt','isn’t','cannot','cant','can’t']);
const FACT_VERBS = /\b(is|are|was|were|has|have|had|said|stated|reported|confirmed|denied|called|emailed|contacted|attended|received|sent|told|asked|applied|filed|occurred|happened|arrested|charged|ordered|advised|agreed|refused|left|returned|started|ended|moved|paid|saw|heard|wrote|signed|served)\b/i;
const IMPORTANT_TERMS = /\b(court|hearing|police|officer|inspector|evidence|order|avo|bail|arrest|charge|complaint|school|hospital|medical|incident|statement|witness|child|parent|legal aid|dcj|ombudsman)\b/i;
const MONTHS = Object.freeze({
  january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12
});
function isoDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function dateMatches(value) {
  const source = String(value || '');
  const hits = [];
  const add = (match, date) => { if (date) hits.push({ date, index: match.index, text: match[0] }); };
  for (const match of source.matchAll(/\b(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) add(match, isoDate(match[1], match[2], match[3]));
  for (const match of source.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2}|19\d{2})\b/g)) add(match, isoDate(match[3], MONTHS[match[2].toLowerCase()], match[1]));
  for (const match of source.matchAll(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2}|19\d{2})\b/g)) add(match, isoDate(match[3], MONTHS[match[1].toLowerCase()], match[2]));
  return [...new Map(hits.map((hit) => [`${hit.date}:${hit.index}`, hit])).values()];
}
function aliasKeyValues(object, depth = 0, found = []) {
  if (!object || typeof object !== 'object' || depth > 3) return found;
  const aliasKeys = /^(alias|aliases|aka|alsoKnownAs|knownAs|nickname|nicknames|preferredName|otherName|otherNames|maidenName)$/i;
  for (const [key, value] of Object.entries(object)) {
    if (aliasKeys.test(key)) {
      if (Array.isArray(value)) found.push(...value.map(String));
      else if (value != null && typeof value !== 'object') found.push(String(value));
    }
    if (value && typeof value === 'object') aliasKeyValues(value, depth + 1, found);
  }
  return found;
}
function usableAliases(values) {
  return unique(values)
    .map((value) => value.replace(/^['"]|['"]$/g, '').trim())
    .filter((value) => value.length >= 3 && value.length <= 120)
    .filter((value) => !['unknown','none','n/a','profile','document','file'].includes(lower(value)))
    .sort((a,b) => b.length - a.length);
}
export function buildEntityCatalog(profileCatalog = {}, items = []) {
  const entities = [];
  for (const profile of profileCatalog?.profiles || []) {
    const aliases = usableAliases([profile.name, profile.displayName, profile.fullName, ...aliasKeyValues(profile)]);
    if (!aliases.length) continue;
    const linked = items.find((item) => item.source?.provider === 'base.profiles' && String(item.source?.locator?.profileId) === String(profile.id));
    entities.push({ id: stableId('ent', `profile:${profile.id}`), kind: 'profile', profileId: String(profile.id), linkedItemId: linked?.id || null, name: aliases[0], aliases, profileType: profile.type || null });
  }
  for (const item of items.filter((entry) => entry.status !== 'archived')) {
    const aliases = usableAliases([item.name, ...(item.aliases || []), ...(item.metadata?.aliases || [])]);
    if (!aliases.length) continue;
    entities.push({ id: stableId('ent', `item:${item.id}`), kind: 'knowledge_item', itemId: item.id, linkedItemId: item.id, name: aliases[0], aliases });
  }
  const byId = new Map();
  for (const entity of entities) {
    const existing = byId.get(entity.id);
    if (!existing) byId.set(entity.id, entity);
    else existing.aliases = usableAliases([...(existing.aliases || []), ...(entity.aliases || [])]);
  }
  return [...byId.values()];
}
function boundaryCharacter(char) { return Boolean(char && /[\p{L}\p{N}_]/u.test(char)); }
function aliasHits(source, alias) {
  const haystack = source.toLocaleLowerCase(), needle = alias.toLocaleLowerCase();
  const hits = [];
  let cursor = 0;
  while (needle && (cursor = haystack.indexOf(needle, cursor)) !== -1) {
    const before = cursor > 0 ? haystack[cursor - 1] : '';
    const after = cursor + needle.length < haystack.length ? haystack[cursor + needle.length] : '';
    if (!boundaryCharacter(before) && !boundaryCharacter(after)) hits.push(cursor);
    cursor += Math.max(1, needle.length);
  }
  return hits;
}
function extractMentions(item, sections, entities, previousMentions = []) {
  const previous = new Map(previousMentions.filter((entry) => entry.itemId === item.id).map((entry) => [entry.id, entry]));
  const mentions = [];
  for (const section of sections) {
    const body = String(section.__content || '');
    for (const entity of entities) {
      if (entity.kind === 'knowledge_item' && entity.itemId === item.id) continue;
      const matchedAliases = [];
      let count = 0, firstOffset = -1;
      for (const alias of entity.aliases || []) {
        const hits = aliasHits(body, alias);
        if (!hits.length) continue;
        matchedAliases.push(alias); count += hits.length;
        if (firstOffset < 0 || hits[0] < firstOffset) firstOffset = hits[0];
      }
      if (!count) continue;
      const id = stableId('mention', `${item.id}:${section.id}:${entity.id}`);
      const prior = previous.get(id);
      const evidenceStart = Math.max(0, firstOffset - 100), evidenceEnd = Math.min(body.length, firstOffset + 260);
      mentions.push({ id, itemId: item.id, sectionId: section.id, entityId: entity.id, count, matchedAliases: usableAliases(matchedAliases), firstOffset, evidence: short(body.slice(evidenceStart, evidenceEnd), 420), createdAt: prior?.createdAt || now(), updatedAt: now() });
      if (mentions.length >= 4000) return mentions;
    }
  }
  return mentions;
}
function classifyEvent(value) {
  const s = lower(value);
  if (/\b(court|hearing|listing|magistrate|judge|legal aid)\b/.test(s)) return 'court';
  if (/\b(police|officer|inspector|detective|station|arrest|custody)\b/.test(s)) return 'police';
  if (/\b(school|principal|teacher|centrepay)\b/.test(s)) return 'school';
  if (/\b(hospital|medical|doctor|fracture|injury|dental|health)\b/.test(s)) return 'health';
  if (/\b(call|called|email|emailed|message|contacted|spoke|reply)\b/.test(s)) return 'communication';
  if (/\b(order|avo|bail|charge|complaint|application|served|evidence)\b/.test(s)) return 'legal';
  return 'source_date';
}
function buildEvents(item, sections, previousEvents = []) {
  const previous = new Map(previousEvents.filter((event) => event.origin === 'indexer' && event.itemId === item.id).map((event) => [event.id, event]));
  const events = [];
  for (const section of sections) {
    const explicit = explicitSectionDate(section);
    if (!explicit?.date) continue;
    const evidence = short(String(section.__content || section.preview || section.title || ''), 900);
    const id = stableId('evt', `${item.id}:${section.id}:${explicit.date}`);
    const prior = previous.get(id);
    events.push({ id, workspaceId:item.workspaceId, itemId:item.id, sectionId:section.id, date:explicit.date,
      title:short(section.title || item.name,240), description:evidence, eventType:classifyEvent(`${section.title} ${evidence}`),
      origin:'indexer', status:['confirmed','dismissed'].includes(prior?.status) ? prior.status : 'confirmed',
      confidence: explicit.source === 'heading' ? 0.99 : 0.96, createdAt:prior?.createdAt || now(), updatedAt:now(), updatedBy:prior?.updatedBy || null });
  }
  return events;
}
function comparable(value) {
  return lower(value)
    .replace(/[“”"'`]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function comparisonTokens(value, { keepNegation = false } = {}) {
  return comparable(value).split(/\s+/).filter((token) => token.length >= 3 && !STOPWORDS.has(token) && (keepNegation || !NEGATIONS.has(token)));
}
function polarity(value) {
  const tokens = comparable(value).split(/\s+/);
  return tokens.some((token) => NEGATIONS.has(token)) ? -1 : 1;
}
function sentenceCandidates(body) {
  const result = [];
  for (const rawLine of String(body || '').split('\n')) {
    const line = clean(rawLine.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, ''));
    if (!line) continue;
    const pieces = line.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'(])/);
    for (const piece of pieces) {
      const candidate = clean(piece);
      if (candidate.length >= 20 && candidate.length <= 900) result.push(candidate);
      if (result.length >= 80) return result;
    }
  }
  return result;
}
function buildFacts(item, sections, mentions, previousFacts = []) {
  const previous = new Map(previousFacts.filter((fact) => fact.itemId === item.id).map((fact) => [fact.id, fact]));
  const mentionsBySection = new Map();
  for (const mention of mentions) {
    if (!mentionsBySection.has(mention.sectionId)) mentionsBySection.set(mention.sectionId, []);
    mentionsBySection.get(mention.sectionId).push(mention);
  }
  const facts = [];
  for (const section of sections) {
    const sectionMentions = mentionsBySection.get(section.id) || [];
    const entityIds = unique(sectionMentions.map((entry) => entry.entityId));
    for (const candidate of sentenceCandidates(section.__content)) {
      const dates = dateMatches(candidate);
      const hasSignal = dates.length || entityIds.length || FACT_VERBS.test(candidate) || IMPORTANT_TERMS.test(candidate) || /\b\d{2,}\b/.test(candidate);
      if (!hasSignal) continue;
      const normalized = comparable(candidate);
      if (normalized.length < 16) continue;
      const id = stableId('fact', `${item.id}:${section.id}:${normalized}`);
      const prior = previous.get(id);
      const confidence = clamp(0.48 + (dates.length ? 0.12 : 0) + (entityIds.length ? 0.1 : 0) + (FACT_VERBS.test(candidate) ? 0.1 : 0) + (IMPORTANT_TERMS.test(candidate) ? 0.06 : 0));
      const importance = clamp(0.35 + (dates.length ? 0.18 : 0) + Math.min(0.18, entityIds.length * 0.06) + (IMPORTANT_TERMS.test(candidate) ? 0.15 : 0) + (candidate.length > 80 ? 0.05 : 0));
      facts.push({ id, itemId: item.id, sectionId: section.id, text: short(candidate, 900), normalized, fingerprint: sha256(normalized), entityIds, date: dates[0]?.date || null, polarity: polarity(candidate), confidence, importance, origin: 'extractor', status: ['confirmed','dismissed'].includes(prior?.status) ? prior.status : 'candidate', createdAt: prior?.createdAt || now(), updatedAt: now(), updatedBy: prior?.updatedBy || null });
      if (facts.length >= 3000) return facts;
    }
  }
  return facts;
}
function enrichSections(sections, mentions, facts, events) {
  const mentionCount = new Map(), factCount = new Map(), eventCount = new Map();
  for (const mention of mentions) mentionCount.set(mention.sectionId, (mentionCount.get(mention.sectionId) || 0) + mention.count);
  for (const fact of facts.filter((entry) => entry.status !== 'dismissed')) factCount.set(fact.sectionId, (factCount.get(fact.sectionId) || 0) + 1);
  for (const event of events.filter((entry) => entry.status !== 'dismissed')) eventCount.set(event.sectionId, (eventCount.get(event.sectionId) || 0) + 1);
  return sections.map((section) => {
    const mentionsHere = mentions.filter((entry) => entry.sectionId === section.id);
    const entityIds = unique(mentionsHere.map((entry) => entry.entityId));
    const m = mentionCount.get(section.id) || 0, f = factCount.get(section.id) || 0, e = eventCount.get(section.id) || 0;
    const headingBoost = section.level === 1 ? 0.12 : section.level === 2 ? 0.08 : section.level === 3 ? 0.04 : 0;
    const importance = clamp(0.28 + headingBoost + Math.min(0.2, m * 0.025) + Math.min(0.18, f * 0.025) + Math.min(0.18, e * 0.06) + (IMPORTANT_TERMS.test(`${section.title} ${section.preview}`) ? 0.1 : 0));
    return { ...section, importance, entityIds, entityMentionCount: m, factCount: f, eventCount: e };
  });
}
function mentionLinks(store, item, mentions, entities) {
  const priorById = new Map((store.autoLinks || []).map((link) => [link.id, link]));
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const links = [];
  for (const mention of mentions) {
    const entity = entityById.get(mention.entityId), targetItemId = entity?.linkedItemId;
    if (!targetItemId || targetItemId === item.id || !store.items.some((entry) => entry.id === targetItemId)) continue;
    const id = stableId('alnk', `${item.id}:${mention.sectionId}:${targetItemId}:mentions`), prior = priorById.get(id);
    links.push({ id, sourceItemId: item.id, sourceSectionId: mention.sectionId, targetItemId, targetSectionId: null, relation: 'mentions', inverseRelation: 'mentioned_by', origin: 'entity_indexer', status: ['confirmed','dismissed'].includes(prior?.status) ? prior.status : 'candidate', confidence: clamp(0.7 + Math.min(0.2, mention.count * 0.03)), evidence: mention.evidence, createdAt: prior?.createdAt || now(), updatedAt: now(), updatedBy: prior?.updatedBy || null });
  }
  return [...new Map(links.map((link) => [link.id, link])).values()].slice(0, 1000);
}
function jaccard(a, b) {
  const left = new Set(a), right = new Set(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}
function sharedEntity(a, b) {
  const right = new Set(b.entityIds || []);
  return (a.entityIds || []).some((id) => right.has(id));
}
function relationScope(a, b) {
  const left = String(a?.accessUserId || ''), right = String(b?.accessUserId || '');
  if (left && right && left !== right) return false;
  return left || right || null;
}
function relationRecord(type, a, b, confidence, previous, accessUserId = null) {
  const ordered = [a, b].sort((x,y) => x.id.localeCompare(y.id));
  const id = stableId('frel', `${type}:${ordered[0].id}:${ordered[1].id}`), prior = previous.get(id);
  return { id, relation: type, sourceFactId: ordered[0].id, targetFactId: ordered[1].id, sourceItemId: ordered[0].itemId, sourceSectionId: ordered[0].sectionId, targetItemId: ordered[1].itemId, targetSectionId: ordered[1].sectionId, confidence: clamp(confidence), accessUserId, status: ['confirmed','dismissed'].includes(prior?.status) ? prior.status : 'candidate', origin: 'fact_engine', evidence: [short(ordered[0].text, 320), short(ordered[1].text, 320)], createdAt: prior?.createdAt || now(), updatedAt: now(), updatedBy: prior?.updatedBy || null };
}
export function buildFactRelations(facts = [], previousRelations = []) {
  const previous = new Map(previousRelations.map((entry) => [entry.id, entry]));
  const active = facts.filter((fact) => fact.status !== 'dismissed').slice(0, 5000);
  const relations = new Map(), exact = new Map(), buckets = new Map();
  const putBucket = (key, fact) => { if (!key) return; if (!buckets.has(key)) buckets.set(key, []); if (buckets.get(key).length < 120) buckets.get(key).push(fact); };
  for (const fact of active) {
    if (!exact.has(fact.normalized)) exact.set(fact.normalized, []);
    exact.get(fact.normalized).push(fact);
    if (fact.date) putBucket(`date:${fact.date}`, fact);
    for (const entityId of (fact.entityIds || []).slice(0, 4)) putBucket(`entity:${entityId}`, fact);
    const tokens = [...new Set(comparisonTokens(fact.text))].sort();
    if (tokens.length >= 2) putBucket(`tokens:${tokens.slice(0, 2).join(':')}`, fact);
  }
  for (const group of exact.values()) {
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      if (group[i].itemId === group[j].itemId) continue;
      const scope = relationScope(group[i], group[j]);
      if (scope === false) continue;
      const relation = relationRecord('duplicate_of', group[i], group[j], 0.99, previous, scope);
      relations.set(relation.id, relation);
      if (relations.size >= 2500) return [...relations.values()];
    }
  }
  const seenPairs = new Set();
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      const a = group[i], b = group[j];
      if (a.itemId === b.itemId) continue;
      const scope = relationScope(a, b);
      if (scope === false) continue;
      const pairKey = [a.id,b.id].sort().join(':');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      if (a.normalized === b.normalized) continue;
      const similarity = jaccard(comparisonTokens(a.text), comparisonTokens(b.text));
      const contextMatch = sharedEntity(a,b) || (a.date && a.date === b.date);
      if (!contextMatch && similarity < 0.82) continue;
      let type = null, confidence = 0;
      if (a.polarity !== b.polarity && similarity >= 0.62) { type = 'contradicts'; confidence = 0.58 + similarity * 0.32; }
      else if (a.polarity === b.polarity && similarity >= 0.72) { type = 'supports'; confidence = 0.55 + similarity * 0.38; }
      if (!type) continue;
      const relation = relationRecord(type, a, b, confidence, previous, scope);
      relations.set(relation.id, relation);
      if (relations.size >= 2500) return [...relations.values()];
    }
  }
  return [...relations.values()];
}
export function factRelationLinks(relations = [], previousAutoLinks = []) {
  const previous = new Map(previousAutoLinks.map((entry) => [entry.id, entry]));
  const links = [];
  for (const relation of relations) {
    if (relation.sourceItemId === relation.targetItemId) continue;
    const id = stableId('alnk', `fact:${relation.id}`), prior = previous.get(id);
    const inverse = relation.relation === 'supports' ? 'supported_by' : relation.relation === 'contradicts' ? 'contradicted_by' : relation.relation;
    links.push({ id, sourceItemId: relation.sourceItemId, sourceSectionId: relation.sourceSectionId, targetItemId: relation.targetItemId, targetSectionId: relation.targetSectionId, relation: relation.relation, inverseRelation: inverse, origin: 'fact_engine', status: ['confirmed','dismissed'].includes(prior?.status) ? prior.status : relation.status, confidence: relation.confidence, evidence: (relation.evidence || []).join(' ⇄ ').slice(0, 900), factRelationId: relation.id, accessUserId: relation.accessUserId || null, createdAt: prior?.createdAt || relation.createdAt || now(), updatedAt: now(), updatedBy: prior?.updatedBy || relation.updatedBy || null });
    if (links.length >= 1500) break;
  }
  return links;
}
export function buildKnowledgeIntelligence({ store, item, sections, profileCatalog = {} }) {
  const entities = buildEntityCatalog(profileCatalog, store.items || []);
  const mentions = extractMentions(item, sections, entities, store.entityMentions || []);
  const events = buildEvents(item, sections, store.events || []);
  const facts = buildFacts(item, sections, mentions, store.facts || []);
  const enrichedSections = enrichSections(sections, mentions, facts, events);
  const links = mentionLinks(store, item, mentions, entities);
  return { entities, mentions, events, facts, sections: enrichedSections, links };
}
export function retrievalIntelligenceBoost(query, item, section, entities = [], mentions = [], facts = []) {
  let boost = clamp(section.importance ?? 0.5) * 6 + clamp(item.importance ?? 0.5) * 4;
  const q = lower(query);
  if (!q) return boost;
  const sectionMentions = mentions.filter((entry) => entry.sectionId === section.id);
  const mentionedIds = new Set(sectionMentions.map((entry) => entry.entityId));
  for (const entity of entities) if (mentionedIds.has(entity.id) && (entity.aliases || []).some((alias) => q.includes(lower(alias)) || lower(alias).includes(q))) boost += 8;
  const factHits = facts.filter((fact) => fact.sectionId === section.id && fact.status !== 'dismissed' && lower(fact.text).includes(q)).length;
  boost += Math.min(8, factHits * 2);
  return boost;
}

