import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(filename) {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, filename), "utf8"));
}

test("MCP Registry metadata stays aligned with the npm package", async () => {
  const [packageMetadata, serverMetadata] = await Promise.all([
    readJson("package.json"),
    readJson("server.json"),
  ]);
  const npmPackage = serverMetadata.packages.find(({ registryType }) => registryType === "npm");

  assert.equal(serverMetadata.name, packageMetadata.mcpName);
  assert.equal(serverMetadata.version, packageMetadata.version);
  assert.ok(serverMetadata.description.length <= 100);
  assert.equal(packageMetadata.bin[packageMetadata.name], "bin/session-steward.mjs");
  assert.ok(npmPackage);
  assert.equal(npmPackage.identifier, packageMetadata.name);
  assert.equal(npmPackage.version, packageMetadata.version);
  assert.deepEqual(npmPackage.transport, { type: "stdio" });
  assert.deepEqual(npmPackage.packageArguments, [{ type: "positional", value: "mcp" }]);
});
