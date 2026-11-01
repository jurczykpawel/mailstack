import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
it('locates TEST-WORKER status offline without credential lookup or printing tokens',()=>{
  const dir=mkdtempSync(join(tmpdir(),'worker-status-')),path=join(dir,'status.json');
  const run=()=>spawnSync('bash',['scripts/test-worker.sh','status'],{encoding:'utf8',env:{...process.env,MAILSTACK_TEST_WORKER_STATUS:path}});
  try {
    const missing=run(); expect(missing.status).toBe(3); expect(missing.stdout).toContain(path);
    writeFileSync(path,JSON.stringify({url:'https://mailstack-test.test.workers.dev',tokens:{legacy:'private-token'},database:'mailstack-preview'}));
    const ready=run(); expect(ready.status,ready.stderr).toBe(0); expect(ready.stdout).toContain(path);
    expect(ready.stdout).toContain('mailstack-preview'); expect(ready.stdout+ready.stderr).not.toContain('private-token');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
