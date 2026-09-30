import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".csv", ".tsv", ".js", ".ts", ".jsx", ".tsx",
  ".svelte", ".html", ".css", ".xml", ".yaml", ".yml", ".log", ".ini", ".conf", ".sql"
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpeg", ".mpg"]);
const DOCUMENT_MAX_BYTES = Number(process.env.ORBITFS_MAX_FILE_BYTES || 20 * 1024 * 1024);
const MEDIA_MAX_BYTES = Number(process.env.ORBITFS_MAX_MEDIA_FILE_BYTES || 250 * 1024 * 1024);
const MEDIA_CHUNK_SECONDS = Math.max(60, Number(process.env.ORBITFS_MEDIA_CHUNK_SECONDS || 600));
const MEDIA_MAX_CHUNKS = Math.max(1, Number(process.env.ORBITFS_MEDIA_MAX_CHUNKS || 12));
const MEDIA_OUTPUT_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.ORBITFS_MAX_MEDIA_OUTPUT_BYTES || 12 * 1024 * 1024));
const VIDEO_FRAME_INTERVAL = Math.max(5, Number(process.env.ORBITFS_VIDEO_FRAME_INTERVAL_SECONDS || 15));
const VIDEO_MAX_FRAMES = Math.max(1, Number(process.env.ORBITFS_VIDEO_MAX_FRAMES || 8));
function mimeFor(ext) {
  return ({
    ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".gif":"image/gif",
    ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".aac":"audio/aac", ".ogg":"audio/ogg", ".flac":"audio/flac", ".opus":"audio/ogg",
    ".mp4":"video/mp4", ".mov":"video/quicktime", ".mkv":"video/x-matroska", ".avi":"video/x-msvideo", ".webm":"video/webm",
    ".m4v":"video/x-m4v", ".mpeg":"video/mpeg", ".mpg":"video/mpeg"
  })[ext] || "application/octet-stream";
}
function maxBytesFor(ext, limits = {}) {
  const documentMaxBytes = Number(limits.documentMaxBytes ?? DOCUMENT_MAX_BYTES);
  const mediaMaxBytes = Number(limits.mediaMaxBytes ?? MEDIA_MAX_BYTES);
  return AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) ? mediaMaxBytes : documentMaxBytes;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}
export function hashMcpContent(blocks = []) {
  const hash = crypto.createHash('sha256');
  for (const block of blocks) hash.update(`${block.type}:${block.mimeType || ''}:`).update(String(block.data || ''));
  return hash.digest('hex');
}
function boundMediaBlocks(blocks, maxBytes = MEDIA_OUTPUT_MAX_BYTES) {
  const kept = []; let bytes = 0;
  for (const block of blocks || []) {
    const blockBytes = Math.floor(String(block.data || "").length * 3 / 4);
    if (bytes + blockBytes > maxBytes) break;
    kept.push(block); bytes += blockBytes;
  }
  return { blocks: kept, bytes, truncated: kept.length < (blocks || []).length };
}
async function normalizeAudioChunks(file, tempDir) {
  if (!ffmpegPath) throw new Error("Bundled FFmpeg runtime is unavailable");
  const pattern = path.join(tempDir, "audio-%03d.mp3");
  await execFileAsync(ffmpegPath, [
    "-y", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
    "-f", "segment", "-segment_time", String(MEDIA_CHUNK_SECONDS), "-reset_timestamps", "1", pattern
  ], { maxBuffer: 8 * 1024 * 1024 });
  const names = (await fs.readdir(tempDir)).filter((name) => /^audio-\d+\.mp3$/i.test(name)).sort();
  if (names.length > MEDIA_MAX_CHUNKS) throw new Error(`Media exceeds ${MEDIA_MAX_CHUNKS} audio chunks; reduce the file or raise mediaMaxChunks`);
  return names.map((name) => path.join(tempDir, name));
}
async function extractVideoMedia(file, tempDir) {
  if (!ffmpegPath) throw new Error("Bundled FFmpeg runtime is unavailable");
  const blocks = [];
  try {
    for (const audio of await normalizeAudioChunks(file, tempDir)) {
      blocks.push({ type: "audio", data: (await fs.readFile(audio)).toString("base64"), mimeType: "audio/mpeg" });
    }
  } catch {}
  const pattern = path.join(tempDir, "frame-%02d.jpg");
  try {
    await execFileAsync(ffmpegPath, [
      "-y", "-loglevel", "error", "-i", file,
      "-vf", `fps=1/${VIDEO_FRAME_INTERVAL},scale=1280:-2`, "-frames:v", String(VIDEO_MAX_FRAMES), pattern
    ], { maxBuffer: 8 * 1024 * 1024 });
    let names = (await fs.readdir(tempDir)).filter((name) => /^frame-\d+\.jpg$/i.test(name)).sort();
    if (!names.length) {
      const first = path.join(tempDir, "frame-first.jpg");
      await execFileAsync(ffmpegPath, ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "scale=1280:-2", first], { maxBuffer: 8 * 1024 * 1024 });
      names = ["frame-first.jpg"];
    }
    for (const name of names) blocks.push({ type: "image", data: (await fs.readFile(path.join(tempDir, name))).toString("base64"), mimeType: "image/jpeg" });
  } catch {}
  if (!blocks.length) throw new Error("Video could not be decoded into audio or frames");
  return blocks;
}
export async function extractDocument(file, maxCharacters, limits = {}) {
  const ext = path.extname(file).toLowerCase();
  const info = await fs.stat(file);
  const maxBytes = maxBytesFor(ext, limits);
  if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit for ${AUDIO_EXTENSIONS.has(ext)||VIDEO_EXTENSIONS.has(ext)?"media":"documents"}`);
  let text = "", mediaKind = null, mimeType = mimeFor(ext), mcpContent = [];
  if (TEXT_EXTENSIONS.has(ext) || !ext) text = await fs.readFile(file, "utf8");
  else if (ext === ".docx") text = (await mammoth.extractRawText({ path: file })).value;
  else if (ext === ".pdf") {
    const parser = new PDFParse({ data: await fs.readFile(file) });
    try { text = (await parser.getText()).text || ""; } finally { await parser.destroy(); }
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    mediaKind = "image";
    mcpContent = [{ type: "image", data: (await fs.readFile(file)).toString("base64"), mimeType }];
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    mediaKind = "audio";
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbitfs-audio-"));
    try {
      const chunks = await normalizeAudioChunks(file, tempDir);
      mcpContent = await Promise.all(chunks.map(async (audio) => ({ type: "audio", data: (await fs.readFile(audio)).toString("base64"), mimeType: "audio/mpeg" })));
      mimeType = "audio/mpeg";
    } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    mediaKind = "video";
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbitfs-video-"));
    try { mcpContent = await extractVideoMedia(file, tempDir); } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
  } else throw new Error(`Unsupported context file type: ${ext || "unknown"}`);
  const clean = String(text).replace(/\u0000/g, "").trim();
  const content = clean.slice(0, Math.max(0, maxCharacters));
  const originalMediaBlockCount = mcpContent.length;
  const boundedMedia = mediaKind ? boundMediaBlocks(mcpContent, Number(limits.mediaOutputMaxBytes ?? MEDIA_OUTPUT_MAX_BYTES)) : { blocks: mcpContent, bytes: 0, truncated: false };
  if (mediaKind && originalMediaBlockCount > 0 && boundedMedia.blocks.length === 0) throw new Error('Media output budget is too small to transfer this item');
  mcpContent = boundedMedia.blocks;
  const sourceHash = mediaKind ? await hashFile(file) : crypto.createHash('sha256').update(clean, 'utf8').digest('hex');
  const transferredHash = mediaKind ? hashMcpContent(mcpContent) : crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  return {
    content,
    mcpContent,
    mediaKind,
    mimeType,
    mediaBytesTransferred: boundedMedia.bytes,
    mediaTruncated: boundedMedia.truncated,
    originalCharacters: clean.length,
    characters: content.length,
    truncated: clean.length > content.length || boundedMedia.truncated,
    bytes: info.size,
    maxBytes,
    extension: ext,
    modifiedAt: info.mtime.toISOString(),
    sourceHash,
    transferredHash
  };
}

export function documentLimits() {
  return { documentMaxBytes: DOCUMENT_MAX_BYTES, mediaMaxBytes: MEDIA_MAX_BYTES, mediaOutputMaxBytes: MEDIA_OUTPUT_MAX_BYTES, mediaChunkSeconds: MEDIA_CHUNK_SECONDS, mediaMaxChunks: MEDIA_MAX_CHUNKS, videoFrameIntervalSeconds: VIDEO_FRAME_INTERVAL, videoMaxFrames: VIDEO_MAX_FRAMES };
}