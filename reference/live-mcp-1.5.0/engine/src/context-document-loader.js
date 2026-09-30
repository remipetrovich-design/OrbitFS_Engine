import { documentLimits, extractDocument, hashMcpContent } from './document-loader.js';

const DEFAULT_MEDIA_OUTPUT_MAX_BYTES = documentLimits().mediaOutputMaxBytes;
function mediaBlockBytes(block) {
  return Math.floor(String(block?.data || '').length * 3 / 4);
}
function capMediaBlocks(blocks, maxBytes) {
  const kept = []; let bytes = 0;
  for (const block of blocks || []) {
    const size = mediaBlockBytes(block);
    if (bytes + size > maxBytes) break;
    kept.push(block); bytes += size;
  }
  return { blocks: kept, bytes, truncated: kept.length < (blocks || []).length };
}

function failureFor(item, error) {
  return {
    path: item.path,
    bundleId: item.bundleId || null,
    bundleName: item.bundleName || null,
    required: item.required === true,
    status: 'failed',
    opened: false,
    extracted: false,
    transferred: false,
    error: error.message
  };
}

export async function loadDocumentItems(items, maxCharacters, limits = {}) {
  const loaded = [], errors = [];
  let remaining = maxCharacters;
  const mediaOutputMaxBytes = Number(limits.mediaOutputMaxBytes ?? DEFAULT_MEDIA_OUTPUT_MAX_BYTES);
  let remainingMediaBytes = mediaOutputMaxBytes;
  for (const item of items) {
    if (remaining <= 0) break;
    try {
      const doc = await extractDocument(item.absolute, remaining, limits);
      const capped = doc.mediaKind ? capMediaBlocks(doc.mcpContent, remainingMediaBytes) : { blocks: doc.mcpContent, bytes: 0, truncated: false };
      if (doc.mediaKind && (doc.mcpContent || []).length > 0 && capped.blocks.length === 0) {
        throw new Error('Media output budget exhausted before this item could be transferred');
      }
      remaining -= doc.characters;
      remainingMediaBytes -= capped.bytes;
      const { absolute, ...persistable } = item;
      loaded.push({ ...persistable, status: 'transferred', opened: true, extracted: true, transferred: true, ...doc, mcpContent: capped.blocks, mediaBytesTransferred: capped.bytes, mediaTruncated: doc.mediaTruncated || capped.truncated, truncated: doc.truncated || capped.truncated, transferredHash: doc.mediaKind ? hashMcpContent(capped.blocks) : doc.transferredHash });
    } catch (error) {
      const failure = failureFor(item, error);
      errors.push(failure);
      if (item.required === true) {
        throw Object.assign(
          new Error(`Required bundle entry failed: ${item.path}: ${error.message}`),
          { status: 409, code: 'BUNDLE_REQUIRED_ENTRY_FAILED', details: errors }
        );
      }
    }
  }
  return {
    loaded,
    errors,
    characters: maxCharacters - remaining,
    remainingCharacters: remaining,
    mediaBytesTransferred: mediaOutputMaxBytes - remainingMediaBytes,
    remainingMediaBytes
  };
}
