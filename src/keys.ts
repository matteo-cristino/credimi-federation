/**
 * The Trust Anchor's federation signing key: one ES256 private JWK on disk.
 *
 * The key is created once by `credimi-federation init` and only ever read
 * afterwards. Loading validates it fully so a damaged or swapped file stops
 * the service at startup instead of producing statements nobody can verify.
 */
import { constants } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CompactSign,
  calculateJwkThumbprint,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
} from "jose";
import { z } from "zod";

export const FEDERATION_KEY_ALG = "ES256";

/** A loaded, validated federation signing key. */
export interface FederationKey {
  readonly kid: string;
  /** Private JWK including `d`. Never serialize this into a response. */
  readonly privateJwk: Readonly<JWK>;
  /** Public JWK exactly as published in the Entity Configuration. */
  readonly publicJwk: Readonly<JWK>;
}

export class KeyError extends Error {
  override readonly name = "KeyError";
}

const PrivateKeyFileSchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  d: z.string().min(1),
  kid: z.string().min(1),
  alg: z.literal(FEDERATION_KEY_ALG),
  use: z.literal("sig"),
});

type PrivateKeyFile = z.infer<typeof PrivateKeyFileSchema>;

/**
 * Generates a new ES256 key and writes it to `path` with mode 0600 inside a
 * directory created with mode 0700. Refuses to replace an existing file: the
 * key is the federation's identity, and overwriting it would silently break
 * every Trust Chain that pins the current key.
 */
export async function generateFederationKey(path: string): Promise<FederationKey> {
  const { privateKey } = await generateKeyPair(FEDERATION_KEY_ALG, {
    crv: "P-256",
    extractable: true,
  });
  const exported = await exportJWK(privateKey);
  const keyWithoutKid = {
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
    d: exported.d,
  };
  const kid = await calculateJwkThumbprint(keyWithoutKid, "sha256");
  const file = PrivateKeyFileSchema.parse({
    ...keyWithoutKid,
    kid,
    alg: FEDERATION_KEY_ALG,
    use: "sig",
  });

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    // O_EXCL makes the existence check and the creation one atomic step.
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new KeyError(
        `Refusing to overwrite the existing federation signing key at ${path}. ` +
          "The key is the federation's identity; rotate it deliberately instead (see README).",
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return toFederationKey(file);
}

/** Reads and validates the private key file. Throws KeyError on any problem. */
export async function loadFederationKey(path: string): Promise<FederationKey> {
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new KeyError(
        `Federation signing key not found at ${path}. ` +
          'Run "credimi-federation init" once to create it, or restore it from backup.',
      );
    }
    throw error;
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new KeyError(
      `Federation signing key at ${path} is accessible by group or others ` +
        `(mode ${(mode & 0o777).toString(8)}). Restrict it with: chmod 600 ${path}`,
    );
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "EACCES") {
      throw new KeyError(
        `Federation signing key at ${path} cannot be read by the service user (uid ${String(process.getuid?.() ?? "unknown")}). ` +
          "Give that user ownership of the file and keep mode 600.",
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KeyError(`Federation signing key at ${path} is not valid JSON.`);
  }
  const result = PrivateKeyFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeyError(
      `Federation signing key at ${path} must be a private EC P-256 JWK with ` +
        `kty, crv, x, y, d, kid, alg "ES256" and use "sig": ${z.prettifyError(result.error)}`,
    );
  }
  const file = result.data;

  const thumbprint = await calculateJwkThumbprint(
    { kty: file.kty, crv: file.crv, x: file.x, y: file.y },
    "sha256",
  );
  if (thumbprint !== file.kid) {
    throw new KeyError(
      `Federation signing key at ${path} has kid "${file.kid}" but its RFC 7638 thumbprint is "${thumbprint}".`,
    );
  }

  const key = toFederationKey(file);
  await assertKeyPairMatches(key, path);
  return key;
}

/** The public JWK Set to publish and distribute. Contains no private members. */
export function publicJwks(key: FederationKey): { keys: JWK[] } {
  return { keys: [{ ...key.publicJwk }] };
}

function toFederationKey(file: PrivateKeyFile): FederationKey {
  const publicJwk: JWK = {
    kty: file.kty,
    crv: file.crv,
    x: file.x,
    y: file.y,
    kid: file.kid,
    alg: file.alg,
    use: file.use,
  };
  return { kid: file.kid, privateJwk: { ...file }, publicJwk };
}

/** Signs a probe with the private half and verifies it with the public half. */
async function assertKeyPairMatches(key: FederationKey, path: string): Promise<void> {
  try {
    const privateKey = await importJWK(key.privateJwk, FEDERATION_KEY_ALG);
    const publicKey = await importJWK(key.publicJwk, FEDERATION_KEY_ALG);
    const probe = await new CompactSign(new TextEncoder().encode("credimi-federation key probe"))
      .setProtectedHeader({ alg: FEDERATION_KEY_ALG })
      .sign(privateKey);
    await compactVerify(probe, publicKey);
  } catch {
    throw new KeyError(
      `Federation signing key at ${path} is invalid: its private and public parts do not form a usable ES256 key pair.`,
    );
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
