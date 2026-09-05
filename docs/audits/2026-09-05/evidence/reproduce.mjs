import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const repo = process.cwd();
const freshnessUrl = pathToFileURL(join(repo,'packages/cli/dist/freshness.js')).href;
const memoryUrl = pathToFileURL(join(repo,'packages/memory/dist/index.js')).href;
const dir = mkdtempSync(join(tmpdir(), 'crib-audit-probes-'));
const out = { checkout: repo, queue: [], identity: {} };
try {
  const { readFreshnessQueue } = await import(freshnessUrl);
  const childFile = join(dir, 'writer.mjs');
  writeFileSync(childFile, `import { enqueueFreshness } from ${JSON.stringify(freshnessUrl)};\nprocess.send('ready');\nprocess.on('message', ({root, registry}) => { const acked=[]; const errors=[]; for(let i=0;i<25;i++) { try { enqueueFreshness(root+'-'+i, 'head-'+i, {KCRIB_REGISTRY_DIR:registry}); acked.push(root+'-'+i); } catch(e) { errors.push(e.code || e.message); } } process.send({acked,errors}); process.exit(0); });\n`);
  for (let trial=0;trial<3;trial++) {
    const registry = join(dir, 'registry-'+trial);
    const children = Array.from({length:8},()=>fork(childFile,[],{stdio:['ignore','ignore','ignore','ipc']}));
    await Promise.all(children.map(c=>new Promise(r=>c.once('message',r))));
    const pending = children.map(c=>new Promise(r=>c.once('message',r)));
    children.forEach((c,i)=>c.send({root:'/test/project-'+i,registry}));
    const results = await Promise.all(pending);
    await Promise.all(children.map(c=>c.exitCode!==null?Promise.resolve():new Promise(r=>c.once('exit',r))));
    const retained=readFreshnessQueue({KCRIB_REGISTRY_DIR:registry}).pending; const acknowledged=results.flatMap(r=>r.acked); const errors=results.flatMap(r=>r.errors); out.queue.push({trial,attempted:200,acknowledged:acknowledged.length,retained:retained.length,acknowledgedButMissing:acknowledged.filter(root=>!retained.some(t=>t.projectRoot===root)).length,errorCount:errors.length,errorTypes:[...new Set(errors)]});
  }
  const { MemoryStore, MemoryApi, memoryRecordV2Id, derivePropositionKey, gatherRecall, memoryRecordV3Id } = await import(memoryUrl);
  const env={ KCRIB_MEMORY_DIR:join(dir,'memory'), KCRIB_PRINCIPAL_ID:'principal:A' };
  const local = MemoryStore.local('audit-repo',{env});
  const subject='topic:deployment';
  const evidence=[{kind:'source-quote',verdict:'valid',checkedAt:'2026-09-05T00:00:00.000Z',soulId:subject,quote:'Synthetic deployment rule',targetHash:'blake3:abcd1234'}];
  const seed={kind:'fact',subject,propositionKey:derivePropositionKey({subject}),claim:'Synthetic principal B private deployment rule',evidence};
  const record={...seed,id:memoryRecordV2Id(seed),schemaVersion:'2',visibility:'private',validTime:{from:'2026-09-05T00:00:00.000Z'},transactionTime:{observedAt:'2026-09-05T00:00:00.000Z',recordedAt:'2026-09-05T00:00:00.000Z'},provenance:{principalId:'principal:B',deviceId:'test',actorId:'test',clientId:'test'},lineage:{},sensitivity:'internal',retentionPolicyId:'ret:default'};
  local.upsertEntries('active',[record]);
  const api=new MemoryApi({stores:{local},env});
  const gathered=gatherRecall({local},{env});
  const got=api.get(record.id);
  out.identity={caller:'principal:A',recordPrincipal:'principal:B',gatheredCount:gathered.records.length,excluded:gathered.principalExcluded,getFound:got.found,returnedPrincipal:got.record?.provenance?.principalId,historyCount:api.history(record.id).records?.length};
  const namespace={principalId:'principal:B',projectId:'audit-repo'};
  const v3={...record,schemaVersion:'3',namespace,id:memoryRecordV3Id({...seed,namespace})};
  local.upsertEntries('active',[v3]);
  const v3gather=gatherRecall({local},{env});
  let v3search;
  try { const found=api.search('deployment',{fresh:false,limit:5}); v3search={ok:true,resultKeys:Object.keys(found),count:found.hits?.length}; } catch(e) {v3search={ok:false,error:e.message};}
  let ownSearch; try { new MemoryApi({stores:{local},env:{...env,KCRIB_PRINCIPAL_ID:'principal:B'}}).search('deployment',{fresh:false,limit:5}); ownSearch={ok:true}; } catch(e) { ownSearch={ok:false,error:e.message}; }
  out.v3={ownPrincipalSearch:ownSearch,gathered:v3gather.records.map(r=>({schemaVersion:r.record.schemaVersion,principal:r.record.provenance?.principalId})),excluded:v3gather.principalExcluded,search:v3search};
  console.log(JSON.stringify(out,null,2));
} finally { rmSync(dir,{recursive:true,force:true}); }
