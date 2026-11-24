const { test } = require("node:test");
const assert = require("node:assert/strict");
const { configureHardwareKeyboardAppDelegate } = require("./app.plugin.js");
const template = `internal import Expo
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?
  // Other plugins and the app's linking methods stay here.
}
`;

test("selects the keyboard scene without replacing Expo's scene lifecycle", () => {
  const result = configureHardwareKeyboardAppDelegate(template);
  assert.match(result, /configurationForConnecting connectingSceneSession: UISceneSession/);
  assert.match(result, /configuration.delegateClass = JAgentDeskSceneDelegate.self/);
  assert.match(result, /class JAgentDeskSceneDelegate: ExpoAppSceneDelegate/);
  assert.match(result, /super.scene\(scene, willConnectTo: session, options: connectionOptions\)/);
  assert.match(result, /JAgentDeskHardwareKeyboardWindow.observing\(window\)/);
  assert.match(result, /ExpoReactNativeFactoryProvider\)\?\.window = observedWindow/);
  assert.match(result, /Other plugins and the app's linking methods stay here/);
});

test("does not duplicate the scene or window observer on repeated prebuilds", () => {
  const result = configureHardwareKeyboardAppDelegate(template);
  assert.equal(configureHardwareKeyboardAppDelegate(result), result);
});

test("requires Expo's scene factory rather than emitting an unusable scene", () => {
  assert.throws(
    () => configureHardwareKeyboardAppDelegate("class AppDelegate: ExpoAppDelegate {}"),
    /requires the app's Expo scene delegate/,
  );
});
