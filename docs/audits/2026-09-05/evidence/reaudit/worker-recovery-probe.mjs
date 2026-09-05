// Isolated reproduction of concurrent worker startup followed by hard process loss.
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleUrl = pathToFileURL(resolve('packages/cli/dist/freshness.js')).href;
const { FreshnessWorker, enqueueFreshness, readFreshnessQueue, readWorkerState } = await import(moduleUrl);
const root = mkdtempSync(join(tmpdir(), 'crib-audit-worker-recovery-'));
const env = { KCRIB_REGISTRY_DIR: join(root, 'registry') };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const children = [];
let recovery;
try {
  const path = join(root, 'worker.mjs');
  writeFileSync(path, `import { FreshnessWorker } from ${JSON.stringify(moduleUrl)};
process.send({ready:true});
process.on('message', async ({env}) => {
  const worker = new FreshnessWorker({env, pollMs:25, heartbeatMs:50,
    revalidate:async(task)=>{process.send({claimed:task.projectRoot}); await new Promise(()=>{}); return {generation:'unreachable'};}});
  try { await worker.start(); process.send({started:true}); }
  catch(error) { process.send({started:false,error:error.message}); }
});
`);
  const group = Array.from({length:8}, () => fork(path, [], {stdio:['ignore','ignore','ignore','ipc']}));
  children.push(...group);
  await Promise.all(group.map((child) => new Promise((done) => child.once('message', done))));
  const claimed = [];
  const starts = group.map((child) => new Promise((done) => child.on('message', (message) => {
    if ('started' in message) done(message.started);
    if (message.claimed) claimed.push(message.claimed);
  })));
  for (const child of group) child.send({env});
  const elected = (await Promise.all(starts)).filter(Boolean).length;
  const acknowledged = [];
  for (let i=0; i<8; i++) {
    const project = `/synthetic/project-${i}`;
    enqueueFreshness(project, `head-${i}`, env);
    acknowledged.push(project);
  }
  await delay(900);
  const beforeCrash = {
    pending: readFreshnessQueue(env).pending.map((task) => task.projectRoot),
    active: readWorkerState(env)?.activeTask?.projectRoot,
  };
  await Promise.all(group.map((child) => new Promise((done) => {child.once('exit', done); child.kill('SIGKILL');})));
  const recovered = [];
  recovery = new FreshnessWorker({env, pollMs:10, heartbeatMs:50, revalidate: async(task) => {recovered.push(task.projectRoot); return {generation:`audit:${task.head}`};}});
  await recovery.start();
  await delay(700);
  await recovery.stop();
  recovery = undefined;
  const pending = readFreshnessQueue(env).pending.map((task) => task.projectRoot);
  console.log(JSON.stringify({format:'knowledge-crib-worker-crash-recovery-audit', generatedAt:new Date().toISOString(), contenders:8, elected, acknowledged, claimed, beforeCrash, recovered, pending, acknowledgedMissingAfterRecovery: acknowledged.filter((project)=>!recovered.includes(project)&&!pending.includes(project)), qualification:'Synthetic eight-project queue; concurrent real OS processes killed before any revalidation completes. Canonical memory records are not deleted.'}, null, 2));
} finally {
  if(recovery) await recovery.stop();
  for (const child of children) if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');
  rmSync(root,{recursive:true,force:true});
}
