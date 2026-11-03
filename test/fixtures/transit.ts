import { generateKeyPairSync } from 'node:crypto';
import { parseTransitKeys } from '../../src/core/keyring';
import { sealTransit, type TransitOp } from '../../src/core/transit';
import { panelEnv } from './panel';

const pair = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
export const transitEnv = { TRANSIT_KEYS: JSON.stringify({ keys: [{ ...pair, kid: 'tk1' }] }) };
const publicKey = (await parseTransitKeys(transitEnv.TRANSIT_KEYS)).publicKeys[0];

/** What the browser sends: the sensitive value sealed for this API's audience and one operation. */
export const seal = (payload: unknown, op: TransitOp, aud = panelEnv.PANEL_AUDIENCE, now = Date.now()) =>
  sealTransit(payload, { aud, op, messageId: null }, publicKey, now);
export const sealed = async (payload: unknown, op: TransitOp) => ({ envelope: await seal(payload, op) });
