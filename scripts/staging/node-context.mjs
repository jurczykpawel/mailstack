// Prepare an isolated build context; never edits either product source tree.
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [core,pro,output,...extra]=process.argv.slice(2);
if(!core||!pro||!output||extra.length)throw Error('Use node-context.mjs CORE PRO NEW_OUTPUT');
execFileSync(process.execPath,[resolve(pro,'scripts/container-context.mjs'),resolve(core),resolve(output)],{stdio:'inherit'});
const here=dirname(fileURLToPath(import.meta.url)),target=resolve(output,'mailstack/scripts/staging');
mkdirSync(target);
for(const file of ['ses-budget.ts','node-sender.ts','build-node.mjs'])copyFileSync(resolve(here,file),resolve(target,file));
writeFileSync(resolve(output,'mailstack/scripts/build-node.mjs'),"import './staging/build-node.mjs';\n");
