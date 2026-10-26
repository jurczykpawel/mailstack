import { z } from 'zod';
import type { SendResult } from '../types';

export const resendPayload = z.strictObject({
  to: z.array(z.email().max(320)).min(1).max(5),
  template: z.string().min(1).max(128),
  data: z.record(z.string().max(128), z.string().max(5000)).refine(v => Object.keys(v).length <= 43),
  replyTo: z.email().max(320).optional(), subjectOverride: z.string().max(5000).optional(),
  markup: z.array(z.unknown()).max(5).optional(),
});
export type ResendPayload = z.infer<typeof resendPayload>;
export interface ResendSource {
  id: string; brand: string; template: string; strategy: 'replay' | 'source';
  replay: { sealed: string; expires_at: number } | null;
  ref_sealed: string | null;
  owner?: { clientId: string; callback: { url: string; secretEnv: string } };
}
export interface ResendRequest { messageId: string; reason: string; idempotencyKey: string; replay?: unknown }
export type ResendOutcome = SendResult & { resendId?: string; source?: ResendSource };
export interface ResendCapability {
  source(messageId: string): Promise<ResendSource | SendResult>;
  request(input: ResendRequest): Promise<ResendOutcome>;
}
