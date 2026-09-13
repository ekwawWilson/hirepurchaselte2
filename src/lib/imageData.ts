/**
 * Reading images stored inline as base64 data URLs (the company logo, the
 * customer photo). Pure and DB-free, so server code of any kind can share it.
 */

export type ImageType = 'image/png' | 'image/jpeg';

/**
 * The real format of image bytes, from their file signature. A declared
 * content type is never trusted on its own: bytes that are not really an
 * image render as a blank picture rather than failing.
 */
export function detectImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * Decodes a base64 data URL, or null unless it declares one of `allowed` and
 * its bytes really are that format.
 */
export function parseImageDataUrl(dataUrl: string, allowed: readonly string[]): { contentType: ImageType; bytes: Buffer } | null {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  if (!allowed.includes(contentType)) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (detectImageType(bytes) !== contentType) return null;
  return { contentType: contentType as ImageType, bytes };
}
