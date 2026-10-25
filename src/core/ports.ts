import type { Env, SendParams, SendResult } from '../types';
import type { MessageStore } from './store/messages';

export type Sender = (env: Env, params: SendParams) => Promise<SendResult>;

export interface Store extends MessageStore {
  health(): Promise<void>;
  migrate(): Promise<void>;
  consume(key: string, expiresAt: number): Promise<boolean>;
  increment(key: string, expiresAt: number): Promise<number>;
  purgeGuards(now: number): Promise<void>;
}
