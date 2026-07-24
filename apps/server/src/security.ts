import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function quickCode():string {
  return randomInt(0,100_000).toString().padStart(5,"0");
}

export function normalizeQuickCode(value:string):string {
  const compact=value.replace(/\s/g,"");
  if(!/^\d{5}$/.test(compact))throw new Error("Invalid quick code");
  return compact;
}

export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function derive(secret: string, context: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("gib-sync-v1"), Buffer.from(context), 32));
}

export function sealJson(value: unknown, secret: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(secret, context), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function openJson<T>(payload: string, secret: string, context: string): T {
  const packed = Buffer.from(payload, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", derive(secret, context), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8")) as T;
}

export function decryptVaultBlob(payload:Uint8Array,vaultKey:string,hash:string):Uint8Array {
  if(payload[0]!==1||payload.length<29)throw new Error("Unsupported or invalid encrypted blob");
  const packed=Buffer.from(payload);const ciphertext=packed.subarray(13,packed.length-16);const tag=packed.subarray(packed.length-16);
  const decipher=createDecipheriv("aes-256-gcm",Buffer.from(vaultKey,"base64url"),packed.subarray(1,13));decipher.setAAD(Buffer.from(hash));decipher.setAuthTag(tag);
  const clear=Buffer.concat([decipher.update(ciphertext),decipher.final()]);if(sha256(clear)!==hash)throw new Error(`Integrity check failed for ${hash}`);return new Uint8Array(clear);
}

export function encryptVaultBlob(payload:Uint8Array,vaultKey:string,hash:string):Uint8Array {
  if(sha256(payload)!==hash)throw new Error(`Integrity check failed for ${hash}`);
  const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",Buffer.from(vaultKey,"base64url"),iv);cipher.setAAD(Buffer.from(hash));
  return Uint8Array.from(Buffer.concat([Buffer.from([1]),iv,cipher.update(payload),cipher.final(),cipher.getAuthTag()]));
}
