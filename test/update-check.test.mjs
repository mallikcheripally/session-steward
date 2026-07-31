import assert from "node:assert/strict";
import test from "node:test";

import {
  compareStableVersions,
  findAvailableUpdate,
  formatUpdateNotice,
} from "../lib/update-check.mjs";

const packageMetadata = {
  name: "session-steward",
  version: "1.4.2",
};

function registryResponse(value, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return value;
    },
  };
}

test("stable versions are compared without a package dependency", () => {
  assert.equal(compareStableVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareStableVersions("1.4.2+build.8", "1.4.2"), 0);
  assert.equal(compareStableVersions("1.4.1", "1.4.2"), -1);
  assert.equal(compareStableVersions("1.5.0-beta.1", "1.4.2"), null);
  assert.equal(compareStableVersions("01.5.0", "1.4.2"), null);
});

test("a newer stable npm release produces one update notice", async () => {
  let request;
  const update = await findAvailableUpdate({
    fetchImpl: async (url, options) => {
      request = { options, url };
      return registryResponse({ version: "1.5.0" });
    },
    packageMetadata,
  });

  assert.deepEqual(update, {
    currentVersion: "1.4.2",
    latestVersion: "1.5.0",
    packageName: "session-steward",
  });
  assert.equal(request.url, "https://registry.npmjs.org/session-steward/latest");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(
    formatUpdateNotice(update),
    "Session Steward 1.5.0 is available. Update with: npm install -g session-steward@latest",
  );
});

test("non-updates and unusable registry responses stay quiet", async (context) => {
  const cases = [
    { label: "same version", response: registryResponse({ version: "1.4.2" }) },
    { label: "older version", response: registryResponse({ version: "1.3.9" }) },
    { label: "prerelease", response: registryResponse({ version: "2.0.0-rc.1" }) },
    { label: "malformed version", response: registryResponse({ version: "newest" }) },
    { label: "unpublished package", response: registryResponse({}, { ok: false }) },
  ];

  for (const { label, response } of cases) {
    await context.test(label, async () => {
      const result = await findAvailableUpdate({
        fetchImpl: async () => response,
        packageMetadata,
      });
      assert.equal(result, null);
    });
  }

  await context.test("registry error", async () => {
    const result = await findAvailableUpdate({
      fetchImpl: async () => {
        throw new Error("offline");
      },
      packageMetadata,
    });
    assert.equal(result, null);
  });

  await context.test("invalid registry body", async () => {
    const result = await findAvailableUpdate({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          throw new SyntaxError("invalid JSON");
        },
      }),
      packageMetadata,
    });
    assert.equal(result, null);
  });
});

test("a slow registry does not block startup", async () => {
  const startedAt = Date.now();
  const result = await findAvailableUpdate({
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    packageMetadata,
    timeoutMs: 20,
  });

  assert.equal(result, null);
  assert.ok(Date.now() - startedAt < 500);
});
