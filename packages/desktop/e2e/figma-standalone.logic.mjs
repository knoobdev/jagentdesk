#!/usr/bin/env node
// W9 scaffold/logic tier for Figma standalone browsing + playback.
// Contract bounds for `figma.file.playback.request|response` (ADR-0037) and the
// isolated picker policy (ADR-0038). No app, no daemon, no network: these tests
// prove the shared draft contract and picker rules, NOT runtime E2E acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..", "..", "..");

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error?.message ?? String(error) });
    console.log(`  FAIL  ${name}\n        ${error?.message ?? String(error)}`);
  }
}

const { FigmaFilePlaybackRequestSchema, FigmaFilePlaybackResponseSchema, FigmaPrototypeSchema } =
  await import(path.join(rootDir, "packages/protocol/src/figma/rpc-schemas.ts"));
const { ServerInfoStatusPayloadSchema } = await import(
  path.join(rootDir, "packages/protocol/src/messages.ts")
);
const { FIGMA_PICKER_URL, FIGMA_PICKER_PARTITION, isFigmaPickerNavigation, selectedFigmaFileUrl } =
  await import(path.join(rootDir, "packages/desktop/src/integrations/figma-file-picker-policy.ts"));

const FILE_KEY = "w9ContractProbe";
const playbackRequest = (shape) => ({
  type: "figma.file.playback.request",
  requestId: "w9-l1",
  fileKey: FILE_KEY,
  ...shape,
});
const playbackResponse = (payload) => ({
  type: "figma.file.playback.response",
  payload: { requestId: "w9-l1", error: null, ...payload },
});
const node = (id) => ({ id, name: `Frame ${id}`, type: "FRAME" });

console.log("playback request/response bounds (ADR-0037, spec 32.9)");

test("accepts 1 frame id at the immutable version", () => {
  const parsed = FigmaFilePlaybackRequestSchema.parse(
    playbackRequest({ frameIds: ["1:2"], version: "123" }),
  );
  assert.deepEqual(parsed.frameIds, ["1:2"]);
  assert.equal(parsed.version, "123");
});

test("accepts 10 frame ids (upper bound)", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `1:${i}`);
  const parsed = FigmaFilePlaybackRequestSchema.parse(
    playbackRequest({ frameIds: ids, version: "123" }),
  );
  assert.equal(parsed.frameIds.length, 10);
});

test("rejects 0 frame ids", () => {
  assert.equal(
    FigmaFilePlaybackRequestSchema.safeParse(playbackRequest({ frameIds: [], version: "123" }))
      .success,
    false,
  );
});

test("rejects 11 frame ids (request is bounded to one visible batch)", () => {
  const ids = Array.from({ length: 11 }, (_, i) => `1:${i}`);
  assert.equal(
    FigmaFilePlaybackRequestSchema.safeParse(playbackRequest({ frameIds: ids, version: "123" }))
      .success,
    false,
  );
});

test("version is mandatory — playback reads the outline snapshot only", () => {
  assert.equal(
    FigmaFilePlaybackRequestSchema.safeParse({
      type: "figma.file.playback.request",
      requestId: "r",
      fileKey: FILE_KEY,
      frameIds: ["1:2"],
    }).success,
    false,
  );
});

test("fileKey is mandatory", () => {
  assert.equal(
    FigmaFilePlaybackRequestSchema.safeParse({
      type: "figma.file.playback.request",
      requestId: "r",
      frameIds: ["1:2"],
      version: "1",
    }).success,
    false,
  );
});

test("response carries frames + nullable prototype", () => {
  const parsed = FigmaFilePlaybackResponseSchema.parse(
    playbackResponse({ frames: { "1:2": node("1:2") }, prototype: null }),
  );
  assert.deepEqual(Object.keys(parsed.payload.frames), ["1:2"]);
  assert.equal(parsed.payload.prototype, null);
});

test("response accepts the full prototype shape (flows/interactions/overlays/overlaySettingsAvailable)", () => {
  const prototype = {
    flows: [{ nodeId: "1:2", name: "Flow", pageId: "0:1" }],
    interactions: [],
    overlays: [{ frameId: "1:2", position: "CENTER" }],
    overlaySettingsAvailable: false,
  };
  const parsed = FigmaFilePlaybackResponseSchema.parse(
    playbackResponse({ frames: { "1:2": node("1:2") }, prototype }),
  );
  assert.deepEqual(parsed.payload.prototype.flows, prototype.flows);
  assert.equal(parsed.payload.prototype.overlaySettingsAvailable, false);
});

test("prototype.overlaySettingsAvailable is required — missing metadata cannot hide", () => {
  assert.equal(
    FigmaPrototypeSchema.safeParse({ flows: [], interactions: [], overlays: [] }).success,
    false,
  );
});

test("response rejects frame entries without id/name/type", () => {
  assert.equal(
    FigmaFilePlaybackResponseSchema.safeParse(
      playbackResponse({ frames: { "1:2": { id: "1:2" } }, prototype: null }),
    ).success,
    false,
  );
});

test("response rejects a missing frames record", () => {
  assert.equal(
    FigmaFilePlaybackResponseSchema.safeParse(playbackResponse({ prototype: null })).success,
    false,
  );
});

console.log("server_info capability (figmaPlayback is optional boolean)");

const serverInfo = (features) => ({ status: "server_info", serverId: "w9-server", features });

test("server_info advertises features.figmaPlayback", () => {
  const parsed = ServerInfoStatusPayloadSchema.parse(
    serverInfo({ figma: true, figmaPlayback: true }),
  );
  assert.equal(parsed.features.figmaPlayback, true);
});

test("server_info omits figmaPlayback for older daemons", () => {
  const parsed = ServerInfoStatusPayloadSchema.parse(serverInfo({ figma: true }));
  assert.equal(parsed.features.figmaPlayback, undefined);
});

test("figmaPlayback must be a boolean, not a string", () => {
  assert.equal(
    ServerInfoStatusPayloadSchema.safeParse(serverInfo({ figmaPlayback: "yes" })).success,
    false,
  );
});

console.log("picker policy (ADR-0038 — isolated Files guest, navigation URL only)");

test("guest opens the real Figma Files site and a dedicated partition", () => {
  assert.equal(FIGMA_PICKER_URL, "https://www.figma.com/files");
  assert.equal(FIGMA_PICKER_PARTITION, "persist:jagentdesk-figma-picker");
});

test("only https navigations are allowed in the guest", () => {
  assert.equal(isFigmaPickerNavigation("https://www.figma.com/files"), true);
  assert.equal(isFigmaPickerNavigation("http://www.figma.com/files"), false);
  assert.equal(isFigmaPickerNavigation("file:///tmp/index.html"), false);
  assert.equal(isFigmaPickerNavigation("not a url"), false);
});

test("returns canonical design/file/proto URLs from figma.com hosts", () => {
  assert.equal(
    selectedFigmaFileUrl("https://www.figma.com/design/AbC123/Marketing-Site?node-id=1-2&t=xyz"),
    "https://www.figma.com/design/AbC123?node-id=1-2",
  );
  assert.equal(
    selectedFigmaFileUrl("https://figma.com/file/AbC123"),
    "https://www.figma.com/file/AbC123",
  );
  assert.equal(
    selectedFigmaFileUrl("https://www.figma.com/proto/AbC123"),
    "https://www.figma.com/proto/AbC123",
  );
});

test("keeps branch keys and drops session/tracking params", () => {
  assert.equal(
    selectedFigmaFileUrl("https://www.figma.com/design/AbC123:Def456/x?node-id=1-2&f=1&t=abc123"),
    "https://www.figma.com/design/AbC123:Def456?node-id=1-2",
  );
});

test("rejects non-https, non-Figma hosts, ports, and invalid paths", () => {
  assert.equal(selectedFigmaFileUrl("http://www.figma.com/design/AbC123/x"), null);
  assert.equal(selectedFigmaFileUrl("https://evil.example/design/AbC123/x"), null);
  assert.equal(selectedFigmaFileUrl("https://www.figma.com:3000/design/AbC123/x"), null);
  assert.equal(selectedFigmaFileUrl("https://www.figma.com/files"), null);
  assert.equal(selectedFigmaFileUrl("https://www.figma.com/design/"), null);
  assert.equal(selectedFigmaFileUrl("https://www.figma.com/design/not-a-key!/x"), null);
  assert.equal(selectedFigmaFileUrl("https://www.figma.com/settings"), null);
});

test("user/password credentials block acceptance", () => {
  assert.equal(selectedFigmaFileUrl("https://user:pw@www.figma.com/design/AbC123/x"), null);
});

console.log("desktop bridge + guest window wiring (source contract, W1 seed audit)");

const fileText = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");
const pickerSource = fileText("packages/desktop/src/integrations/figma-file-picker.ts");
const managerSource = fileText("packages/desktop/src/daemon/daemon-manager.ts");
const preloadSource = fileText("packages/desktop/src/preload.ts");

const expectSource = (name, haystack, needle, why) => {
  test(name, () => assert.ok(haystack.includes(needle), why));
};

expectSource(
  "guest window is sandboxed with context isolation",
  pickerSource,
  "sandbox: true",
  "ADR-0038: the Files guest runs sandboxed",
);
expectSource(
  "guest window has no Node integration",
  pickerSource,
  "nodeIntegration: false",
  "ADR-0038: no Node in the guest",
);
test("guest window has no preload", () => {
  assert.ok(!/preload\s*:/.test(pickerSource), "ADR-0038: the guest must not receive a preload");
});
expectSource(
  "guest window does not nest webviews",
  pickerSource,
  "webviewTag: false",
  "ADR-0038: guest cannot smuggle the heavy editor webview",
);
expectSource(
  "selection stops loading before the heavy editor",
  pickerSource,
  "contents.stop();",
  "ADR-0038: the guest is halted before the editor loads",
);
expectSource(
  "the guest window is destroyed after pick or cancel",
  pickerSource,
  "picker.destroy();",
  "ADR-0038: cancel/close destroys the window",
);
expectSource(
  "desktop RPC figma_pick_file is registered",
  managerSource,
  "figma_pick_file",
  "ADR-0038: the bridge command exists",
);
expectSource(
  "figma_pick_file takes no arbitrary URL/partition",
  managerSource,
  "figma_pick_file: () => pickFigmaFile()",
  "ADR-0038: no caller-supplied URL or partition",
);
expectSource(
  "preload exposes pickFile through the bridge",
  preloadSource,
  'pickFile: () => ipcRenderer.invoke("jagentdesk:invoke", "figma_pick_file")',
  "ADR-0038: renderer invokes the bridge without arguments",
);

const failures = results.filter((result) => !result.ok);
console.log(
  `\n${failures.length === 0 ? "LOGIC TIER PASSED" : "LOGIC TIER FAILED"}: ${results.length - failures.length}/${results.length} checks`,
);
console.log("(scaffold/logic only — not full E2E acceptance; see figma-standalone.e2e.mjs)");
if (failures.length > 0) {
  console.log("Failed checks:");
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error}`);
}
process.exit(failures.length === 0 ? 0 : 1);
