// A foreign principal receives the same isolated store configuration used by the repaired record probe.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { MemoryStore, MemoryApi } = await import(pathToFileURL(resolve('packages/memory/dist/index.js')).href);
const root = mkdtempSync(join(tmpdir(), 'crib-audit-intake-isolation-'));
try {
  const env = {KCRIB_MEMORY_DIR:root,KCRIB_PRINCIPAL_ID:'principal:B'};
  const local=MemoryStore.local('isolation-fixture',{env});
  const owner=new MemoryApi({stores:{local},env});
  const requirement=owner.createIntake({
    namespace:{principalId:'principal:B',projectId:'isolation-fixture'},
    original:'Synthetic private principal B task',
    interpretation:{outcome:'Complete the synthetic private task',scope:[],constraints:[],acceptanceCriteria:[]},
    sensitivity:'internal',retentionPolicyId:'default',
    provenance:{principalId:'principal:B',deviceId:'fixture',actorId:'fixture',clientId:'fixture'},
    createdAt:'2026-09-05T00:00:00.000Z',
  });
  owner.checkpointIntake({intakeId:requirement.id,kind:'progress',phase:'executing',nextSafeAction:'Synthetic private next action',summary:'Private synthetic checkpoint',audience:'private',repository:{dirty:false},actor:'principal:B',recordedAt:'2026-09-05T00:01:00.000Z'});
  const reader=new MemoryApi({stores:{local},env:{...env,KCRIB_PRINCIPAL_ID:'principal:A'}});
  const retrieved=reader.getIntake(requirement.id);
  const handoff=reader.handoff();
  let mutation;
  try {
    const checkpoint=reader.checkpointIntake({intakeId:requirement.id,kind:'progress',phase:'executing',nextSafeAction:'Synthetic foreign-authored action',summary:'Foreign caller modified private continuation',audience:'private',repository:{dirty:false},actor:'principal:A',recordedAt:'2026-09-05T00:02:00.000Z'});
    mutation={accepted:true,checkpointId:checkpoint.id};
  } catch(error) {mutation={accepted:false,error:error.message};}
  console.log(JSON.stringify({format:'knowledge-crib-intake-isolation-audit',generatedAt:new Date().toISOString(),caller:'principal:A',owner:'principal:B',audience:retrieved?.checkpoints[0]?.audience,getFound:Boolean(retrieved),listExposesIntake:reader.listIntakes().choices.some(x=>x.intakeId===requirement.id),handoffExposesIntake:handoff.intakes.choices.some(x=>x.intakeId===requirement.id),foreignCheckpoint:mutation,qualification:'Library API shared-store principal boundary; default local stdio is OS-user scoped. Not a remote unauthenticated exploit.'},null,2));
} finally {rmSync(root,{recursive:true,force:true});}
