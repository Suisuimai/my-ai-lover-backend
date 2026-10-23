const crypto = require("crypto");

function encryptionKey() {
  const key = Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new Error("SETTINGS_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decryptSecret(value) {
  const payload = Buffer.from(value, "base64"); const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28)); return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}

module.exports = { encryptionKey, encryptSecret, decryptSecret };
