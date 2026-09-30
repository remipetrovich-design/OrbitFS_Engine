function cleanSlug(value: string) {
	return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'section';
}

function fail(message: string, status = 400) {
	throw Object.assign(new Error(message), { status });
}

export function profilePayloadFromText(text: string, filename = 'Imported profile') {
	const lines = String(text || '').replace(/\r/g, '').split('\n');
	const first = lines.find((line) => line.trim());
	const name = String(first || filename).replace(/^#{1,6}\s*/, '').trim().slice(0, 120) || 'Imported profile';
	const sections: any[] = [];
	let current: any = { id: 'overview', title: 'Overview', content: '', enabled: true };
	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const heading = line.match(/^#{1,6}\s+(.+)$/);
		if (heading) {
			if (current.content.trim()) sections.push(current);
			const title = heading[1].trim();
			current = { id: cleanSlug(title), title, content: '', enabled: true };
		} else current.content += `${line}\n`;
	}
	if (current.content.trim() || sections.length === 0) sections.push(current);
	return { profile: { name, type: 'master', status: 'active', classification: 'workspace', restricted: false, fields: { source_file: filename }, sections } };
}

async function pdfText(buffer: Buffer) {
	const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
	try {
		const pages: string[] = [];
		for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
			const page = await doc.getPage(pageNumber);
			const content = await page.getTextContent();
			pages.push(content.items.map((item: any) => item.str || '').join(' '));
		}
		return pages.join('\n\n');
	} finally {
	}
}

export async function parseProfileUpload(buffer: Buffer, filename: string, contentType = ''): Promise<any> {
	const lower = String(filename || '').toLowerCase();
	if (lower.endsWith('.zip') || contentType.includes('application/zip') || contentType.includes('x-zip-compressed')) return parseProfileZipUpload(buffer);
	if (lower.endsWith('.json') || contentType.includes('application/json')) return JSON.parse(buffer.toString('utf8'));
	if (lower.endsWith('.pdf') || contentType.includes('application/pdf')) return profilePayloadFromText(await pdfText(buffer), filename);
	if (lower.endsWith('.docx') || contentType.includes('wordprocessingml')) {
		const mammoth = (await import('mammoth')).default;
		const result = await mammoth.extractRawText({ buffer });
		return profilePayloadFromText(result.value, filename);
	}
	if (/\.(md|markdown|txt)$/i.test(lower) || contentType.startsWith('text/')) return profilePayloadFromText(buffer.toString('utf8'), filename);
	return fail('Unsupported profile file. Use ZIP, JSON, Markdown, text, PDF or DOCX.', 415);
}

async function parseProfileZipUpload(buffer: Buffer) {
	if (buffer.length > 50 * 1024 * 1024) return fail('Profile ZIP is too large (50 MB maximum)', 413);
	const JSZip = (await import('jszip')).default;
	const archive = await JSZip.loadAsync(buffer);
	const supported = Object.values(archive.files).filter((entry) => !entry.dir && /\.(json|md|markdown|txt|pdf|docx)$/i.test(entry.name));
	if (supported.length > 500) return fail('Profile ZIP contains too many files (500 maximum)', 413);
	if (!supported.length) return fail('ZIP contains no supported profile files', 415);
	let expanded = 0;
	const canonical = supported.find((entry) => /(^|\/)(profiles-export|profile-export|export)\.json$/i.test(entry.name));
	if (canonical) {
		const bytes = Buffer.from(await canonical.async('uint8array'));
		return parseProfileUpload(bytes, canonical.name, 'application/json');
	}
	const profiles: any[] = [];
	const zipFailures: Array<{ file: string; error: string }> = [];
	for (const entry of supported) {
		try {
			const bytes = Buffer.from(await entry.async('uint8array'));
			expanded += bytes.length;
			if (expanded > 100 * 1024 * 1024) return fail('Expanded profile ZIP is too large (100 MB maximum)', 413);
			const payload = await parseProfileUpload(bytes, entry.name, '');
			if (Array.isArray(payload)) profiles.push(...payload);
			else if (Array.isArray(payload?.profiles)) profiles.push(...payload.profiles);
			else if (payload?.profile) profiles.push(payload.profile);
		} catch (error: any) {
			zipFailures.push({ file: entry.name, error: String(error?.message || error) });
		}
	}
	if (!profiles.length) return fail('No valid profiles could be read from ZIP', 422);
	return { profiles, zipFailures };
}
