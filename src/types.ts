/** Worker bindings (vars + secrets + KV). Mirrors wrangler.toml + `wrangler secret`. */
export interface Env {
  // vars
  SES_REGION: string;
  /** Default brand id for the Sellf webhook when `?brand=` is omitted (optional). */
  SELLF_DEFAULT_BRAND?: string;
  // secrets (set via `wrangler secret put`)
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  TURNSTILE_SECRET: string;
  API_KEY: string;
  // KV (optional so tests / misconfigured envs degrade gracefully)
  RATE_LIMIT?: KVNamespace;
}

/** Visual + contact identity used to render a brand's email. */
export interface BrandTheme {
  accent: string;
  accent2?: string;
  logoUrl?: string;
  siteUrl: string;
  address?: string;
  phone?: string;
}

/** A single tenant: where mail goes, who may submit, and how it looks. */
export interface Brand {
  id: string;
  name: string;
  /** Verified SES sender, e.g. "Foo <info@foo.example>". */
  from: string;
  /** Fixed recipient(s). The request body can NEVER change this (anti-relay). */
  to: string[];
  /** Origins allowed to submit in public mode. */
  allowedOrigins: string[];
  subjectPrefix: string;
  theme: BrandTheme;
  /**
   * Default for the public-contact auto-reply (confirmation back to the
   * submitter). A per-request `autoreply` control key overrides this. Default false.
   */
  autoReply?: boolean;
  /** Template used for the auto-reply. Default "received". */
  autoReplyTemplate?: string;
}

/** A submitted content field after coercion (control keys are stripped out). */
export interface ContentField {
  key: string;
  value: string;
}

/** Inputs to the email renderer. */
export interface RenderInput {
  subject: string;
  fields: ContentField[];
  message?: string;
  meta: {
    receivedAt: string;
    origin: string;
    ip: string;
  };
}

export interface RenderedEmail {
  html: string;
  text: string;
}

/** Flat content fields from the request (control keys already stripped). */
export type TemplateData = Record<string, string>;

/** What a template type produces; the layout wraps this with brand chrome. */
export interface RenderedBody {
  heading: string;
  bodyHtml: string;
  bodyText: string;
  previewText?: string;
}

/** Inputs to the shared branded layout. */
export interface LayoutInput {
  heading: string;
  bodyHtml: string;
  bodyText: string;
  previewText?: string;
}

/**
 * A kind of email (contact form, welcome, payment receipt, ...). Each owns its
 * subject + content; the shared layout supplies the brand header/footer chrome.
 */
export interface TemplateDef {
  id: string;
  /** Whether public (browser) requests may select this type. Only 'contact' is true. */
  publicAllowed?: boolean;
  subject(brand: Brand, data: TemplateData): string;
  render(brand: Brand, data: TemplateData): RenderedBody;
}

/** Result of an SES send attempt. */
export interface SendResult {
  ok: boolean;
  status: number;
}

/** Parameters passed to the SES sender. */
export interface SendParams {
  from: string;
  to: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

/** Injectable side effects, so the handler stays pure and testable. */
export interface SendDeps {
  verifyTurnstile: (
    secret: string,
    token: string,
    remoteIp: string | null,
  ) => Promise<boolean>;
  sendEmail: (env: Env, params: SendParams) => Promise<SendResult>;
  now: () => Date;
  /**
   * Keep a background task alive past the response (Worker `ctx.waitUntil`). Used
   * for the best-effort auto-reply. When absent, the task is detached instead.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}
