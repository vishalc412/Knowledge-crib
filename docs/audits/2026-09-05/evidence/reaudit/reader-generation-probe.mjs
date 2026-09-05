// Small deterministic diagnostic separating durable index truth from connected MCP reader truth.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const cli=resolve('packages/cli/dist/bin.js');
const root=mkdtempSync(join(tmpdir(),'crib-audit-generation-'));
const env={...process.env,KCRIB_MEMORY_DIR:join(root,'memory'),KCRIB_REGISTRY_DIR:join(root,'registry')};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const run=(cmd,args)=>execFileSync(cmd,args,{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
const git=args=>run('git',args);
const clients=[];
class Client {
  constructor(){this.id=0;this.pending=new Map();this.stderr='';this.child=spawn(process.execPath,[cli,'serve',root,'--watch'],{cwd:root,env,stdio:['pipe','pipe','pipe']});clients.push(this);this.child.stderr.on('data',d=>this.stderr+=d);createInterface({input:this.child.stdout}).on('line',line=>{try{const m=JSON.parse(line),p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);p.resolve(m.result??m.error);}}catch{}});}
  request(method,params){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP timeout')),15000);this.pending.set(id,{resolve,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  async init(){await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'audit-generation',version:'1'}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}
  async tool(name,args){const result=await this.request('tools/call',{name,arguments:args});return JSON.parse(result.content.find(c=>c.type==='text').text);}
  async close(){if(this.child.exitCode===null&&this.child.signalCode===null){const exited=new Promise(r=>this.child.once('exit',r));this.child.kill('SIGTERM');await exited;}for(const p of this.pending.values())clearTimeout(p.timer);}
}
try {
  const file=join(root,'app.ts');writeFileSync(file,'export function auditOriginalBranch() { return 0; }\n');
  git(['init','-q','-b','original']);git(['add','app.ts']);
  const commit=message=>git(['-c','user.name=Audit Fixture','-c','user.email=audit@example.invalid','commit','-qm',message]);commit('original');
  git(['checkout','-qb','alternate']);writeFileSync(file,'export function auditAlternateBranch() { return 1; }\n');git(['add','app.ts']);commit('alternate');git(['checkout','-q','original']);
  run(process.execPath,[cli,'index',root]);
  const reader=new Client();await reader.init();
  const baseline=await reader.tool('query',{q:'auditOriginalBranch',limit:5});
  git(['checkout','-q','alternate']);await delay(3000);
  const beforeUpdate=await reader.tool('query',{q:'auditAlternateBranch',limit:5});
  const updateOutput=run(process.execPath,[cli,'update',root]);await delay(3500);
  const connectedAfterUpdate=await reader.tool('query',{q:'auditAlternateBranch',limit:5});
  const connectedStatus=await reader.tool('status',{});
  const fresh=new Client();await fresh.init();
  const restartedAfterUpdate=await fresh.tool('query',{q:'auditAlternateBranch',limit:5});
  const freshStatus=await fresh.tool('status',{});
  const hits=result=>(result.hits??[]).map(h=>h.id);
  console.log(JSON.stringify({format:'knowledge-crib-reader-generation-audit',generatedAt:new Date().toISOString(),baseline:hits(baseline),cleanBranchSwitchAfter3s:hits(beforeUpdate),updateOutput,connectedAfterUpdate:hits(connectedAfterUpdate),connectedStatus,restartedAfterUpdate:hits(restartedAfterUpdate),freshStatus,connectedStderr:reader.stderr},null,2));
}finally{for(const client of clients)await client.close();rmSync(root,{recursive:true,force:true});}
