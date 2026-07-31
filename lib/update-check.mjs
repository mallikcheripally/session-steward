const DEFAULT_TIMEOUT_MS = 1_200;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseStableVersion(value) {
  if (typeof value !== "string") return null;

  const match = STABLE_VERSION_PATTERN.exec(value);
  return match ? match.slice(1, 4).map(BigInt) : null;
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);

  if (!leftParts || !rightParts) return null;

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }

  return 0;
}

export async function findAvailableUpdate({
  fetchImpl = globalThis.fetch,
  packageMetadata,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const packageName = packageMetadata?.name;
  const currentVersion = packageMetadata?.version;

  if (
    typeof fetchImpl !== "function"
    || typeof packageName !== "string"
    || packageName.length === 0
    || !parseStableVersion(currentVersion)
  ) {
    return null;
  }

  const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout;
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, requestTimeoutMs);
  });
  const request = (async () => {
    try {
      const response = await fetchImpl(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
        {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );

      if (!response?.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  })();

  try {
    const result = await Promise.race([request, timedOut]);
    const latestVersion = result?.version;
    const comparison = compareStableVersions(latestVersion, currentVersion);

    if (comparison !== 1) return null;

    return { currentVersion, latestVersion, packageName };
  } finally {
    clearTimeout(timeout);
  }
}

export function formatUpdateNotice({ latestVersion, packageName }) {
  return `Session Steward ${latestVersion} is available. Update with: npm install -g ${packageName}@latest`;
}
