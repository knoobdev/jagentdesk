import { describe, expect, it } from "vitest";
import { resolveCliInstallSourcePath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/JAgentDesk.app/Contents/MacOS/JAgentDesk",
        shimPath: "/Applications/JAgentDesk.app/Contents/Resources/bin/jagentdesk",
      }),
    ).toBe("/Applications/JAgentDesk.app/Contents/Resources/bin/jagentdesk");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_jagentdesk123/jagentdesk",
        shimPath: "/tmp/.mount_jagentdesk123/resources/bin/jagentdesk",
        appImagePath: "/home/user/Applications/JAgentDesk.AppImage",
      }),
    ).toBe("/home/user/Applications/JAgentDesk.AppImage");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\JAgentDesk\\JAgentDesk.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\JAgentDesk\\resources\\bin\\jagentdesk.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\JAgentDesk\\resources\\bin\\jagentdesk.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/JAgentDesk/jagentdesk",
        shimPath: "/opt/JAgentDesk/resources/bin/jagentdesk",
      }),
    ).toBe("/opt/JAgentDesk/resources/bin/jagentdesk");
  });
});
