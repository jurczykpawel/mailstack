import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundlePurchase } from './purchase-license-fixture.ts';
import { purchaseLicenseData } from '../src/purchase-licenses.ts';
import { paymentTemplate } from '../src/templates/types/payment.ts';
import { renderLayout } from '../src/templates/layout.ts';
import { activationPage } from '../scripts/manual/activation-page.ts';
import example from '../config/mailstack.example.json' with { type: 'json' };

const destination = process.argv[2];
if (!destination) throw new Error('Pass an output directory for the purchase fixtures');
await mkdir(destination, { recursive: true });
const purchase = bundlePurchase();
await writeFile(resolve(destination, 'purchase.json'), JSON.stringify(purchase, null, 2));
for (const configured of [true, false]) {
  const brand = { ...example.brands.acme, licenseActivationUrls: configured ? example.brands.acme.licenseActivationUrls : {} };
  const data = { name: 'Żaneta Łącka', amount: '123.00', currency: 'PLN', item: purchase.data.product.name, orderId: 'pi_bundle',
    ...purchaseLicenseData(purchase.data, brand) };
  const rendered = renderLayout(brand, paymentTemplate.render(brand, data));
  await writeFile(resolve(destination, `${configured ? 'configured' : 'unconfigured'}.html`), rendered.html);
  await writeFile(resolve(destination, `${configured ? 'configured' : 'unconfigured'}.txt`), rendered.text);
}
await mkdir(resolve(destination, 'activate'), { recursive: true });
for (const license of purchase.data.licenses)
  await writeFile(resolve(destination, 'activate', license.productId + '.html'), activationPage('/activate/' + license.productId)!);
await writeFile(resolve(destination, 'index.html'), `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demonstracja zakupu bundle</title><style>body{font:16px system-ui;margin:16px;overflow-wrap:anywhere}pre{white-space:pre-wrap;word-break:break-all}iframe{width:100%;height:844px;border:0}</style>
<h1>Syntetyczny pierwszy mail zakupu</h1><p>Demonstracja lokalna, bez aktywacji u dostawcy. Wybierz wariant, porównaj pełne klucze i zmierz przewijanie przy 390/1440 px.</p>
<button data-case="configured">Z konfiguracją</button><button data-case="unconfigured">Bez konfiguracji</button>
<button id="measure">Zmierz szerokość</button><output></output><iframe title="Pierwszy mail" src="configured.html"></iframe>
<h2>Oczekiwane pełne klucze</h2>${purchase.data.licenses.map(license => `<p>${license.productId}</p><pre>${license.token}</pre>`).join('')}
<script>const frame=document.querySelector('iframe');
for(const button of document.querySelectorAll('[data-case]')) button.onclick=()=>frame.src=button.dataset.case+'.html';
document.querySelector('#measure').onclick=()=>{const root=frame.contentDocument.documentElement;document.querySelector('output').textContent=JSON.stringify({width:root.clientWidth,scroll:root.scrollWidth});};
frame.onload=()=>{for(const link of frame.contentDocument.querySelectorAll('a')){const url=new URL(link.href);if(url.hostname==='source.test.example'&&url.pathname.startsWith('/activate/')) link.onclick=event=>{event.preventDefault();location.href=url.pathname.slice(1)+'.html';};}};
</script></html>`);
console.log('Wrote synthetic purchase fixtures');
