import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyInstalledVersion,
  VERSION_SUPPORT_STATUS,
} from "../lib/version-support.mjs";

test("recognizes an exact supported ChatGPT version", () => {
  assert.deepEqual(
    classifyInstalledVersion({
      installedVersion: "26.727.40816",
      supportedVersions: ["26.710.30211", "26.727.40816"],
    }),
    {
      installedVersion: "26.727.40816",
      latestSupportedVersion: "26.727.40816",
      matchedSupportedVersion: "26.727.40816",
      status: VERSION_SUPPORT_STATUS.EXACT_SUPPORTED,
    },
  );
});

test("extracts a supported semantic version from Codex CLI output", () => {
  assert.deepEqual(
    classifyInstalledVersion({
      installedVersion: "codex-cli 0.144.1",
      supportedVersions: ["0.143.0", "0.144.1"],
    }),
    {
      installedVersion: "0.144.1",
      latestSupportedVersion: "0.144.1",
      matchedSupportedVersion: "0.144.1",
      status: VERSION_SUPPORT_STATUS.EXACT_SUPPORTED,
    },
  );
});

test("classifies versions relative to the latest supported version", async (context) => {
  const supportedVersions = ["0.144.1", "0.142.0"];

  await context.test("older than every supported version", () => {
    assert.equal(
      classifyInstalledVersion({
        installedVersion: "codex-cli 0.141.9",
        supportedVersions,
      }).status,
      VERSION_SUPPORT_STATUS.OLDER,
    );
  });

  await context.test("between explicitly supported versions", () => {
    assert.equal(
      classifyInstalledVersion({
        installedVersion: "codex-cli 0.143.4",
        supportedVersions,
      }).status,
      VERSION_SUPPORT_STATUS.OLDER,
    );
  });

  await context.test("newer than the latest supported version", () => {
    assert.deepEqual(
      classifyInstalledVersion({
        installedVersion: "codex-cli 0.145.0",
        supportedVersions,
      }),
      {
        installedVersion: "0.145.0",
        latestSupportedVersion: "0.144.1",
        matchedSupportedVersion: null,
        status: VERSION_SUPPORT_STATUS.NEWER,
      },
    );
  });
});

test("compares numeric components instead of version text", () => {
  assert.equal(
    classifyInstalledVersion({
      installedVersion: "ChatGPT 26.1000.2",
      supportedVersions: ["26.999.99"],
    }).status,
    VERSION_SUPPORT_STATUS.NEWER,
  );
  assert.equal(
    classifyInstalledVersion({
      installedVersion: "1.2.3.0",
      supportedVersions: ["1.2.3"],
    }).status,
    VERSION_SUPPORT_STATUS.EXACT_SUPPORTED,
  );
});

test("reports unavailable installed versions", () => {
  for (const installedVersion of [null, undefined, "", "   "]) {
    assert.deepEqual(
      classifyInstalledVersion({
        installedVersion,
        supportedVersions: ["0.144.1"],
      }),
      {
        installedVersion: null,
        latestSupportedVersion: "0.144.1",
        matchedSupportedVersion: null,
        status: VERSION_SUPPORT_STATUS.UNAVAILABLE,
      },
    );
  }
});

test("reports output that cannot identify one stable numeric version", () => {
  for (const installedVersion of [
    "codex-cli unknown",
    "codex-cli 0.145.0-beta.1",
    "built 2026.7.31, codex-cli 0.144.1",
    1441,
  ]) {
    assert.equal(
      classifyInstalledVersion({
        installedVersion,
        supportedVersions: ["0.144.1"],
      }).status,
      VERSION_SUPPORT_STATUS.UNRECOGNIZED,
    );
  }
});

test("reports an invalid or missing support list as unrecognized", () => {
  for (const supportedVersions of [
    undefined,
    [],
    ["latest"],
    ["0.143.0", "0.144.1-beta.1"],
  ]) {
    assert.deepEqual(
      classifyInstalledVersion({
        installedVersion: "codex-cli 0.144.1",
        supportedVersions,
      }),
      {
        installedVersion: "0.144.1",
        latestSupportedVersion: null,
        matchedSupportedVersion: null,
        status: VERSION_SUPPORT_STATUS.UNRECOGNIZED,
      },
    );
  }
});

test("classification does not return a cleanup-safety decision", () => {
  const classification = classifyInstalledVersion({
    installedVersion: "codex-cli 0.144.1",
    supportedVersions: ["0.144.1"],
  });

  assert.equal("canDelete" in classification, false);
  assert.equal("safe" in classification, false);
});
