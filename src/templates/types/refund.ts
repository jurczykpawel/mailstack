import type { TemplateDef } from "../../types.ts";
import { noticeTemplate } from "./notice.ts";

export const refundTemplate: TemplateDef = {
  id: "refund",
  maskedFields: ["amount", "currency", "productName", "transactionId", "paymentId", "refundId", "isFullRefund", "totalRefunded", "refundedAt"],
  requiredFields: ["amount", "currency", "productName", "transactionId", "paymentId",
    "refundId", "isFullRefund", "totalRefunded", "refundedAt"],
  subject() { return "Zwrot środków"; },
  render(brand, data) {
    const value: unknown = data.isFullRefund;
    const scope = value === true || value === "true" ? "pełny"
      : value === false || value === "false" ? "częściowy" : undefined;
    return noticeTemplate.render(brand, {
      heading: "Zwrot środków",
      paragraphs: [
        `Zwróciliśmy ${data.amount} ${data.currency} za: ${data.productName}.`,
        `Numer transakcji: ${data.transactionId}.`,
        `Identyfikator płatności: ${data.paymentId}.`,
        `Identyfikator zwrotu: ${data.refundId}.`,
        "Status zwrotu: zakończony (succeeded).",
        ...(scope ? [`Zakres zwrotu: ${scope}.`] : []),
        `Łącznie zwrócono: ${data.totalRefunded} ${data.currency}.`,
        `Data zwrotu: ${data.refundedAt}.`,
        ...(data.reason?.trim() ? [`Powód: ${data.reason}.`] : []),
      ].join("\n\n"),
    });
  },
};
