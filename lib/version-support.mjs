export const VERSION_SUPPORT_STATUS = Object.freeze({
  EXACT_SUPPORTED: "exact-supported",
  NEWER: "newer",
  OLDER: "older",
  UNAVAILABLE: "unavailable",
  UNRECOGNIZED: "unrecognized",
});

const DOTTED_VERSION_PATTERN = /(?<![\d.])(\d+(?:\.\d+){2,})(?![\d.+-])/gu;

function extractVersion(value) {
  if (typeof value !== "string") return null;

  const matches = [...value.matchAll(DOTTED_VERSION_PATTERN)];
  if (matches.length !== 1) return null;

  return {
    parts: matches[0][1].split(".").map(BigInt),
    value: matches[0][1],
  };
}

function compareParts(left, right) {
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0n;
    const rightPart = right[index] ?? 0n;

    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
}

function parseSupportedVersions(values) {
  if (!Array.isArray(values) || values.length === 0) return null;

  const parsed = values.map(extractVersion);
  if (parsed.some((version) => version === null)) return null;

  return parsed.sort((left, right) => compareParts(left.parts, right.parts));
}

function result(status, {
  installedVersion = null,
  latestSupportedVersion = null,
  matchedSupportedVersion = null,
} = {}) {
  return {
    installedVersion,
    latestSupportedVersion,
    matchedSupportedVersion,
    status,
  };
}

export function classifyInstalledVersion({ installedVersion, supportedVersions } = {}) {
  const parsedSupportedVersions = parseSupportedVersions(supportedVersions);
  const latestSupportedVersion = parsedSupportedVersions?.at(-1)?.value ?? null;

  if (
    installedVersion === null
    || installedVersion === undefined
    || (typeof installedVersion === "string" && installedVersion.trim() === "")
  ) {
    return result(VERSION_SUPPORT_STATUS.UNAVAILABLE, { latestSupportedVersion });
  }

  const installed = extractVersion(installedVersion);
  if (!installed || !parsedSupportedVersions) {
    return result(VERSION_SUPPORT_STATUS.UNRECOGNIZED, {
      installedVersion: installed?.value ?? null,
      latestSupportedVersion,
    });
  }

  const matched = parsedSupportedVersions.find(
    (supported) => compareParts(installed.parts, supported.parts) === 0,
  );

  if (matched) {
    return result(VERSION_SUPPORT_STATUS.EXACT_SUPPORTED, {
      installedVersion: installed.value,
      latestSupportedVersion,
      matchedSupportedVersion: matched.value,
    });
  }

  const comparison = compareParts(
    installed.parts,
    parsedSupportedVersions.at(-1).parts,
  );

  return result(
    comparison < 0 ? VERSION_SUPPORT_STATUS.OLDER : VERSION_SUPPORT_STATUS.NEWER,
    {
      installedVersion: installed.value,
      latestSupportedVersion,
    },
  );
}
