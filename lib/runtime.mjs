export const MINIMUM_NODE_VERSION = "24.15.0";

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);

  if (!match) {
    return null;
  }

  return match.slice(1).map(Number);
}

export function assertSupportedNode(version = process.versions.node) {
  const current = parseVersion(version);
  const minimum = parseVersion(MINIMUM_NODE_VERSION);

  if (!current || !minimum) {
    throw new Error(`Session Steward could not read the Node.js version. Node.js ${MINIMUM_NODE_VERSION} or newer is required.`);
  }

  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return;
    if (current[index] < minimum[index]) {
      throw new Error(`Session Steward requires Node.js ${MINIMUM_NODE_VERSION} or newer. You have ${version}.`);
    }
  }
}
