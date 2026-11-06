type Kind = "text" | "email" | "url";
const entries = {
  contact: ["name email:email phone type topic person message gdpr Imię_i_nazwisko _receivedAt _origin _ip", "messageLabel receivedAtLabel originLabel ipLabel", ""],
  received: ["name summary refId", "greetingWithName greetingWithoutName intro refLabel", ""],
  welcome: ["name intro body ctaUrl:url ctaLabel productName accessId", "headingWithName headingWithoutName", "main"],
  payment: ["name amount currency item description orderId date invoiceUrl:url orderUrl:url settledVia", "branchHeading transferHeading intro transferIntro greetingWithName greetingWithoutName", "invoice orderMarkup"],
  license: ["name productName tier domain licenseKey activationUrl:url instructions productId licenseId", "branchHeading intro greetingWithName greetingWithoutName keyLabel preview", "activation"],
  notice: ["heading paragraphs ctaUrl:url ctaLabel", "fallbackHeading fallbackSubject", "main"],
  refund: ["amount currency productName transactionId paymentId refundId isFullRefund totalRefunded refundedAt reason", "branchHeading amount transaction payment refund status scopeFull scopePartial total date reason", ""],
  "bank-transfer": ["orderId holder account bank title amount currency deadline orderUrl:url reminder", "branchHeading reminderHeading intro reminderIntro", "order"],
} as const;
export type TemplateId = keyof typeof entries;
export const MANIFEST = Object.fromEntries(Object.entries(entries).map(([id, [fields, copy, ctas]]) => [id, {
  fields: Object.fromEntries(fields.split(" ").map(field => {
    const [key, kind = "text"] = field.split(":");
    return [key === "Imię_i_nazwisko" ? "Imię i nazwisko" : key, { kind: kind as Kind }];
  })), copy: copy.split(" ").filter(Boolean), ctas: ctas.split(" ").filter(Boolean),
}])) as Record<TemplateId, { fields: Record<string, { kind: Kind }>; copy: string[]; ctas: string[] }>;
export const COMMON_SLOTS = ["greetingWithName", "greetingWithoutName"];
export const CONTEXT_FIELDS = ["brand.id", "brand.name", "brand.subjectPrefix"];
export const HEADER_FIELDS: Record<TemplateId, Record<"subject" | "heading" | "previewText", string[]>> = {
  contact: { subject: ["type"], heading: ["type"], previewText: [] },
  received: { subject: [], heading: [], previewText: [] },
  welcome: { subject: [], heading: ["name"], previewText: ["intro", "body", "name"] },
  payment: { subject: ["orderId", "settledVia"], heading: ["settledVia"], previewText: ["amount", "currency", "settledVia"] },
  license: { subject: ["productName"], heading: [], previewText: ["productName"] },
  notice: { subject: ["heading"], heading: ["heading"], previewText: ["paragraphs", "heading"] },
  refund: { subject: [], heading: [], previewText: ["amount", "currency", "productName"] },
  "bank-transfer": { subject: ["orderId", "reminder"], heading: ["reminder"], previewText: ["reminder"] },
};
