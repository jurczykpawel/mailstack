// Run once on the owner's computer, with an empty, dedicated register prefix.
import { initTombstoneRegistry } from '../../src/core/offsite.ts';
await initTombstoneRegistry(process.env);
console.log('Erasure register initialized; retain TOMBSTONE_REGISTRY_ID with the backups.');
