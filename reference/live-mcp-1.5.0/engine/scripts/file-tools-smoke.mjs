import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbitfs-file-tools-"));
const backend = path.join(root, "panel-backend");
const workspace = path.join(root, "workspace");
await fs.mkdir(path.join(backend, "data"), { recursive: true });
await fs.mkdir(workspace, { recursive: true });
const state = {
  users: [
    { id: "owner", username: "Owner", role: "user" },
    { id: "viewer", username: "Viewer", role: "user" },
    { id: "admin", username: "Admin", role: "admin" }
  ],
  workspaces: [{ id: "ws", owner_id: "owner", owner_username: "Owner" }],
  members: { ws: [
    { user_id: "viewer", permission: "viewer" },
    { user_id: "admin", permission: "viewer" }
  ] },
  permissionOverrides: { ws: [
    { role: "viewer", path: "private", permissions: { read: false } }
  ] }
};
await fs.writeFile(path.join(backend, "data", "state.json"), JSON.stringify(state));
process.env.ORBITFS_BACKEND_ROOT = backend;

const { effectiveFilePermissions, requireFilePermission } =
  await import("../src/services/file-permission-service.js");
assert.equal((await effectiveFilePermissions({ userId: "owner" }, "ws")).role, "owner");
assert.equal((await effectiveFilePermissions({ userId: "viewer" }, "ws")).permissions.write, false);
assert.equal((await effectiveFilePermissions({ userId: "admin" }, "ws")).role, "viewer");
await assert.rejects(
  () => requireFilePermission({ userId: "viewer" }, "ws", "private/secret.txt", "read"),
  (error) => error.code === "FILE_PERMISSION_DENIED"
);
await assert.rejects(
  () => effectiveFilePermissions({ userId: "admin" }, "unrelated"),
  (error) => error.code === "WORKSPACE_NOT_FOUND"
);

const registered = new Map();
const fakeServer = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
const { registerFileTools } = await import("../src/tools/file-tools.js");
const resolveWorkspacePath = async (_workspaceId, relative = "") => {
  const clean = String(relative).replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.resolve(workspace, clean);
  if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) {
    throw Object.assign(new Error("Path escaped workspace root"), { code: "INVALID_PATH" });
  }
  return { root: workspace, clean, absolute };
};
registerFileTools(fakeServer, {
  requireLicence() {},
  identity: { userId: "owner", workspaceIds: ["ws"] },
  meta: {},
  listWorkspaces: async () => [{ id: "ws" }],
  filterWorkspaces: (items) => items,
  resolveWorkspacePath,
  workspaceRoot: async () => workspace
});
assert.deepEqual([...registered.keys()], ["search_files", "read_file", "write_file", "upload_chatgpt_file", "create_folder", "move_entry", "delete_entry"]);
const uploadDef = registered.get("upload_chatgpt_file").definition;
assert.deepEqual(uploadDef._meta["openai/fileParams"], ["file"]);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(Buffer.from("chatgpt upload body"), { status: 200, headers: { "content-length": "19" } });
const upload = registered.get("upload_chatgpt_file").handler;
await assert.rejects(() => upload({ file: { download_url: "https://files.example.test/file", file_id: "blocked" }, directory: "" }), (error) => error.code === "ORBITFS_FILE_TRANSFER_INTENT_REQUIRED");
let uploaded = await upload({ intent: "orbitfs", file: { download_url: "https://files.example.test/file", file_id: "file_test", mime_type: "text/plain", file_name: "created.txt" }, directory: "" });
assert.equal(uploaded._meta.orbitfsUiState.metadata.path, "created.txt");
assert.equal(await fs.readFile(path.join(workspace, "created.txt"), "utf8"), "chatgpt upload body");
uploaded = await upload({ intent: "orbitfs", file: { download_url: "https://files.example.test/file", file_id: "file_test", mime_type: "text/plain", file_name: "created.txt" }, directory: "" });
assert.equal(uploaded._meta.orbitfsUiState.metadata.path, "created (1).txt");
const write = registered.get("write_file").handler;
const writeDef = registered.get("write_file").definition;
assert.equal(writeDef._meta?.["openai/fileParams"], undefined);
const fallbackBinary = await write({ workspaceId: "ws", path: "payload.oddtype", fileTransferIntent: "orbitfs", data: Buffer.from([0,255,1,2,3,254]).toString("base64"), encoding: "base64", mode: "create" });
assert.equal(fallbackBinary._meta.orbitfsUiState.metadata.path, "payload.oddtype");
assert.deepEqual(await fs.readFile(path.join(workspace, "payload.oddtype")), Buffer.from([0,255,1,2,3,254]));
globalThis.fetch = originalFetch;
let result = await write({ workspaceId: "ws", path: "notes/test.txt", data: "hello", createParents: true });
assert.equal(result._meta.orbitfsUiState.created, true);
const sha = result._meta.orbitfsUiState.metadata.sha256;
result = await write({ workspaceId: "ws", path: "notes/test.txt", data: "updated", mode: "update", expectedSha256: sha });
assert.equal(result._meta.orbitfsUiState.updated, true);
const read = await registered.get("read_file").handler({ workspaceId: "ws", path: "notes/test.txt", output: "text" });
assert.match(read.content[0].text, /updated/);
await assert.rejects(
  () => write({ workspaceId: "ws", path: "notes/test.txt", data: "bad", mode: "update", expectedSha256: "0".repeat(64) }),
  (error) => error.code === "FILE_VERSION_CONFLICT"
);
await registered.get("create_folder").handler({ workspaceId: "ws", path: "archive" });
await registered.get("move_entry").handler({ workspaceId: "ws", sourcePath: "notes/test.txt", destinationPath: "archive/test.txt" });
assert.equal(await fs.readFile(path.join(workspace, "archive", "test.txt"), "utf8"), "updated");
const deleted = await registered.get("delete_entry").handler({ workspaceId: "ws", path: "archive/test.txt" });
assert.equal(deleted._meta.orbitfsUiState.recoverable, true);
assert.equal(await fs.readFile(path.join(workspace, "_trash", deleted._meta.orbitfsUiState.trashId, "payload"), "utf8"), "updated");
await assert.rejects(
  () => write({ workspaceId: "ws", path: "_system/rules.txt", data: "blocked", createParents: true }),
  (error) => error.code === "PROTECTED_SYSTEM_PATH"
);
await fs.rm(root, { recursive: true, force: true });
console.log("file-tools smoke: native file + core checks passed");

