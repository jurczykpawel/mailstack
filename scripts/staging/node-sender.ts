import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sendEmail } from '../../src/ses';
import { budgetSender, budgetResponse } from './ses-budget';
const outcome = new AsyncLocalStorage<{reason?: string}>();
let database: Database.Database | undefined;
const limits = { day: Number(process.env.STAGING_SES_DAY ?? 50), hour: Number(process.env.STAGING_SES_HOUR ?? 10) };
if (limits.day > 50 || limits.hour > 10) throw new Error('Invalid staging allocation');
const sender = budgetSender(async (sql, values = []) => {
  database ??= new Database('/data/staging-ses-budget.db');
  database.pragma('busy_timeout=5000');
  const statement = database.prepare(sql);
  return statement.reader ? statement.all(...values) : (statement.run(...values), []);
}, sendEmail, process.env.MAILSTACK_STAGING_FROM!, limits);
export const stagingSender: typeof sendEmail = async (env, params) => {
  const result = await sender(env, params);
  if (!result.ok && typeof result.response === 'string' && result.response.startsWith('staging_')) {
    const state = outcome.getStore(); if (state) state.reason = result.response;
  }
  return result;
};
export const stagingOutcome = (call: () => Promise<Response>) => outcome.run({}, async () => {
  const response = await call(); return budgetResponse(response, outcome.getStore()?.reason);
});
