import crypto from "node:crypto";

export function sealProfileBundle(devicePublicKeyRaw: Buffer, jsonPlaintext: string): Buffer {
  if (devicePublicKeyRaw.length !== 65 || devicePublicKeyRaw[0] !== 4) {
    throw new Error("Invalid device key (expected 65-byte uncompressed P-256 public key)");
  }

  // 1. Ephemeral P-256 keypair
  const ephemeral = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ephemeralJwk = ephemeral.publicKey.export({ format: "jwk" });
  const x = Buffer.from(ephemeralJwk.x!, "base64url");
  const y = Buffer.from(ephemeralJwk.y!, "base64url");
  const ephemeralPubRaw = Buffer.concat([Buffer.from([0x04]), x, y]);

  // 2. Device Key Object
  const devX = devicePublicKeyRaw.subarray(1, 33);
  const devY = devicePublicKeyRaw.subarray(33, 65);
  const deviceKeyObj = crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: devX.toString("base64url"),
      y: devY.toString("base64url")
    },
    format: "jwk"
  });

  // 3. ECDH shared secret
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: deviceKeyObj
  });

  // 4. HKDF SHA-256
  const info = Buffer.from("gpb-profile-envelope-v1", "utf8");
  const aesKey = crypto.hkdfSync("sha256", sharedSecret, ephemeralPubRaw, info, 32);

  // 5. AES-256-GCM
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.concat([Buffer.from([0x01]), ephemeralPubRaw]);

  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(aesKey), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(jsonPlaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([0x01]), // Version = 1
    ephemeralPubRaw,      // 65 bytes
    nonce,                // 12 bytes
    tag,                  // 16 bytes
    ciphertext            // variable
  ]);
}
