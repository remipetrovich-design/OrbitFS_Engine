export type ApexImportMode = 'knowledge'|'reference'|'draft';
export type ApexJobStatus = 'queued'|'processing'|'awaiting_review'|'ready_to_finalize'|'completed'|'failed'|'cancelled';
export type ApexJobStage = 'queued'|'detect'|'extract'|'normalize'|'structure'|'fingerprint'|'duplicate_check'|'route'|'ready_to_finalize'|'complete';
export type ApexDuplicateKind = 'new'|'exact_duplicate'|'possible_revision'|'related';

export const APEX_PROCESSING_VERSION = 2;
export const APEX_PROCESSOR_ID = 'orbitfs-apex-knowledge-v2';
export const APEX_SUPPORTED_EXTENSIONS = ['pdf','docx','txt','md','markdown','html','htm','csv','json'] as const;
export const APEX_SUPPORTED_MIME_TYPES = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'text/plain','text/markdown','text/html','text/csv','application/json','text/json'
] as const;

export type ApexSourceDescriptor = {
	id:string;
	workspaceId:string;
	name:string;
	path:string;
	extension:string;
	mimeType:string|null;
	sizeBytes:number;
	storagePath:string|null;
	updatedAt:string|null;
};

export type ApexPage = { page:number; text:string; startChar:number; endChar:number };
export type ApexSection = { id:string; heading:string; level:number; startChar:number; endChar:number; pageStart:number|null; pageEnd:number|null; text:string };
export type ApexChunk = { id:string; index:number; heading:string|null; text:string; startChar:number; endChar:number; pageStart:number|null; pageEnd:number|null; sectionIds:string[]; hash:string };

export type ApexExtractionResult = {
	processor:string;
	source:ApexSourceDescriptor;
	title:string|null;
	rawText:string;
	markdown?:string|null;
	pages?:ApexPage[];
	metadata?:Record<string,unknown>;
	warnings?:string[];
};

export type ApexKnowledgePackage = {
	version:number;
	processor:string;
	workspaceId:string;
	source:ApexSourceDescriptor & { sourceHash:string };
	title:string;
	markdown:string;
	normalizedHash:string;
	sections:ApexSection[];
	chunks:ApexChunk[];
	pages:ApexPage[];
	metadata:Record<string,unknown>;
	duplicate:{ kind:ApexDuplicateKind; confidence:number; existingItemId:string|null; existingItemName:string|null; reason:string };
	routing:Record<string,unknown>;
	createdAt:string;
};

export type ApexJob = {
	id:string;
	workspaceId:string;
	type:'knowledge_import'|'reprocess'|'revision_import'|'conversion';
	status:ApexJobStatus;
	stage:ApexJobStage;
	progress:number;
	importMode:ApexImportMode;
	source:ApexSourceDescriptor;
	sourceHash:string|null;
	result:ApexKnowledgePackage|null;
	error:string|null;
	errorCode:string|null;
	attempts:number;
	createdByUserId:string;
	createdBy:string;
	createdAt:string;
	updatedAt:string;
	startedAt:string|null;
	completedAt:string|null;
	cancelledAt:string|null;
};
