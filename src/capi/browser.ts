import { spawn } from "node:child_process";

const KEEP = {
  all: ["PATH"],
  win32: ["SYSTEMROOT", "COMSPEC"],
  linux: ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"],
};

// The opener may be a script on PATH, so it must not inherit ED_MCP_SYNC_PASSWORD or API keys.
export function browserEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const names = [
    ...KEEP.all,
    ...(platform === "win32" ? KEEP.win32 : []),
    ...(platform === "linux" ? KEEP.linux : []),
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const n of names) {
    // Windows names are case-insensitive: Path, PATH.
    const key = Object.keys(env).find((k) => k.toUpperCase() === n);
    if (key && env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

export async function openInBrowser(url: string): Promise<void> {
  // rundll32 avoids cmd.exe treating "&" in the URL as a command separator.
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args as string[], {
      detached: true,
      stdio: "ignore",
      env: browserEnv(),
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
