const text=(value:unknown)=>String(value??'');
const clean=(value:unknown)=>String(value??'').trim();
const objectValue=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};

function sectionText(section:any){
	const title=clean(section?.title||section?.heading||section?.id||'Section');
	const content=text(section?.content);
	return content?`## ${title}\n${content}`:`## ${title}`;
}

function distributedIndexes(length:number,max:number){
	if(length<=0||max<=0)return [];
	if(length<=max)return Array.from({length},(_,index)=>index);
	if(max===1)return [0];
	const indexes=new Set<number>([0,length-1]);
	for(let slot=1;slot<max-1;slot++)indexes.add(Math.round((slot*(length-1))/(max-1)));
	return [...indexes].sort((a,b)=>a-b);
}

function apexMeta(item:any){
	const apex=objectValue(item?.metadata?.apex);
	const integration=objectValue(apex.libraryIntegration);
	return {
		apexManaged:Boolean(apex.jobId||apex.processor||apex.sourceAssetId),
		jobId:apex.jobId||null,
		processor:apex.processor||null,
		processingVersion:apex.processingVersion||null,
		sourceAssetId:apex.sourceAssetId||null,
		sourceFilename:apex.sourceFilename||null,
		sourceMimeType:apex.sourceMimeType||null,
		sourceHash:apex.sourceHash||null,
		normalizedHash:apex.normalizedHash||null,
		revision:Number(apex.revision||0)||null,
		revisionOf:apex.revisionOf||null,
		pageCount:Number(apex.pageCount||0),
		sectionCount:Number(apex.sectionCount||0),
		chunkCount:Number(apex.chunkCount||0),
		indexed:integration.indexed===true,
		provenanceSectionCount:Number(integration.provenanceSectionCount||0)
	};
}

export function knowledgeVersion(item:any){
	const apex=apexMeta(item);
	return clean(apex.normalizedHash||apex.sourceHash||item?.updatedAt||item?.updated_at||item?.versionLabel||item?.version||item?.id);
}

export function buildMcpKnowledgeContext(state:any,item:any,maxCharacters:number,mode:string){
	const limit=Math.max(1,Number(maxCharacters||500000));
	const effectiveMode=['summary','smart','full'].includes(String(mode))?String(mode):'full';
	const fullContent=text(item?.content);
	const sections=(state?.sections||[]).filter((section:any)=>String(section.itemId)===String(item.id));
	const apex=apexMeta(item);
	let content='';
	let selectedSections:any[]=[];
	let selection='full';

	if(effectiveMode==='summary'){
		const cap=Math.min(limit,4000);
		if(sections.length){
			selectedSections=[sections[0]];
			content=sectionText(sections[0]).slice(0,cap);
		}else content=fullContent.slice(0,cap);
		selection='summary';
	}else if(effectiveMode==='smart'){
		const cap=Math.min(limit,24000);
		if(sections.length){
			// Representative context: preserve the start and end while sampling
			// across the canonical Library sections APEX indexed in between.
			const estimatedPerSection=4500;
			const maxSections=Math.max(2,Math.min(sections.length,Math.floor(cap/estimatedPerSection)||2));
			const indexes=distributedIndexes(sections.length,maxSections);
			selectedSections=indexes.map((index)=>sections[index]).filter(Boolean);
			const parts:string[]=[];
			let remaining=cap;
			for(const section of selectedSections){
				if(remaining<=0)break;
				const raw=sectionText(section);
				const perSection=Math.max(800,Math.floor(remaining/Math.max(1,selectedSections.length-parts.length)));
				const part=raw.slice(0,Math.min(perSection,remaining));
				if(part.trim())parts.push(part);
				remaining-=part.length+2;
			}
			content=parts.join('\n\n').slice(0,cap);
			selection=apex.apexManaged?'apex_section_coverage':'library_section_coverage';
		}else{
			// No section index exists; take representative slices rather than only
			// the beginning so smart mode still provides whole-document coverage.
			if(fullContent.length<=cap)content=fullContent;
			else{
				const slice=Math.max(1000,Math.floor(cap/3));
				const middle=Math.max(0,Math.floor((fullContent.length-slice)/2));
				content=[fullContent.slice(0,slice),fullContent.slice(middle,middle+slice),fullContent.slice(-slice)].join('\n\n[…]\n\n').slice(0,cap);
			}
			selection='distributed_text';
		}
	}else{
		content=fullContent.slice(0,limit);
	}

	const selectedSectionIds=selectedSections.map((section:any)=>String(section.id)).filter(Boolean);
	const provenance=selectedSections.map((section:any)=>({
		sectionId:String(section.id||''),
		title:section.title||section.heading||null,
		pageStart:section.apex?.pageStart??null,
		pageEnd:section.apex?.pageEnd??null,
		apexSectionId:section.apex?.apexSectionId||null,
		chunkIds:Array.isArray(section.apex?.chunkIds)?section.apex.chunkIds:[]
	}));
	return {
		content,
		fullCharacters:fullContent.length,
		truncated:fullContent.length>content.length,
		selection,
		selectedSectionIds,
		provenance,
		apex,
		knowledgeVersion:knowledgeVersion(item)
	};
}
