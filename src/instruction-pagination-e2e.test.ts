import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-instruction-pagination-e2e-"));
const workspaceRoot = join(root, "workspace");
const nested = join(workspaceRoot, "nested");
const deep = join(nested, "deep");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const ownerToken = "instruction-pagination-owner-token-long-enough";
const accessToken = "instruction-pagination-access-token";

await mkdir(deep, { recursive: true });
const expectedInstructions = new Map([
  ["AGENTS.md", instruction("ROOT_PAGE", 7_000)],
  ["nested/AGENTS.md", instruction("NESTED_PAGE", 7_000)],
  ["nested/deep/AGENTS.md", instruction("DEEP_PAGE_中文🙂", 12_000)],
]);
await Promise.all([
  writeFile(join(workspaceRoot, "AGENTS.md"), expectedInstructions.get("AGENTS.md")!),
  writeFile(join(nested, "AGENTS.md"), expectedInstructions.get("nested/AGENTS.md")!),
  writeFile(join(deep, "AGENTS.md"), expectedInstructions.get("nested/deep/AGENTS.md")!),
  writeFile(join(deep, "payload.txt"), "before\n"),
]);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

seedGrant();
const running = createServer(config);
const httpServer = createHttpServer(running.app);
const origin = await listen(httpServer);
const client = new Client({ name: "instruction-pagination", version: "1.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "instruction-pagination",
      writeAccess: "read_write",
      contextMode: "full",
    },
  });
  assertSucceeded(opened);
  let currentReceipt = receipt(opened);

  const first = await client.callTool({
    name: "load_workspace_instructions",
    arguments: { receipt: currentReceipt, paths: ["nested/deep/payload.txt"] },
  });
  assertSucceeded(first);
  const reconstructed = new Map<string, Buffer>();
  assertInstructionPage(first, reconstructed);
  assert.equal(instructionToken(first), undefined);
  assert.equal(statePhase(first), "context_loaded");
  const firstCursor = nextCursor(first);
  assert.equal(typeof firstCursor, "string");
  currentReceipt = receipt(first);

  const tamperedCursor = `${firstCursor!.slice(0, -1)}${firstCursor!.endsWith("a") ? "b" : "a"}`;
  const tampered = await client.callTool({
    name: "load_workspace_instructions",
    arguments: {
      receipt: currentReceipt,
      paths: ["nested/deep/payload.txt"],
      cursor: tamperedCursor,
    },
  });
  assert.equal(tampered.isError, true);
  assert.equal(
    (tampered.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code,
    "invalid_instruction_cursor",
  );

  let cursor: string | undefined = firstCursor;
  let finalPage = first;
  let pages = 1;
  while (cursor) {
    const page = await client.callTool({
      name: "load_workspace_instructions",
      arguments: {
        receipt: currentReceipt,
        paths: ["nested/deep/payload.txt"],
        cursor,
      },
    });
    assertSucceeded(page);
    assertInstructionPage(page, reconstructed);
    pages += 1;
    cursor = nextCursor(page);
    currentReceipt = receipt(page);
    finalPage = page;
    if (cursor) {
      assert.equal(instructionToken(page), undefined);
      assert.equal(statePhase(page), "context_loaded");
    }
  }
  assert.ok(pages >= 4, "the oversized instruction chain must require multiple 8 KiB pages");
  assert.equal(statePhase(finalPage), "target_scoped");
  const finalToken = instructionToken(finalPage);
  assert.match(finalToken ?? "", /^instructions_/u);
  for (const [path, expected] of expectedInstructions) {
    assert.equal(
      reconstructed.get(path)?.toString("utf8"),
      expected,
      `${path} must be reassembled without missing, duplicate, or broken UTF-8 bytes`,
    );
  }

  const read = await client.callTool({
    name: "read",
    arguments: { receipt: currentReceipt, path: "nested/deep/payload.txt" },
  });
  assertSucceeded(read);
  const contentHash = String(
    (read.structuredContent as { contentHash?: unknown } | undefined)?.contentHash,
  );
  const patched = await client.callTool({
    name: "apply_patch",
    arguments: {
      receipt: currentReceipt,
      operationId: "instruction-pagination-patch",
      instructionToken: finalToken,
      ifMatch: { "nested/deep/payload.txt": contentHash },
      patch: "*** Begin Patch\n*** Update File: nested/deep/payload.txt\n@@\n-before\n+after\n*** End Patch",
    },
  });
  assertSucceeded(patched);
} finally {
  await client.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
  await rm(root, { recursive: true, force: true });
}

function instruction(marker: string, bytes: number): string {
  const heading = `# ${marker}\n\n${marker}\n`;
  return `${heading}${"x".repeat(Math.max(0, bytes - Buffer.byteLength(heading, "utf8")))}\n`;
}

function seedGrant(): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const clientInfo = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    ).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "Instruction pagination",
    });
    const grant = store.createAuthorizationGrant({
      clientId: clientInfo.client_id,
      scopes: ["workspace:read", "workspace:write"],
      allowedRootIds: [authorizationRootId(workspaceRoot, ownerToken)],
    });
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const resource = new URL("/mcp", publicBaseUrl).href;
    store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: {
        grantId: grant.grantId,
        clientId: clientInfo.client_id,
        principalId: grant.principalId,
        authorizationEpoch: grant.authorizationEpoch,
        scopes: [...grant.grantedScopes],
        expiresAt,
        resource,
      },
      refreshTokenHash: hashToken(`${accessToken}-refresh`),
      refreshToken: {
        grantId: grant.grantId,
        clientId: clientInfo.client_id,
        principalId: grant.principalId,
        authorizationEpoch: grant.authorizationEpoch,
        scopes: [...grant.grantedScopes],
        expiresAt,
        resource,
      },
    });
  } finally {
    store.close();
  }
}

function assertInstructionPage(
  result: Awaited<ReturnType<Client["callTool"]>>,
  reconstructed: Map<string, Buffer>,
): void {
  const pagination = (result.structuredContent as {
    pagination?: {
      returnedFiles?: unknown;
      returnedFragments?: unknown;
      returnedBytes?: unknown;
      totalBytes?: unknown;
    };
  } | undefined)?.pagination;
  assert.equal(typeof pagination?.returnedFiles, "number");
  assert.equal(typeof pagination?.returnedFragments, "number");
  assert.equal(typeof pagination?.returnedBytes, "number");
  assert.equal(typeof pagination?.totalBytes, "number");
  assert.ok(Number(pagination?.returnedBytes) > 0);
  assert.ok(Number(pagination?.returnedBytes) <= 8 * 1024);
  assert.ok(modelVisibleBytes(result) < 12_500, "one instruction page must remain context-bounded");

  const items = (result.structuredContent as {
    workspaceInstructions?: {
      items?: Array<{
        path?: unknown;
        content?: unknown;
        bytes?: unknown;
        fragment?: {
          offsetBytes?: unknown;
          lengthBytes?: unknown;
          totalBytes?: unknown;
          complete?: unknown;
          lineBoundary?: unknown;
        };
      }>;
    };
  } | undefined)?.workspaceInstructions?.items ?? [];
  assert.equal(items.length, pagination?.returnedFragments);
  for (const item of items) {
    assert.equal(typeof item.path, "string");
    assert.equal(typeof item.content, "string");
    const path = String(item.path);
    const content = Buffer.from(String(item.content), "utf8");
    const existing = reconstructed.get(path) ?? Buffer.alloc(0);
    assert.equal(item.fragment?.offsetBytes, existing.byteLength);
    assert.equal(item.fragment?.lengthBytes, content.byteLength);
    assert.equal(item.fragment?.totalBytes, item.bytes);
    assert.equal(typeof item.fragment?.complete, "boolean");
    assert.equal(typeof item.fragment?.lineBoundary, "boolean");
    reconstructed.set(path, Buffer.concat([existing, content]));
  }
}

function modelVisibleBytes(result: Awaited<ReturnType<Client["callTool"]>>): number {
  return Buffer.byteLength(JSON.stringify({
    content: result.content,
    structuredContent: result.structuredContent,
  }), "utf8");
}

function receipt(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const value = (result.structuredContent as {
    continuation?: { receipt?: unknown };
  } | undefined)?.continuation?.receipt;
  assert.equal(typeof value, "string");
  return String(value);
}

function nextCursor(result: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
  const value = (result.structuredContent as {
    pagination?: { nextCursor?: unknown };
  } | undefined)?.pagination?.nextCursor;
  return typeof value === "string" ? value : undefined;
}

function instructionToken(result: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
  const value = (result.structuredContent as { instructionToken?: unknown } | undefined)
    ?.instructionToken;
  return typeof value === "string" ? value : undefined;
}

function statePhase(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return (result.structuredContent as { state?: { phase?: unknown } } | undefined)?.state?.phase;
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function listen(server: HttpServer): Promise<URL> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolveListen(new URL(`http://127.0.0.1:${address.port}`));
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
