// Reference-repository watch measurement. Copies tracked source into an isolated Git repository.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
const origin = process.cwd();
const cli = resolve('packages/cli/dist/bin.js');
const base = mkdtempSync(join(tmpdir(), 'crib-audit-full-watch-'));
const env = {...process.env, KCRIB_MEMORY_DIR:join(base,'isolated-memory'), KCRIB_REGISTRY_DIR:join(base,'isolated-registry')};
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
const shell = (cmd,args)=>execFileSync(cmd,args,{cwd:base,env,encoding:'utf8',maxBuffer:64*1024*1024,timeout:480000,stdio:['ignore','pipe','pipe']});
const git = args=>shell('git',args);
const sourceRel = 'packages/cli/src/reaudit-clock.ts';
const source = join(base,sourceRel);
class Client {
  constructor(){this.i=0;this.pending=new Map();this.stderr='';this.child=spawn(process.execPath,[cli,'serve',base,'--watch'],{cwd:base,env,stdio:['pipe','pipe','pipe']});this.exit=new Promise(r=>this.child.once('exit',r));this.child.stderr.on('data',d=>this.stderr+=d);createInterface({input:this.child.stdout}).on('line',line=>{try{const m=JSON.parse(line),p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}catch{}});}
  request(method,params){const id=++this.i;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('request timeout')),30000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  async init(){await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'audit-full-watch',version:'1'}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}
  async query(q){const r=await this.request('tools/call',{name:'query',arguments:{q,limit:5}});if(r.isError)throw new Error(JSON.stringify(r));return JSON.parse(r.content.find(x=>x.type==='text').text);}
  async found(q){return (await this.query(q)).hits.some(h=>h.id.includes('#'+q+'@'));}
  async close(){this.child.stdin.end();await Promise.race([this.exit,sleep(1500)]);if(this.child.exitCode===null)this.child.kill('SIGKILL');for(const p of this.pending.values())clearTimeout(p.timer);}
}
let client;
try {
  const paths = execFileSync('git',['ls-files','-z'],{cwd:origin,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(p=>p&&!p.startsWith('.crib/'));
  for(const path of paths){const to=join(base,path);mkdirSync(dirname(to),{recursive:true});copyFileSync(join(origin,path),to);}
  writeFileSync(source,'export function auditBranchOriginal() { return 0; }\n');
  git(['init','-q','-b','audit-original']);git(['add','.']);
  const commit=message=>git(['-c','user.name=Audit Fixture','-c','user.email=audit@example.invalid','commit','-qm',message]);
  commit('reference source snapshot');
  git(['checkout','-qb','audit-alternate']);writeFileSync(source,'export function auditBranchAlternate() { return 99; }\n');git(['add',sourceRel]);commit('branch transition fixture');git(['checkout','-q','audit-original']);
  process.stderr.write(`Indexing ${paths.length} tracked files copied from reference repository\n`);
  const indexingStart=performance.now();const indexing=shell(process.execPath,[cli,'index',base,'--package','all']);
  process.stderr.write(`Index done in ${Math.round(performance.now()-indexingStart)}ms; starting MCP reader\n`);
  client=new Client();await client.init();
  const waitFor = async(q,expected=true,limit=7000)=>{const start=performance.now();let matched=false;while(performance.now()-start<limit){if((await client.found(q))===expected){matched=true;break;}await sleep(50);}return {matched,ms:Math.round(performance.now()-start)};};
  const baseline=await client.found('auditBranchOriginal');
  const saves=[];
  for(let i=0;i<52;i++){const marker=`auditFullSaveMarker${i}`;const start=performance.now();writeFileSync(source,`export function ${marker}() { return ${i}; }\n`);const result=await waitFor(marker);if(i>=2)saves.push({iteration:i-2,found:result.matched,ms:Math.round(performance.now()-start)});}
  process.stderr.write('50 measured saves completed; checking rename, delete, branch, restart and explicit update\n');
  const renamed=join(base,'packages/cli/src/reaudit-renamed.ts');renameSync(source,renamed);
  const rename=await waitFor('auditFullSaveMarker51');
  const renameHits=(await client.query('auditFullSaveMarker51')).hits.map(h=>h.id).filter(id=>id.includes('#auditFullSaveMarker51@'));
  rmSync(renamed);const deletion=await waitFor('auditFullSaveMarker51',false);
  git(['checkout','--',sourceRel]);await waitFor('auditBranchOriginal');
  git(['checkout','-q','audit-alternate']);const branch=await waitFor('auditBranchAlternate');
  const oldAfterBranch=await client.found('auditBranchOriginal');
  await client.close();client=new Client();await client.init();
  const afterRestart=await waitFor('auditBranchAlternate',true,3000);
  shell(process.execPath,[cli,'update',base]);const afterExplicitUpdate=await waitFor('auditBranchAlternate',true,7000);
  const times=saves.filter(x=>x.found).map(x=>x.ms).sort((a,b)=>a-b);
  const percentile=p=>times.length?times[Math.ceil(times.length*p)-1]:null;
  console.log(JSON.stringify({format:'knowledge-crib-reference-watch-audit',generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:origin,encoding:'utf8'}).trim(),copiedTrackedFiles:paths.length,indexing:indexing.trim(),baseline,configuration:'explicit --watch; no service/hooks installed in isolated repo; real stdio MCP; 2 warmup + 50 measured saves; 50ms polling',saves,saveSummary:{success:saves.filter(x=>x.found).length,timeouts:saves.filter(x=>!x.found).length,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99)},rename:{...rename,ids:renameHits},deletion,cleanBranchSwitch:{...branch,oldSymbolStillFound:oldAfterBranch},afterRestart,afterExplicitUpdate},null,2));
} finally {if(client)await client.close();rmSync(base,{recursive:true,force:true});}
