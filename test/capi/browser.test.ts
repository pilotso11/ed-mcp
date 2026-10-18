import { describe, expect, it } from "vitest";
import { browserEnv } from "../../src/capi/browser.js";

const env = {
  PATH: "/bin",
  HOME: "/home/j",
  ED_MCP_SYNC_PASSWORD: "hunter2hunter2",
  INARA_API_KEY: "i",
  EDSM_API_KEY: "e",
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_RUNTIME_DIR: "/run/user/1",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/x",
  SYSTEMROOT: "C:\\Windows",
  COMSPEC: "cmd.exe",
};

describe("browserEnv", () => {
  it("never passes secrets", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const out = browserEnv(env, platform);
      expect(Object.keys(out)).not.toContain("ED_MCP_SYNC_PASSWORD");
      expect(Object.keys(out)).not.toContain("INARA_API_KEY");
      expect(Object.keys(out)).not.toContain("EDSM_API_KEY");
      expect(Object.keys(out)).not.toContain("HOME");
    }
  });

  it("keeps only what the opener needs on each platform", () => {
    expect(browserEnv(env, "darwin")).toEqual({ PATH: "/bin" });
    expect(browserEnv(env, "linux")).toEqual({
      PATH: "/bin",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/x",
    });
    expect(browserEnv(env, "win32")).toEqual({
      PATH: "/bin",
      SYSTEMROOT: "C:\\Windows",
      COMSPEC: "cmd.exe",
    });
  });

  it("finds Path on Windows", () => {
    expect(browserEnv({ Path: "C:\\bin" }, "win32")).toEqual({ Path: "C:\\bin" });
  });
});
