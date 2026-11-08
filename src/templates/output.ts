export type Content = string | readonly string[];
export const parts = (value: Content): readonly string[] => typeof value === "string" ? [value] : value;
export const length = (value: Content) => parts(value).reduce((sum, part) => sum + part.length, 0);
export function utf8Size(value: string): number {
  if (/^[\x00-\x7f]*$/.test(value)) return value.length;
  return new TextEncoder().encode(value).byteLength;
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
  const output = new Output(limit, false), strings = new Map<string, number>();
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      let bytes = strings.get(item);
      if (bytes === undefined) {
        if (output.bytes + item.length + 2 > limit) throw new RangeError("template_output_limit");
        bytes = item.length + 2;
        const expression = /["\\]+|[\u0000-\u001f\u0080-\uffff]/g;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(item)) !== null) {
          const code = match[0].charCodeAt(0);
          if (code === 34 || code === 92) bytes += match[0].length;
          else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
          else if (code < 2048) bytes++;
          else if (code >= 0xd800 && code <= 0xdfff) {
            const next = item.charCodeAt(expression.lastIndex);
            if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { bytes += 2; expression.lastIndex++; }
            else bytes += 5;
          } else bytes += 2;
          if (output.bytes + bytes > limit) throw new RangeError("template_output_limit");
        }
        strings.set(item, bytes);
      }
      output.addBytes(bytes);
    } else if (Array.isArray(item)) { output.raw("["); item.forEach((child, i) => { if (i) output.raw(","); visit(child ?? null); }); output.raw("]"); }
    else if (item && typeof item === "object") {
      output.raw("{"); Object.entries(item).filter(([, child]) => child !== undefined).forEach(([key, child], i) => { if (i) output.raw(","); visit(key); output.raw(":"); visit(child); }); output.raw("}");
    } else output.raw(JSON.stringify(item ?? null));
  };
  visit(value); return output.bytes;
}
