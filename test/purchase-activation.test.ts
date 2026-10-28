import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { activationPage } from '../scripts/manual/activation-page';
import { bundlePurchase } from './purchase-license-fixture';

it('confirms each complete synthetic key for the selected demonstration product', () => {
  for (const [i, license] of bundlePurchase().data.licenses.entries()) {
    const page = activationPage(`/activate/${license.productId}`)!;
    expect(page).toContain('Nie aktywuje licencji u dostawcy');
    const form = { onsubmit: (_event: { preventDefault(): void }) => {} };
    const input = { value: license.token };
    const status = { textContent: '' };
    const output = { textContent: '' };
    const elements = { form, textarea: input, '[role=status]': status, pre: output };
    runInNewContext(page.match(/<script>([\s\S]*)<\/script>/)![1], {
      document: { querySelector: (selector: keyof typeof elements) => elements[selector] },
    });
    form.onsubmit({ preventDefault() {} });
    expect(status.textContent).toContain('Pełny klucz i produkt zgodne');
    expect(output.textContent).toContain(license.token);
    input.value = bundlePurchase().data.licenses[1 - i].token;
    form.onsubmit({ preventDefault() {} });
    expect(status.textContent).toContain('nie pasuje');
    input.value = license.token.slice(0, -1);
    form.onsubmit({ preventDefault() {} });
    expect(status.textContent).toContain('nie pasuje');
  }
  expect(activationPage('/activate/unknown')).toBeUndefined();
});
