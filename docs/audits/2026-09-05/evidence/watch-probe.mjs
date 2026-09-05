import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
const repo = process.cwd();
const cli = resolve(repo,'packages/cli/dist/bin.js');
const base = mkdtempSync(join(tmpdir(),'crib-audit-watch-'));
const env = {...process.env,KCRIB_MEMORY_DIR:join(base,'memory'),KCRIB_REGISTRY_DIR:join(base,'registry')};
delete env.KCRIB_EMBEDDER;
const source = join(base,'example.ts');
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
function sh(cmd,args){return execFileSync(cmd,args,{cwd:base,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
class Client {
  constructor(watch){this.i=0;this.pending=new Map();this.stderr='';this.child=spawn(process.execPath,[cli,'serve',base,...(watch?['--watch']:[])],{cwd:base,env,stdio:['pipe','pipe','pipe']});this.exit=new Promise(r=>this.child.once('exit',r));this.child.stderr.on('data',d=>this.stderr+=d);createInterface({input:this.child.stdout}).on('line',line=>{try{const msg=JSON.parse(line);const p=this.pending.get(msg.id);if(p){clearTimeout(p.timer);this.pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}}catch{}});}
  request(method,params){const id=++this.i;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('request timeout')),15000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  async init(){await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'audit-freshness',version:'1'}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}
  async query(q){const result=await this.request('tools/call',{name:'query',arguments:{q,limit:3}});if(result.isError)throw new Error(JSON.stringify(result));return JSON.parse(result.content.find(x=>x.type==='text').text);}
  async close(){this.child.stdin.end();await Promise.race([this.exit,sleep(1500)]);if(this.child.exitCode===null)this.child.kill('SIGTERM');for(const p of this.pending.values())clearTimeout(p.timer);}
}
let client;
try {
  writeFileSync(source,'export function auditInitialMarker() { return 1; }\n');
  sh('git',['init','-q']);sh('git',['add','example.ts']);sh('git',['-c','user.name=Audit Fixture','-c','user.email=audit@example.invalid','commit','-qm','fixture']);
  sh(process.execPath,[cli,'index',base]);
  client=new Client(false);await client.init();
  const baseline=await client.query('auditInitialMarker');
  writeFileSync(source,'export function auditUnwatchedMarker() { return 2; }\n');
  await sleep(2500);
  const stale=await client.query('auditUnwatchedMarker');
  const old=await client.query('auditInitialMarker');
  const withoutWatch={baselineFound:baseline.hits.some(h=>h.id.includes('auditInitialMarker')),newSymbolFound:stale.hits.some(h=>h.id.includes('auditUnwatchedMarker')),oldSymbolStillFound:old.hits.some(h=>h.id.includes('auditInitialMarker')),afterMs:2500};
  await client.close();client=new Client(true);await client.init();
  const times=[];
  for(let i=0;i<10;i++){
    const marker='auditFreshMarker'+i;const start=performance.now();
    writeFileSync(source,`export function ${marker}() { return ${i}; }\n`);
    let found=false;
    while(performance.now()-start<7000){const result=await client.query(marker);if(result.hits.some(h=>h.id.includes('#'+marker+'@'))){found=true;break;}await sleep(50);}
    times.push({iteration:i,found,ms:Math.round(performance.now()-start)});
  }
  const sorted=times.map(x=>x.ms).sort((a,b)=>a-b);
  console.log(JSON.stringify({withoutWatch,withWatch:{fixture:`one TypeScript file; ${times.length} sequential change(s); real stdio MCP; 50ms polling; diagnostic, not the full-repo release gate`,times,observationDurationP95Ms:sorted[Math.ceil(sorted.length*.95)-1],successfulUpdates:times.filter(x=>x.found).length,timeouts:times.filter(x=>!x.found).length,successfulUpdateP95Ms:times.some(x=>!x.found)?null:sorted[Math.ceil(sorted.length*.95)-1]}},null,2));
} finally {if(client)await client.close();rmSync(base,{recursive:true,force:true});}
