// Build a staging-only Node composition. The normal build-node.mjs is untouched.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
await build({ entryPoints: ['src/runtime/node-api.ts'], outfile: 'dist/node-api.mjs', bundle: true, platform: 'node',
  format: 'esm', packages: 'external', plugins: [{name:'staging',setup(b){
    b.onResolve({filter:/\/bundled\.ts$/},()=>({path:resolve('src/runtime/config.ts')}));
    b.onResolve({filter:/\/assets\/logo$/},()=>({path:resolve('src/assets/logo.example.ts')}));
    b.onLoad({filter:/\/runtime\/node-api\.ts$/},({path})=>{
      let contents=readFileSync(path,'utf8');
      const selection="const sender = provider === 'smtp' ? smtpFromEnv(process.env) : sendEmail;";
      const call="const response = await handler(new Request(new URL(incoming.url ?? '/', 'http://localhost:8080'), init), env, ctx);";
      if(!contents.includes(selection)||!contents.includes(call))throw Error('Staging composition source mismatch');
      contents=contents.replace(selection,"if(provider!=='ses')throw Error('Staging requires SES'); const sender = stagingSender;")
        .replace(call,"const response = await stagingOutcome(() => handler(new Request(new URL(incoming.url ?? '/', 'http://localhost:8080'), init), env, ctx));");
      return{contents:`import {stagingSender,stagingOutcome} from '../../scripts/staging/node-sender';\n`+contents,loader:'ts'};
    });
  }}] });
