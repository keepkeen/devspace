export type FilesystemIsolationCapability = "guardrail_only" | "sandboxed";
export type McpHttpTransportMode = "stateless" | "stateful";

export interface RuntimeCapabilities {
  networkIsolation: boolean;
  filesystemIsolation: FilesystemIsolationCapability;
  processSandbox: boolean;
  mcpHttpTransport: McpHttpTransportMode;
}

export function runtimeCapabilities(options: {
  mcpHttpTransport?: McpHttpTransportMode;
  networkIsolation?: boolean;
  filesystemIsolation?: FilesystemIsolationCapability;
  processSandbox?: boolean;
} = {}): RuntimeCapabilities {
  return {
    networkIsolation: options.networkIsolation ?? false,
    filesystemIsolation: options.filesystemIsolation ?? "guardrail_only",
    processSandbox: options.processSandbox ?? false,
    mcpHttpTransport: options.mcpHttpTransport ?? "stateless",
  };
}

export function supportedNetworkModes(
  capabilities: Pick<RuntimeCapabilities, "networkIsolation">,
): Array<"inherit" | "deny"> {
  return capabilities.networkIsolation ? ["inherit", "deny"] : ["inherit"];
}
