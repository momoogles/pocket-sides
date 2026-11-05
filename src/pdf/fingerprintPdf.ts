// Create the local-only key used to match a PDF with cached data.

export function fingerprintPdf(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return Promise.resolve(null);
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  return globalThis.crypto.subtle
    .digest("SHA-256", digestInput)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    )
    .catch(() => null);
}
