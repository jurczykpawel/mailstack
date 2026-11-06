export type Content = string | readonly string[];
export const parts = (value: Content): readonly string[] => typeof value === "string" ? [value] : value;
export const length = (value: Content) => parts(value).reduce((sum, part) => sum + part.length, 0);
export function utf8Size(value: string): number {
  if (/^[\x00-\x7f]*$/.test(value)) return value.length;
  let bytes = 0;
  for (const char of value) { const n = char.codePointAt(0)!; bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; }
  return bytes;
}
export class WorkBudget {
  remaining: number;
  constructor(remaining = 16 * 1024 * 1024) { this.remaining = remaining; }
  spend(size: number) { if ((this.remaining -= size) < 0) throw new RangeError("template_output_limit"); }
}
export type Emit = (output: Output) => void;
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: Content, lines = false): Emit => output => output.escaped(value, lines);
type Encoding = { bytes: number; escaped?: number; lines?: number; html?: string; htmlLines?: string };
export class Output {
  bytes = 0;
  private chunks: string[] = [];
  private tail = 0;
  private high = false;
  limit: number;
  writing: boolean;
  private trimming: boolean;
  encodings: Map<string, Encoding>;
  constructor(limit = Infinity, writing = true, trimming = false, encodings = new Map<string, Encoding>()) {
    this.limit = limit; this.writing = writing; this.trimming = trimming; this.encodings = encodings;
  }
  private encoding(text: string): Encoding {
    let value = this.encodings.get(text);
    if (!value) { value = { bytes: utf8Size(text) }; this.encodings.set(text, value); }
    return value;
  }
  private count(bytes: number) { this.bytes += bytes; if (this.bytes - (this.trimming ? this.tail : 0) > this.limit) throw new RangeError("template_output_limit"); }
  addBytes(bytes: number) { this.count(bytes); }
  private track(text: string, bytes: number, lines = false) {
    if (this.trimming) {
      const tail = /\s*$/.exec(lines ? text.slice(text.lastIndexOf("\n") + 1) : text)![0];
      this.tail = tail.length === text.length ? this.tail + utf8Size(tail) : utf8Size(tail);
    }
    const pair = this.high && /^[\udc00-\udfff]/.test(text);
    this.high = /[\ud800-\udbff]$/.test(text);
    this.count(bytes - (pair ? 2 : 0));
  }
  raw(value: Content) {
    for (const text of parts(value)) {
      if (!text.length) continue;
      this.track(text, this.encoding(text).bytes);
      if (this.writing) this.chunks.push(text);
    }
  }
  escaped(value: Content, lines = false) {
    for (const text of parts(value)) {
      if (!text.length) continue;
      const expression = lines ? /[&<>"'\n]/g : /[&<>"']/g;
      const encoding = this.encoding(text), key = lines ? "lines" : "escaped", htmlKey = lines ? "htmlLines" : "html";
      if (encoding[key] === undefined) {
        let extra = 0;
        for (const match of text.matchAll(expression)) extra += (match[0] === "\n" ? 4 : entities[match[0]].length) - 1;
        encoding[key] = encoding.bytes + extra;
      }
      this.track(text, encoding[key]!, lines);
      if (this.writing) this.chunks.push(encoding[htmlKey] ??= text.replace(expression, char => char === "\n" ? "<br>" : entities[char]));
    }
  }
  html(strings: TemplateStringsArray, ...values: (Content | Emit)[]) {
    strings.forEach((text, i) => { this.raw(text); const value = values[i]; if (typeof value === "function") value(this); else if (value !== undefined) this.raw(value); });
  }
  trimEnd() { this.bytes -= this.tail; this.tail = 0; this.trimming = false; if (this.writing) this.chunks = [this.chunks.join("").trimEnd()]; }
  result() { return this.writing ? this.chunks.join("") : ""; }
}
export function measureJson(value: unknown, limit: number): number {
  const output = new Output(limit, false);
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      output.raw('"');
      let start = 0;
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < item.length && item.charCodeAt(i + 1) >= 0xdc00 && item.charCodeAt(i + 1) <= 0xdfff) { i++; continue; }
        if (code < 32 || code === 34 || code === 92 || code >= 0xd800 && code <= 0xdfff) {
          output.raw(item.slice(start, i)); output.raw(JSON.stringify(item[i]).slice(1, -1)); start = i + 1;
        }
      }
      output.raw(item.slice(start)); output.raw('"');
    } else if (Array.isArray(item)) { output.raw("["); item.forEach((child, i) => { if (i) output.raw(","); visit(child ?? null); }); output.raw("]"); }
    else if (item && typeof item === "object") {
      output.raw("{"); Object.entries(item).filter(([, child]) => child !== undefined).forEach(([key, child], i) => { if (i) output.raw(","); visit(key); output.raw(":"); visit(child); }); output.raw("}");
    } else output.raw(JSON.stringify(item ?? null));
  };
  visit(value); return output.bytes;
}
