import { Recipe } from "../recipe.ts";
import type { TemplateDef } from '../../types.ts';
import { ctaText } from "../layout.ts";

export const bankTransferTemplate: TemplateDef = {
  id: 'bank-transfer',
  requiredFields: ['orderId', 'holder', 'account', 'bank', 'title', 'amount', 'currency', 'deadline', 'orderUrl'],
  maskedFields: ['orderId', 'amount', 'currency', 'deadline'],
  secretFields: ['orderUrl'],
  subject(_brand, data, recipe = new Recipe()) {
    return `${recipe.copy(data.reminder === 'true' ? 'reminderHeading' : 'branchHeading', data.reminder === 'true' ? 'Przypomnienie o płatności' : 'Dane do przelewu')} - ${data.orderId || ''}`;
  },
  render(brand, data, recipe = new Recipe()) {
    const heading = recipe.copy(data.reminder === 'true' ? 'reminderHeading' : 'branchHeading', data.reminder === 'true' ? 'Przypomnienie o płatności' : 'Dane do przelewu');
    const intro = recipe.copy(data.reminder === 'true' ? 'reminderIntro' : 'intro', data.reminder === 'true'
      ? 'Czekamy na wpłatę za Twoje zamówienie. Wykonaj przelew w podanym terminie:'
      : 'Dziękujemy za zamówienie. Aby je opłacić, wykonaj przelew na poniższe konto:');
    const rows = [
      { label: recipe.label('orderId', 'Nr zamówienia'), value: data.orderId || '' },
      { label: recipe.label('holder', 'Odbiorca'), value: data.holder || '' },
      { label: recipe.label('account', 'Numer konta'), value: data.account || '' },
      { label: recipe.label('bank', 'Bank'), value: data.bank || '' },
      { label: recipe.label('title', 'Tytuł przelewu'), value: data.title || '' },
      { label: recipe.label('amount', 'Kwota'), value: `${data.amount || ''} ${data.currency || ''}`.trim() },
      { label: recipe.label('deadline', 'Termin płatności'), value: data.deadline || '' },
    ];
    const label = recipe.cta('order', 'Zobacz zamówienie'), url = data.orderUrl || '';
    return {
      heading,
      bodyHtml: recipe.html([recipe.paragraph(intro), recipe.table(rows), recipe.button(brand, url, label)]),
      bodyText: recipe.text([intro, ...rows.filter(row => row.value).map(row => `${row.label}: ${row.value}`), ctaText(url, label)].filter(Boolean)),
      previewText: heading,
    };
  },
};
