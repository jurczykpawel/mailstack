import type { JsonLdBlock } from "../types";

/** schema.org context every block is emitted with (callers may override in `raw`). */
export const SCHEMA_CONTEXT = "https://schema.org";

type Rec = Record<string, unknown>;

/** Trimmed string, or "" for anything non-string. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** True for a syntactically valid http(s) URL (rejects javascript:/data: etc.). */
export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Go-to button in the message bar. Requires a name and an http(s) url. */
export function viewAction(d: Rec): JsonLdBlock | null {
  const name = str(d.name);
  if (!name || !isHttpUrl(d.url)) return null;
  const block: JsonLdBlock = {
    "@context": SCHEMA_CONTEXT,
    "@type": "EmailMessage",
    potentialAction: { "@type": "ViewAction", url: d.url, name },
  };
  const desc = str(d.description);
  if (desc) block.description = desc;
  return block;
}

/** One-click confirm; Gmail issues the HTTP request itself. Requires name + url. */
export function confirmAction(d: Rec): JsonLdBlock | null {
  const name = str(d.name);
  if (!name || !isHttpUrl(d.url)) return null;
  const block: JsonLdBlock = {
    "@context": SCHEMA_CONTEXT,
    "@type": "EmailMessage",
    potentialAction: {
      "@type": "ConfirmAction",
      name,
      handler: { "@type": "HttpActionHandler", url: d.url },
    },
  };
  const desc = str(d.description);
  if (desc) block.description = desc;
  return block;
}

/** Parcel-tracking action. Requires an http(s) tracking url. */
export function trackAction(d: Rec): JsonLdBlock | null {
  if (!isHttpUrl(d.url)) return null;
  const block: JsonLdBlock = {
    "@context": SCHEMA_CONTEXT,
    "@type": "ParcelDelivery",
    trackingUrl: d.url,
    potentialAction: { "@type": "TrackAction", target: d.url },
  };
  const tn = str(d.trackingNumber);
  if (tn) block.trackingNumber = tn;
  return block;
}

/** Promotions-tab discount annotation. Requires a discountCode. */
export function discountOffer(d: Rec): JsonLdBlock | null {
  const code = str(d.discountCode);
  if (!code) return null;
  const block: JsonLdBlock = {
    "@context": SCHEMA_CONTEXT,
    "@type": "DiscountOffer",
    discountCode: code,
  };
  const desc = str(d.description);
  if (desc) block.description = desc;
  const starts = str(d.availabilityStarts);
  if (starts) block.availabilityStarts = starts;
  const ends = str(d.availabilityEnds);
  if (ends) block.availabilityEnds = ends;
  return block;
}

/** Promotions-tab image card. Requires at least one http(s) image. */
export function promotionCard(d: Rec): JsonLdBlock | null {
  const candidates = Array.isArray(d.images)
    ? d.images
    : d.image !== undefined
      ? [d.image]
      : [];
  const image = candidates.filter(isHttpUrl);
  if (image.length === 0) return null;
  const block: JsonLdBlock = {
    "@context": SCHEMA_CONTEXT,
    "@type": "PromotionCard",
    image,
  };
  const name = str(d.name);
  if (name) block.name = name;
  if (isHttpUrl(d.url)) block.url = d.url;
  return block;
}

/** Brand logo/organization. Requires a name and an http(s) logo url. */
export function organization(d: Rec): JsonLdBlock | null {
  const name = str(d.name);
  if (!name || !isHttpUrl(d.logo)) return null;
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "Organization",
    name,
    logo: d.logo,
  };
}

/** Generic wrapper: any schema.org `type` + flat `props`. Requires a type. */
export function schema(d: Rec): JsonLdBlock | null {
  const type = str(d.type);
  if (!type) return null;
  const props =
    d.props && typeof d.props === "object" && !Array.isArray(d.props)
      ? (d.props as Rec)
      : {};
  return { "@context": SCHEMA_CONTEXT, "@type": type, ...props };
}

/** Raw passthrough: a full JSON-LD object with a string `@type`. */
export function raw(d: Rec): JsonLdBlock | null {
  const value = d.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Rec;
  if (!str(obj["@type"])) return null;
  // Inject a default context; a caller-provided "@context" in obj overrides it.
  return { "@context": SCHEMA_CONTEXT, ...obj };
}
