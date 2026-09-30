import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import mime from "mime-types";
import { extractDocument } from "../document-loader.js";
import { requireFilePermission } from "../services/file-permission-service.js";

const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const clean = (value) => String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
async function assertWorkspace(identity, workspaceId, listWorkspaces, filterWorkspaces) {
  const allowed = filterWorkspaces(await listWorkspaces(), identity);
  if (!allowed.some((item) => item.id === workspaceId)) {
    throw Object.assign(new Error("Workspace access denied"), { status: 403, code: "WORKSPACE_ACCESS_DENIED" });
  }
}
async function chooseWorkspaceId(requested, identity, listWorkspaces, filterWorkspaces) {
  const allowed = filterWorkspaces(await listWorkspaces(), identity);
  const selected = requested || identity.currentWorkspaceId || allowed.find((item) => item.status === "active")?.id || allowed[0]?.id;
  if (!selected || !allowed.some((item) => item.id === selected)) {
    throw Object.assign(new Error("Workspace access denied"), { status: 403, code: "WORKSPACE_ACCESS_DENIED" });
  }
  identity.currentWorkspaceId = selected;
  return selected;
}
function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0, from = 0;
  while (true) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}
async function walk(root, current, output, limit) {
  if (output.length >= limit) return;
  for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
    if (output.length >= limit) break;
    if (entry.name === ".orbitfs-workspace.json" || entry.name === "_trash") continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    output.push({ absolute, path: relative, type: entry.isDirectory() ? "folder" : "file" });
    if (entry.isDirectory()) await walk(root, absolute, output, limit);
  }
}
const fileMetadataSchema = z.object({ path: z.string(), bytes: z.number().optional(), modifiedAt: z.string().optional(), mimeType: z.string().nullable().optional(), sha256: z.string().optional() }).passthrough();
const fileOutputSchema = z.object({ ok: z.boolean(), message: z.string().optional(), workspaceId: z.string().optional(), metadata: fileMetadataSchema.optional() }).passthrough();
function publicStructured(value = {}) {
  const output = { ...value };
  delete output.data;
  if (output.document && typeof output.document === "object") {
    output.document = { ...output.document };
    delete output.document.content;
    delete output.document.mcpContent;
  }
  return output;
}
function resultText(text, structuredContent, meta) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, message: text, ...publicStructured(structuredContent) },
    _meta: { ...meta, orbitfsUiState: structuredContent }
  };
}
const PANEL_API_BASE = String(process.env.ORBITFS_PANEL_API_URL || "http://127.0.0.1:8400/api").replace(/\/$/, "");
async function panelRequest(pathname, options = {}) {
  const token = String(process.env.ORBITFS_CONTROL_TOKEN || "");
  if (!token) throw Object.assign(new Error("MCP control token is unavailable"), { status: 503, code: "PANEL_CONTROL_TOKEN_MISSING" });
  const response = await fetch(PANEL_API_BASE + pathname, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `Panel API HTTP ${response.status}`), { status: response.status, code: body.code || "PANEL_API_ERROR" });
  return body;
}
async function notifyWorkspaceIndexDirty(workspaceId) {
  try {
    await panelRequest(`/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/search-index/dirty`, { method: "POST" });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ event: "orbitfs.mcp.search_index_dirty_notify_failed", workspaceId, code: error?.code || null, message: error?.message || "notify failed" }));
    return false;
  }
}
function assertMutablePath(relativePath) {
  const value = clean(relativePath).toLowerCase();
  if (!value || value === "_system" || value.startsWith("_system/") || value === "_trash" || value.startsWith("_trash/")) {
    throw Object.assign(new Error("Protected OrbitFS system path"), { status: 403, code: "PROTECTED_SYSTEM_PATH" });
  }
}

const openAIFileSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
}).strict();
function safeUploadName(file, overrideName) {
  let name = path.basename(String(overrideName || file?.file_name || "").replace(/\0/g, "")).trim();
  if (!name) {
    const extension = mime.extension(String(file?.mime_type || "")) || "bin";
    const id = String(file?.file_id || "file").replace(/[^a-zA-Z0-9_-]/g, "").slice(-24) || "file";
    name = `chatgpt-${id}.${extension}`;
  }
  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!name) name = "chatgpt-file.bin";
  const stem = name.split(".")[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) name = "_" + name;
  if (name.length > 220) {
    const ext = path.extname(name);
    name = name.slice(0, Math.max(1, 220 - ext.length)) + ext;
  }
  return name;
}
async function downloadChatGPTFile(file, temporaryPath, maxBytes) {
  let url;
  try { url = new URL(file.download_url); }
  catch { throw Object.assign(new Error("ChatGPT file download URL is invalid"), { status: 400, code: "INVALID_FILE_DOWNLOAD_URL" }); }
  if (url.protocol !== "https:") throw Object.assign(new Error("ChatGPT file download URL must use HTTPS"), { status: 400, code: "INVALID_FILE_DOWNLOAD_URL" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let handle;
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error(`ChatGPT file download failed with HTTP ${response.status}`), { status: 502, code: "FILE_DOWNLOAD_FAILED" });
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw Object.assign(new Error(`ChatGPT file exceeds ${maxBytes} byte upload limit`), { status: 413, code: "FILE_TOO_LARGE" });
    if (!response.body) throw Object.assign(new Error("ChatGPT file download returned no body"), { status: 502, code: "FILE_DOWNLOAD_FAILED" });
    handle = await fs.open(temporaryPath, "wx");
    const reader = response.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw Object.assign(new Error(`ChatGPT file exceeds ${maxBytes} byte upload limit`), { status: 413, code: "FILE_TOO_LARGE" });
      }
      await handle.write(value);
    }
    return total;
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("ChatGPT file download timed out"), { status: 504, code: "FILE_DOWNLOAD_TIMEOUT" });
    throw error;
  } finally {
    clearTimeout(timer);
    if (handle) await handle.close().catch(() => {});
  }
}
export function registerFileTools(server, deps) {
  const { requireLicence, identity, meta, listWorkspaces, filterWorkspaces, resolveWorkspacePath, workspaceRoot } = deps;
  server.registerTool("search_files", {
    title: "Search OrbitFS files",
    description: "Search the Base File Search Index by file/folder name, path, and optionally extracted document content. This is deterministic filesystem search and is separate from Library knowledge retrieval. NEVER use this tool to resolve OrbitFS app commands such as studio, ventmode, workspace, or loadworkspace; command tools take priority.",
    inputSchema: {
      workspaceId: z.string().optional(), query: z.string().min(1), path: z.string().optional(),
      includeContent: z.boolean().optional(), maxResults: z.number().int().positive().max(200).optional()
    },
    outputSchema: fileOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, query, path: basePath = "", includeContent = false, maxResults = 50 }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    await requireFilePermission(identity, workspaceId, basePath, "read");
    const params = new URLSearchParams({ q: query, path: basePath, includeContent: includeContent ? "1" : "0", maxResults: String(maxResults) });
    const indexed = await panelRequest(`/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/search?${params}`);
    const matches = [], failedFiles = [...(Array.isArray(indexed.failedFiles) ? indexed.failedFiles : [])];
    for (const item of indexed.matches || []) {
      try { await requireFilePermission(identity, workspaceId, item.path, "read"); matches.push(item); }
      catch (error) { failedFiles.push({ path: item.path, code: error?.code || "READ_PERMISSION_DENIED", error: error?.message || "Read permission denied" }); }
    }
    const lines = matches.length ? matches.map((item) => item.path) : ["No matching files or folders."];
    if (failedFiles.length) lines.push("", `Failed files (${failedFiles.length}):`, ...failedFiles.slice(0, 50).map((item) => `- ${item.path}: ${item.error || item.code || "failed"}`));
    return resultText(lines.join("\n"), { ...indexed, matches, failedFiles, failedCount: failedFiles.length }, meta);
  });
  server.registerTool("read_file", {
    title: "Read OrbitFS file",
    description: "Read a permitted file without adding it to active context. Text and supported documents are extracted; any file may be returned losslessly as base64.",
    inputSchema: {
      workspaceId: z.string().optional(), path: z.string(), output: z.enum(["auto", "text", "base64"]).optional(),
      maxCharacters: z.number().int().positive().max(1500000).optional(),
      maxBytes: z.number().int().positive().max(20971520).optional()
    },
    outputSchema: fileOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, path: relativePath, output = "auto", maxCharacters = 500000, maxBytes = 20971520 }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    await requireFilePermission(identity, workspaceId, relativePath, "read");
    const resolved = await resolveWorkspacePath(workspaceId, relativePath);
    const info = await fs.stat(resolved.absolute).catch(() => null);
    if (!info?.isFile()) throw Object.assign(new Error("File not found"), { status: 404, code: "FILE_NOT_FOUND" });
    if (info.size > maxBytes) throw Object.assign(new Error(`File exceeds ${maxBytes} byte read limit`), { status: 413, code: "FILE_TOO_LARGE" });
    const buffer = await fs.readFile(resolved.absolute);
    const metadata = { path: resolved.clean, bytes: info.size, modifiedAt: info.mtime.toISOString(), mimeType: mime.lookup(resolved.absolute) || "application/octet-stream", sha256: hash(buffer) };
    if (output !== "base64") {
      try {
        const document = await extractDocument(resolved.absolute, maxCharacters);
        return resultText(document.content, { workspaceId, encoding: "text", metadata, document }, meta);
      } catch (error) {
        if (output === "text") throw Object.assign(new Error(error.message), { status: 415, code: "TEXT_EXTRACTION_UNSUPPORTED" });
      }
    }
    return resultText(`Read ${resolved.clean} as lossless base64 (${info.size} bytes).`, { workspaceId, encoding: "base64", data: buffer.toString("base64"), metadata }, meta);
  });
  server.registerTool("write_file", {
    title: "Write OrbitFS file",
    description: "Create or update an OrbitFS file from text or explicit data supplied in the tool call. Use upload_chatgpt_file instead when the source is an existing ChatGPT attachment or Library file. Base64 data is reserved for the widget fallback path and requires explicit OrbitFS transfer intent.",
    inputSchema: {
      workspaceId: z.string().optional(), path: z.string(), data: z.string(), fileTransferIntent: z.literal("orbitfs").optional(),
      encoding: z.enum(["utf8", "base64"]).optional(), mode: z.enum(["create", "update", "upsert"]).optional(),
      expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(), createParents: z.boolean().optional(),
      maxBytes: z.number().int().positive().max(262144000).optional()
    },
    outputSchema: fileOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { ...meta, "openai/toolInvocation/invoking": "Writing file to OrbitFS...", "openai/toolInvocation/invoked": "Wrote file to OrbitFS" }
  }, async ({ workspaceId, path: relativePath, data, fileTransferIntent, encoding = "utf8", mode = "create", expectedSha256, createParents = false, maxBytes = 104857600 }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    if (encoding === "base64" && fileTransferIntent !== "orbitfs") throw Object.assign(new Error("Explicit OrbitFS file transfer intent is required for base64 data"), { status: 400, code: "ORBITFS_FILE_TRANSFER_INTENT_REQUIRED" });
    const resolved = await resolveWorkspacePath(workspaceId, relativePath);
    if (!resolved.clean || resolved.clean.endsWith("/")) throw Object.assign(new Error("A file path is required"), { status: 400, code: "INVALID_FILE_PATH" });
    assertMutablePath(resolved.clean);
    const current = await fs.stat(resolved.absolute).catch(() => null);
    if (current?.isDirectory()) throw Object.assign(new Error("Path is a folder"), { status: 409, code: "PATH_IS_FOLDER" });
    await requireFilePermission(identity, workspaceId, resolved.clean, current ? "write" : "create");
    if (mode === "create" && current) throw Object.assign(new Error("File already exists"), { status: 409, code: "FILE_EXISTS" });
    if (mode === "update" && !current) throw Object.assign(new Error("File not found"), { status: 404, code: "FILE_NOT_FOUND" });
    if (current && !expectedSha256) throw Object.assign(new Error("expectedSha256 is required when replacing an existing file"), { status: 409, code: "OVERWRITE_CONFIRMATION_REQUIRED" });
    if (current) {
      const currentBuffer = await fs.readFile(resolved.absolute);
      if (hash(currentBuffer).toLowerCase() !== expectedSha256.toLowerCase()) throw Object.assign(new Error("File changed since it was read"), { status: 409, code: "FILE_VERSION_CONFLICT" });
    }
    let buffer;
    try { buffer = encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8"); }
    catch { throw Object.assign(new Error("Invalid file data"), { status: 400, code: "INVALID_FILE_DATA" }); }
    if (encoding === "base64" && buffer.toString("base64").replace(/=+$/, "") !== data.replace(/\s/g, "").replace(/=+$/, "")) {
      throw Object.assign(new Error("Invalid base64 data"), { status: 400, code: "INVALID_BASE64" });
    }
    if (buffer.length > maxBytes) throw Object.assign(new Error(`File exceeds ${maxBytes} byte write limit`), { status: 413, code: "FILE_TOO_LARGE" });
    const parent = path.dirname(resolved.absolute);
    const parentInfo = await fs.stat(parent).catch(() => null);
    if (!parentInfo && !createParents) throw Object.assign(new Error("Parent folder not found"), { status: 404, code: "PARENT_FOLDER_NOT_FOUND" });
    if (!parentInfo) await fs.mkdir(parent, { recursive: true });
    const temporary = path.join(parent, `.${path.basename(resolved.absolute)}.${crypto.randomUUID()}.tmp`);
    const rollback = current ? path.join(parent, `.${path.basename(resolved.absolute)}.${crypto.randomUUID()}.rollback`) : null;
    try {
      await fs.writeFile(temporary, buffer, { flag: "wx" });
      if (rollback) await fs.rename(resolved.absolute, rollback);
      try {
        await fs.rename(temporary, resolved.absolute);
      } catch (error) {
        if (rollback) await fs.rename(rollback, resolved.absolute).catch(() => {});
        throw error;
      }
      if (rollback) await fs.unlink(rollback).catch(() => {});
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
    await notifyWorkspaceIndexDirty(workspaceId);
    const saved = await fs.stat(resolved.absolute);
    const metadata = { path: resolved.clean, bytes: saved.size, modifiedAt: saved.mtime.toISOString(), mimeType: mime.lookup(resolved.absolute) || "application/octet-stream", sha256: hash(buffer), encoding };
    return resultText(`${current ? "Updated" : "Created"} ${resolved.clean} (${saved.size} bytes).`, { workspaceId, created: !current, updated: Boolean(current), metadata }, meta);
  });

  server.registerTool("upload_chatgpt_file", {
  title: "Upload ChatGPT file to OrbitFS",
  description: "Transfer one existing ChatGPT attachment or Library file into OrbitFS only when the user explicitly asks to save/upload/copy that file to OrbitFS. Preserve original bytes; never base64-encode the native file. Existing files are never overwritten; OrbitFS chooses a numbered filename on conflict. For generated text/data, use write_file instead.",
  inputSchema: {
    file: openAIFileSchema,
    intent: z.literal("orbitfs"),
    directory: z.string().optional(),
    workspaceId: z.string().optional(),
    fileName: z.string().optional(),
    maxBytes: z.number().int().positive().max(262144000).optional()
  },
  outputSchema: fileOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: {
    ...meta,
    "openai/fileParams": ["file"],
    "openai/toolInvocation/invoking": "Uploading to OrbitFS...",
    "openai/toolInvocation/invoked": "Uploaded to OrbitFS"
  }
}, async ({ file, intent, directory = "", workspaceId, fileName, maxBytes = 104857600 }) => {
  requireLicence();
  if (intent !== "orbitfs") throw Object.assign(new Error("Explicit OrbitFS file transfer intent is required"), { status: 400, code: "ORBITFS_FILE_TRANSFER_INTENT_REQUIRED" });
  const allowed = filterWorkspaces(await listWorkspaces(), identity);
  const targetWorkspaceId = workspaceId || allowed.find((item) => item.status === "active")?.id || allowed[0]?.id;
  if (!targetWorkspaceId || !allowed.some((item) => item.id === targetWorkspaceId)) {
    throw Object.assign(new Error("Workspace access denied"), { status: 403, code: "WORKSPACE_ACCESS_DENIED" });
  }
  const folder = await resolveWorkspacePath(targetWorkspaceId, directory);
  const folderInfo = await fs.stat(folder.absolute).catch(() => null);
  if (!folderInfo?.isDirectory()) throw Object.assign(new Error("Destination folder not found"), { status: 404, code: "FOLDER_NOT_FOUND" });
  const originalName = safeUploadName(file, fileName);
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  let attempt = 0, resolved;
  while (attempt < 1000) {
    const name = attempt === 0 ? originalName : `${base} (${attempt})${ext}`;
    const relativePath = clean(path.posix.join(folder.clean, name));
    assertMutablePath(relativePath);
    resolved = await resolveWorkspacePath(targetWorkspaceId, relativePath);
    if (!(await fs.stat(resolved.absolute).catch(() => null))) break;
    attempt += 1;
  }
  if (attempt >= 1000) throw Object.assign(new Error("Unable to choose a unique destination filename"), { status: 409, code: "FILE_NAME_CONFLICT" });
  await requireFilePermission(identity, targetWorkspaceId, resolved.clean, "create");
  const temporary = path.join(path.dirname(resolved.absolute), `.${path.basename(resolved.absolute)}.${crypto.randomUUID()}.chatgpt-upload`);
  let bytes = 0;
  try {
    bytes = await downloadChatGPTFile(file, temporary, maxBytes);
    await fs.rename(temporary, resolved.absolute);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  await notifyWorkspaceIndexDirty(targetWorkspaceId);
  const buffer = await fs.readFile(resolved.absolute);
  const metadata = {
    path: resolved.clean,
    bytes,
    mimeType: file.mime_type || mime.lookup(resolved.absolute) || "application/octet-stream",
    sha256: hash(buffer),
    chatgptFileId: file.file_id,
    originalFileName: file.file_name || null,
    renamedOnConflict: attempt > 0
  };
  return resultText(`Uploaded ${file.file_name || originalName} to ${resolved.clean} (${bytes} bytes).`, {
    workspaceId: targetWorkspaceId,
    uploaded: true,
    metadata
  }, meta);
});

  server.registerTool("create_folder", {
    title: "Create OrbitFS folder",
    description: "Create one permitted workspace folder, optionally including missing parent folders.",
    inputSchema: { workspaceId: z.string().optional(), path: z.string(), createParents: z.boolean().optional() },
    outputSchema: fileOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, path: relativePath, createParents = false }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    const resolved = await resolveWorkspacePath(workspaceId, relativePath);
    assertMutablePath(resolved.clean);
    await requireFilePermission(identity, workspaceId, resolved.clean, "create");
    if (await fs.stat(resolved.absolute).catch(() => null)) throw Object.assign(new Error("Path already exists"), { status: 409, code: "ENTRY_EXISTS" });
    const parent = path.dirname(resolved.absolute);
    if (!createParents && !(await fs.stat(parent).catch(() => null))) throw Object.assign(new Error("Parent folder not found"), { status: 404, code: "PARENT_FOLDER_NOT_FOUND" });
    await fs.mkdir(resolved.absolute, { recursive: createParents });
    await notifyWorkspaceIndexDirty(workspaceId);
    return resultText(`Created folder ${resolved.clean}.`, { workspaceId, path: resolved.clean, created: true }, meta);
  });

  server.registerTool("move_entry", {
    title: "Move or rename OrbitFS entry",
    description: "Move or rename one permitted file or folder without overwriting an existing entry.",
    inputSchema: { workspaceId: z.string().optional(), sourcePath: z.string(), destinationPath: z.string() },
    outputSchema: fileOutputSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, sourcePath, destinationPath }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    const source = await resolveWorkspacePath(workspaceId, sourcePath);
    const destination = await resolveWorkspacePath(workspaceId, destinationPath);
    assertMutablePath(source.clean); assertMutablePath(destination.clean);
    await requireFilePermission(identity, workspaceId, source.clean, "move");
    await requireFilePermission(identity, workspaceId, destination.clean, "create");
    const info = await fs.stat(source.absolute).catch(() => null);
    if (!info) throw Object.assign(new Error("Source entry not found"), { status: 404, code: "ENTRY_NOT_FOUND" });
    if (info.isDirectory() && destination.absolute.startsWith(source.absolute + path.sep)) throw Object.assign(new Error("Cannot move a folder inside itself"), { status: 409, code: "INVALID_MOVE" });
    if (await fs.stat(destination.absolute).catch(() => null)) throw Object.assign(new Error("Destination already exists"), { status: 409, code: "ENTRY_EXISTS" });
    if (!(await fs.stat(path.dirname(destination.absolute)).catch(() => null))) throw Object.assign(new Error("Destination parent not found"), { status: 404, code: "PARENT_FOLDER_NOT_FOUND" });
    await fs.rename(source.absolute, destination.absolute);
    await notifyWorkspaceIndexDirty(workspaceId);
    return resultText(`Moved ${source.clean} to ${destination.clean}.`, { workspaceId, sourcePath: source.clean, destinationPath: destination.clean, type: info.isDirectory() ? "folder" : "file" }, meta);
  });

  server.registerTool("delete_entry", {
    title: "Move OrbitFS entry to trash",
    description: "Recoverably delete a permitted file or folder by moving it into workspace trash with restore metadata.",
    inputSchema: { workspaceId: z.string().optional(), path: z.string() },
    outputSchema: fileOutputSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, path: relativePath }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    const source = await resolveWorkspacePath(workspaceId, relativePath);
    assertMutablePath(source.clean);
    await requireFilePermission(identity, workspaceId, source.clean, "delete");
    const info = await fs.stat(source.absolute).catch(() => null);
    if (!info) throw Object.assign(new Error("Entry not found"), { status: 404, code: "ENTRY_NOT_FOUND" });
    const trashId = crypto.randomUUID(), trashRoot = path.join(source.root, "_trash", trashId);
    await fs.mkdir(trashRoot, { recursive: true });
    const payload = path.join(trashRoot, "payload");
    try {
      await fs.rename(source.absolute, payload);
      await fs.writeFile(path.join(trashRoot, "metadata.json"), JSON.stringify({
        id: trashId, workspaceId, originalPath: source.clean, type: info.isDirectory() ? "folder" : "file",
        deletedAt: new Date().toISOString(), deletedBy: identity.userId || identity.username || null
      }, null, 2), "utf8");
    } catch (error) {
      await fs.rename(payload, source.absolute).catch(() => {});
      await fs.rm(trashRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await notifyWorkspaceIndexDirty(workspaceId);
    return resultText(`Moved ${source.clean} to recoverable trash.`, { workspaceId, trashId, originalPath: source.clean, recoverable: true }, meta);
  });
}
