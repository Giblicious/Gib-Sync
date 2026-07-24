import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeQuickCode,openPairingEnvelope, toBase64Url } from "./crypto";

describe("pairing envelope", () => {
  it("normalizes a typed quick code",()=>{expect(normalizeQuickCode(" 01234 ")).toBe("01234");expect(()=>normalizeQuickCode("1234")).toThrow();});
  it("opens the server IV-tag-ciphertext format", async () => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    const secret = "pairing-secret-value"; const id = "00000000-0000-4000-8000-000000000000";
    const encoder = new TextEncoder(); const raw = await webcrypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    const key = await webcrypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:encoder.encode("gib-sync-v1"),info:encoder.encode(`pairing:${id}`)},raw,{name:"AES-GCM",length:256},false,["encrypt"]);
    const iv = webcrypto.getRandomValues(new Uint8Array(12)); const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({name:"AES-GCM",iv},key,encoder.encode(JSON.stringify({ok:true}))));
    const ciphertext = encrypted.slice(0,-16), tag = encrypted.slice(-16); const packed = new Uint8Array(12+16+ciphertext.length); packed.set(iv); packed.set(tag,12); packed.set(ciphertext,28);
    await expect(openPairingEnvelope(toBase64Url(packed), secret, id)).resolves.toEqual({ok:true});
  });
});
