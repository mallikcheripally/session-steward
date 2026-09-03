import { spawn } from "node:child_process";

const READY_TIMEOUT_MS = 5_000;
const UNIX_HOLDER_SCRIPT = "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.once('end', () => process.exit(0));";
const WINDOWS_HOLDER_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$stream = [System.IO.File]::Open(
  $args[0],
  [System.IO.FileMode]::OpenOrCreate,
  [System.IO.FileAccess]::ReadWrite,
  ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
)
$stream.Lock(0, [long]::MaxValue)
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()
[Console]::In.ReadLine()
$stream.Unlock(0, [long]::MaxValue)
$stream.Dispose()
`;

function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out while starting the file-lock test process."));
    }, READY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      if (!String(chunk).includes("ready")) return;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`The file-lock test process exited before acquiring the lock (${code}).`));
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function holdFileLock(filePath) {
  let command;
  let args;

  if (process.platform === "win32") {
    command = "powershell.exe";
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_HOLDER_SCRIPT, filePath];
  } else if (process.platform === "darwin") {
    command = "/usr/bin/lockf";
    args = ["-ks", filePath, process.execPath, "-e", UNIX_HOLDER_SCRIPT];
  } else {
    command = "flock";
    args = ["-x", "-F", filePath, process.execPath, "-e", UNIX_HOLDER_SCRIPT];
  }

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });

  try {
    await waitUntilReady(child);
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    release: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", resolve);
      child.stdin.end();
    }),
  };
}
