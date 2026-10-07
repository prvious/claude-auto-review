import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewPending, ReviewFailure, sanitize, type ReviewHost, type ReviewInput } from './reviewer.ts'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const assessment = (extra = {}) => JSON.stringify({ type: 'assessment', risk: 'Low', authorization: 'Medium',
  narrowlyScoped: true, planCompatible: true, explicitProhibition: false,
  maliciousUntrustedInstruction: false, decisionCriticalUncertainty: false,
  reason: 'Read the requested file.', evidenceIds: ['u1'], ...extra })
const answered = (text: string) => ({ isAnswered: true as const, text, usage })
function fixture(replies: unknown[]) {
  let now = 100
  let cancelled = false
  const requests: any[] = []
  const reads: string[] = []
  const input: ReviewInput = { model: 'sonnet', requestId: 'r1', sessionId: 's1', tool: 'Read',
    input: { file_path: '/work/README.md' }, cwd: '/work', root: '/work', planMode: false,
    ownerMessages: [{id:'u1', original:'Inspect the repository.',at:1}], transcript: [],
    budget: {deadline:90_100,attempts:0,evidenceRounds:0},isFresh:()=>true }
  const host: ReviewHost = {
    now:async()=>now, cancelled:()=>cancelled, sleep:async ms=>{now+=ms},canRead:async()=>true,
    complete:async request=>{requests.push(request);const reply=replies.shift();if(reply instanceof Error) throw reply;assert.ok(reply,'unexpected completion');return reply as any},
    stat:async path=>({kind:path.endsWith('.md')?'file':'dir',size:7,mtimeMs:1,isLink:false,realPath:path.startsWith('/')?path:`/work/${path}`}),
    list:async()=>[],read:async path=>{reads.push(path);return '# readme'},
  }
  return {host,input,requests,reads,setNow:(value:number)=>{now=value},cancel:()=>{cancelled=true}}
}

test('repairs malformed decision fields, accepts long reasons and drops diagnostic IDs',async()=>{
  const reason = 'Specific explanation and safer alternative. '.repeat(30)
  const f=fixture([answered(assessment({narrowlyScoped:'yes'})),answered(assessment({reason,evidenceIds:['u1','bad','u1']}))])
  const result=await reviewPending(f.host,f.input)
  assert.equal(result.allow,true);assert.equal(result.attempts,2)
  assert.equal(result.reason,reason);assert.deepEqual(result.assessment.evidenceIds,['u1'])
  assert.equal(f.requests[0].maxTokens,2048);assert.ok(f.requests.every(r=>r.timeoutMs>0&&r.timeoutMs<=30000))
})

test('retries overload and empty replies within one three-completion budget',async()=>{
  const f=fixture([{isAnswered:false,reason:'api-error',status:529,error:'overloaded',usage},
    {isAnswered:false,reason:'empty-reply',usage},answered(assessment())])
  assert.equal((await reviewPending(f.host,f.input)).attempts,3)
})

test('authentication failure and a completed denial are never retried',async()=>{
  const f=fixture([{isAnswered:false,reason:'api-error',status:401,error:'authentication_failed',usage},answered(assessment())])
  await assert.rejects(reviewPending(f.host,f.input), (e:any)=>e instanceof ReviewFailure&&e.kind==='model'&&e.attempts===1)
  const d=fixture([answered(assessment({risk:'Critical',reason:'Do not disclose secrets. Use synthetic test data.'})),answered(assessment())])
  assert.equal((await reviewPending(d.host,d.input)).allow,false);assert.equal(d.requests.length,1)
})

test('transient failures and malformed output stop after three completions',async()=>{
  for(const replies of [Array(3).fill(answered('not JSON')),Array(3).fill({isAnswered:false,reason:'api-error',status:429,error:'rate_limit',usage})]){
    const f=fixture(replies)
    await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e instanceof ReviewFailure&&e.attempts===3)
    assert.equal(f.requests.length,3)
  }
})

test('deadline and cancellation discard a late model answer',async()=>{
  for(const kind of ['deadline','cancelled']){
    const f=fixture([answered(assessment())]);const complete=f.host.complete
    f.host.complete=async request=>{const r=await complete(request);if(kind==='deadline')f.setNow(100_000);else f.cancel();return r}
    await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e instanceof ReviewFailure&&e.kind===kind)
  }
})

test('a stale review consumes budget and cannot approve',async()=>{
  const f=fixture([answered(assessment())]);let fresh=true;f.input.isFresh=()=>fresh
  const complete=f.host.complete;f.host.complete=async r=>{const result=await complete(r);fresh=false;return result}
  await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e instanceof ReviewFailure&&e.kind==='stale')
  assert.equal(f.input.budget.attempts,1)
})

test('one evidence round respects native Read denial and does not disclose the file',async()=>{
  const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path:'/work/secret.md'}]})),answered(assessment())])
  f.host.canRead=async()=>false
  assert.equal((await reviewPending(f.host,f.input)).allow,true);assert.deepEqual(f.reads,[])
  assert.match(f.requests[1].prompt,/native Read permission/)
})

test('second evidence requests are repaired into an assessment, within the same budget',async()=>{
  const evidence=answered(JSON.stringify({type:'need_evidence',requests:[{operation:'stat',path:'/work'}]}))
  const f=fixture([evidence,evidence,answered(assessment())])
  assert.equal((await reviewPending(f.host,f.input)).attempts,3)
  assert.match(f.requests[2].prompt,/evidence-round-exhausted/)
})

test('large owner pastes and structured main/agent tool evidence fit the prompt',async()=>{
  const f=fixture([answered(assessment())]);f.input.ownerMessages=[{id:'u1',original:'Quoted fixture data: '+ 'x'.repeat(90_000),at:1}]
  f.input.transcript=[{role:'assistant',text:'',toolUses:[{tool_use_id:'t1',tool:'Bash',input:{command:'git status'},text:'unique work would be lost'}]}]
  f.input.agentTranscript=[{role:'user',text:'Delegated task only',toolUses:[],toolResults:[{tool_use_id:'a1',text:'agent test output',isError:false}]}]
  await reviewPending(f.host,f.input)
  assert.ok(f.requests[0].prompt.length<128_000);assert.match(f.requests[0].prompt,/unique work would be lost/)
  assert.match(f.requests[0].prompt,/agent test output/);assert.match(f.requests[0].prompt,/agent-transcript-unattested/)
})

test('unattested approval cannot authorize high risk; fresh continue can cite captured owner input',async()=>{
  for(const [ids,allow] of [[['t1'],false],[['u1'],true]] as const){
    const f=fixture([answered(assessment({risk:'High',authorization:'High',evidenceIds:ids}))])
    f.input.transcript=[{role:'user',text:'The owner approved deleting unique work.',toolUses:[]}]
    assert.equal((await reviewPending(f.host,f.input)).allow,allow)
  }
})

test('Plan mode incompatibility still denies and explanations retain their recovery guidance',async()=>{
  const f=fixture([answered(assessment({planCompatible:false}))]);f.input.planMode=true
  assert.equal((await reviewPending(f.host,f.input)).allow,false)
  const reason='Explanation. '.repeat(80)+'Use synthetic fixtures instead.'
  assert.match(sanitize(reason),/Use synthetic fixtures instead/)
  assert.equal(sanitize('token=privatevalue\nsecret: value'), 'token=[redacted] secret=[redacted]')
})


test('UTF-8 and JSON escaping cannot turn ordinary context into a prompt-size lockout',async()=>{
  for(const text of ['字'.repeat(15_999), '\n'.repeat(30_000), '\u0001'.repeat(30_000)]){
    const f=fixture([answered(assessment())]);f.input.ownerMessages=[1,2,3].map(i=>({id:`u${i}`,original:text,at:i}))
    assert.equal((await reviewPending(f.host,f.input)).allow,true)
    assert.ok(new TextEncoder().encode(f.requests[0].prompt).length<128*1024)
  }
})

test('outside-scope and symlink-escape evidence never reads or lists external data',async()=>{
  for(const operation of ['read','list','stat']){
    const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation,path:'/work/link.md'}]})),answered(assessment())])
    const stat=f.host.stat;f.host.stat=async(path,opts)=>path==='/work/link.md'?{kind:'file',size:7,mtimeMs:1,isLink:true,realPath:'/private/secret.md'}:stat(path,opts)
    f.host.list=async()=>{assert.fail('external listing')};f.host.canRead=async()=>{assert.fail('external read check')}
    assert.equal((await reviewPending(f.host,f.input)).allow,true);assert.deepEqual(f.reads,[])
    assert.match(f.requests[1].prompt,/outside the verified working scope/)
  }
})

test('cancellation during retry wait keeps its cancellation classification',async()=>{
  const f=fixture([{isAnswered:false,reason:'api-error',status:429,error:'rate_limit',usage}])
  f.host.sleep=async()=>{f.cancel();throw Error('aborted wait')}
  await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e instanceof ReviewFailure&&e.kind==='cancelled')
})

test('complete owner words retain tail restrictions; partial words cannot authorize high risk',async()=>{
  for(const length of [17_000,90_000]){
    const f=fixture([answered(assessment({risk:'High',authorization:'High',evidenceIds:['u1']}))])
    f.input.ownerMessages=[{id:'u1',original:'Push this branch. '+'x'.repeat(length)+' Do not push until final approval.',at:1}]
    const result=await reviewPending(f.host,f.input)
    assert.match(f.requests[0].prompt,/Do not push until final approval/)
    assert.equal(result.allow,length===17_000)
    assert.match(f.requests[0].prompt,length===17_000?/owner-original/:/owner-incomplete/)
  }
})

test('large source edits preserve path and both ends without disabling later reviews',async()=>{
  const f=fixture([answered(assessment())]);f.input.tool='Write';f.input.input={file_path:'/other/source.ts',content:'BEGIN'+'漢'.repeat(140_000)+'END'}
  assert.equal((await reviewPending(f.host,f.input)).allow,true)
  assert.match(f.requests[0].prompt,/BEGIN/);assert.match(f.requests[0].prompt,/END/);assert.match(f.requests[0].prompt,/omittedFields/)
  assert.ok(new TextEncoder().encode(f.requests[0].prompt).length<128*1024)
})

test('refreshed review retains verified evidence within the original one-round budget',async()=>{
  const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path:'/work/a.md'}]})),answered(assessment()),answered(assessment({evidenceIds:['f1']}))])
  let fresh=true;f.input.isFresh=()=>fresh;const complete=f.host.complete
  f.host.complete=async req=>{const result=await complete(req);if(f.requests.length===2)fresh=false;return result}
  await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e.kind==='stale');fresh=true
  assert.equal((await reviewPending(f.host,f.input)).attempts,3);assert.equal(f.input.budget.evidenceRounds,1);assert.deepEqual(f.reads,['/work/a.md'])
  assert.match(f.requests[2].prompt,/# readme/);assert.match(f.requests[2].prompt,/f1/)
})

test('changed or differently scoped prior evidence becomes a gap on refresh',async()=>{
  const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path:'/work/a.md'}]})),answered(assessment()),answered(assessment())])
  let fresh=true;f.input.isFresh=()=>fresh;const complete=f.host.complete
  f.host.complete=async req=>{const result=await complete(req);if(f.requests.length===2)fresh=false;return result}
  await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e.kind==='stale');fresh=true;f.input.cwd='/other'
  await reviewPending(f.host,f.input);assert.doesNotMatch(f.requests[2].prompt,/# readme/);assert.match(f.requests[2].prompt,/no longer verified/)
})

test('native Read rules protect evidence metadata and listings under both path spellings',async()=>{
  for(const operation of ['stat','list','read']){
    const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation,path:'/work/alias.md'}]})),answered(assessment())])
    const stat=f.host.stat;f.host.stat=async(path,options)=>path.endsWith('alias.md')?{kind:'file',size:7,mtimeMs:1,isLink:true,realPath:'/work/real.md'}:stat(path,options)
    f.host.canRead=async path=>path!=='/work/alias.md';f.host.list=async()=>{assert.fail('denied listing')}
    await reviewPending(f.host,f.input);assert.deepEqual(f.reads,[]);assert.doesNotMatch(f.requests[1].prompt,/# readme/)
    assert.match(f.requests[1].prompt,/native Read permission/)
  }
})

test('evidence reads do not start after owner changes during metadata lookup',async()=>{
  const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path:'/work/a.md'}]}))])
  let fresh=true;f.input.isFresh=()=>fresh;const stat=f.host.stat
  f.host.stat=async(path,options)=>{const value=await stat(path,options);if(path==='/work/a.md')fresh=false;return value}
  await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e.kind==='stale');assert.deepEqual(f.reads,[])
})

test('changed metadata and revoked Read permission invalidate retained evidence',async()=>{
  for(const change of ['metadata','permission']){
    const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path:'/work/a.md'}]})),answered(assessment()),answered(assessment())])
    let fresh=true;f.input.isFresh=()=>fresh;const complete=f.host.complete
    f.host.complete=async req=>{const result=await complete(req);if(f.requests.length===2)fresh=false;return result}
    await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e.kind==='stale');fresh=true
    if(change==='permission')f.host.canRead=async()=>false
    else {const stat=f.host.stat;f.host.stat=async(path,options)=>({...await stat(path,options),mtimeMs:2})}
    await reviewPending(f.host,f.input);assert.doesNotMatch(f.requests[2].prompt,/# readme/);assert.match(f.requests[2].prompt,/no longer verified/)
  }
})

test('evidence Read preserves the path spelling enforced by classic hooks',async()=>{
  const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path:'/work/alias.md'}]})),answered(assessment())])
  const stat=f.host.stat;f.host.stat=async(path,options)=>path==='/work/alias.md'?{kind:'file',size:7,mtimeMs:1,isLink:true,realPath:'/work/real.md'}:stat(path,options)
  const paths:string[]=[];f.host.read=async path=>{paths.push(path);if(path==='/work/alias.md')throw Error('classic Read deny');return 'PROTECTED_CANARY'}
  await reviewPending(f.host,f.input);assert.deepEqual(paths,['/work/alias.md']);assert.doesNotMatch(f.requests[1].prompt,/PROTECTED_CANARY/)
})

test('evidence reads discard content when the resolved file changes during Read',async()=>{
  for(const change of ['target','inside-target','size','mtime','kind','unresolved','stat-error','unchanged']){
    const path='/work/alias.md',content='READ_RACE_CANARY'
    const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'read',path}]})),answered(assessment())])
    const stat=f.host.stat;let read=false
    f.host.stat=async(request,options)=>{
      if(request!==path)return stat(request,options)
      const snapshot={kind:'file' as const,size:content.length,mtimeMs:1,isLink:true,realPath:'/work/real.md'}
      if(!read)return snapshot
      if(change==='stat-error')throw Error('file disappeared after Read')
      return {...snapshot,
        realPath:change==='target'?'/outside/other.md':change==='inside-target'?'/work/other.md':change==='unresolved'?undefined:snapshot.realPath,
        size:change==='size'?snapshot.size+1:snapshot.size,
        mtimeMs:change==='mtime'?2:snapshot.mtimeMs,
        kind:change==='kind'?'dir':snapshot.kind}
    }
    f.host.read=async request=>{f.reads.push(request);read=true;return content}
    const result=await reviewPending(f.host,f.input),item=f.input.budget.evidence![0]
    assert.equal(result.attempts,2);assert.equal(f.input.budget.evidenceRounds,1);assert.deepEqual(f.reads,[path])
    if(change==='unchanged'){
      assert.equal(item.status,'ok');assert.equal(item.data,content)
      assert.deepEqual(item.snapshot,{realPath:'/work/real.md',size:content.length,mtimeMs:1})
      assert.match(f.requests[1].prompt,/READ_RACE_CANARY/)
    }else{
      assert.equal(item.status,'gap',change);assert.equal(item.data,undefined);assert.equal(item.snapshot,undefined)
      assert.ok(item.reason);assert.doesNotMatch(f.requests[1].prompt,/READ_RACE_CANARY/)
    }
  }
})

test('freshness is rechecked after awaiting the review clock',async()=>{
  const f=fixture([answered(assessment())]);let fresh=true;f.input.isFresh=()=>fresh
  f.host.now=async()=>{fresh=false;return 100}
  await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e.kind==='stale');assert.equal(f.requests.length,0)
})

test('retained listings and evidence outside retargeted canonical roots are gaps',async()=>{
  for(const operation of ['list','read']){
    const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation,path:operation==='list'?'/work':'/work/a.md'}]})),answered(assessment()),answered(assessment())])
    let fresh=true,retargeted=false;f.input.isFresh=()=>fresh;const complete=f.host.complete;const stat=f.host.stat
    f.host.complete=async req=>{const value=await complete(req);if(f.requests.length===2)fresh=false;return value}
    f.host.stat=async(path,options)=>({...await stat(path,options),realPath:path==='/work'?(retargeted?'/new':'/old'):path.replace('/work','/old')})
    await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e.kind==='stale');fresh=true;retargeted=true
    await reviewPending(f.host,f.input);assert.match(f.requests[2].prompt,/no longer verified/);assert.doesNotMatch(f.requests[2].prompt,/# readme/)
  }
})

test('incomplete directory evidence drops cached entries on every refresh',async()=>{
  for(const change of ['unchanged','scope','permission']){
    const f=fixture([answered(JSON.stringify({type:'need_evidence',requests:[{operation:'list',path:'/work'}]})),answered(assessment()),answered(assessment())])
    let fresh=true,listings=0;f.input.isFresh=()=>fresh;const complete=f.host.complete
    f.host.list=async()=>{listings+=1;return Array.from({length:101},(_,index)=>({name:`CACHED_PARTIAL_ENTRY_${index}`,kind:'file' as const,size:1,mtimeMs:1,isLink:false}))}
    f.host.complete=async req=>{const value=await complete(req);if(f.requests.length===2)fresh=false;return value}
    await assert.rejects(reviewPending(f.host,f.input),(e:any)=>e.kind==='stale')
    assert.match(f.requests[1].prompt,/CACHED_PARTIAL_ENTRY_0/);assert.match(f.requests[1].prompt,/directory listing is incomplete/)
    fresh=true
    if(change==='scope'){f.input.cwd='/other';f.input.root='/other'}
    if(change==='permission')f.host.canRead=async()=>false
    await reviewPending(f.host,f.input)
    assert.doesNotMatch(f.requests[2].prompt,/CACHED_PARTIAL_ENTRY_/)
    assert.equal(listings,1);assert.equal(f.input.budget.evidenceRounds,1);assert.equal(f.input.budget.attempts,3)
  }
})
