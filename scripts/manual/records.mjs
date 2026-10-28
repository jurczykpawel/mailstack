import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const selectedHeaders = new Set(['content-type', 'content-length', 'idempotency-key', 'x-mailstack-signature', 'title', 'priority', 'tags']);
export function recordHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => selectedHeaders.has(key.toLowerCase())));
}

function source(file) {
  try { return readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
}
function preserve(file, bytes) {
  const original = `${file}.original-${createHash('sha256').update(bytes).digest('hex')}`;
  let fd;
  try {
    fd = openSync(original, 'wx', 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST' || !readFileSync(original).equals(bytes)) throw error;
  }
  finally { if (fd !== undefined) closeSync(fd); }
  return basename(original);
}

export function readRecords(file) {
  const bytes = source(file), records = [], discarded = [], nulRanges = [];
  let nulBytes = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    const offset = i;
    while (i < bytes.length && bytes[i] === 0) i++;
    const count = i - offset;
    nulRanges.push({ offset, bytes: count }); nulBytes += count; i--;
  }
  let offset = 0, line = 1;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
    const raw = bytes.subarray(offset, end), text = raw.toString('utf8').replaceAll('\0', '');
    if (text.trim()) {
      try {
        const record = JSON.parse(text);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid record');
        if (record.headers) record.headers = recordHeaders(record.headers);
        records.push(record);
      } catch { discarded.push({ line, offset, bytes: raw.length }); }
    } else if (raw.includes(0)) discarded.push({ line, offset, bytes: raw.length });
    offset = end + 1; line++;
  }
  const diagnostics = { recovered: records.length, discarded, nulBytes, nulRanges };
  if (nulBytes || discarded.length) {
    diagnostics.original = preserve(file, bytes);
  }
  return { records, diagnostics };
}

export function appendRecord(file, record) {
  const bytes = source(file);
  // Every append gets a fresh O_APPEND descriptor, including after a file replacement.
  if (bytes.length && bytes.at(-1) !== 10) preserve(file, bytes);
  const fd = openSync(file, 'a', 0o600);
  try {
    const value = { ...record, ...(record.headers ? { headers: recordHeaders(record.headers) } : {}) };
    writeFileSync(fd, (bytes.length && bytes.at(-1) !== 10 ? '\n' : '') + JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
