import type { MessageStore } from './store/messages';

export interface Store extends MessageStore {
  migrate(): Promise<void>;
  consume(key: string, expiresAt: number): Promise<boolean>;
  increment(key: string, expiresAt: number): Promise<number>;
  purgeGuards(now: number): Promise<void>;
}
