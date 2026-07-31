import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProvider } from "./providers/index.mjs";
import { createProviderSettings } from "./settings.mjs";
import { classifyInstalledVersion } from "./version-support.mjs";

const {
  assertDeepCleanupSupported,
  formatSessionForJson,
  executeSessionDeletion,
  diagnoseStorageCompatibility,
  getSessionRecord,
  listSessions,
  loadSessionStore,
  planSessionDeletion,
  preflightSessionDeletion,
  verifySessionDeletion,
} = getProvider("codex");

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_SCOPES = new Set(["core", "deep"]);
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const staticAssets = new Map([
  ["/", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
]);

function readCommandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

async function getInstalledProductVersions() {
  const versions = { chatgptDesktop: null, codexCli: readCommandVersion("codex", ["--version"]) };

  if (process.platform !== "darwin") {
    return versions;
  }

  const chatGptInfoPath = "/Applications/ChatGPT.app/Contents/Info.plist";
  try {
    await fs.access(chatGptInfoPath);
    versions.chatgptDesktop = readCommandVersion("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", chatGptInfoPath]);
  } catch {
  }

  return versions;
}

function getStaticAsset(requestPath) {
  const knownAsset = staticAssets.get(requestPath);

  if (knownAsset) {
    return knownAsset;
  }

  if (!requestPath.startsWith("/assets/") || requestPath.includes("..")) {
    return null;
  }

  const fileName = requestPath.slice(1);
  const extension = path.extname(fileName);
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  const contentType = contentTypes[extension];

  return contentType ? { fileName, contentType } : null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function sendStaticAsset(response, asset) {
  const content = await fs.readFile(path.join(publicDirectory, asset.fileName));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": asset.contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function normalizeIds(value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === "string")) {
    throw new Error("ids must be a non-empty array of session IDs.");
  }

  return [...new Set(value)];
}

function getScope(value) {
  if (!ALLOWED_SCOPES.has(value)) {
    throw new Error("scope must be either core or deep.");
  }

  return value;
}

function getPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, maximum);
}

function getLocalRequestOrigin({ hostHeader, server }) {
  if (typeof hostHeader !== "string") {
    return null;
  }

  const address = server.address();

  if (!address || typeof address === "string") {
    return null;
  }

  let expectedHost = null;

  if (address.address === "127.0.0.1") {
    expectedHost = `127.0.0.1:${address.port}`;
  } else if (address.address === "::1") {
    expectedHost = `[::1]:${address.port}`;
  }

  return hostHeader === expectedHost ? `http://${expectedHost}` : null;
}

function requireMutationAuthorization({ request, requestUrl, token }) {
  if (request.headers.origin !== requestUrl.origin) {
    throw new Error("Destructive requests must originate from this local server.");
  }

  if (request.headers["x-session-steward-token"] !== token) {
    throw new Error("Destructive request authorization failed.");
  }
}

function summarizePlan(plan, preflight) {
  return {
    availableDiskBytes: preflight.availableDiskBytes,
    childCount: plan.childCount,
    desktopStateMatchCount: preflight.desktopStateMatchCount,
    desktopStateSupport: preflight.desktopStateSupport,
    estimatedBackupBytes: preflight.estimatedBackupBytes,
    goalRowCount: plan.goalRowCount,
    historyMatchCount: plan.historyMatchCount,
    ids: plan.ids,
    logRowCount: plan.logRowCount,
    memoryRowCount: plan.memoryRowCount,
    missingTranscriptPaths: plan.missingTranscriptPaths,
    records: plan.records.map(formatSessionForJson),
    sessionIndexMatchCount: plan.sessionIndexMatchCount,
    spawnEdgeCount: plan.spawnEdgeCount,
    transcriptCount: plan.transcriptPaths.length,
  };
}

export async function startLocalServer({ codexHome, configDirectory, port = 0 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer between 0 and 65535.");
  }

  const settings = await createProviderSettings({
    configDirectory,
    providerHomeOverrides: codexHome === undefined ? {} : { codex: codexHome },
  });
  const mutationToken = randomBytes(32).toString("base64url");
  let mutationInProgress = false;
  const server = createServer(async (request, response) => {
    const localOrigin = getLocalRequestOrigin({
      hostHeader: request.headers.host,
      server,
    });

    if (!localOrigin) {
      sendJson(response, 403, { error: "This request is not allowed." });
      return;
    }

    let requestUrl;

    try {
      requestUrl = new URL(request.url || "/", localOrigin);
    } catch {
      sendJson(response, 403, { error: "This request is not allowed." });
      return;
    }

    if (requestUrl.origin !== localOrigin) {
      sendJson(response, 403, { error: "This request is not allowed." });
      return;
    }

    try {
      const staticAsset = request.method === "GET" ? getStaticAsset(requestUrl.pathname) : null;

      if (staticAsset) {
        await sendStaticAsset(response, staticAsset);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/config") {
        sendJson(response, 200, { mutationToken, providers: settings.getAll() });
        return;
      }

      const providerSettingsPrefix = "/api/settings/providers/";

      if (
        (request.method === "PUT" || request.method === "DELETE")
        && requestUrl.pathname.startsWith(providerSettingsPrefix)
      ) {
        const providerId = decodeURIComponent(requestUrl.pathname.slice(providerSettingsPrefix.length));
        requireMutationAuthorization({ request, requestUrl, token: mutationToken });

        if (mutationInProgress) {
          sendJson(response, 409, { error: "Wait for the current change to finish before changing folders." });
          return;
        }

        mutationInProgress = true;

        try {
          const provider = request.method === "DELETE"
            ? await settings.resetProviderHome(providerId)
            : await settings.setProviderHome(providerId, (await readJsonBody(request)).home);
          sendJson(response, 200, { provider });
        } finally {
          mutationInProgress = false;
        }

        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/compatibility") {
        const diagnostic = await diagnoseStorageCompatibility({ codexHome: settings.getHome("codex") });
        const currentVersions = await getInstalledProductVersions();
        const versionSupport = Object.fromEntries(
          Object.entries(diagnostic.builtFor).map(([product, supportedVersions]) => [
            product,
            classifyInstalledVersion({
              installedVersion: currentVersions[product],
              supportedVersions,
            }),
          ]),
        );
        sendJson(response, 200, { ...diagnostic, currentVersions, versionSupport });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
        const result = await listSessions({
          codexHome: settings.getHome("codex"),
          includeInternals: requestUrl.searchParams.get("includeInternals") === "true",
          includeSupporting: requestUrl.searchParams.get("includeSupporting") === "true",
          page: getPositiveInteger(requestUrl.searchParams.get("page"), 1),
          pageSize: getPositiveInteger(requestUrl.searchParams.get("pageSize"), 25, 100),
          search: requestUrl.searchParams.get("search"),
          sort: requestUrl.searchParams.get("sort"),
        });
        sendJson(response, 200, {
          ...result,
          records: result.records.map(formatSessionForJson),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(requestUrl.pathname.slice("/api/sessions/".length));
        const record = await getSessionRecord({ codexHome: settings.getHome("codex"), id });

        if (!record) {
          sendJson(response, 404, { error: "Session not found." });
          return;
        }

        sendJson(response, 200, { record: formatSessionForJson(record) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/deletion-plans") {
        const body = await readJsonBody(request);
        const ids = normalizeIds(body.ids);
        const scope = getScope(body.scope);
        const activeCodexHome = settings.getHome("codex");

        if (scope === "deep") {
          await assertDeepCleanupSupported({ codexHome: activeCodexHome });
        }

        const store = await loadSessionStore({ codexHome: activeCodexHome });
        const plan = await planSessionDeletion({ recordIds: ids, store });
        const preflight = await preflightSessionDeletion({ plan, store });
        sendJson(response, 200, {
          plan: summarizePlan(plan, preflight),
          scope,
          warnings: preflight.activeThreadDetection === "unavailable"
            ? ["The current Codex runtime cannot identify an active session. Confirm it is safe to delete the selected sessions."]
            : [],
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/deletions") {
        requireMutationAuthorization({ request, requestUrl, token: mutationToken });

        if (mutationInProgress) {
          sendJson(response, 409, { error: "Another deletion is already in progress." });
          return;
        }

        mutationInProgress = true;

        try {
          const body = await readJsonBody(request);
          const ids = normalizeIds(body.ids);
          const scope = getScope(body.scope);
          const activeCodexHome = settings.getHome("codex");

          if (scope === "deep") {
            await assertDeepCleanupSupported({ codexHome: activeCodexHome });
          }

          const store = await loadSessionStore({ codexHome: activeCodexHome });
          const plan = await planSessionDeletion({ recordIds: ids, store });
          const result = await executeSessionDeletion({ plan, scope, store });
          const verification = await verifySessionDeletion({ plan, scope, store });
          sendJson(response, 200, { result, verification });
        } finally {
          mutationInProgress = false;
        }

        return;
      }

      sendJson(response, 404, { error: "Route not found." });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Request failed.",
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Local server did not expose a TCP port.");
  }

  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    port: address.port,
    token: mutationToken,
  };
}
