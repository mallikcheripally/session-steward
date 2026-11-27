import { spawn } from "node:child_process";

export function desktopLaunchInvocation(url, { platform = process.platform } = {}) {
  if (!/^(?:codex:\/\/new\?|claude:\/\/code\/new\?)/u.test(url)) throw new Error("Invalid desktop handoff link.");
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  // No command shell: encoded prompts must not undergo cmd.exe expansion.
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url], windowsHide: true };
  throw new Error("Desktop handoff links are not supported on this operating system.");
}

export async function openDesktopHandoff(handoff, { platform, spawnProcess = spawn } = {}) {
  const invocation = desktopLaunchInvocation(handoff.launchUrl, { platform });
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, { stdio: "ignore", windowsHide: invocation.windowsHide });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The desktop opener did not finish. Use the handoff link or copy its prompt."));
    }, 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("The desktop app could not be opened. Install it or copy the handoff prompt into its local coding chat."));
    });
  });
}
