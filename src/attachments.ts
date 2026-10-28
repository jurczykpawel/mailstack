import type { Attachment } from './types';

const TYPES: Record<string, readonly string[]> = {
  'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'],
  'text/plain': ['txt'], 'text/csv': ['csv'], 'text/calendar': ['ics'],
  'application/xml': ['xml'], 'text/xml': ['xml'],
};
const SIGNATURES: Record<string, readonly number[]> = {
  'application/pdf': [37, 80, 68, 70, 45], 'image/png': [137, 80, 78, 71, 13, 10, 26, 10], 'image/jpeg': [255, 216, 255],
};
export function attachmentBytes(file: Attachment): Uint8Array<ArrayBuffer> {
  const binary = atob(file.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function validateAttachments(raw: unknown): { files: Attachment[] } | { status: number; code: string; message: string } {
  const invalid = { status: 422, code: 'attachment_invalid', message: 'invalid attachment' };
  if (!Array.isArray(raw) || raw.length > 5) return invalid;
  const files: Attachment[] = [];
  let size = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.filename !== 'string' || typeof item.contentType !== 'string' || typeof item.contentBase64 !== 'string') return invalid;
    const { filename, contentType, contentBase64 } = item;
    if (!Object.hasOwn(TYPES, contentType)) return { status: 415, code: 'attachment_type', message: 'attachment type not allowed' };
    if (!/^[\w .()-]{1,100}$/.test(filename) || !filename.includes('.') || !TYPES[contentType].includes(filename.split('.').at(-1)!.toLowerCase())) return invalid;
    if (contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) return invalid;
    const file = { filename, contentType, contentBase64 };
    const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = alphabet.indexOf(contentBase64.at(-padding - 1) ?? 'A');
    if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return invalid;
    const length = contentBase64.length / 4 * 3 - padding;
    if ((size += length) > 7 * 1024 * 1024) return invalid;
    const signature = SIGNATURES[contentType];
    if (signature) {
      const prefix = atob(contentBase64.slice(0, 12));
      if (signature.some((byte, i) => prefix.charCodeAt(i) !== byte)) return invalid;
    }
    files.push(file);
  }
  return { files };
}
export async function attachmentSummary(files: Attachment[]) {
  const identity = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = attachmentBytes(file);
    totalBytes += bytes.length;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    identity.push({ filename: file.filename, contentType: file.contentType,
      sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') });
  }
  return { identity, meta: { count: files.length, totalBytes, types: [...new Set(files.map(f => f.contentType))] } };
}
