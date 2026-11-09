'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('the declared API and readonly invariants type-check with existing root TypeScript tooling', () => {
  const ts = require('typescript');
  const fixture = path.join(__dirname, 'fixtures/protocol-compatibility/contract-types.ts');
  const program = ts.createProgram([fixture], {
    noEmit: true, strict: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
  });
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
});

test('contracts and declarations load with translators from the actual Docker COPY layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-protocol-layout-'));
  try {
    const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8').replace(/\\\n/g, ' ');
    const copies = dockerfile.split('\n').map(line => /^COPY (.+) (\.\/\S*)$/.exec(line)).filter(Boolean);
    expect(copies.some(copy => copy[1] === 'protocol-compatibility/')).toBe(true);
    for (const [, sources, destination] of copies) {
      for (const source of sources.trim().split(/\s+/)) {
        const names = source === 'package*.json'
          ? fs.readdirSync(__dirname).filter(name => /^package.*\.json$/.test(name))
          : [source];
        for (const name of names) {
          const absolute = path.join(__dirname, name);
          const target = destination === './' ? path.join(root, path.basename(name)) : path.join(root, destination);
          fs.cpSync(absolute, target, { recursive: true });
        }
      }
    }
    expect(fs.existsSync(path.join(root, 'protocol-compatibility', 'index.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'fixtures'))).toBe(false);
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('assert/strict');
      const { CONTRACTS, assessFeature } = require('./protocol-compatibility');
      const wire = require('./wire-api-compat');
      const messages = require('./anthropic-chat-compat');
      assert.equal(CONTRACTS.length, 6);
      assert.equal(assessFeature({source:'anthropic_messages', target:'chat_completions',
        direction:'request', feature:'message_text'}).status, 'unknown');
      assert.deepEqual(wire.translateChatRequest({model:'fixture-model', messages:[{role:'user',content:'hello'}]}),
        {model:'fixture-model',input:[{role:'user',content:'hello'}]});
      assert.equal(messages.chatRequestToAnthropic({model:'fixture-model',messages:[]}).max_tokens,8192);
      assert.equal(JSON.parse(messages.anthropicResponseToChat(Buffer.from('{"content":[]}'))).object,'chat.completion');
      const transform = wire.createWireApiSseTransform({direction:'responses_to_chat'});
      let output = '';
      transform.on('data', chunk => { output += chunk; });
      transform.on('end', () => assert.ok(output.includes('response.completed')));
      transform.end('data: [DONE]\\n\\n');
      const {assessRequestCompatibility} = require('./protocol-compatibility/assessment');
      assert.equal(assessRequestCompatibility({body:{model:'fixture',input:'hello'},
        source:'responses',target:'chat_completions'}).status,'compatible');
      const {resolveModelReasoning} = require('./model-reasoning');
      const {normalizeModel} = require('./routing-catalogue');
      const {getModelRoutingChoices} = require('./routing-candidates');
      const mini = resolveModelReasoning('gpt-5.4-mini-2026-03-17','openai',{records:[]});
      assert.deepEqual(mini.selectableEfforts,['none','low','medium','high','xhigh']);
      assert.equal(mini.default,'none');
      assert.equal(normalizeModel('gpt-5.4-mini',undefined,'openai').contextWindow,400000);
      assert.equal(normalizeModel('gpt-5.4-mini',undefined,'openai',
        {deployment:'custom'}).contextWindow,undefined);
      assert.equal(getModelRoutingChoices(normalizeModel('claude-opus-4-7',undefined,'anthropic'),
        'anthropic').some(choice=>choice.effort==='xhigh'),true);
      assert.equal(resolveModelReasoning('claude-opus-4-6','anthropic',
        {records:[]}).selectableEfforts.includes('xhigh'),false);
    `], { cwd: root, encoding: 'utf8', timeout: 10000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const integration = spawnSync(process.execPath, ['-e', `
      const assert = require('assert/strict');
      const {EventEmitter} = require('events');
      const {createSendUpstreamRequest} = require('./upstream-http');
      const {transformProtocolResponseBody} = require('./cross-provider-fallback');
      const {createModelDecisionObservation} = require('./model-decision-observation');
      const {createManagementHandlers} = require('./management');
      const {createProxyEligibilityStore} = require('./model-eligibility');
      const models = {copilot:['origin'],anthropic:['candidate'],
        openai:['native','gpt-5.4-mini','gpt-5.4-mini-preview']};
      const adapters = Object.fromEntries(Object.keys(models).map(provider => [provider,{
        name:provider,isEnabled:()=>true,getTargetHost:()=> 'api.'+provider+'.com',
        getBasePath:()=>'',getAuthHeaders:()=>({}),getBodyTransform:()=>null,
        getReflectionInfo:()=>({provider,configured:true,port:10000,base_url:'http://api-proxy:10000',
          models_url:'/models',models_cache_key:provider}),
      }]));
      const noop = () => {};
      async function run(body, chain) {
        const calls = [];
        const observer = createModelDecisionObservation({context:'primary-agent',getModels:()=>models});
        const req = {method:'POST',url:'/chat/completions',headers:{},awfEligibility:createProxyEligibilityStore().pin(),
          awfCatalogue:{revision:'a'.repeat(64)},awfRuntimePricing:{}};
        const res = new EventEmitter();
        res.writeHead = status => {res.statusCode=status;res.headersSent=true;};
        let resolve;
        const finished = new Promise(done=>{resolve=done;});
        res.end = bytes => {res.bytes=bytes;res.writableFinished=true;res.emit('finish');resolve();};
        const transport = {request(options, callback) {
          const request = new EventEmitter();
          let parsed;
          request.write = bytes => {parsed=JSON.parse(bytes);calls.push({model:parsed.model,body:parsed,path:options.path});};
          request.end = () => setImmediate(()=>callback({statusCode:parsed.model==='origin'?503:200,headers:{}}));
          return request;
        }};
        const send = createSendUpstreamRequest({
          https:transport,http:transport,proxyAgent:{},sleep:()=>Promise.resolve(),
          getFallbackModels:()=>chain,getProviderAdapter:provider=>adapters[provider],
          isFallbackModelPermitted:()=>true,
          modelBudget:{beginAttempt:()=>({allowed:true,settleMissing:noop})},
          metrics:{gaugeDec:noop,gaugeInc:noop,increment:noop,observe:noop},
          otel:{endSpan:noop,endSpanError:noop},handleRequestError:()=>{throw Error('unexpected error');},
          handleUpstreamResponse(upstream,headers,ctx) {
            if(upstream.statusCode===503) {
              const abandon=()=>{res.awfUpstreamResponse=true;res.writeHead(503);res.end('original failure');};
              if(!ctx.onModelFallback({statusCode:503,reason:'upstream_5xx',abandon})) abandon();
            } else {
              const bytes=Buffer.from(JSON.stringify({id:'message',model:'candidate',content:[
                {type:'text',text:'result'},{type:'tool_use',id:'call1',name:'lookup',input:{key:'value'}}],
                stop_reason:'tool_use',usage:{input_tokens:2,output_tokens:3}}));
              res.awfUpstreamResponse=true;
              res.writeHead(200);res.end(transformProtocolResponseBody(bytes,ctx.protocolTranslation)||bytes);
            }
          },
        });
        observer.wrapProxyRequest((req,res,host,headers,provider)=>send(headers,{
          req,res,provider,targetHost:host,upstreamPath:req.url,body:Buffer.from(JSON.stringify(body)),
          requestId:'layout-test',startTime:Date.now(),span:{},requestBytes:1,
        }))(req,res,'api.githubcopilot.com',{},'copilot');
        await finished;
        const management = createManagementHandlers({
          getAdapters:()=>Object.values(adapters),getCachedModels:()=>models,
          isModelFetchComplete:()=>true,getAiCreditsUsage:()=>({total:0,by_model:{}}),
          getModelAliases:()=>null,getModelFallback:()=>({enabled:true}),
          getEffectiveModelFallback:()=>({}),getMaxRunsUsage:()=>({}),
          getMaxCacheMissesUsage:()=>({}),getPermissionDeniedUsage:()=>({}),
          diagnosticsContext:'primary-agent',getRecentModelDecisions:()=>observer.getRecent(),
        });
        let reflection;
        const count = calls.length;
        management.handleManagementEndpoint({method:'GET',url:'/reflect'},{
          writeHead:status=>assert.equal(status,200),end:bytes=>{reflection=JSON.parse(bytes);},
        });
        assert.equal(calls.length,count);
        return {calls,res,decisions:reflection.model_decision_diagnostics.recent.decisions};
      }
      (async()=>{
        const format={type:'json_schema',json_schema:{name:'answer',schema:{type:'object'},strict:true}};
        const incompatible={model:'origin',messages:[{role:'user',content:'PRIVATE_PROMPT'}],response_format:format};
        const suppressed=await run(incompatible,['anthropic/candidate','openai/native']);
        assert.deepEqual(suppressed.calls.map(call=>call.model),['origin','native']);
        assert.deepEqual(suppressed.calls[1].body.response_format,format);
        assert.ok(suppressed.decisions.some(item=>item.reason==='fallback_incompatible'));
        assert.ok(!JSON.stringify(suppressed.decisions).includes('PRIVATE_PROMPT'));
        const exhausted=await run(incompatible,['anthropic/candidate']);
        assert.deepEqual(exhausted.calls.map(call=>call.model),['origin']);
        assert.equal(exhausted.res.statusCode,503);
        const exhaustion=exhausted.decisions.find(item=>item.reason==='fallback_exhausted');
        assert.ok(exhaustion);
        assert.equal(exhaustion.identity.model_id,null);
        assert.equal(exhaustion.action.retry,'do_not_repeat');
        const tool={type:'function',function:{name:'lookup',parameters:{type:'object'},strict:true}};
        const translated=await run({model:'origin',messages:[{role:'user',content:'hello'}],tools:[tool],
          tool_choice:{type:'function',function:{name:'lookup'}},parallel_tool_calls:false},
          ['anthropic/candidate']);
        assert.deepEqual(translated.calls.map(call=>call.model),['origin','candidate']);
        assert.deepEqual(translated.calls[1].body.tools,[{name:'lookup',input_schema:{type:'object'},strict:true}]);
        assert.deepEqual(translated.calls[1].body.tool_choice,{type:'tool',name:'lookup',disable_parallel_tool_use:true});
        const output=JSON.parse(translated.res.bytes);
        assert.equal(output.choices[0].message.tool_calls[0].function.arguments,'{"key":"value"}');
        assert.equal(output.usage.total_tokens,5);
        assert.ok(translated.decisions.some(item=>item.reason==='fallback_compatible'));
        const reviewed=await run({model:'origin',messages:[{role:'user',content:'hello'}],
          reasoning_effort:'xhigh'},['openai/gpt-5.4-mini-preview','openai/gpt-5.4-mini']);
        assert.deepEqual(reviewed.calls.map(call=>call.model),['origin','gpt-5.4-mini']);
        assert.equal(reviewed.calls[1].body.reasoning_effort,'xhigh');
        const accepted=reviewed.decisions.find(item=>item.reason==='fallback_compatible');
        assert.equal(accepted.identity.model_id,'gpt-5.4-mini');
        assert.equal(accepted.reasoning.support,'supported');
        assert.equal(accepted.reasoning.mode,'optional');
        assert.equal(accepted.reasoning.reason,'reasoning_effort_accepted');
        assert.ok(reviewed.decisions.some(item=>item.reason==='fallback_unverified'));
        const invalid=await run({model:'origin',messages:[{role:'user',content:'hello'}],
          reasoning_effort:'max'},['openai/gpt-5.4-mini']);
        assert.deepEqual(invalid.calls.map(call=>call.model),['origin']);
        assert.ok(invalid.decisions.some(item=>item.reason==='fallback_incompatible'));
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `], { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, AWF_VERSION: '0.0.0-test', NODE_PATH: path.join(__dirname, 'node_modules') } });
    expect({ status: integration.status, stderr: integration.stderr }).toEqual({ status: 0, stderr: '' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
