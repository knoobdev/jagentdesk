package sh.jagentdesk.tailscale

import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import tailscalebridge.Bridge
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class JAgentDeskTailscaleModule : Module() {
  private val bridge = Bridge()
  private val worker = Executors.newSingleThreadExecutor()
  private val nodeLock = Any()
  private val loginInFlight = AtomicBoolean(false)
  private var nodeStarting = false
  private var nodeReady = false

  override fun definition() = ModuleDefinition {
    Name("JAgentDeskTailscale")

    AsyncFunction("getStatus") {
      synchronized(nodeLock) {
        if (nodeStarting) return@AsyncFunction "connecting"
        if (!nodeReady) {
          val stateDir = stateDirectory()
          if (!File(stateDir, AUTHENTICATED_MARKER).exists()) {
            return@AsyncFunction "needs-login"
          }
          startInteractiveNodeIfNeeded()
          return@AsyncFunction "connecting"
        }
      }
      if (bridge.tailnetName().isNotEmpty()) {
        markAuthenticated()
        "connected"
      } else {
        removeAuthenticatedMarker()
        "needs-login"
      }
    }

    Function("beginInteractiveLogin") {
      beginInteractiveLogin()
    }

    Function("prepareInteractiveLogin") {
      startInteractiveNodeIfNeeded()
      mapOf("ok" to true)
    }

    Function("getAuthURL") {
      bridge.authURL().trim().takeIf { it.isNotEmpty() }
    }

    AsyncFunction("startInteractiveLogin") {
      beginInteractiveLogin()
    }

    AsyncFunction("loginWithAuthKey") { authKey: String ->
      val key = authKey.trim()
      if (key.isEmpty()) {
        return@AsyncFunction mapOf("ok" to false, "error" to "An auth key is required.")
      }
      try {
        bridge.start(key, stateDirectory().absolutePath, "jagentdesk-mobile", "")
        synchronized(nodeLock) {
          nodeStarting = false
          nodeReady = true
        }
        loginInFlight.set(false)
        markAuthenticated()
        mapOf("ok" to true)
      } catch (error: Throwable) {
        synchronized(nodeLock) {
          nodeStarting = false
          nodeReady = false
        }
        loginInFlight.set(false)
        mapOf("ok" to false, "error" to (error.message ?: "Tailscale login failed."))
      }
    }

    Function("getProxyAddress") { target: String ->
      bridge.proxy(target)
      bridge.localAddress()
    }

    Function("getDevicePublicKeyB64") {
      bridge.devicePublicKeyB64().takeIf { it.isNotEmpty() }
    }

    Function("signNonce") { nonce: String ->
      bridge.signNonce(nonce)
    }
  }

  private fun beginInteractiveLogin(): Map<String, Any> {
    if (!loginInFlight.compareAndSet(false, true)) {
      return mapOf("ok" to false, "error" to "A Tailscale login is already in progress")
    }
    startInteractiveNodeIfNeeded()
    worker.execute {
      val deadline = System.currentTimeMillis() + 120_000L
      while (System.currentTimeMillis() < deadline) {
        val authUrl = bridge.authURL().trim()
        if (authUrl.startsWith("https://")) {
          openBrowser(authUrl)
          loginInFlight.set(false)
          return@execute
        }
        Thread.sleep(250L)
      }
      loginInFlight.set(false)
    }
    return mapOf("ok" to true)
  }

  private fun startInteractiveNodeIfNeeded() {
    synchronized(nodeLock) {
      if (nodeStarting || nodeReady) return
      nodeStarting = true
    }
    worker.execute {
      try {
        bridge.start("", stateDirectory().absolutePath, "jagentdesk-mobile", "")
        synchronized(nodeLock) {
          nodeStarting = false
          nodeReady = true
        }
      } catch (_: Throwable) {
        synchronized(nodeLock) {
          nodeStarting = false
          nodeReady = false
        }
        loginInFlight.set(false)
      }
    }
  }

  private fun openBrowser(authUrl: String) {
    val context = appContext.reactContext?.applicationContext ?: return
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(authUrl)).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
  }

  private fun stateDirectory(): File {
    val directory = File(appContext.reactContext?.filesDir ?: throw IllegalStateException("Application context unavailable"), "JAgentDesk/Tailscale")
    if (!directory.exists() && !directory.mkdirs()) {
      throw IllegalStateException("Unable to create Tailscale state directory")
    }
    return directory
  }

  private companion object {
    const val AUTHENTICATED_MARKER = "tailscale-authenticated.marker"
  }

  private fun markAuthenticated() {
    val marker = File(stateDirectory(), AUTHENTICATED_MARKER)
    if (!marker.exists()) {
      marker.writeBytes(byteArrayOf(0x4a, 0x44, 0x54, 0x53))
    }
  }

  private fun removeAuthenticatedMarker() {
    File(stateDirectory(), AUTHENTICATED_MARKER).delete()
  }
}
