import { z } from "zod";
import { securitySchemesForTool } from "./tool-security.js";

export const permissiveOutputSchema = z.object({}).passthrough();

const RECOVERY = {
  FILE_VERSION_CONFLICT: [true, "Read the file again and retry using its new SHA-256."],
  FILE_NOT_FOUND: [false, "Search or browse the workspace to locate the current file path."],
  FOLDER_NOT_FOUND: [false, "Browse the workspace and choose an existing folder."],
  PARENT_FOLDER_NOT_FOUND: [false, "Create the parent folder first or enable parent creation where supported."],
  WORKSPACE_ACCESS_DENIED: [false, "Refresh OrbitFS permissions/UI or choose an accessible workspace."],
  PROTECTED_SYSTEM_PATH: [false, "Choose a user workspace path. OrbitFS internal data is system-managed."],
  OVERWRITE_CONFIRMATION_REQUIRED: [true, "Read the file or file info first and retry with expectedSha256."],
  TEXT_EXTRACTION_UNSUPPORTED: [false, "Read the file as base64 or convert it to a supported document format."],
  EDIT_TARGET_NOT_FOUND: [true, "Read the latest file and use exact current text in the edit request."],
  EDIT_OCCURRENCE_MISMATCH: [true, "Read the latest file and correct expectedOccurrences before retrying."],
  LICENSE_REQUIRED: [true, "Refresh OrbitFS configuration/license or inspect MCP diagnostics in the Panel."],
  CCS_DISABLED: [false, "Enable the Complex Context System in the OrbitFS Panel."],
  OSS_DISABLED: [false, "Enable Startup in the OrbitFS Panel."]
};
export function errorDetails(error, tool) {
  const code = String(error?.code || "ORBITFS_TOOL_FAILED");
  const fallbackRetry = Number(error?.status || 500) >= 500;
  const [canRetry, suggestedAction] = RECOVERY[code] || [
    fallbackRetry,
    fallbackRetry
      ? "Retry once. If it fails again, inspect OrbitFS Panel diagnostics."
      : "Review the request or OrbitFS Panel configuration before retrying."
  ];
  return {
    code,
    message: String(error?.message || "OrbitFS tool failed"),
    status: Number(error?.status || 500),
    canRetry,
    suggestedAction,
    tool
  };
}

export function installToolDefaults(server, getSessionContext = async () => ({}), authorizeTool = async () => {}) {
  const original = server.registerTool.bind(server);
  server.registerTool = (name, config = {}, handler) => {
    const annotations = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      ...(config.annotations || {})
    };
    const outputSchema = config.outputSchema || permissiveOutputSchema;
    const securitySchemes = config.securitySchemes || securitySchemesForTool(name);
    const descriptorMeta = { ...(config._meta || {}), securitySchemes };
    return original(name, { ...config, _meta: descriptorMeta, annotations, outputSchema, securitySchemes }, async (input, extra) => {
      try {
        await authorizeTool(name);
        const result = await handler(input, extra);
        const current = result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
          ? result.structuredContent
          : {};
        const session = await getSessionContext();
        return {
          ...result,
          structuredContent: {
            ok: true,
            ...current
          },
          _meta: {
            ...(result?._meta || {}),
            orbitfsSession: session
          }
        };
      } catch (error) {
        const details = errorDetails(error, name);
        const session = await getSessionContext();
        return {
          isError: true,
          content: [{ type: "text", text: `${details.code}: ${details.message}\nNext: ${details.suggestedAction}` }],
          structuredContent: {
            ok: false,
            error: details
          },
          _meta: {
            ...(error?.wwwAuthenticate ? { "mcp/www_authenticate": [error.wwwAuthenticate] } : {}),
            orbitfsSession: session
          }
        };
      }
    });
  };
}
