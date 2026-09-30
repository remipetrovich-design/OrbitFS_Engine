import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import mime from "mime-types";
import { z } from "zod";
import { extractDocument } from "../document-loader.js";
import { requireFilePermission } from "../services/file-permission-service.js";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

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
const advancedFileOutputSchema = z.object({ ok: z.boolean().optional(), message: z.string().optional(), workspaceId: z.string().optional() }).passthrough();
function resultText(text, structuredContent, meta) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, message: text, ...structuredContent },
    _meta: { ...meta, orbitfsUiState: structuredContent }
  };
}

async function fileMetadata(resolved, info, includeHash = true) {
  const metadata = {
    path: resolved.clean,
    type: info.isDirectory() ? "folder" : "file",
    bytes: info.isFile() ? info.size : 0,
    modifiedAt: info.mtime?.toISOString?.() || null,
    createdAt: info.birthtime?.toISOString?.() || null,
    mimeType: info.isFile() ? (mime.lookup(resolved.absolute) || "application/octet-stream") : null
  };
  if (info.isFile() && includeHash) {
    const buffer = await fs.readFile(resolved.absolute);
    metadata.sha256 = sha256(buffer);
  }
  return metadata;
}

export function registerAdvancedFileTools(server, deps) {
  const { requireLicence, identity, meta, listWorkspaces, filterWorkspaces, resolveWorkspacePath } = deps;

  server.registerTool("file_info", {
    title: "Get OrbitFS file info",
    description: "Return current metadata and SHA-256 for one permitted file or folder without loading it into active context.",
    inputSchema: { workspaceId: z.string().optional(), path: z.string(), includeSha256: z.boolean().optional() },
    outputSchema: advancedFileOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, path: relativePath, includeSha256 = true }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    await requireFilePermission(identity, workspaceId, relativePath, "read");
    const resolved = await resolveWorkspacePath(workspaceId, relativePath);
    const info = await fs.stat(resolved.absolute).catch(() => null);
    if (!info) throw Object.assign(new Error("File not found"), { status: 404, code: "FILE_NOT_FOUND" });
    const metadata = await fileMetadata(resolved, info, includeSha256);
    return resultText(`${metadata.type}: ${metadata.path}\n${metadata.bytes} bytes${metadata.sha256 ? `\nSHA-256: ${metadata.sha256}` : ""}`, { workspaceId, metadata }, meta);
  });

  server.registerTool("read_many", {
    title: "Read multiple OrbitFS files",
    description: "Read multiple permitted files in one call without adding them to active context. Continues past failures and reports every failed file.",
    inputSchema: {
      workspaceId: z.string().optional(),
      paths: z.array(z.string()).min(1).max(50),
      maxCharactersPerFile: z.number().int().positive().max(1500000).optional(),
      maxTotalCharacters: z.number().int().positive().max(3000000).optional(),
      maxBytesPerFile: z.number().int().positive().max(20971520).optional()
    },
    outputSchema: advancedFileOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, paths, maxCharactersPerFile = 500000, maxTotalCharacters = 1500000, maxBytesPerFile = 20971520 }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    const loaded = [], failedFiles = [], content = [];
    let remaining = maxTotalCharacters;    for (const relativePath of paths) {
      if (remaining <= 0) {
        failedFiles.push({ path: relativePath, code: "READ_BUDGET_EXHAUSTED", error: "Total character budget exhausted" });
        continue;
      }
      try {
        await requireFilePermission(identity, workspaceId, relativePath, "read");
        const resolved = await resolveWorkspacePath(workspaceId, relativePath);
        const info = await fs.stat(resolved.absolute).catch(() => null);
        if (!info?.isFile()) throw Object.assign(new Error("File not found"), { status: 404, code: "FILE_NOT_FOUND" });
        if (info.size > maxBytesPerFile) throw Object.assign(new Error(`File exceeds ${maxBytesPerFile} byte read limit`), { status: 413, code: "FILE_TOO_LARGE" });
        const limit = Math.min(maxCharactersPerFile, remaining);
        const document = await extractDocument(resolved.absolute, limit);
        const buffer = await fs.readFile(resolved.absolute);
        const item = {
          path: resolved.clean,
          characters: document.content.length,
          truncated: Boolean(document.truncated),
          bytes: info.size,
          sha256: sha256(buffer),
          mimeType: mime.lookup(resolved.absolute) || "application/octet-stream"
        };
        loaded.push(item);
        remaining -= item.characters;
        content.push({ type: "text", text: `===== ${resolved.clean} =====\n${document.content}` });
      } catch (error) {
        failedFiles.push({ path: relativePath, code: error?.code || "READ_FAILED", error: error?.message || "Read failed" });
      }
    }    if (!content.length) content.push({ type: "text", text: "No files were successfully read." });
    if (failedFiles.length) {
      content.push({ type: "text", text: `Failed files (${failedFiles.length}):\n${failedFiles.map((item) => `- ${item.path}: ${item.error}`).join("\n")}` });
    }
    return {
      content,
      structuredContent: {
        workspaceId,
        requestedCount: paths.length,
        loadedCount: loaded.length,
        failedCount: failedFiles.length,
        loaded,
        failedFiles,
        charactersRead: loaded.reduce((sum, item) => sum + item.characters, 0)
      },
      _meta: meta
    };
  });

  server.registerTool("edit_file", {
    title: "Edit OrbitFS file",
    description: "Safely apply exact text replacements to one permitted text file. Requires the SHA-256 from a prior read/file_info, supports dry-run preview, and writes atomically.",
    inputSchema: {
      workspaceId: z.string().optional(), path: z.string(),
      expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string(), expectedOccurrences: z.number().int().positive().max(1000).optional() })).min(1).max(100),
      dryRun: z.boolean().optional()
    },
    outputSchema: advancedFileOutputSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, path: relativePath, expectedSha256, edits, dryRun = false }) => {
    requireLicence();
    workspaceId = await chooseWorkspaceId(workspaceId, identity, listWorkspaces, filterWorkspaces);
    await requireFilePermission(identity, workspaceId, relativePath, "write");
    const resolved = await resolveWorkspacePath(workspaceId, relativePath);
    const info = await fs.stat(resolved.absolute).catch(() => null);
    if (!info?.isFile()) throw Object.assign(new Error("File not found"), { status: 404, code: "FILE_NOT_FOUND" });
    if (info.size > 20 * 1024 * 1024) throw Object.assign(new Error("File exceeds 20 MB edit limit"), { status: 413, code: "FILE_TOO_LARGE" });
    const buffer = await fs.readFile(resolved.absolute);
    const currentSha256 = sha256(buffer);
    if (currentSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw Object.assign(new Error("File changed since it was read"), { status: 409, code: "FILE_VERSION_CONFLICT" });
    }
    let text;
    try { text = buffer.toString("utf8"); }
    catch { throw Object.assign(new Error("File is not editable UTF-8 text"), { status: 415, code: "TEXT_EXTRACTION_UNSUPPORTED" }); }
    const applied = [];
    let next = text;
    for (const edit of edits) {
      const occurrences = countOccurrences(next, edit.oldText);
      const expected = edit.expectedOccurrences ?? 1;
      if (!occurrences) throw Object.assign(new Error("Edit target text was not found"), { status: 409, code: "EDIT_TARGET_NOT_FOUND" });
      if (occurrences !== expected) {
        throw Object.assign(new Error(`Expected ${expected} occurrence(s) but found ${occurrences}`), { status: 409, code: "EDIT_OCCURRENCE_MISMATCH" });
      }
      next = next.split(edit.oldText).join(edit.newText);
      applied.push({ expectedOccurrences: expected, oldCharacters: edit.oldText.length, newCharacters: edit.newText.length });
    }
    const nextBuffer = Buffer.from(next, "utf8");
    const preview = {
      workspaceId, path: resolved.clean, dryRun: Boolean(dryRun), edits: applied,
      beforeSha256: currentSha256, afterSha256: sha256(nextBuffer),
      beforeBytes: buffer.length, afterBytes: nextBuffer.length
    };
    if (dryRun) return resultText(`Dry run ready: ${applied.length} edit(s) can be applied to ${resolved.clean}.`, preview, meta);

    const parent = path.dirname(resolved.absolute);
    const temporary = path.join(parent, `.${path.basename(resolved.absolute)}.${crypto.randomUUID()}.edit-tmp`);
    const rollback = path.join(parent, `.${path.basename(resolved.absolute)}.${crypto.randomUUID()}.edit-rollback`);
    try {
      await fs.writeFile(temporary, nextBuffer, { flag: "wx" });
      await fs.rename(resolved.absolute, rollback);
      try { await fs.rename(temporary, resolved.absolute); }
      catch (error) { await fs.rename(rollback, resolved.absolute).catch(() => {}); throw error; }
      await fs.unlink(rollback).catch(() => {});
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
    const token = String(process.env.ORBITFS_CONTROL_TOKEN || "");
    if (token) {
      const base = String(process.env.ORBITFS_PANEL_API_URL || "http://127.0.0.1:8400/api").replace(/\/$/, "");
      await fetch(`${base}/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/search-index/dirty`, {
        method: "POST", headers: { authorization: `Bearer ${token}` }
      }).catch(() => {});
    }
    return resultText(`Applied ${applied.length} edit(s) to ${resolved.clean}.`, { ...preview, dryRun: false }, meta);
  });
}
