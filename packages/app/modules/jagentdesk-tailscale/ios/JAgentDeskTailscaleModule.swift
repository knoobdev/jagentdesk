import ExpoModulesCore
import Foundation
import UIKit
import TailscaleBridgeNative

public final class JAgentDeskTailscaleModule: Module {
  private var bridge = TailscalebridgeBridge()
  private let interactiveLoginLock = NSLock()
  private let interactiveLoginQueue = DispatchQueue(
    label: "sh.jagentdesk.tailscale.interactive-login",
    qos: .userInitiated
  )
  private let interactiveNodeLock = NSLock()
  private var interactiveLoginInFlight = false
  private var interactiveNodeStartInFlight = false
  private var interactiveNodeReady = false

  public func definition() -> ModuleDefinition {
    Name("JAgentDeskTailscale")

    AsyncFunction("getStatus") {
      self.interactiveLoginLock.lock()
      let interactiveLoginInFlight = self.interactiveLoginInFlight
      self.interactiveLoginLock.unlock()
      self.interactiveNodeLock.lock()
      let nodeStarting = self.interactiveNodeStartInFlight
      let nodeReady = self.interactiveNodeReady
      self.interactiveNodeLock.unlock()

      if nodeStarting {
        return "connecting"
      }

      if !nodeReady {
        do {
          let stateDir = try self.stateDirectory()
          // A status read must not create an unauthenticated tsnet node. The
          // login screen calls this method before the user has chosen a login
          // method; starting here races an auth-key join and leaves the UI on
          // the login screen while the native start is still blocked.
          // Restore only a state that this module previously observed as
          // authenticated. Explicit login buttons call prepareInteractiveLogin
          // or loginWithAuthKey and are the only paths that create a new node.
          if self.hasPersistedAuthenticatedState(stateDir: stateDir) {
            self.startInteractiveNodeIfNeeded(stateDir: stateDir)
            return "connecting"
          }
          return "needs-login"
        } catch {
          return "needs-login"
        }
      }

      // Do not let the background status poll resurrect an old auth-key
      // session while the user is completing the browser login flow. The
      // embedded tsnet node must remain the same node that produced the URL.
      if interactiveLoginInFlight {
        if !self.bridge.tailnetName().isEmpty {
          self.interactiveLoginLock.lock()
          self.interactiveLoginInFlight = false
          self.interactiveLoginLock.unlock()
          return "connected"
        }
        return "needs-login"
      }

      // A status probe must be cheap and side-effect free. Calling
      // bridge.start(authKey) here would call tsnet.Up with a 60-second
      // control-plane deadline and block the startup gate. Auth-key login is
      // an explicit user action; it must never be resumed from a background
      // status poll.
      if !self.bridge.tailnetName().isEmpty {
        self.markAuthenticated(stateDir: try? self.stateDirectory())
        return "connected"
      }
      self.removeAuthenticatedMarker(stateDir: try? self.stateDirectory())
      return "needs-login"
    }

    Function("beginInteractiveLogin") { () -> [String: Any] in
      self.beginInteractiveLogin()
    }

    Function("prepareInteractiveLogin") { () -> [String: Any] in
      self.prepareInteractiveLogin()
    }

    Function("getAuthURL") { () -> String? in
      let authURL = self.bridge.authURL().trimmingCharacters(in: .whitespacesAndNewlines)
      return authURL.isEmpty ? nil : authURL
    }

    AsyncFunction("startInteractiveLogin") { () -> [String: Any] in
      self.beginInteractiveLogin()
    }

    AsyncFunction("loginWithAuthKey") { (authKey: String) -> [String: Any] in
      let stateDir = try self.stateDirectory()
      let normalizedAuthKey = authKey.trimmingCharacters(in: .whitespacesAndNewlines)
      NSLog("[JAgentDeskTailscale] auth key received bytes=%ld", normalizedAuthKey.lengthOfBytes(using: .utf8))
      self.resetUnauthenticatedInteractiveNodeIfNeeded(stateDir: stateDir)
      do {
        try self.bridge.start(normalizedAuthKey, stateDir: stateDir, hostname: "jagentdesk-mobile", target: "")
      } catch {
        NSLog("[JAgentDeskTailscale] auth key join failed: %@", error.localizedDescription)
        return ["ok": false, "error": error.localizedDescription]
      }
      self.interactiveNodeLock.lock()
      self.interactiveNodeStartInFlight = false
      self.interactiveNodeReady = true
      self.interactiveNodeLock.unlock()
      self.interactiveLoginLock.lock()
      self.interactiveLoginInFlight = false
      self.interactiveLoginLock.unlock()
      self.markAuthenticated(stateDir: stateDir)
      return ["ok": true]
    }

    Function("getProxyAddress") { (target: String) -> String in
      do {
        try self.bridge.proxy(target)
      } catch {
        throw error
      }
      return self.bridge.localAddress()
    }

    Function("getDevicePublicKeyB64") { () -> String? in
      let publicKey = self.bridge.devicePublicKeyB64()
      return publicKey.isEmpty ? nil : publicKey
    }

    Function("signNonce") { (nonce: String) -> String in
      return self.bridge.signNonce(nonce)
    }
  }

  private func beginInteractiveLogin() -> [String: Any] {
      NSLog("[JAgentDeskTailscale] begin interactive login")
      self.interactiveLoginLock.lock()
      if self.interactiveLoginInFlight {
        self.interactiveLoginLock.unlock()
        return ["ok": false, "error": "A Tailscale login is already in progress"]
      }
      self.interactiveLoginInFlight = true
      self.interactiveLoginLock.unlock()

      do {
        let stateDir = try self.stateDirectory()
        self.resetUnauthenticatedInteractiveNodeIfNeeded(stateDir: stateDir)
        self.startInteractiveNodeIfNeeded(stateDir: stateDir)

        DispatchQueue.global(qos: .userInitiated).async {
          let deadline = Date().addingTimeInterval(120)
          while Date() < deadline {
            let authURL = self.bridge.authURL()
            if let url = URL(string: authURL), url.scheme == "https" {
              NSLog("[JAgentDeskTailscale] auth URL received")
              DispatchQueue.main.async {
                UIApplication.shared.open(url, options: [:]) { opened in
                  NSLog("[JAgentDeskTailscale] browser open completed: %@", opened ? "true" : "false")
                  // The browser attempt is complete. If the user cancelled
                  // Safari, the next tap must be allowed to start the flow
                  // again; a later status poll will still detect a completed
                  // login and report connected.
                  self.interactiveLoginLock.lock()
                  self.interactiveLoginInFlight = false
                  self.interactiveLoginLock.unlock()
                }
              }
              return
            }
            Thread.sleep(forTimeInterval: 0.25)
          }
          NSLog("[JAgentDeskTailscale] interactive login URL was not available before timeout")
          self.interactiveLoginLock.lock()
          self.interactiveLoginInFlight = false
          self.interactiveLoginLock.unlock()
        }
        return ["ok": true]
      } catch {
        self.interactiveLoginLock.lock()
        self.interactiveLoginInFlight = false
        self.interactiveLoginLock.unlock()
        return ["ok": false, "error": error.localizedDescription]
      }
  }

  private func prepareInteractiveLogin() -> [String: Any] {
    do {
      let stateDir = try self.stateDirectory()
      self.resetUnauthenticatedInteractiveNodeIfNeeded(stateDir: stateDir)
      self.startInteractiveNodeIfNeeded(stateDir: stateDir)
      return ["ok": true]
    } catch {
      return ["ok": false, "error": error.localizedDescription]
    }
  }

  private func resetUnauthenticatedInteractiveNodeIfNeeded(stateDir: String) {
    // A failed browser attempt leaves tsnet's old auth URL cached in the
    // bridge. Keep an authenticated node, but replace an unauthenticated one
    // before the next attempt so Tailscale issues a fresh URL.
    if self.hasPersistedAuthenticatedState(stateDir: stateDir) {
      return
    }

    self.interactiveNodeLock.lock()
    let canReset = self.interactiveNodeReady && !self.interactiveNodeStartInFlight
    self.interactiveNodeLock.unlock()
    if !canReset || !self.bridge.tailnetName().isEmpty {
      return
    }

    self.interactiveNodeLock.lock()
    if self.interactiveNodeReady && !self.interactiveNodeStartInFlight {
      self.bridge = TailscalebridgeBridge()
      self.interactiveNodeReady = false
    }
    self.interactiveNodeLock.unlock()
  }

  private func startInteractiveNodeIfNeeded(stateDir: String) {
    self.interactiveNodeLock.lock()
    if self.interactiveNodeStartInFlight || self.interactiveNodeReady {
      self.interactiveNodeLock.unlock()
      return
    }
    self.interactiveNodeStartInFlight = true
    self.interactiveNodeLock.unlock()

    // tsnet can perform network and control-plane initialization before
    // returning from Start on iOS. Never hold Expo's call thread open while
    // that happens; the login screen can render while this node warms up.
    self.interactiveLoginQueue.async {
      do {
        try self.bridge.start("", stateDir: stateDir, hostname: "jagentdesk-mobile", target: "")
        self.interactiveNodeLock.lock()
        self.interactiveNodeStartInFlight = false
        self.interactiveNodeReady = true
        self.interactiveNodeLock.unlock()
        NSLog("[JAgentDeskTailscale] interactive start returned")
      } catch {
        self.interactiveNodeLock.lock()
        self.interactiveNodeStartInFlight = false
        self.interactiveNodeReady = false
        self.interactiveNodeLock.unlock()
        NSLog("[JAgentDeskTailscale] interactive start failed: %@", error.localizedDescription)
        self.interactiveLoginLock.lock()
        self.interactiveLoginInFlight = false
        self.interactiveLoginLock.unlock()
      }
    }
  }

  private func stateDirectory() throws -> String {
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appendingPathComponent("JAgentDesk/Tailscale", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.path
  }

  private let authenticatedMarkerName = "tailscale-authenticated.marker"

  private func authenticatedMarkerURL(stateDir: String) -> URL {
    URL(fileURLWithPath: stateDir, isDirectory: true).appendingPathComponent(authenticatedMarkerName)
  }

  private func hasPersistedAuthenticatedState(stateDir: String) -> Bool {
    FileManager.default.fileExists(atPath: authenticatedMarkerURL(stateDir: stateDir).path)
  }

  private func markAuthenticated(stateDir: String?) {
    guard let stateDir else { return }
    let marker = authenticatedMarkerURL(stateDir: stateDir)
    if !FileManager.default.fileExists(atPath: marker.path) {
      _ = FileManager.default.createFile(atPath: marker.path, contents: Data([0x4a, 0x44, 0x54, 0x53]), attributes: [.posixPermissions: 0o600])
    }
  }

  private func removeAuthenticatedMarker(stateDir: String?) {
    guard let stateDir else { return }
    try? FileManager.default.removeItem(at: authenticatedMarkerURL(stateDir: stateDir))
  }

}
