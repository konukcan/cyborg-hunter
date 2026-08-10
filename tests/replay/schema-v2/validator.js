// SessionRecording v2 validator — dual profiles per spec §11.
// Zero dependencies; this file lifts into the shared schema package.

// Gzip magic bytes (RFC 1952): 0x1f 0x8b.
export function detectGzip(bytes) {
  return bytes != null && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
