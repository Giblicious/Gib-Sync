import { describe, expect, it } from "vitest";
import { createCipheriv,randomBytes } from "node:crypto";
import { decryptVaultBlob,openJson, safeEqual, sealJson, sha256 } from "./security.js";

describe("security", () => {
  it("round trips sealed JSON", () => {
    const sealed = sealJson({ key: "value" }, "x".repeat(32), "test");
    expect(openJson(sealed, "x".repeat(32), "test")).toEqual({ key: "value" });
  });
  it("compares and hashes safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true); expect(safeEqual("abc", "abd")).toBe(false);
    expect(sha256("abc")).toHaveLength(64);
  });
  it("decrypts the plugin vault-blob format",()=>{
    const clear=Buffer.from("readable recovery");const hash=sha256(clear);const key=randomBytes(32);const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(Buffer.from(hash));const ciphertext=Buffer.concat([cipher.update(clear),cipher.final()]);
    const payload=Buffer.concat([Buffer.from([1]),iv,ciphertext,cipher.getAuthTag()]);expect(Buffer.from(decryptVaultBlob(payload,key.toString("base64url"),hash))).toEqual(clear);
  });
});
