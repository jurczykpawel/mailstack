import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { layoutCases, renderLayoutCase } from "./email-layout-fixture.ts";

const destination = process.argv[2];
if (!destination) throw new Error("Pass an output directory for the email fixtures");
await mkdir(destination, { recursive: true });
for (const entry of layoutCases) {
  const rendered = renderLayoutCase(entry);
  await writeFile(resolve(destination, `${entry.id}.html`), rendered.html);
  await writeFile(resolve(destination, `${entry.id}.txt`), rendered.text);
}
await writeFile(resolve(destination, "cases.json"), JSON.stringify(layoutCases, null, 2));
await writeFile(resolve(destination, "index.html"), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email layout fixtures</title>
<style>body{margin:8px;font:14px sans-serif}iframe{display:block;width:100%;height:844px;border:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<label>Case <select id="cases">${layoutCases.map(c => `<option>${c.id}</option>`).join("")}</select></label>
<button id="measure">Measure</button><pre id="results"></pre><iframe id="email" title="Original email HTML"></iframe>
<script>
const frame = document.querySelector('#email');
const cases = ${JSON.stringify(layoutCases).replace(/</g, "\\u003c")};
const history = [];
document.querySelector('#cases').onchange = () => { frame.src = document.querySelector('#cases').value + '.html'; };
window.measureEmail = () => {
  const doc = frame.contentDocument;
  const root = doc.documentElement;
  const entry = cases.find(c => c.id === document.querySelector('#cases').value);
  const ranges = [...doc.querySelectorAll('td,p,pre,a,h1,h2,li,div')].flatMap(el => {
    if (!el.textContent.trim()) return [];
    const range = doc.createRange(); range.selectNodeContents(el);
    return [...range.getClientRects()].filter(r => r.width > 0 && (r.left < -1 || r.right > root.clientWidth + 1))
      .map(r => ({tag: el.tagName, left:r.left, right:r.right}));
  });
  const missing = entry.values.filter(value => !doc.body.textContent.includes(value));
  const result = {id:entry.id, viewport:[innerWidth,innerHeight], iframeWidth:frame.clientWidth,
    clientWidth:root.clientWidth, scrollWidth:root.scrollWidth, bodyScrollWidth:doc.body.scrollWidth,
    missing, outside:ranges, devicePixelRatio, visualScale:visualViewport.scale,
    ok:root.scrollWidth <= root.clientWidth + 1 && doc.body.scrollWidth <= root.clientWidth + 1 && !missing.length && !ranges.length};
  history.push(result); document.querySelector('#results').textContent = JSON.stringify(history,null,2);
  return result;
};
document.querySelector('#measure').onclick = window.measureEmail;
frame.src = cases[0].id + '.html';
</script></html>`);
console.log(`Wrote ${layoutCases.length} original email fixtures to ${destination}`);
