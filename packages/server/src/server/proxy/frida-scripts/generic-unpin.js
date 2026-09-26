/*
 * Generic, app-agnostic TLS-pinning bypass for iOS Simulator apps under test.
 *
 * Hooks the common pinning surfaces so it works regardless of which app is running (no per-app
 * config): the low-level BoringSSL custom verify callback (used by NSURLSession / CFNetwork on
 * modern iOS), the classic SecTrustEvaluate family, plus the widely-used third-party pinning
 * libraries (TrustKit, AFNetworking). This only affects apps on simulators the operator controls,
 * for authorized security testing — the same technique as objection / frida "multiple unpinning".
 *
 * Sources this consolidates (community, MIT/public): objection's ios pinning bypass and the
 * "frida-multiple-unpinning" pattern. Kept intentionally small and readable so it can be reviewed.
 */
"use strict";

function log(msg) {
  send({ wb: "unpin", msg: msg });
}

// 1) BoringSSL custom verify (SSL_CTX_set_custom_verify / SSL_set_custom_verify). Returning
//    SSL_VERIFY_OK (0) from the replacement callback disables certificate validation for the
//    connection, which is what NSURLSession/CFNetwork use under the hood on current iOS.
function hookBoringSSL() {
  const SSL_VERIFY_OK = 0;
  for (const name of ["SSL_CTX_set_custom_verify", "SSL_set_custom_verify"]) {
    const addr = Module.findExportByName(null, name);
    if (!addr) continue;
    try {
      const fn = new NativeFunction(addr, "void", ["pointer", "int", "pointer"]);
      const replaced = new NativeCallback(
        function (ssl, mode, _cb) {
          const ok = new NativeCallback(() => SSL_VERIFY_OK, "int", ["pointer", "pointer"]);
          fn(ssl, mode, ok);
        },
        "void",
        ["pointer", "int", "pointer"],
      );
      Interceptor.replace(addr, replaced);
      log("hooked " + name);
    } catch (e) {
      log("skip " + name + ": " + e);
    }
  }
  const getResult = Module.findExportByName(null, "SSL_get_verify_result");
  if (getResult) {
    try {
      Interceptor.replace(getResult, new NativeCallback(() => 0, "long", ["pointer"]));
      log("hooked SSL_get_verify_result");
    } catch (e) {
      log("skip SSL_get_verify_result: " + e);
    }
  }
}

// 2) Security.framework SecTrustEvaluate / SecTrustEvaluateWithError -> force "trusted".
function hookSecTrust() {
  const withError = Module.findExportByName("Security", "SecTrustEvaluateWithError");
  if (withError) {
    try {
      Interceptor.replace(
        withError,
        new NativeCallback(
          function (_trust, errorRef) {
            if (!errorRef.isNull()) errorRef.writePointer(NULL);
            return 1; // true
          },
          "int",
          ["pointer", "pointer"],
        ),
      );
      log("hooked SecTrustEvaluateWithError");
    } catch (e) {
      log("skip SecTrustEvaluateWithError: " + e);
    }
  }
  const evaluate = Module.findExportByName("Security", "SecTrustEvaluate");
  if (evaluate) {
    try {
      Interceptor.replace(
        evaluate,
        new NativeCallback(
          function (_trust, resultPtr) {
            if (!resultPtr.isNull()) resultPtr.writeU32(1); // kSecTrustResultProceed
            return 0; // errSecSuccess
          },
          "int",
          ["pointer", "pointer"],
        ),
      );
      log("hooked SecTrustEvaluate");
    } catch (e) {
      log("skip SecTrustEvaluate: " + e);
    }
  }
}

// 3) Popular ObjC pinning libraries — neutralize their validators if present.
function hookObjCLibraries() {
  if (!ObjC.available) return;
  const tsk = ObjC.classes.TSKPinningValidator;
  if (tsk && tsk["- evaluateTrust:forHostname:"]) {
    try {
      Interceptor.attach(tsk["- evaluateTrust:forHostname:"].implementation, {
        onLeave(ret) {
          ret.replace(0); // TSKTrustDecisionShouldAllowConnection
        },
      });
      log("hooked TrustKit TSKPinningValidator");
    } catch (e) {
      log("skip TrustKit: " + e);
    }
  }
  const af = ObjC.classes.AFSecurityPolicy;
  if (af && af["- evaluateServerTrust:forDomain:"]) {
    try {
      Interceptor.attach(af["- evaluateServerTrust:forDomain:"].implementation, {
        onLeave(ret) {
          ret.replace(0x1); // YES
        },
      });
      log("hooked AFNetworking AFSecurityPolicy");
    } catch (e) {
      log("skip AFNetworking: " + e);
    }
  }
}

function main() {
  try {
    hookBoringSSL();
  } catch (e) {
    log("boringssl error: " + e);
  }
  try {
    hookSecTrust();
  } catch (e) {
    log("sectrust error: " + e);
  }
  try {
    hookObjCLibraries();
  } catch (e) {
    log("objc error: " + e);
  }
  log("generic unpin installed");
}

main();
