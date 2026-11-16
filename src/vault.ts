import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReferenceGrant } from "./types.js";
import { identityPlates } from "./local/mark.js";

const VIEWS = ["front", "three-quarter", "profile"] as const;

/**
 * Reference media lives here, encrypted, apart from the application database
 * and apart from finished takes. Each actor has a key. Revocation deletes it.
 * Decrypted bytes exist only inside a grant and are wiped when the grant ends.
 */
export class Vault {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  capture(input: {
    actorId: string;
    consentId: string;
    packId: string;
    token: string;
    phrase: string;
    plates?: { view: string; bytes: Buffer }[];
  }): void {
    const key = this.ensureKey(input.actorId);
    const plates =
      input.plates ??
      identityPlates(input.token, input.phrase).map((plate) => ({
        view: plate.view,
        bytes: Buffer.from(plate.svg, "utf8"),
      }));
    const dir = this.packDir(input.actorId, input.packId);
    fs.mkdirSync(dir, { recursive: true });
    for (const plate of plates) {
      const sealed = encrypt(key, plate.bytes);
      fs.writeFileSync(path.join(dir, `${safeView(plate.view)}.bin`), sealed);
    }
  }

  openGrant(input: { actorId: string; consentId: string; packId: string; token: string }): ReferenceGrant {
    const key = this.readKey(input.actorId);
    if (!key) {
      throw new Error("reference key destroyed");
    }
    const dir = this.packDir(input.actorId, input.packId);
    const plates = VIEWS.flatMap((view) => {
      const file = path.join(dir, `${safeView(view)}.bin`);
      if (!fs.existsSync(file)) return [];
      return [{ view, bytes: decrypt(key, fs.readFileSync(file)) }];
    });
    if (plates.length === 0) {
      throw new Error("reference pack empty");
    }
    const grant: ReferenceGrant = {
      actorId: input.actorId,
      consentId: input.consentId,
      packId: input.packId,
      token: input.token,
      plates,
      released: false,
      release() {
        for (const plate of plates) plate.bytes.fill(0);
        grant.released = true;
      },
    };
    return grant;
  }

  readPlate(input: { actorId: string; packId: string; view: string }): Buffer | null {
    const key = this.readKey(input.actorId);
    if (!key) return null;
    const file = path.join(this.packDir(input.actorId, input.packId), `${safeView(input.view)}.bin`);
    if (!fs.existsSync(file)) return null;
    return decrypt(key, fs.readFileSync(file));
  }

  /** Destroys the actor key and deletes ciphertext. Backups of the key are not kept here. */
  destroyActor(actorId: string): void {
    const dir = path.join(this.root, actorId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  removePack(actorId: string, packId: string): void {
    const dir = this.packDir(actorId, packId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  keyExists(actorId: string): boolean {
    return fs.existsSync(this.keyPath(actorId));
  }

  private ensureKey(actorId: string): Buffer {
    const existing = this.readKey(actorId);
    if (existing) return existing;
    const key = randomBytes(32);
    fs.mkdirSync(path.join(this.root, actorId), { recursive: true });
    fs.writeFileSync(this.keyPath(actorId), key, { mode: 0o600 });
    return key;
  }

  private readKey(actorId: string): Buffer | null {
    const file = this.keyPath(actorId);
    if (!fs.existsSync(file)) return null;
    const key = fs.readFileSync(file);
    if (key.length !== 32) return null;
    return key;
  }

  private keyPath(actorId: string): string {
    return path.join(this.root, actorId, "key");
  }

  private packDir(actorId: string, packId: string): string {
    return path.join(this.root, actorId, packId);
  }
}

function safeView(view: string): string {
  return view.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
}

function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]);
}

function decrypt(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const body = sealed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
