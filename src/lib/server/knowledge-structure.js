// @ts-nocheck
import crypto from 'node:crypto';

const MONTHS = Object.freeze({
  january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12
});
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const hash = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
const stableId = (prefix, value) => `${prefix}_${hash(value).slice(0, 24)}`;
function isoDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

export function parseLeadingDate(value) {
  const source = String(value || '').trim();
  let match = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+((?:19|20)\d{2})\b/.exec(source);
  if (match && MONTHS[match[2].toLowerCase()]) return { date: isoDate(match[3], MONTHS[match[2].toLowerCase()], match[1]), raw: match[0], rest: source.slice(match[0].length).replace(/^\s*(?:[—–-]|:|\|)\s*/, '').trim() };
  match = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+((?:19|20)\d{2})\b/.exec(source);
  if (match && MONTHS[match[1].toLowerCase()]) return { date: isoDate(match[3], MONTHS[match[1].toLowerCase()], match[2]), raw: match[0], rest: source.slice(match[0].length).replace(/^\s*(?:[—–-]|:|\|)\s*/, '').trim() };
  match = /^((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(source);
  if (match) return { date: isoDate(match[1], match[2], match[3]), raw: match[0], rest: source.slice(match[0].length).replace(/^\s*(?:[—–-]|:|\|)\s*/, '').trim() };
  match = /^(\d{1,2})[/.](\d{1,2})[/.]((?:19|20)\d{2})\b/.exec(source);
  if (match) return { date: isoDate(match[3], match[2], match[1]), raw: match[0], rest: source.slice(match[0].length).replace(/^\s*(?:[—–-]|:|\|)\s*/, '').trim() };
  return null;
}
export function datedHeading(line) {
  const source = String(line || '').trim();
  if (!source || source.length > 260 || /^#{1,6}\s+/.test(source) || /^[A-Za-z][A-Za-z /_-]{1,30}:\s*/.test(source)) return null;
  const parsed = parseLeadingDate(source);
  if (!parsed?.date) return null;
  if (parsed.rest && !/^[\p{L}\p{N}]/u.test(parsed.rest)) return null;
  return { date: parsed.date, title: parsed.rest || parsed.raw, raw: source };
}

export function explicitSectionDate(section) {
  const titleHit = parseLeadingDate(section?.title || '');
  if (titleHit?.date) return { ...titleHit, source: 'heading' };
  const body = String(section?.__content || section?.preview || '');
  for (const raw of body.split('\n').slice(0, 12)) {
    const match = /^\s*Date(?:\s*\/\s*Time)?\s*:\s*(.+)$/i.exec(raw);
    if (!match) continue;
    const hit = parseLeadingDate(match[1]);
    if (hit?.date) return { ...hit, source: 'date_field', fieldText: clean(match[1]) };
  }
  return null;
}

function extractFields(body) {
  const source = String(body || '');
  const labels = /(Date\s*\/\s*Time|Date|Location|Persons involved|People involved|What happened|Witnesses(?:\s*\/\s*Evidence)?|Evidence|Impact(?: on [^:\n]+)?|Reported to police|Notes|Status)\s*:/gi;
  const hits = [...source.matchAll(labels)];
  const fields = {};
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    const key = clean(hit[1]).toLowerCase().replace(/\s+/g, '_').replace(/\//g, '_');
    const start = hit.index + hit[0].length;
    const end = index + 1 < hits.length ? hits[index + 1].index : source.length;
    fields[key] = clean(source.slice(start, end));
  }
  return fields;
}

function peopleFromText(value) {
  return String(value || '').split(/\s*[,;]\s*|\s+and\s+/i).map(clean).filter((name) => name.length >= 2 && name.length <= 160).slice(0, 40);
}
export function buildStructuredRecords({ item, sections, entities = [], mentions = [], previousRecords = [] }) {
  const previous = new Map(previousRecords.filter((record) => record.itemId === item.id).map((record) => [record.id, record]));
  const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
  const itemHints = `${item.name || ''} ${item.category || ''} ${(item.tags || []).join(' ')} ${(item.purposes || []).join(' ')}`.toLowerCase();
  const records = [];
  for (const section of sections) {
    const explicit = explicitSectionDate(section);
    if (!explicit?.date) continue;
    const body = String(section.__content || '');
    const fields = extractFields(body);
    const sectionMentions = mentions.filter((mention) => mention.sectionId === section.id);
    const mentionedPeople = sectionMentions.map((mention) => entityMap.get(mention.entityId)).filter((entity) => entity?.kind === 'profile').map((entity) => ({ name: entity.name, entityId: entity.id, profileId: entity.profileId || null }));
    const peopleText = fields.persons_involved || fields.people_involved || '';
    const explicitPeople = peopleFromText(peopleText).map((name) => ({ name, entityId: null, profileId: null }));
    const people = [];
    const seenPeople = new Set();
    for (const person of [...explicitPeople, ...mentionedPeople]) {
      const key = String(person.name || '').toLowerCase(); if (!key || seenPeople.has(key)) continue;
      seenPeople.add(key); people.push(person);
    }
    const heading = parseLeadingDate(section.title || '');
    const title = clean(heading?.rest || section.title || item.name).slice(0, 240);
    const isIncident = /incident|incident-log/.test(itemHints) || Boolean(fields.what_happened) || /\bincident\b/i.test(title);
    const id = stableId('rec', `${item.id}:${section.id}`);
    const prior = previous.get(id);
    records.push({
      id, workspaceId: item.workspaceId, itemId: item.id, sectionId: section.id,
      type: isIncident ? 'incident' : 'dated_entry', date: explicit.date,
      dateTimeText: fields.date___time || fields.date || explicit.fieldText || explicit.raw || '',
      title, location: fields.location || '', people,
      summary: String(fields.what_happened || section.preview || '').slice(0, 5000),
      witnesses: String(fields.witnesses || fields.witnesses___evidence || '').slice(0, 2500),
      evidence: String(fields.evidence || '').slice(0, 2500), notes: String(fields.notes || '').slice(0, 2500),
      sourceOrder: Number(section.lineStart || 0), origin: 'source', reviewStatus: prior?.reviewStatus || 'derived',
      locked: prior?.locked === true, createdAt: prior?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), accessUserId: section.accessUserId || null
    });
  }
  return records.sort((a, b) => a.date.localeCompare(b.date) || a.sourceOrder - b.sourceOrder);
}

