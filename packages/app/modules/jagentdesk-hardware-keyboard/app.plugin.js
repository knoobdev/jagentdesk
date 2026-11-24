const { withAppDelegate } = require("expo/config-plugins");

const SCENE_DELEGATE = `
class JAgentDeskSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    if let window {
      let observedWindow = JAgentDeskHardwareKeyboardWindow.observing(window)
      self.window = observedWindow
      (UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider)?.window = observedWindow
    }
  }
}
`;
const SCENE_CONFIGURATION = `
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = JAgentDeskSceneDelegate.self
    return configuration
  }
`;

function configureHardwareKeyboardAppDelegate(source) {
  source = source.replace(
    /^import JAgentDeskHardwareKeyboard$/m,
    "internal import JAgentDeskHardwareKeyboard",
  );
  if (source.includes("JAgentDeskHardwareKeyboardWindow.observing(window)")) return source;
  const appDelegate = /^class AppDelegate: [^{]+\{/m;
  if (!appDelegate.test(source) || !source.includes("ExpoReactNativeFactoryProvider")) {
    throw new Error("Hardware keyboard observation requires the app's Expo scene delegate");
  }
  // SDK 57 keeps the default scene delegate inside Expo. Choose our subclass through the
  // application delegate so Expo still owns its scene manifest, including repeated prebuilds.
  return (
    "internal import JAgentDeskHardwareKeyboard\n" +
    source.replace(appDelegate, (declaration) => declaration + SCENE_CONFIGURATION) +
    SCENE_DELEGATE
  );
}
module.exports = function withHardwareKeyboardWindow(config) {
  return withAppDelegate(config, (modConfig) => {
    modConfig.modResults.contents = configureHardwareKeyboardAppDelegate(
      modConfig.modResults.contents,
    );
    return modConfig;
  });
};
module.exports.configureHardwareKeyboardAppDelegate = configureHardwareKeyboardAppDelegate;
