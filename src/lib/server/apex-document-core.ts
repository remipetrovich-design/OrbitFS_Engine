import { createHash } from 'node:crypto';
import { readLibrary } from '$lib/server/library';
import { APEX_PROCESSING_VERSION, APEX_PROCESSOR_ID, type ApexChunk, type ApexExtractionResult, type ApexKnowledgePackage, type ApexPage, type ApexSection } from '$lib/server/apex-processing-types';

const now=()=>new Date().toISOString();
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const uniq=<T>(items:T[])=>[...new Set(items)];

export function normalizeApexText(input:string){
	let text=String(input||'').normalize('NFKC').replace(/\r\n?/g,'\n').replace(/[\t\u00a0]+/g,' ');
	text=text.split('\n').map((line)=>line.replace(/[ ]+$/g,'').replace(/^[ ]{5,}/,'    ')).join('\n');
	text=text.replace(/([^\n])\n(?=[a-z])/g,'$1 ');
	text=text.replace(/\n{4,}/g,'\n\n\n').trim();
	return text;
}

function preserveApexText(input:string){
	return String(input||'').replace(/\r\n?/g,'\n').trim();
}

function headingLevel(line:string){
	const markdown=line.match(/^(#{1,6})\s+(.+)$/);if(markdown)return {level:markdown[1].length,heading:markdown[2].trim()};
	const clean=line.trim();
	if(clean.length>=3&&clean.length<=100&&/^[A-Z0-9][A-Z0-9\s&/,:()'’.-]+$/.test(clean)&&/[A-Z]/.test(clean))return {level:2,heading:clean.replace(/\s+/g,' ')};
	if(clean.length>=3&&clean.length<=100&&/^[A-Z][^.!?]{2,99}:$/.test(clean))return {level:3,heading:clean.slice(0,-1)};
	return null;
}

function pageForChar(pages:ApexPage[],offset:number){
	if(!pages.length)return null;
	const exact=pages.find((item)=>offset>=item.startChar&&offset<item.endChar);if(exact)return exact.page;
	const previous=[...pages].reverse().find((item)=>item.endChar<=offset);if(previous)return previous.page;
	const next=pages.find((item)=>item.startChar>=offset);return next?.page??null;
}

function trimRange(text:string,start:number,end:number){
	let from=Math.max(0,start),to=Math.min(text.length,end);
	while(from<to&&/\s/.test(text[from]))from++;
	while(to>from&&/\s/.test(text[to-1]))to--;
	return {start:from,end:to,text:text.slice(from,to)};
}

export function structureApexDocument(markdown:string,pages:ApexPage[]=[]):ApexSection[]{
	const text=String(markdown||'');if(!text.trim())return [];
	const headings:Array<{start:number;heading:string;level:number}>=[];let cursor=0;
	for(const line of text.split('\n')){const detected=headingLevel(line);if(detected)headings.push({start:cursor,heading:detected.heading,level:detected.level});cursor+=line.length+1;}
	const sections:ApexSection[]=[];
	const add=(heading:string,level:number,start:number,end:number)=>{const range=trimRange(text,start,end);if(!range.text)return;sections.push({id:`sec_${sections.length+1}`,heading,level,startChar:range.start,endChar:range.end,pageStart:pageForChar(pages,range.start),pageEnd:pageForChar(pages,Math.max(range.start,range.end-1)),text:range.text});};
	if(!headings.length){add('Document',1,0,text.length);return sections;}
	if(headings[0].start>0)add('Document',1,0,headings[0].start);
	for(let index=0;index<headings.length;index++){const item=headings[index];add(item.heading,item.level,item.start,headings[index+1]?.start??text.length);}
	return sections;
}

export function chunkApexDocument(markdown:string,sections:ApexSection[],targetChars=4000,overlapChars=400,pages:ApexPage[]=[]):ApexChunk[]{
	const target=Math.max(1000,Math.min(16000,Number(targetChars)||4000));const overlap=Math.max(0,Math.min(Math.floor(target/2),Number(overlapChars)||0));const chunks:ApexChunk[]=[];
	for(const section of sections){const source=markdown.slice(section.startChar,section.endChar);let offset=0;
		while(offset<source.length){let end=Math.min(source.length,offset+target);if(end<source.length){const para=source.lastIndexOf('\n\n',end);const sentence=Math.max(source.lastIndexOf('. ',end),source.lastIndexOf('? ',end),source.lastIndexOf('! ',end));const boundary=Math.max(para,sentence);if(boundary>offset+Math.floor(target*.55))end=boundary+(boundary===para?2:1);}
			const raw=source.slice(offset,end);const leading=raw.length-raw.trimStart().length;const trailing=raw.length-raw.trimEnd().length;const text=raw.trim();
			if(text){const absoluteStart=section.startChar+offset+leading,absoluteEnd=section.startChar+end-trailing;chunks.push({id:`chunk_${chunks.length+1}`,index:chunks.length,heading:section.heading||null,text,startChar:absoluteStart,endChar:absoluteEnd,pageStart:pageForChar(pages,absoluteStart)??section.pageStart,pageEnd:pageForChar(pages,Math.max(absoluteStart,absoluteEnd-1))??section.pageEnd,sectionIds:[section.id],hash:hash(text)});}
			if(end>=source.length)break;offset=Math.max(offset+1,end-overlap);
		}
	}
	return chunks;
}

function tokens(value:string){return uniq(String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter((x)=>x.length>2)).slice(0,5000);}
function similarity(a:string,b:string){const A=new Set(tokens(a)),B=new Set(tokens(b));if(!A.size||!B.size)return 0;let hits=0;for(const token of A)if(B.has(token))hits++;return hits/Math.max(A.size,B.size);}
function liveCanonicalItem(item:any){
	if(String(item?.status||'active').toLowerCase()!=='active')return false;
	if(!['library.native','memory.knowledge'].includes(String(item?.source?.provider||'')))return false;
	const lifecycle=String(item?.lifecycleState||item?.lifecycle||'').toLowerCase();
	return !['old','deprecated','archived','archive','superseded'].includes(lifecycle);
}

export async function analyzeApexDuplicate(workspaceId:string,sourceHash:string,normalizedHash:string,markdown:string){
	const state=await readLibrary(workspaceId);let related:any=null;
	for(const item of state.items||[]){
		if(!liveCanonicalItem(item))continue;
		const apex=item.metadata?.apex||item.metadata?.sourceImport||{};
		if(sourceHash&&String(apex.sourceHash||'')===sourceHash)return {kind:'exact_duplicate' as const,confidence:1,existingItemId:String(item.id),existingItemName:String(item.name||'Knowledge'),reason:'The original source hash already exists in current Library Knowledge.'};
		if(normalizedHash&&String(apex.normalizedHash||'')===normalizedHash)return {kind:'exact_duplicate' as const,confidence:1,existingItemId:String(item.id),existingItemName:String(item.name||'Knowledge'),reason:'The processed Knowledge content already exists in current Library Knowledge.'};
		const score=similarity(markdown,String(item.content||''));if(score>=.72&&(!related||score>related.confidence))related={kind:score>=.88?'possible_revision':'related',confidence:Number(score.toFixed(3)),existingItemId:String(item.id),existingItemName:String(item.name||'Knowledge'),reason:score>=.88?'Processed content strongly resembles current Knowledge but is not identical.':'Processed content is related to current Knowledge.'};
	}
	return related||{kind:'new' as const,confidence:1,existingItemId:null,existingItemName:null,reason:'No matching current Knowledge source or content fingerprint was found.'};
}

function pageDocument(rawPages:ApexPage[],normalize=true){
	let markdown='';const pages:ApexPage[]=[];
	for(let index=0;index<rawPages.length;index++){
		const text=normalize?normalizeApexText(rawPages[index]?.text||''):preserveApexText(rawPages[index]?.text||'');if(index>0)markdown+='\n\n';const startChar=markdown.length;markdown+=text;
		pages.push({page:Number(rawPages[index]?.page||index+1),text,startChar,endChar:markdown.length});
	}
	return {markdown,pages};
}

export async function buildApexKnowledgePackage(args:{workspaceId:string;sourceBytes:Buffer;extraction:ApexExtractionResult;routing?:Record<string,unknown>;chunkTargetChars?:number;chunkOverlapChars?:number;normalize?:boolean}) : Promise<ApexKnowledgePackage>{
	const shouldNormalize=args.normalize!==false;
	const pagesDoc=(args.extraction.pages||[]).length?pageDocument(args.extraction.pages||[],shouldNormalize):null;
	const rawMarkdown=String(args.extraction.markdown||args.extraction.rawText||'');const markdown=pagesDoc?.markdown||(shouldNormalize?normalizeApexText(rawMarkdown):preserveApexText(rawMarkdown));const sourceHash=hash(args.sourceBytes);const normalizedHash=hash(markdown);
	const pages=pagesDoc?.pages||[];const sections=structureApexDocument(markdown,pages);const chunks=chunkApexDocument(markdown,sections,args.chunkTargetChars,args.chunkOverlapChars,pages);const duplicate=await analyzeApexDuplicate(args.workspaceId,sourceHash,normalizedHash,markdown);
	const title=String(args.extraction.title||sections[0]?.heading||args.extraction.source.name.replace(/\.[^.]+$/,'')||'Knowledge').trim().slice(0,240)||'Knowledge';
	const createdAt=now();const processor=args.extraction.processor||APEX_PROCESSOR_ID;
	const metadata={
		...(args.extraction.metadata||{}),
		warnings:args.extraction.warnings||[],
		pageCount:pages.length,
		sectionCount:sections.length,
		chunkCount:chunks.length,
		apex:{
			processingVersion:APEX_PROCESSING_VERSION,
			processor,
			importedAt:createdAt,
			sourceAssetId:args.extraction.source.id,
			sourceName:args.extraction.source.name,
			sourceMimeType:args.extraction.source.mimeType,
			sourceExtension:args.extraction.source.extension,
			sourceHash,
			normalizedHash,
			normalizationApplied:shouldNormalize,
			pageCount:pages.length,
			sectionCount:sections.length,
			chunkCount:chunks.length,
			pageTracking:pages.length>0,
			originalSourcePreserved:true,
			processingOwner:'engine-host',
			knowledgeOwner:'panel-library'
		}
	};
	return {version:APEX_PROCESSING_VERSION,processor,workspaceId:args.workspaceId,source:{...args.extraction.source,sourceHash},title,markdown,normalizedHash,sections,chunks,pages,metadata,duplicate,routing:args.routing||{},createdAt};
}

export function apexFingerprintText(value:string){return hash(normalizeApexText(value));}
export function apexFingerprintBytes(value:Buffer){return hash(value);}
