import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const state=process.argv[2], status=JSON.parse(readFileSync(state+'/status.json'));
status.invitations={};
for(const role of ['viewer','operator','admin']) if(existsSync(state+'/invite-'+role+'.txt')) status.invitations[role]=readFileSync(state+'/invite-'+role+'.txt','utf8').trim();
writeFileSync(state+'/status.json',JSON.stringify(status,null,2),{mode:0o600});
console.log('API http://localhost:18880 | Panel https://localhost:18890 | Mailpit http://localhost:18825');
console.log('Playground http://localhost:18882 | Receiver https://localhost:18843/records');
console.log('Accounts, tokens and invitations: '+state+'/status.json (0600; invitations expire after 15 minutes, use invite again)');
