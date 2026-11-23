import { getTailscaleLoginAdapter, type DeviceSigningMaterial } from "@/tailscale";

let signing: DeviceSigningMaterial | null = null;
let preparing: Promise<void> | null = null;

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function loadBrowserKey(): Promise<CryptoKeyPair> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("jagentdesk-device-identity", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("keys"));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  try {
    // Generate before the transaction, then read and insert atomically. Two tabs
    // pairing at once must enroll the same key, not overwrite each other's key.
    const generated = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
    return await new Promise<CryptoKeyPair>((resolve, reject) => {
      const transaction = database.transaction("keys", "readwrite");
      const store = transaction.objectStore("keys");
      const request = store.get("device");
      let keys: CryptoKeyPair;
      request.addEventListener("success", () => {
        keys = request.result ?? generated;
        if (!request.result) store.put(keys, "device");
      });
      transaction.addEventListener("complete", () => resolve(keys));
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

export async function prepareRelayDeviceSigning(): Promise<void> {
  const adapter = getTailscaleLoginAdapter();
  if (adapter.platform === "desktop") {
    await adapter.getStatus();
    if (!adapter.getDeviceSigningMaterial?.()) throw new Error("Device signing is unavailable.");
    return;
  }
  if (signing) return;
  if (!preparing) {
    preparing = (async () => {
      const key = await loadBrowserKey();
      signing = {
        devicePublicKeyB64: base64(await crypto.subtle.exportKey("raw", key.publicKey)),
        signNonce: async (nonce) =>
          base64(
            await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(nonce)),
          ),
      };
    })().finally(() => {
      preparing = null;
    });
  }
  await preparing;
}

export function getRelayDeviceSigning(): DeviceSigningMaterial | null {
  return getTailscaleLoginAdapter().getDeviceSigningMaterial?.() ?? signing;
}
