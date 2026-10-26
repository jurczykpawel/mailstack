import { readFileSync,writeFileSync } from 'node:fs';
const [state,variant]=process.argv.slice(2), variants=JSON.parse(readFileSync(state+'/license-variants.json'));
if(!Object.hasOwn(variants,variant)) throw new Error('Use valid|expired|wrong-domain|revoked|bad-signature|missing');
writeFileSync(state+'/install/secrets/panel/license.json',JSON.stringify(variants[variant]),{mode:0o600});
const file=state+'/install/config/api.json',cfg=JSON.parse(readFileSync(file));
cfg.extensions[0].options={...variants[variant],webhooks:cfg.extensions[0].options.webhooks};
writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
console.log('Selected synthetic license variant: '+variant);
