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
    `], { cwd: root, encoding: 'utf8', timeout: 10000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
