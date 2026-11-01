import {readFileSync} from 'node:fs';
const path=process.env.MAILSTACK_TEST_WORKER_STATUS??'/private/tmp/mailstack-test-worker/status.json';
try {
  const record=JSON.parse(readFileSync(path,'utf8'));
  if(!record.url||record.database!=='mailstack-preview') throw Error('Incomplete record');
  console.log(JSON.stringify({status:'RECORDED_NOT_LIVE_VERIFIED',path,url:record.url,database:record.database}));
} catch {
  console.log(JSON.stringify({status:'UNAVAILABLE',path,action:'Coordinator must provision TEST-WORKER and deliver its manifest before W tests'}));
  process.exitCode=3;
}
