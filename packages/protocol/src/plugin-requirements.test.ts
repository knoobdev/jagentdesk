import { describe, expect, it } from "vitest";
import { assertPluginCompatibility, validatePluginRequirements } from "./plugin-requirements.js";

describe.each(["daemon", "app"] as const)("plugin requirements on %s", (runtime) => {
  it.each(["0.7.2", "0.8.0-beta.1", "0.9.40", null])(
    "accepts a manifest without requirements on %s (pre-split plugins keep loading)",
    (version) => {
      expect(() => assertPluginCompatibility({ id: "legacy", version, runtime })).not.toThrow();
    },
  );

  it.each([
    [undefined, "0.7.2"],
    [">=0.8.0", "0.8.0"],
    [">=0.8.0", "0.8.0-beta.1"],
    [">=0.8.0", "1.0.0"],
    ["^0.8.0", "0.8.4"],
    [">=0.8.0-beta.1", "0.8.0-beta.2"],
    [">=0.8.0-beta.1", "0.8.0-beta.1"],
    [">=0.8.0-beta.1", "0.8.0"],
    ["^0.8.0 || ^0.9.0", "0.9.2+build.42"],
  ])("accepts %s on %s", (jagentdesk, version) => {
    expect(() =>
      assertPluginCompatibility({ id: "test", requirements: { jagentdesk }, version, runtime }),
    ).not.toThrow();
  });

  it.each([
    [">=0.8.0", "0.7.2"],
    ["^0.8.0", "0.9.0"],
    ["<0.8.0", "0.8.0-beta.1"],
  ])("rejects %s on %s", (jagentdesk, version) => {
    expect(() =>
      assertPluginCompatibility({ id: "test", requirements: { jagentdesk }, version, runtime }),
    ).toThrow(`Your ${runtime} is ${version}`);
  });

  it.each(["", "   ", "latest", ">=potato", "0.8.0 nonsense"])(
    "rejects malformed range %s",
    (jagentdesk) => {
      expect(() => validatePluginRequirements({ jagentdesk })).toThrow(
        "Invalid requirements.jagentdesk",
      );
    },
  );

  it.each([null, "unknown"])("fails closed when the runtime version is %s", (version) => {
    expect(() =>
      assertPluginCompatibility({
        id: "test",
        requirements: { jagentdesk: "*" },
        version,
        runtime,
      }),
    ).toThrow(`JAgentDesk ${runtime} version is unknown`);
  });
});
