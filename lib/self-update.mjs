import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import packageMetadata from "../package.json" with { type: "json" };
import { getCommandInvocation } from "./platform.mjs";

const PACKAGE_SPEC = `${packageMetadata.name}@latest`;
const INSTALL_ARGS = ["install", "--global", PACKAGE_SPEC];
const VERSION_ARGS = ["list", "--global", "--depth=0", "--json", packageMetadata.name];

async function runCommand(command, args, { captureStdout = false, platform, stderr, stdout }) {
  const invocation = getCommandInvocation(command, args, { platform });

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: invocation.windowsHide,
    });
    let errorOutput = "";
    let output = "";

    child.stdout.on("data", (chunk) => {
      if (captureStdout) output = (output + chunk.toString()).slice(-16_384);
      else stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
      errorOutput = (errorOutput + chunk.toString()).slice(-8_192);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, errorOutput, output }));
  });
}

async function confirmSudo({ stdin, stdout }) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question("Retry the update with sudo? [y/N] ");
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function updateSessionSteward({
  confirm = confirmSudo,
  currentVersion = packageMetadata.version,
  platform = process.platform,
  run = runCommand,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  stdout.write(`Current version: ${currentVersion}\nUpdating Session Steward with npm...\n`);
  let result = await run("npm", INSTALL_ARGS, { platform, stderr, stdout });
  let usedSudo = false;

  if (result.exitCode !== 0 && /\b(?:EACCES|EPERM)\b/u.test(result.errorOutput)) {
    if (platform === "win32") {
      stderr.write("Global npm install needs permission. Open an elevated terminal and run session-steward update.\n");
    } else if (stdin.isTTY && stdout.isTTY) {
      stdout.write("The global npm install needs elevated permission.\n");
      if (await confirm({ stdin, stdout })) {
        usedSudo = true;
        result = await run("sudo", ["npm", ...INSTALL_ARGS], { platform, stderr, stdout });
      }
    } else {
      stderr.write("Global npm install needs elevated permission. Run sudo session-steward update in a terminal.\n");
    }
  }

  if (result.exitCode === 0) {
    let installedVersion;
    try {
      const versionResult = await run(
        usedSudo ? "sudo" : "npm",
        usedSudo ? ["npm", ...VERSION_ARGS] : VERSION_ARGS,
        { captureStdout: true, platform, stderr, stdout },
      );
      if (versionResult.exitCode === 0) {
        installedVersion = JSON.parse(versionResult.output)?.dependencies?.[packageMetadata.name]?.version;
      }
    } catch {
      // Installation succeeded, but npm could not confirm the installed version.
    }

    if (typeof installedVersion === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(installedVersion)) {
      stdout.write(`Updated version: ${installedVersion}\n`);
    } else {
      stderr.write("Update completed, but the installed version could not be confirmed. Run session-steward --version.\n");
    }
  }

  return result.exitCode;
}
