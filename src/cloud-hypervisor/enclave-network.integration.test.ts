import { randomBytes } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { createMicrovmNetworkPlan, generateMicrovmNftRuleset } from '../microvm/network';

const live = process.env.AWF_TEST_ENCLAVE_NETWORK === '1';

(live ? describe : describe.skip)('agent-enclave host nftables packet boundary', () => {
  const token = randomBytes(5).toString('hex');
  const bridge = `br-${token}`;
  const guestNs = `eg${token}`;
  const peerNs = `ep${token}`;
  const guestIf = `g${token}`;
  const peerIf = `p${token}`;
  const peerHost = `h${token}`;
  const plan = createMicrovmNetworkPlan(`enclave-${token}`, {
    infrastructureBridge: bridge,
    enableApiProxy: false,
    enclaveAgent: { apiProxyPort: 10002, githubDataPlane: true },
    tapOwnerUid: 2001,
    tapOwnerGid: 2002,
  });
  let server: ChildProcess | undefined;
  let rulesFile: string;

  const ip = (args: string[]) => execa('ip', args);
  const inNs = (ns: string, command: string, args: string[]) =>
    ip(['netns', 'exec', ns, command, ...args]);

  beforeAll(async () => {
    if (process.getuid?.() !== 0) {
      throw new Error('AWF_TEST_ENCLAVE_NETWORK requires root and Linux network namespaces');
    }
    await ip(['netns', 'add', plan.namespaceName]);
    await ip(['netns', 'add', guestNs]);
    await ip(['netns', 'add', peerNs]);
    await ip(['link', 'add', bridge, 'type', 'bridge']);
    await ip(['link', 'set', bridge, 'up']);
    await ip(['link', 'add', plan.hostVethName, 'type', 'veth',
      'peer', 'name', plan.namespaceVethName]);
    await ip(['link', 'set', plan.namespaceVethName, 'netns', plan.namespaceName]);
    await ip(['link', 'set', plan.hostVethName, 'master', bridge]);
    await ip(['link', 'set', plan.hostVethName, 'up']);
    await ip(['link', 'add', plan.tapName, 'type', 'veth', 'peer', 'name', guestIf]);
    await ip(['link', 'set', plan.tapName, 'netns', plan.namespaceName]);
    await ip(['link', 'set', guestIf, 'netns', guestNs]);
    await inNs(plan.namespaceName, 'ip', ['addr', 'add',
      `${plan.guestGatewayIp}/30`, 'dev', plan.tapName]);
    await inNs(plan.namespaceName, 'ip', ['addr', 'add',
      `${plan.infrastructureIp}/24`, 'dev', plan.namespaceVethName]);
    await inNs(plan.namespaceName, 'ip', ['link', 'set', plan.tapName, 'up']);
    await inNs(plan.namespaceName, 'ip', ['link', 'set', plan.namespaceVethName, 'up']);
    await inNs(plan.namespaceName, 'sysctl', ['-q', '-w', 'net.ipv4.ip_forward=1']);
    await inNs(guestNs, 'ip', ['addr', 'add', `${plan.guestIp}/30`, 'dev', guestIf]);
    await inNs(guestNs, 'ip', ['link', 'set', guestIf, 'address', plan.guestMac]);
    await inNs(guestNs, 'ip', ['link', 'set', guestIf, 'up']);
    await inNs(guestNs, 'ip', ['route', 'add', 'default', 'via', plan.guestGatewayIp]);
    await ip(['link', 'add', peerHost, 'type', 'veth', 'peer', 'name', peerIf]);
    await ip(['link', 'set', peerIf, 'netns', peerNs]);
    await ip(['link', 'set', peerHost, 'master', bridge]);
    await ip(['link', 'set', peerHost, 'up']);
    await inNs(peerNs, 'ip', ['addr', 'add', '172.31.0.30/24', 'dev', peerIf]);
    await inNs(peerNs, 'ip', ['addr', 'add', '172.31.0.40/24', 'dev', peerIf]);
    await inNs(peerNs, 'ip', ['link', 'set', peerIf, 'up']);
    rulesFile = path.join(os.tmpdir(), `awf-enclave-${token}.nft`);
    await fs.writeFile(rulesFile, generateMicrovmNftRuleset(plan), { mode: 0o600 });
    await inNs(plan.namespaceName, 'nft', ['-f', rulesFile]);
    server = spawn('ip', ['netns', 'exec', peerNs, process.execPath, '-e',
      'for (const port of [10000,10002,8080,18443,53]) ' +
      'require("http").createServer((_,r)=>r.end("allowed")).listen(port,"0.0.0.0")'],
    { stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
      const probe = await inNs(peerNs, 'curl', [
        '--noproxy', '*', '--max-time', '1', '-s', 'http://172.31.0.30:10002/',
      ]).catch(() => undefined);
      ready = probe?.stdout === 'allowed';
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Enclave network test peer failed to start');
  }, 20_000);

  afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => server!.once('close', () => resolve()));
      server.kill();
      await exited;
    }
    for (const ns of [guestNs, peerNs, plan.namespaceName]) {
      await ip(['netns', 'delete', ns]).catch(() => undefined);
    }
    for (const name of [plan.hostVethName, peerHost, bridge]) {
      await ip(['link', 'delete', name]).catch(() => undefined);
    }
    if (rulesFile) await fs.rm(rulesFile, { force: true });
    const namespaces = (await ip(['netns', 'list'])).stdout.split('\n')
      .map((line) => line.split(' ')[0]);
    for (const ns of [guestNs, peerNs, plan.namespaceName]) expect(namespaces).not.toContain(ns);
    const links = (await ip(['-o', 'link', 'show'])).stdout.split('\n')
      .map((line) => line.split(': ')[1]?.split('@')[0]);
    for (const name of [plan.hostVethName, peerHost, bridge]) expect(links).not.toContain(name);
  });

  const request = async (ipAddress: string, port: number) =>
    inNs(guestNs, 'curl', [
      '--noproxy', '*', '--connect-timeout', '1', '--max-time', '2',
      '-s', `http://${ipAddress}:${port}/`,
    ]);

  it('allows only the selected proxy and GitHub data-plane pairs', async () => {
    await expect(request('172.31.0.30', 10002)).resolves.toMatchObject({ stdout: 'allowed' });
    await expect(request('172.31.0.40', 8080)).resolves.toMatchObject({ stdout: 'allowed' });
  });

  it.each([
    ['nonselected proxy port', '172.31.0.30', 10000],
    ['delegation control port', '172.31.0.40', 18443],
    ['mcpg on proxy address', '172.31.0.30', 8080],
    ['DNS', '172.31.0.30', 53],
    ['host gateway', '172.31.0.1', 10002],
    ['external destination', '8.8.8.8', 10002],
  ])('drops %s from guest packets', async (_label, address, port) => {
    await expect(request(address as string, port as number)).rejects.toThrow();
  });
});
