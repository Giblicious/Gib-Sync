const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function importKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(raw) as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptBlob(bytes: Uint8Array, key: string, hash: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(hash) }, await importKey(key), bytes as BufferSource));
  const output = new Uint8Array(1 + iv.length + encrypted.length); output[0] = 1; output.set(iv, 1); output.set(encrypted, 13);
  return output;
}

export async function decryptBlob(payload: Uint8Array, key: string, hash: string): Promise<Uint8Array> {
  if (payload[0] !== 1 || payload.length < 30) throw new Error("Unsupported or invalid encrypted blob");
  const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(1, 13), additionalData: encoder.encode(hash) }, await importKey(key), payload.slice(13) as BufferSource);
  const bytes = new Uint8Array(result);
  if (await hashBytes(bytes) !== hash) throw new Error(`Integrity check failed for ${hash}`);
  return bytes;
}

export async function openPairingEnvelope<T>(payload: string, secret: string, pairingId: string): Promise<T> {
  const packed = fromBase64Url(payload); const salt = encoder.encode("gib-sync-v1"); const context = encoder.encode(`pairing:${pairingId}`);
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: context }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  // Node stores IV | tag | ciphertext; WebCrypto accepts IV and ciphertext | tag.
  const combined = new Uint8Array(packed.length - 12);
  combined.set(packed.slice(28), 0); combined.set(packed.slice(12, 28), packed.length - 28);
  const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, key, combined as BufferSource);
  return JSON.parse(new TextDecoder().decode(decoded)) as T;
}
