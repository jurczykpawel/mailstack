import type { TemplateDef } from '../../types.ts';
import { ctaButton, ctaText, paragraph, summaryTable } from '../layout.ts';

export const bankTransferTemplate: TemplateDef = {
  id: 'bank-transfer',
  requiredFields: ['orderId', 'holder', 'account', 'bank', 'title', 'amount', 'currency', 'deadline', 'orderUrl'],
  maskedFields: ['orderId', 'amount', 'currency', 'deadline'],
  secretFields: ['orderUrl'],
  subject(_brand, data) {
    return `${data.reminder === 'true' ? 'Przypomnienie o płatności' : 'Dane do przelewu'} - ${data.orderId || ''}`;
  },
  render(brand, data) {
    const heading = data.reminder === 'true' ? 'Przypomnienie o płatności' : 'Dane do przelewu';
    const intro = data.reminder === 'true'
      ? 'Czekamy na wpłatę za Twoje zamówienie. Wykonaj przelew w podanym terminie:'
      : 'Dziękujemy za zamówienie. Aby je opłacić, wykonaj przelew na poniższe konto:';
    const rows = [
      { label: 'Nr zamówienia', value: data.orderId || '' },
      { label: 'Odbiorca', value: data.holder || '' },
      { label: 'Numer konta', value: data.account || '' },
      { label: 'Bank', value: data.bank || '' },
      { label: 'Tytuł przelewu', value: data.title || '' },
      { label: 'Kwota', value: `${data.amount || ''} ${data.currency || ''}`.trim() },
      { label: 'Termin płatności', value: data.deadline || '' },
    ];
    const label = 'Zobacz zamówienie', url = data.orderUrl || '';
    return {
      heading,
      bodyHtml: [paragraph(intro), summaryTable(rows), ctaButton(brand, url, label)].join('\n'),
      bodyText: [intro, ...rows.filter(row => row.value).map(row => `${row.label}: ${row.value}`), ctaText(url, label)].filter(Boolean).join('\n\n'),
      previewText: heading,
    };
  },
};
