import { APEX_SUPPORTED_EXTENSIONS } from '$lib/server/apex-processing-types';

const MIME_TO_EXTENSION:Record<string,string>={
	'application/pdf':'pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
	'text/plain':'txt',
	'text/markdown':'md',
	'text/x-markdown':'md',
	'text/html':'html',
	'application/xhtml+xml':'html',
	'text/csv':'csv',
	'application/csv':'csv',
	'application/json':'json',
	'text/json':'json'
};

const EQUIVALENT:Record<string,Set<string>>={
	md:new Set(['md','markdown']),markdown:new Set(['md','markdown']),
	html:new Set(['html','htm']),htm:new Set(['html','htm'])
};
const STRONG_FORMATS=new Set(['pdf','docx']);

function extensionFromValue(value:string){
	const candidate=String(value||'').trim().toLowerCase();
	if(!candidate.includes('.'))return '';
	const suffix=candidate.split('.').pop()||'';
	return suffix==='markdown'?'markdown':suffix==='htm'?'htm':suffix;
}

export function apexExtensionFromMime(mimeType:string|null|undefined){
	const mime=String(mimeType||'').split(';')[0].trim().toLowerCase();
	return MIME_TO_EXTENSION[mime]||null;
}

export function apexExtensionFromSource(name:string,path:string,mimeType:string|null|undefined){
	const nameExtension=extensionFromValue(name);
	if(APEX_SUPPORTED_EXTENSIONS.includes(nameExtension as any))return nameExtension;
	const pathExtension=extensionFromValue(path);
	if(APEX_SUPPORTED_EXTENSIONS.includes(pathExtension as any))return pathExtension;
	return apexExtensionFromMime(mimeType)||nameExtension||pathExtension;
}

export function apexSourceFormatConflict(extension:string,mimeType:string|null|undefined){
	const ext=String(extension||'').trim().toLowerCase().replace(/^\./,'');
	const mimeExtension=apexExtensionFromMime(mimeType);
	if(!ext||!mimeExtension||ext===mimeExtension)return false;
	if(EQUIVALENT[ext]?.has(mimeExtension))return false;
	if(!STRONG_FORMATS.has(ext)&&!STRONG_FORMATS.has(mimeExtension))return false;
	return true;
}

export function apexMimeSupported(mimeType:string|null|undefined){return Boolean(apexExtensionFromMime(mimeType));}
