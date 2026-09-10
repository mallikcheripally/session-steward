import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";

const runCommand = promisify(execFile);
const PS_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u;

export function validProcessId(pid) {
  return Number.isSafeInteger(pid) && pid > 1 && pid <= 2_147_483_647;
}

export async function localClaudePidDomain(platform = process.platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return `win32:${hostname().toLowerCase()}`;
  if (platform !== "linux") return null;
  try {
    const [machine, namespace] = await Promise.all([
      fs.readFile("/etc/machine-id", "utf8"), fs.readlink("/proc/self/ns/pid"),
    ]);
    return `linux:${machine.trim()}:${namespace}`;
  } catch {
    return null;
  }
}

// These are Claude's process identity tokens, not the session's startedAt:
// UTC ps lstart on macOS/Linux, and Windows creation FILETIME in procStartFt.
export async function readClaudeProcessStart(pid, { platform = process.platform, run = runCommand } = {}) {
  if (!validProcessId(pid)) return null;
  const windows = platform === "win32";
  if (!windows && platform !== "darwin" && platform !== "linux") return null;
  try {
    const { stdout } = await run(windows ? "powershell.exe" : "ps", windows
      ? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`]
      : ["-o", "lstart=", "-p", String(pid)], {
      // PowerShell has a noticeably slower cold start than ps, especially under load.
      encoding: "utf8", timeout: windows ? 10_000 : 1_000, maxBuffer: 4_096, windowsHide: true,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return stdout.trim().replace(/\s+/gu, " ") || null;
  } catch {
    return null;
  }
}

export async function claudeProcessState(marker, {
  platform = process.platform,
  pidDomain,
  kill = process.kill,
  readStart = (pid) => readClaudeProcessStart(pid, { platform }),
} = {}) {
  if (!validProcessId(marker.pid)) return "unverified";
  // A PID from another machine/namespace cannot be checked against this one.
  if (marker.pidDomain !== undefined && marker.pidDomain !== pidDomain) return "unverified";
  const running = () => {
    try { kill(marker.pid, 0); return "active"; }
    catch (error) { return error.code === "ESRCH" ? "inactive" : "unverified"; }
  };
  const state = running();
  if (state !== "active") return state;
  const expected = platform === "win32" ? marker.procStartFt : marker.procStart;
  // Legacy records have no start token: a live PID must remain protected.
  if (expected === undefined) return "active";
  if (typeof expected !== "string") return "unverified";
  const normalized = expected.trim().replace(/\s+/gu, " ");
  const validToken = (value) => typeof value === "string" && (platform === "win32"
    ? /^[1-9]\d{0,19}$/u.test(value) : PS_START.test(value) && Number.isFinite(Date.parse(`${value} UTC`)));
  if (!validToken(normalized)) return "unverified";
  const actual = await readStart(marker.pid);
  if (!validToken(actual)) return running() === "inactive" ? "inactive" : "unverified";
  return normalized === actual ? "active" : "inactive";
}
