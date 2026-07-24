import type {
  registerAppResource as ExtRegisterAppResource,
  registerAppTool as ExtRegisterAppTool,
} from "@modelcontextprotocol/ext-apps/server";

const RESOURCE_URI_META_KEY = "ui/resourceUri";
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Minimal server-side MCP Apps compatibility wrapper.
 *
 * The browser bundle still uses the official ext-apps client library. The
 * server only needs these two metadata adapters, so keeping the full ext-apps
 * package out of production dependencies avoids another consumer-side MCP SDK
 * peer tree.
 */
export const registerAppTool: typeof ExtRegisterAppTool = ((
  server: { registerTool: (...args: unknown[]) => unknown },
  name: string,
  config: Record<string, unknown>,
  callback: unknown,
) => {
  const originalMeta = config._meta && typeof config._meta === "object" && !Array.isArray(config._meta)
    ? config._meta as Record<string, unknown>
    : {};
  const ui = originalMeta.ui && typeof originalMeta.ui === "object" && !Array.isArray(originalMeta.ui)
    ? originalMeta.ui as Record<string, unknown>
    : undefined;
  const resourceUri = typeof originalMeta[RESOURCE_URI_META_KEY] === "string"
    ? originalMeta[RESOURCE_URI_META_KEY]
    : undefined;
  const uiResourceUri = typeof ui?.resourceUri === "string" ? ui.resourceUri : undefined;
  let meta = originalMeta;
  if (uiResourceUri && !resourceUri) {
    meta = { ...originalMeta, [RESOURCE_URI_META_KEY]: uiResourceUri };
  } else if (resourceUri && !uiResourceUri) {
    meta = { ...originalMeta, ui: { ...(ui ?? {}), resourceUri } };
  }
  return server.registerTool(name, { ...config, _meta: meta }, callback);
}) as unknown as typeof ExtRegisterAppTool;

export const registerAppResource: typeof ExtRegisterAppResource = ((
  server: { registerResource: (...args: unknown[]) => unknown },
  name: string,
  uri: string,
  config: Record<string, unknown>,
  callback: unknown,
) => server.registerResource(
  name,
  uri,
  { mimeType: RESOURCE_MIME_TYPE, ...config },
  callback,
)) as unknown as typeof ExtRegisterAppResource;
