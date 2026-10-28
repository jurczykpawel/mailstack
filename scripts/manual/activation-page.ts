import purchase from './purchase-fixture.json' with { type: 'json' };

export function activationPage(path: string): string | undefined {
  const license = purchase.data.licenses.find(entry => path === `/activate/${entry.productId}`);
  if (!license) return;
  const product = [purchase.data.product, ...purchase.data.bundleComponents].find(entry => entry.id === license.productId)!;
  const safeName = product.name.replace(/[<>&"]/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[value]!);
  return `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demonstracja aktywacji</title><style>body{margin:24px auto;padding:0 16px;max-width:650px;font:16px system-ui;overflow-wrap:anywhere}textarea{box-sizing:border-box;width:100%;min-height:160px;word-break:break-all}pre{white-space:pre-wrap;word-break:break-all}</style>
<h1>Demonstracja: ${safeName}</h1><p>To lokalna demonstracja. Nie aktywuje licencji u dostawcy.</p>
<form><label>Pełny syntetyczny klucz dla: ${safeName}<textarea required name="key" autocomplete="off"></textarea></label><button>Sprawdź wklejony klucz</button></form><p role="status"></p><pre></pre>
<script>document.querySelector('form').onsubmit = event => { event.preventDefault();
const key = document.querySelector('textarea').value;
const matches = key === ${JSON.stringify(license.token).replace(/</g, '\\u003c')};
document.querySelector('[role=status]').textContent = matches ? 'Pełny klucz i produkt zgodne. Wynik demonstracyjny.' : 'Klucz nie pasuje do tego produktu lub jest niepełny.';
document.querySelector('pre').textContent = 'Długość: ' + key.length + '\\n' + key;
};</script></html>`;
}
