import { Recipe } from "../recipe.ts";
import type { TemplateDef } from "../../types.ts";
import { noticeTemplate } from "./notice.ts";

export const refundTemplate: TemplateDef = {
  id: "refund",
  maskedFields: ["amount", "currency", "productName", "transactionId", "paymentId", "refundId", "isFullRefund", "totalRefunded", "refundedAt"],
  requiredFields: ["amount", "currency", "productName", "transactionId", "paymentId",
    "refundId", "isFullRefund", "totalRefunded", "refundedAt"],
  subject(_brand, _data, recipe = new Recipe()) { return recipe.copy("branchHeading", "Zwrot środków"); },
  render(brand, data, recipe = new Recipe()) {
    const value: unknown = data.isFullRefund;
    const scope = value === true || value === "true" ? "pełny"
      : value === false || value === "false" ? "częściowy" : undefined;
    const result = noticeTemplate.render(brand, {
      heading: recipe.copy("branchHeading", "Zwrot środków"),
      paragraphs: recipe.combine([
        recipe.copy("amount", `Zwróciliśmy ${data.amount} ${data.currency} za: ${data.productName}.`),
        recipe.copy("transaction", `Numer transakcji: ${data.transactionId}.`),
        recipe.copy("payment", `Identyfikator płatności: ${data.paymentId}.`),
        recipe.copy("refund", `Identyfikator zwrotu: ${data.refundId}.`),
        recipe.copy("status", "Status zwrotu: zakończony (succeeded)."),
        ...(scope ? [recipe.copy(scope === "pełny" ? "scopeFull" : "scopePartial", `Zakres zwrotu: ${scope}.`)] : []),
        recipe.copy("total", `Łącznie zwrócono: ${data.totalRefunded} ${data.currency}.`),
        recipe.copy("date", `Data zwrotu: ${data.refundedAt}.`),
        ...(data.reason?.trim() ? [recipe.copy("reason", `Powód: ${data.reason}.`)] : []),
      ], "\n\n"),
    }, recipe);
    return result;
  },
};
