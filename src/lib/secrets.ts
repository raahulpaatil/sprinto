// Small at-rest encryption for the one credential the app stores itself (the Gmail refresh token).
// Key material is the OAuth client secret from the environment, which never enters the database.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const key = (secret: string) => createHash("sha256").update(`sprinto:v1:${secret}`).digest();

export function seal(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function open(sealed: string, secret: string): string | null {
  try {
    const [v, iv, tag, enc] = sealed.split(".");
    if (v !== "v1") return null;
    const d = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
