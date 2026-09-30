import type { ApexExtractionResult, ApexPage } from '$lib/server/apex-processing-types';
import type { ApexProcessorAdapter, ApexProcessorContext } from '$lib/server/apex-processors';

const VERSION='2.0.0';
const utf8=(bytes:Buffer)=>bytes.toString('utf8').replace(/^\uFEFF/,'');
const sourceTitle=(context:ApexProcessorContext)=>String(context.source.name||'Knowledge').replace(/\.[^.]+$/,'').trim()||'Knowledge';

function decodeEntities(value:string){
	const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
	return String(value||'').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi,(_,token:string)=>{
		const lower=token.toLowerCase();
		if(named[lower]!==undefined)return named[lower];
		if(lower.startsWith('#x')){const cp=parseInt(lower.slice(2),16);return Number.isFinite(cp)?String.fromCodePoint(cp):_;}
		if(lower.startsWith('#')){const cp=parseInt(lower.slice(1),10);return Number.isFinite(cp)?String.fromCodePoint(cp):_;}
		return _;
	});
}

function htmlToMarkdown(input:string){
	let html=String(input||'').replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi,'');
	for(let level=1;level<=6;level++)html=html.replace(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`,'gi'),(_m,body)=>`\n\n${'#'.repeat(level)} ${decodeEntities(String(body).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())}\n\n`);
	html=html.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,'**$2**').replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,'*$2*');
	html=html.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_m,href,body)=>`[${String(body).replace(/<[^>]+>/g,' ').trim()}](${href})`);
	html=html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,(_m,body)=>`\n- ${String(body).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}`);
	html=html.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi,(_m,row)=>{const cells=[...String(row).matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m)=>decodeEntities(m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()));return cells.length?`\n| ${cells.join(' | ')} |`:'';});
	html=html.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(p|div|section|article|header|footer|blockquote|pre|ul|ol|table)>/gi,'\n\n').replace(/<(p|div|section|article|header|footer|blockquote|pre|ul|ol|table)[^>]*>/gi,'');
	html=html.replace(/<[^>]+>/g,' ');
	return decodeEntities(html).replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}

function parseCsv(input:string){
	const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
	for(let i=0;i<input.length;i++){
		const ch=input[i];
		if(quoted){if(ch==='"'&&input[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;continue;}
		if(ch==='"'){quoted=true;continue;}
		if(ch===','){row.push(cell);cell='';continue;}
		if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';continue;}
		cell+=ch;
	}
	if(cell.length||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
	return rows;
}

function csvToMarkdown(input:string){
	const rows=parseCsv(input);if(!rows.length)return {markdown:'',rows:0,columns:0};
	const columns=Math.max(...rows.map((row)=>row.length));const normalized=rows.map((row)=>Array.from({length:columns},(_,i)=>String(row[i]??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ')));
	const header=normalized[0];const body=normalized.slice(1);const markdown=[`| ${header.join(' | ')} |`,`| ${header.map(()=> '---').join(' | ')} |`,...body.map((row)=>`| ${row.join(' | ')} |`)].join('\n');
	return {markdown,rows:rows.length,columns};
}

function titleFromMarkdown(markdown:string,fallback:string){const match=String(markdown||'').match(/^#\s+(.+)$/m);return match?.[1]?.trim()||fallback;}

const textAdapter:ApexProcessorAdapter={
	id:'apex-text',version:VERSION,extensions:['txt'],
	async extract(context){const rawText=utf8(context.bytes);return {processor:`apex-text@${VERSION}`,source:context.source,title:sourceTitle(context),rawText,markdown:rawText,metadata:{format:'txt',sourceTracking:'document'},warnings:[]};}
};

const markdownAdapter:ApexProcessorAdapter={
	id:'apex-markdown',version:VERSION,extensions:['md','markdown'],
	async extract(context){const markdown=utf8(context.bytes);return {processor:`apex-markdown@${VERSION}`,source:context.source,title:titleFromMarkdown(markdown,sourceTitle(context)),rawText:markdown,markdown,metadata:{format:'markdown',sourceTracking:'document'},warnings:[]};}
};

const htmlAdapter:ApexProcessorAdapter={
	id:'apex-html',version:VERSION,extensions:['html','htm'],
	async extract(context){const source=utf8(context.bytes);const titleMatch=source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);const markdown=htmlToMarkdown(source);return {processor:`apex-html@${VERSION}`,source:context.source,title:decodeEntities(titleMatch?.[1]?.replace(/<[^>]+>/g,' ').trim()||'')||titleFromMarkdown(markdown,sourceTitle(context)),rawText:markdown,markdown,metadata:{format:'html',sourceTracking:'document'},warnings:[]};}
};

const csvAdapter:ApexProcessorAdapter={
	id:'apex-csv',version:VERSION,extensions:['csv'],
	async extract(context){const raw=utf8(context.bytes);const converted=csvToMarkdown(raw);return {processor:`apex-csv@${VERSION}`,source:context.source,title:sourceTitle(context),rawText:raw,markdown:`# ${sourceTitle(context)}\n\n${converted.markdown}`,metadata:{format:'csv',rowCount:converted.rows,columnCount:converted.columns,sourceTracking:'rows'},warnings:[]};}
};

const jsonAdapter:ApexProcessorAdapter={
	id:'apex-json',version:VERSION,extensions:['json'],
	async extract(context){const raw=utf8(context.bytes);let parsed:any;try{parsed=JSON.parse(raw);}catch{throw Object.assign(new Error('The uploaded JSON document is invalid'),{status:422,code:'APEX_JSON_INVALID'});}const formatted=JSON.stringify(parsed,null,2);const inferred=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?String(parsed.title||parsed.name||'').trim():'';return {processor:`apex-json@${VERSION}`,source:context.source,title:inferred||sourceTitle(context),rawText:formatted,markdown:`# ${inferred||sourceTitle(context)}\n\n\`\`\`json\n${formatted}\n\`\`\``,metadata:{format:'json',rootType:Array.isArray(parsed)?'array':typeof parsed,sourceTracking:'document'},warnings:[]};}
};

const docxAdapter:ApexProcessorAdapter={
	id:'apex-docx',version:VERSION,extensions:['docx'],
	async extract(context){
		const imported:any=await import('mammoth');const mammoth=imported.default||imported;
		const [htmlResult,textResult]=await Promise.all([mammoth.convertToHtml({buffer:context.bytes}),mammoth.extractRawText({buffer:context.bytes})]);
		const markdown=htmlToMarkdown(String(htmlResult.value||''));const rawText=String(textResult.value||markdown||'');const warnings=[...(htmlResult.messages||[]),...(textResult.messages||[])].filter((m:any)=>String(m?.type||'').toLowerCase()!=='info').map((m:any)=>String(m?.message||m)).slice(0,50);
		return {processor:`apex-docx@${VERSION}`,source:context.source,title:titleFromMarkdown(markdown,sourceTitle(context)),rawText,markdown:markdown||rawText,pages:[],metadata:{format:'docx',extractor:'mammoth',pageTracking:'not_available_in_docx',sourceTracking:'sections'},warnings};
	}
};

function pdfPageText(items:any[]){
	let out='';for(const item of items||[]){const value=typeof item?.str==='string'?item.str:'';if(!value)continue;if(out&&!/[\s\n]$/.test(out)&&!/[,.!?:;\])}]/.test(value[0]||''))out+=' ';out+=value;if(item?.hasEOL)out+='\n';}
	return out.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

const pdfAdapter:ApexProcessorAdapter={
	id:'apex-pdf',version:VERSION,extensions:['pdf'],
	async extract(context){
		const pdfjs:any=await import('pdfjs-dist/legacy/build/pdf.mjs');
		const loadingTask=pdfjs.getDocument({data:new Uint8Array(context.bytes),isEvalSupported:false,useSystemFonts:true});let document:any=null;
		try{
			document=await loadingTask.promise;const pageTexts:string[]=[];const warnings:string[]=[];
			for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){const page=await document.getPage(pageNumber);const content=await page.getTextContent();const text=pdfPageText(content.items);if(!text)warnings.push(`Page ${pageNumber} contains no extractable text.`);pageTexts.push(text);}
			let markdown='';const pages:ApexPage[]=[];for(let i=0;i<pageTexts.length;i++){if(i>0)markdown+='\n\n';const start=markdown.length;markdown+=pageTexts[i];pages.push({page:i+1,text:pageTexts[i],startChar:start,endChar:markdown.length});}
			const metadata=await document.getMetadata().catch(()=>null);const info:any=metadata?.info||{};const title=String(info.Title||'').trim()||sourceTitle(context);
			return {processor:`apex-pdf@${VERSION}`,source:context.source,title,rawText:markdown,markdown,pages,metadata:{format:'pdf',extractor:'pdfjs',pageCount:document.numPages,author:String(info.Author||'')||null,subject:String(info.Subject||'')||null,sourceTracking:'pages'},warnings};
		}finally{try{await document?.destroy?.();}catch{}try{await loadingTask?.destroy?.();}catch{}}
	}
};

export function createBuiltinApexProcessors():ApexProcessorAdapter[]{return [textAdapter,markdownAdapter,htmlAdapter,csvAdapter,jsonAdapter,docxAdapter,pdfAdapter];}
