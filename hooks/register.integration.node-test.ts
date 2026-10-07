import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from './register.ts'

const usage={input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}
const assessment=(extra={})=>JSON.stringify({type:'assessment',risk:'Low',authorization:'Unknown',narrowlyScoped:true,
  planCompatible:true,explicitProhibition:false,maliciousUntrustedInstruction:false,decisionCriticalUncertainty:false,
  reason:'Bounded development action.',evidenceIds:[],...extra})
const reply=(text:string)=>({isAnswered:true,text,usage})
function deferred<T=any>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
function fixture(options={}){
  const hooks=new Map<string,any[]>();const catches=new Map<any,any>()
  const on:any=(event:string,...args:any[])=>{const fn=args.at(-1);hooks.set(event,[...(hooks.get(event)??[]),fn]);return {catch:(handler:any)=>{catches.set(fn,handler)}}}
  register(on,options)
  let sessionId='s1';let modelCalls=0;let effects=0;let clock=100;let messages:any[]=[]
  const prompts:any[]=[];const agentReads:string[]=[]
  const timers:{active:boolean;fn:()=>void}[]=[]
  let complete:any=async(request:any)=>{prompts.push(request);return reply(assessment())}
  const $:any={
    session:{id:async()=>sessionId,cwd:async()=>'/work',root:async()=>'/work',messages:async(args:any)=>{if(args?.agentId){agentReads.push(args.agentId);return [{role:'user',text:'Scoped delegated task',toolUses:[]}]}return messages}},
    clock:{now:async()=>clock,sleep:async(ms:number)=>{clock+=ms},after:(_ms:number,fn:()=>void)=>{const timer={active:true,fn};timers.push(timer);return {cancel:()=>{timer.active=false}}}},
    fs:{stat:async(path:string)=>({kind:path==='/work'?'dir':'file',size:1,mtimeMs:1,isLink:false,realPath:path}),list:async()=>[],read:async()=>''},
    ui:{status:()=>{}},command:{register:async()=>({})},
    model:{complete:async(request:any)=>{modelCalls++;return complete(request)}},
    tool:{check:async()=>({decision:'allow'}),call:async()=>({result:{type:'text',file:{content:'native evidence'}}})},
  }
  const invoke=async(event:string,e:any,next:any)=>{const fn=hooks.get(event)![0];return fn($,e,next)}
  const controller=new AbortController()
  const nextCheck=(down:any={decision:'ask'},origin={plugin:'engine',tier:'core'},signal=controller.signal)=>{
    let count=0;const next:any=async()=>{count++;assert.equal(count,1,'ordinary next must run once');return down}
    next.origin=origin;next.signal=signal;next.trace=[{plugin:'engine',tier:'core',event:'tool.check',outcome:'returned',returned:down}]
    return next
  }
  const check=(input:any={tool:'Bash',input:{command:'echo bounded'},tool_use_id:'r1'},down?:any,origin?:any,signal?:AbortSignal)=>invoke('tool.check',input,nextCheck(down,origin,signal))
  const submit=(text:string,kind='composer',forward?:any,entered=true)=>{
    const next:any=forward??(async(e:any)=>({text:e.text}));next.trace=entered?[{plugin:'engine',tier:'core',event:'prompt.submit',outcome:'returned',returned:{text}}]:[]
    return invoke('prompt.submit',{text,origin:{kind},wait:false},next)
  }
  const call=async(e:any={tool:'Bash',command:'echo bounded',tool_use_id:'r1'},checkInput?:any,down?:any)=>{
    const verdict=await check(checkInput??{tool:e.tool,input:{command:e.command},tool_use_id:e.tool_use_id,agentId:e.agentId},down)
    if(verdict.decision==='allow'){effects++;return {result:{count:effects}}}return {deny:verdict.reason??'native ask'}
  }
  const attach=(type:string,agentId?:string)=>invoke('prompt.attachment',{type,origin:{kind:'engine'},agentId,text:''},async()=>({text:''}))
  return {$,hooks,catches,invoke,nextCheck,check,call,submit,attach,controller,prompts,agentReads,
    expireReviews:()=>{for(const timer of timers)if(timer.active)timer.fn()},
    setSession:(id:string)=>{sessionId=id},setMessages:(rows:any[])=>{messages=rows},setComplete:(fn:any)=>{complete=fn},get modelCalls(){return modelCalls},get effects(){return effects}}
}

const nativeCases:any[]=[
  [{tool:'Bash',input:{},tool_use_id:'r1'},{decision:'allow'},undefined],
  [{tool:'Bash',input:{},tool_use_id:'r1'},{decision:'deny',reason:'managed'},undefined],
  [{tool:'Bash',input:{},tool_use_id:'r1'},{decision:'ask',rule:'Bash(*)'},undefined],
  [{tool:'Edit',input:{file_path:'/work/a'},tool_use_id:'r1'},{decision:'ask',hook:'PreToolUse'},undefined],
  [{tool:'Bash',input:{},tool_use_id:'r1',ceiling:'ask'},{decision:'ask',ceiling:'ask'},undefined],
  [{tool:'AskUserQuestion',input:{},tool_use_id:'r1'},{decision:'ask'},undefined],
  [{tool:'ExitPlanMode',input:{},tool_use_id:'r1'},{decision:'ask'},undefined],
  [{tool:'Bash',input:{}},{decision:'ask'},undefined],
  [{tool:'Bash',input:{},tool_use_id:'r1'},{decision:'ask'},{plugin:'another-plugin',tier:'user'}],
]

test('native allows, denials, explicit asks, questions, plugin calls and queries are preserved',async()=>{
  for(const [input,down,origin] of nativeCases){const f=fixture();assert.deepEqual(await f.check(input,down,origin),down);assert.equal(f.modelCalls,0)}
})

test('metadata failure cannot block native allowed calls',async()=>{
  const f=fixture();f.$.session.id=async()=>{throw Error('metadata unavailable')}
  const result=await f.call(undefined,undefined,{decision:'allow'})
  assert.equal(result.result.count,1);assert.equal(f.effects,1);assert.equal(f.modelCalls,0)
})

test('workspace edits bypass model outage and status failures, while .git changes are reviewed',async()=>{
  const f=fixture();f.$.ui.status=()=>{throw Error('display unavailable')}
  f.setComplete(async()=>({isAnswered:false,reason:'api-error',status:401,error:'authentication_failed',usage}))
  for(const path of ['/work/source.ts','/work/tests/a.ts']){
    assert.equal((await f.call({tool:'Edit',tool_use_id:path}, {tool:'Edit',tool_use_id:path,input:{file_path:path}})).result.count,f.effects)
  }
  assert.equal(f.modelCalls,0);assert.equal(f.effects,2)
  const result=await f.check({tool:'Edit',tool_use_id:'protected',input:{file_path:'/work/.git/config'}})
  assert.equal(result.decision,'deny');assert.match(result.reason,/not a safety judgment/)
})

test('capture precedes turn start, includes SDK and bridge, and never trusts peer or task notifications',async()=>{
  for(const kind of ['composer','sdk','bridge','peer','task-notification','plugin']){
    const f=fixture();f.setComplete(async(req:any)=>{f.prompts.push(req);const owners=JSON.parse(req.prompt.split('\n').find((line:string)=>line.startsWith('{'))).records.filter((r:any)=>r.source==='owner-original')
      return reply(assessment({risk:'High',authorization:'High',evidenceIds:owners.map((r:any)=>r.id)}))})
    let pending:any
    await f.submit('Delete the named disposable fixture.',kind,async(e:any)=>{pending=f.check();return {text:e.text}})
    assert.equal((await pending).decision,['composer','sdk','bridge'].includes(kind)?'allow':'deny')
  }
})

test('a dropped prompt cannot grant permission on the next action',async()=>{
  const f=fixture();await f.submit('Approve risky action.','composer',async()=>({drop:'not accepted'}))
  f.setComplete(async(req:any)=>{f.prompts.push(req);return reply(assessment({risk:'High',authorization:'High',evidenceIds:['u1']}))})
  assert.equal((await f.check()).decision,'deny')
})

test('rewritten tool inputs are reviewed as they will execute',async()=>{
  const f=fixture();let observed:any
  f.setComplete(async(req:any)=>{observed=req.prompt;return reply(assessment())})
  const result=await f.call({tool:'Bash',command:'original',tool_use_id:'r1'}, {tool:'Bash',tool_use_id:'r1',input:{command:'rewritten'}})
  assert.ok(result.result);assert.match(observed,/rewritten/);assert.doesNotMatch(observed,/original/);assert.equal(f.effects,1)
})

test('duplicate permission checks share one in-flight review',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>answer.promise)
  const first=f.check();const second=f.check();await new Promise(r=>setImmediate(r))
  assert.equal(f.modelCalls,1);answer.resolve(reply(assessment()));assert.equal((await first).decision,'allow');assert.equal((await second).decision,'allow')
})

test('new owner restriction triggers one fresh review within the same completion budget',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>f.modelCalls===1?answer.promise:Promise.resolve(reply(assessment({explicitProhibition:true,reason:'Owner said not to run it.'}))))
  const result=f.call();await new Promise(r=>setImmediate(r));await f.submit('Do not run that command.')
  answer.resolve(reply(assessment()));assert.match((await result).deny,/Owner said not/);assert.equal(f.modelCalls,2);assert.equal(f.effects,0)
})

test('subagent mode changes do not invalidate the main review, and agent context is supplied',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>answer.promise)
  const main=f.call();await new Promise(r=>setImmediate(r));await f.attach('plan_mode','child')
  answer.resolve(reply(assessment()));assert.ok((await main).result);assert.equal(f.modelCalls,1)
  f.setComplete(async(req:any)=>{f.prompts.push(req);return reply(assessment())})
  await f.call({tool:'Bash',command:'inspect',tool_use_id:'agent-call',agentId:'child'})
  assert.deepEqual(f.agentReads,['child']);assert.match(f.prompts.at(-1).prompt,/Scoped delegated task/)
})

test('clear starts lazily, resume/fork uses live context, and sessions do not share owner approval',async()=>{
  const f=fixture();await f.submit('Owner approval in session one.')
  await f.invoke('session.end',{sessionId:'s1'},async()=>({}));f.setSession('s2')
  f.setMessages([{role:'user',text:'Inherited conversation and original task.',toolUses:[]}])
  f.setComplete(async(req:any)=>{f.prompts.push(req);return reply(assessment())})
  assert.ok((await f.call()).result);assert.doesNotMatch(f.prompts.at(-1).prompt,/Owner approval in session one/)
  assert.match(f.prompts.at(-1).prompt,/Inherited conversation/)
})

test('failed review does not poison another request; completed denial survives diagnostics failure',async()=>{
  const f=fixture();f.$.ui.status=()=>{throw Error('display failure')}
  f.setComplete(async()=>({isAnswered:false,reason:'api-error',status:401,error:'authentication_failed',usage}))
  const failed=await f.call();assert.match(failed.deny,/not a safety judgment/);assert.equal(f.effects,0)
  f.setComplete(async()=>reply(assessment()));assert.ok((await f.call({tool:'Bash',command:'other',tool_use_id:'r2'})).result);assert.equal(f.effects,1)
  f.setComplete(async()=>reply(assessment({risk:'Critical',reason:'Synthetic secret must not leave this workspace. Use a fake token.'})))
  const denied=await f.call({tool:'Bash',command:'send',tool_use_id:'r3'});assert.match(denied.deny,/Use a fake token/);assert.doesNotMatch(denied.deny,/not a safety judgment/);assert.equal(f.effects,1)
})

test('cancellation discards pending approval without executing',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>answer.promise)
  const pending=f.call();await new Promise(r=>setImmediate(r));f.controller.abort();answer.resolve(reply(assessment()))
  assert.match((await pending).deny,/cancelled/);assert.equal(f.effects,0)
})

test('parallel calls and late answers cannot cross session ownership',async()=>{
  const first=fixture(),second=fixture();const slow=deferred();first.setComplete(()=>slow.promise)
  const pending=first.call();assert.ok((await second.call()).result)
  await first.invoke('session.end',{sessionId:'s1'},async()=>({}));slow.resolve(reply(assessment()))
  assert.ok((await pending).deny);assert.equal(first.effects,0);assert.equal(second.effects,1)
})


test('duplicate checks after owner change share the same refresh and completion budget',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>f.modelCalls===1?answer.promise:Promise.resolve(reply(assessment())))
  const first=f.check();await new Promise(r=>setImmediate(r));await f.submit('Continue the bounded task.')
  const second=f.check();await new Promise(r=>setImmediate(r));assert.equal(f.modelCalls,1)
  answer.resolve(reply(assessment()));assert.equal((await first).decision,'allow');assert.equal((await second).decision,'allow');assert.equal(f.modelCalls,2)
})

test('timestamp failure cannot lose a new owner restriction',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>f.modelCalls===1?answer.promise:Promise.resolve(reply(assessment({explicitProhibition:true,reason:'Owner prohibited this command.'}))))
  const pending=f.call();await new Promise(r=>setImmediate(r));const now=f.$.clock.now
  f.$.clock.now=async()=>{throw Error('timestamp unavailable')};await f.submit('Do not run this command.');f.$.clock.now=now
  answer.resolve(reply(assessment()));assert.match((await pending).deny,/Owner prohibited/);assert.equal(f.effects,0)
})

test('pinned native agent identity preserves child Plan mode without an observer',async()=>{
  const f=fixture();await f.attach('plan_mode','child');f.setComplete(async()=>reply(assessment({planCompatible:false})))
  const result=await f.check({tool:'Edit',tool_use_id:'child-edit',agentId:'child',input:{file_path:'/work/a.ts'}})
  assert.equal(result.decision,'deny');assert.equal(f.modelCalls,1);assert.deepEqual(f.agentReads,['child'])
})

test('scope change during review refreshes within the same budget',async()=>{
  const f=fixture();const answer=deferred();let cwd='/work';f.$.session.cwd=async()=>cwd
  f.setComplete(()=>f.modelCalls===1?answer.promise:Promise.resolve(reply(assessment({explicitProhibition:true,reason:'This other scope is excluded.'}))))
  const pending=f.call();await new Promise(r=>setImmediate(r));cwd='/other';answer.resolve(reply(assessment()))
  assert.match((await pending).deny,/other scope/);assert.equal(f.effects,0);assert.equal(f.modelCalls,2)
})


test('a rejected submission cannot authorize a later high-risk action',async()=>{
  const f=fixture();await assert.rejects(f.submit('Delete unique data.','composer',async()=>{throw Error('prompt rejected')}))
  f.setComplete(async()=>reply(assessment({risk:'High',authorization:'High',evidenceIds:['u1']})))
  assert.equal((await f.check()).decision,'deny')
})

test('one registration keeps simultaneous sessions and their owner approvals separate',async()=>{
  const f=fixture();const first=deferred();let calls=0
  f.setComplete(async(req:any)=>{f.prompts.push(req);calls++;return calls===1?first.promise:reply(assessment({risk:'High',authorization:'High',evidenceIds:['u1']}))})
  await f.submit('Session one authorizes the exact high-risk action.');const pending=f.call();await new Promise(r=>setImmediate(r))
  f.setSession('s2');const other=await f.call({tool:'Bash',command:'other',tool_use_id:'r2'})
  assert.ok(other.deny);assert.doesNotMatch(f.prompts.at(-1).prompt,/Session one authorizes/)
  first.resolve(reply(assessment()));assert.ok((await pending).result)
})

test('a pending grant cannot authorize a concurrent call, and a dropped paste cannot evict accepted restrictions',async()=>{
  const f=fixture();await f.submit('Do not push without my final approval.')
  const admission=deferred();const submitted=f.submit('Approve risky action. '+'x'.repeat(49_000),'composer',()=>admission.promise)
  f.setComplete(async(req:any)=>{f.prompts.push(req);return reply(assessment({risk:'High',authorization:'High',evidenceIds:['u2']}))})
  const pending=f.check();await new Promise(r=>setImmediate(r));assert.equal(f.modelCalls,0)
  admission.resolve({drop:'rejected'});await submitted
  assert.equal((await pending).decision,'deny');assert.match(f.prompts[0].prompt,/Do not push/);assert.doesNotMatch(f.prompts[0].prompt,/Approve risky/)
})

test('captured instructions keep submission order when session metadata resolves out of order',async()=>{
  const f=fixture();const metadata=deferred();let count=0;f.$.session.id=()=>++count===1?metadata.promise:Promise.resolve('s1')
  const first=f.submit('First instruction.');await f.submit('Second instruction.');metadata.resolve('s1');await first
  await f.check();assert.ok(f.prompts[0].prompt.indexOf('First instruction.')<f.prompts[0].prompt.indexOf('Second instruction.'))
})

test('one outer deadline bounds stalled metadata and ignores its late result',async()=>{
  for(const method of ['id','messages']){
    const f=fixture();const stalled=deferred();f.$.session[method]=()=>stalled.promise
    const pending=f.call();await new Promise(r=>setImmediate(r));f.expireReviews()
    assert.match((await pending).deny,/90-second review deadline/);assert.equal(f.effects,0)
    stalled.resolve(method==='id'?'s1':[]);await new Promise(r=>setImmediate(r));assert.equal(f.effects,0);assert.equal(f.modelCalls,0)
  }
})

test('optional file evidence uses actual Read hooks and never bypasses their denial',async()=>{
  const f=fixture();let reads=0;f.$.fs.read=async()=>{assert.fail('raw evidence read')};f.$.tool.call=async()=>{reads++;return {deny:'classic Read hook refused'}}
  f.setComplete(async(req:any)=>{f.prompts.push(req);return f.modelCalls===1?reply(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path:'/work/canary.txt'}]})):reply(assessment())})
  assert.equal((await f.check()).decision,'allow');assert.equal(reads,1);assert.match(f.prompts[1].prompt,/could not be read safely/)
})

test('a completed safety denial survives later working-scope failure',async()=>{
  const f=fixture();f.setComplete(async()=>{f.$.session.cwd=async()=>{throw Error('scope unavailable')};return reply(assessment({risk:'Critical',reason:'Synthetic secret disclosure. Use fake data.'}))})
  const result=await f.check();assert.equal(result.decision,'deny');assert.match(result.reason,/Use fake data/);assert.doesNotMatch(result.reason,/not a safety judgment/)
})

test('each duplicate waiter validates its own cancellation signal',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>answer.promise)
  const first=f.check();await new Promise(r=>setImmediate(r));const other=new AbortController()
  const second=f.check(undefined,undefined,undefined,other.signal);await new Promise(r=>setImmediate(r));other.abort();answer.resolve(reply(assessment()))
  assert.equal((await first).decision,'allow');assert.equal((await second).decision,'deny');assert.equal(f.modelCalls,1)
})

test('an unfinished prompt in one session cannot stall another session',async()=>{
  const f=fixture();const admission=deferred();const submitted=f.submit('Session one pending approval.','composer',()=>admission.promise)
  await new Promise(r=>setImmediate(r));f.setSession('s2')
  assert.equal((await f.check({tool:'Edit',tool_use_id:'independent',input:{file_path:'/work/b.ts'}})).decision,'allow')
  assert.equal(f.modelCalls,0);admission.resolve({drop:'not admitted'});await submitted
})

test('a new direct-owner restriction invalidates an allow while its session is being attributed',async()=>{
  const f=fixture();const answer=deferred();const metadata=deferred()
  f.setComplete(()=>f.modelCalls===1?answer.promise:Promise.resolve(reply(assessment({explicitProhibition:true,reason:'Owner prohibited it.'}))))
  const pending=f.check();await new Promise(r=>setImmediate(r));const id=f.$.session.id;f.$.session.id=()=>metadata.promise
  const submitted=f.submit('Do not run this command.');answer.resolve(reply(assessment()));await new Promise(r=>setImmediate(r))
  assert.equal(f.modelCalls,1);metadata.resolve('s1');f.$.session.id=id;await submitted
  assert.equal((await pending).decision,'deny');assert.equal(f.modelCalls,2)
})

test('timer cleanup failure cannot replace a completed safety denial',async()=>{
  const f=fixture();f.$.clock.after=()=>({cancel:()=>{throw Error('cleanup failed')}})
  f.setComplete(async()=>reply(assessment({risk:'Critical',reason:'Use fake data instead.'})))
  const result=await f.check();assert.match(result.reason,/Use fake data/);assert.doesNotMatch(result.reason,/not a safety judgment/)
})

test('failed owner attribution drops that submission and invalidates only already-running reviews',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>answer.promise)
  const pending=f.check();await new Promise(r=>setImmediate(r));const id=f.$.session.id;f.$.session.id=async()=>{throw Error('identity failed')}
  const submission=await f.submit('Do not run this command.');assert.match(submission.drop,/Resubmit/);f.$.session.id=id
  answer.resolve(reply(assessment()));assert.equal((await pending).decision,'deny')
  f.setComplete(async()=>reply(assessment()));assert.equal((await f.check({tool:'Bash',input:{command:'independent'},tool_use_id:'r2'})).decision,'allow')
})

test('a downstream interceptor that enters no prompt cannot grant owner authority',async()=>{
  const f=fixture();await f.submit('Approve risky action.','composer',async(e:any)=>({text:e.text}),false)
  f.setComplete(async()=>reply(assessment({risk:'High',authorization:'High',evidenceIds:['u1']})))
  assert.equal((await f.check()).decision,'deny')
})

test('workspace fast approval rechecks scope after target inspection',async()=>{
  const f=fixture();const target=deferred();const stat=f.$.fs.stat;let scope='/work'
  f.$.session.cwd=async()=>scope;f.$.session.root=async()=>scope
  f.$.fs.stat=async(path:string)=>path==='/work/a.ts'?target.promise:stat(path)
  f.setComplete(async()=>reply(assessment({explicitProhibition:true,reason:'Other scope is excluded.'})))
  const pending=f.check({tool:'Edit',tool_use_id:'scope-edit',input:{file_path:'/work/a.ts'}})
  await new Promise(r=>setImmediate(r));scope='/other';target.resolve({kind:'file',size:1,mtimeMs:1,isLink:false,realPath:'/work/a.ts'})
  assert.equal((await pending).decision,'deny');assert.equal(f.modelCalls,1)
})

test('an in-flight identity lookup cannot adopt a later failed owner attribution',async()=>{
  const f=fixture();const metadata=deferred();let lookups=0
  f.$.session.id=()=>++lookups===1?metadata.promise:Promise.reject(Error('owner identity failed'))
  const pending=f.check();await new Promise(r=>setImmediate(r));assert.match((await f.submit('Do not run this.')).drop,/Resubmit/)
  metadata.resolve('s1');assert.equal((await pending).decision,'deny');assert.equal(f.modelCalls,0)
})

test('a child inherits parent Plan mode until its own mode attachment arrives',async()=>{
  const f=fixture();await f.attach('plan_mode');f.setComplete(async()=>reply(assessment({planCompatible:false})))
  const child={tool:'Edit',tool_use_id:'child-edit',agentId:'child',input:{file_path:'/work/a.ts'}}
  assert.equal((await f.check(child)).decision,'deny');assert.equal(f.modelCalls,1)
  await f.attach('plan_mode_exit','child')
  assert.equal((await f.check({...child,tool_use_id:'child-manual-edit'})).decision,'allow');assert.equal(f.modelCalls,1)
})

test('parent mode changes refresh an unobserved child within the same budget',async()=>{
  const f=fixture();const answer=deferred();f.setComplete(()=>f.modelCalls===1?answer.promise:Promise.resolve(reply(assessment({planCompatible:false}))))
  const pending=f.check({tool:'Bash',tool_use_id:'child-command',agentId:'child',input:{command:'echo bounded'}})
  await new Promise(r=>setImmediate(r));await f.attach('plan_mode');answer.resolve(reply(assessment()))
  assert.equal((await pending).decision,'deny');assert.equal(f.modelCalls,2)
})

test("a child's own mode attachment refreshes a review started under the parent's mode",async()=>{
  const f=fixture();await f.attach('plan_mode_exit');const answer=deferred()
  f.setComplete(()=>f.modelCalls===1?answer.promise:Promise.resolve(reply(assessment({planCompatible:false}))))
  const pending=f.check({tool:'Bash',tool_use_id:'child-handoff',agentId:'child',input:{command:'echo bounded'}})
  await new Promise(r=>setImmediate(r));await f.attach('plan_mode','child');answer.resolve(reply(assessment()))
  assert.equal((await pending).decision,'deny');assert.equal(f.modelCalls,2)
})

test('native explicit asks survive downstream removal of their metadata',async()=>{
  for(const metadata of [{rule:'Edit(*)'},{hook:'PreToolUse'},{ceiling:'ask'}]){
    const f=fixture();const next:any=async()=>({decision:'ask'})
    next.origin={plugin:'engine',tier:'core'};next.signal=f.controller.signal
    next.trace=[{plugin:'engine',tier:'core',event:'tool.check',outcome:'returned',returned:{decision:'ask',...metadata}}]
    assert.deepEqual(await f.invoke('tool.check',{tool:'Edit',tool_use_id:'explicit',input:{file_path:'/work/a.ts'}},next),{decision:'ask'})
    assert.equal(f.modelCalls,0)
  }
})

test('native child startup mode survives a later parent mode change',async()=>{
  const f=fixture();await f.attach('plan_mode')
  const next:any=async()=>({agentId:'child'});next.trace=[{plugin:'engine',tier:'core',event:'agent.spawn',outcome:'returned',returned:{agentId:'child'}}]
  await f.invoke('agent.spawn',{permissionMode:'plan'},next)
  await f.attach('plan_mode_exit');f.setComplete(async()=>reply(assessment({planCompatible:false})))
  assert.equal((await f.check({tool:'Edit',tool_use_id:'child-edit',agentId:'child',input:{file_path:'/work/a.ts'}})).decision,'deny')
  assert.equal(f.modelCalls,1)
})

test('spawn metadata failure is left to the host before spawning, and newer child attachments are preserved',async()=>{
  const f=fixture();const result={agentId:'child'};let spawned=0;const next:any=async()=>{spawned++;return result}
  next.trace=[{plugin:'engine',tier:'core',event:'agent.spawn',outcome:'returned',returned:result}]
  const id=f.$.session.id;f.$.session.id=async()=>{throw Error('metadata unavailable')}
  // The host skips a failed hook, starts the subagent natively and reports the failure.
  await assert.rejects(f.invoke('agent.spawn',{permissionMode:'plan'},next),/metadata unavailable/);assert.equal(spawned,0);f.$.session.id=id
  await f.attach('plan_mode','child')
  assert.equal(await f.invoke('agent.spawn',{permissionMode:'default'},next),result)
  f.setComplete(async()=>reply(assessment({planCompatible:false})))
  assert.equal((await f.check({tool:'Edit',tool_use_id:'child-edit',agentId:'child',input:{file_path:'/work/a.ts'}})).decision,'deny')
})

test('the registered fallback preserves native verdicts and denies only an eligible ask as unavailable',async()=>{
  const f=fixture();const fallback=f.catches.get(f.hooks.get('tool.check')![0])
  for(const [input,down,origin] of nativeCases)assert.deepEqual(await fallback(f.$,input,f.nextCheck(down,origin)),down,JSON.stringify(input))
  const result=await fallback(f.$,{tool:'Bash',input:{command:'echo bounded'},tool_use_id:'r1'},f.nextCheck())
  assert.equal(result.decision,'deny');assert.match(result.reason,/could not complete \(hook\)/);assert.equal(f.modelCalls,0)
})

test('an ask answered by another plugin or an unreturned core link keeps native behavior',async()=>{
  for(const link of [{plugin:'corp-guard',tier:'append',outcome:'returned'},{plugin:'engine',tier:'core',outcome:'skipped'}]){
    const f=fixture();const next=f.nextCheck();next.trace=[{...link,event:'tool.check',returned:{decision:'ask'}}]
    assert.deepEqual(await f.invoke('tool.check',{tool:'Bash',input:{command:'echo bounded'},tool_use_id:'r1'},next),{decision:'ask'},link.plugin)
    assert.equal(f.modelCalls,0)
  }
})

test('the same tool_use_id with different input gets its own review',async()=>{
  const f=fixture();const answer=deferred()
  f.setComplete(async(req:any)=>{f.prompts.push(req);return f.modelCalls===1?answer.promise:reply(assessment({risk:'Critical',reason:'Destroys workspace data.'}))})
  const first=f.check();await new Promise(r=>setImmediate(r))
  const second=f.check({tool:'Bash',input:{command:'rm -rf /work/data'},tool_use_id:'r1'});await new Promise(r=>setImmediate(r))
  assert.equal(f.modelCalls,2);answer.resolve(reply(assessment()))
  assert.equal((await second).decision,'deny');assert.match(f.prompts[1].prompt,/rm -rf/);assert.equal((await first).decision,'allow')
})

test('missing main or agent history never disables review',async()=>{
  const f=fixture();f.$.session.messages=async(args:any)=>{if(args?.agentId)return {deny:'unavailable'};throw Error('history unavailable')}
  f.setComplete(async(req:any)=>{f.prompts.push(req);return reply(assessment())})
  assert.ok((await f.call({tool:'Bash',command:'inspect',tool_use_id:'r1',agentId:'child'})).result)
  assert.match(f.prompts[0].prompt,/Main transcript unavailable/);assert.match(f.prompts[0].prompt,/Agent transcript unavailable/)
  f.$.session.messages=async()=>{throw Error('history unavailable')}
  assert.ok((await f.call({tool:'Bash',command:'other',tool_use_id:'r2',agentId:'child'})).result)
  assert.match(f.prompts[1].prompt,/Agent transcript unavailable/)
})
