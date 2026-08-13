import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import type {
  MicrovmNetworkCommandExecutor,
  MicrovmNetworkHostTools,
  MicrovmNetworkRulesetFile,
} from './network-types';

const defaultCommandExecutor: MicrovmNetworkCommandExecutor = async (
  command,
  args,
  options,
) => execa(command, [...args], options);

/**
 * Writes an nftables ruleset to a real, private temporary file instead of
 * piping it to `nft -f -` over stdin.
 *
 * Some nftables/libnftables builds internally `open("/dev/stdin")` when
 * given `-f -` rather than reading the already-open fd 0, which fails with
 * `Not a regular file: "/dev/stdin"` when stdin is a genuine pipe (as
 * `execa`'s `input` option provides) rather than a terminal or redirected
 * regular file — observed on GitHub-hosted Ubuntu runners. A real temp
 * file sidesteps this entirely and is at least as safe: still argv-only
 * (no shell), mode 0600, and removed immediately after the `nft` call
 * regardless of success or failure.
 */
const defaultRulesetFile: MicrovmNetworkRulesetFile = {
  write: async (contents) => {
    const rulesetPath = path.join(os.tmpdir(), `awf-nft-${randomBytes(8).toString('hex')}.nft`);
    await fs.writeFile(rulesetPath, contents, { mode: 0o600 });
    return rulesetPath;
  },
  remove: (rulesetPath) => fs.rm(rulesetPath, { force: true }),
};

/**
 * Dependency-injected argv-only Linux networking operations.
 */
export class LinuxNetworkCommands {
  constructor(
    private readonly execute: MicrovmNetworkCommandExecutor = defaultCommandExecutor,
    private readonly tools: MicrovmNetworkHostTools = {
      ip: 'ip',
      nft: 'nft',
      sysctl: 'sysctl',
    },
    private readonly rulesetFile: MicrovmNetworkRulesetFile = defaultRulesetFile,
  ) {}

  ip(args: readonly string[], reject = true): Promise<unknown> {
    return this.execute(this.tools.ip, args, { reject });
  }

  ipInNamespace(
    namespaceName: string,
    args: readonly string[],
    reject = true,
  ): Promise<unknown> {
    return this.execute(this.tools.ip, ['netns', 'exec', namespaceName, this.tools.ip, ...args], { reject });
  }

  sysctlInNamespace(
    namespaceName: string,
    setting: string,
    reject = true,
  ): Promise<unknown> {
    return this.execute(
      this.tools.ip,
      ['netns', 'exec', namespaceName, this.tools.sysctl, '-q', '-w', setting],
      { reject },
    );
  }

  async nftInNamespace(
    namespaceName: string,
    args: readonly string[],
    input?: string,
    reject = true,
  ): Promise<unknown> {
    if (input === undefined) {
      return this.execute(
        this.tools.ip,
        ['netns', 'exec', namespaceName, this.tools.nft, ...args],
        { reject },
      );
    }
    const rulesetPath = await this.rulesetFile.write(input);
    try {
      // Substitute the "read from stdin" placeholder ("-") with the real
      // ruleset file path; any other args pass through unchanged.
      const resolvedArgs = args.map((arg) => (arg === '-' ? rulesetPath : arg));
      return await this.execute(
        this.tools.ip,
        ['netns', 'exec', namespaceName, this.tools.nft, ...resolvedArgs],
        { reject },
      );
    } finally {
      await this.rulesetFile.remove(rulesetPath);
    }
  }

  /**
   * Ensures a scoped `ACCEPT` rule exists in Docker's `DOCKER-USER` chain
   * (which Docker evaluates *before* its own per-network isolation rules)
   * for intra-bridge forwarding on the given infrastructure bridge -- both
   * the incoming and outgoing interface must be this exact bridge.
   *
   * Live-KVM validation found that traffic between our manually-injected
   * (non-Docker-managed) veth and Docker-managed containers (Squid, the
   * API proxy) on the same bridge was silently dropped by the host's
   * `FORWARD` chain default-drop policy: Docker's own generated
   * "same bridge" accept rule in `DOCKER-FORWARD` never matched real
   * traffic in this environment (confirmed via Squid's own access log
   * showing zero incoming connection attempts, despite the microVM's own
   * nftables table already accepting the traffic outbound). Genuine
   * Docker-to-Docker container traffic on the same bridge is unaffected
   * (Docker likely grants those containers rules of their own that our
   * externally-injected veth never receives).
   *
   * Scoped to exactly this per-run bridge (Docker Compose assigns a
   * unique bridge name per invocation) with both interfaces required to
   * match, so this does not weaken isolation for any other bridge/network
   * on the host, and does not bypass the microVM's own in-namespace
   * nftables allowlist (which still restricts what the guest can send in
   * the first place).
   */
  async ensureBridgeForwardAcceptRule(bridgeName: string): Promise<void> {
    const checkResult = await this.execute(
      'iptables',
      ['-t', 'filter', '-C', 'DOCKER-USER', '-i', bridgeName, '-o', bridgeName, '-j', 'ACCEPT'],
      { reject: false },
    );
    const exitCode = (checkResult as { exitCode?: number } | undefined)?.exitCode;
    if (exitCode === 0) return;
    await this.execute(
      'iptables',
      ['-t', 'filter', '-I', 'DOCKER-USER', '1', '-i', bridgeName, '-o', bridgeName, '-j', 'ACCEPT'],
      { reject: true },
    );
  }

  /** Removes the rule `ensureBridgeForwardAcceptRule` installs, if present. Tolerant of it already being gone or the underlying command failing outright. */
  async removeBridgeForwardAcceptRule(bridgeName: string): Promise<void> {
    try {
      await this.execute(
        'iptables',
        ['-t', 'filter', '-D', 'DOCKER-USER', '-i', bridgeName, '-o', bridgeName, '-j', 'ACCEPT'],
        { reject: false },
      );
    } catch {
      // Best-effort cleanup: an already-removed rule, or the iptables
      // binary itself being unavailable, must not fail the caller's own
      // cleanup sequence.
    }
  }

  /**
   * Best-effort, read-only diagnostic dump of the live nftables ruleset,
   * per-interface packet/byte counters, routes/neighbors, and the TAP/veth
   * bridge-forwarding database inside the given namespace. Used to
   * diagnose a connectivity failure (e.g. is the forward-chain rule
   * actually installed and matching packets, are packets reaching the
   * tap/veth at all, does ARP/neighbor resolution look right) without
   * guessing from the guest side alone. Never throws -- folds any command
   * failure into an empty string for that command.
   */
  async captureDiagnosticsInNamespace(namespaceName: string): Promise<string> {
    const run = async (tool: string, args: readonly string[]): Promise<string> => {
      const result = await this.execute(
        this.tools.ip,
        ['netns', 'exec', namespaceName, tool, ...args],
        { reject: false },
      ).catch(() => undefined);
      const stdout = (result as { stdout?: unknown } | undefined)?.stdout;
      return typeof stdout === 'string' ? stdout : '';
    };
    const [nftRuleset, linkStats, linkDetail, routes, neighbors, fdb, conntrack, rpFilter] = await Promise.all([
      // -a includes rule handles so a specific rule can be identified/
      // referenced; the counters attached in generateMicrovmNftRuleset
      // make hit counts visible per rule (not just per interface).
      run(this.tools.nft, ['-a', 'list', 'ruleset']),
      run(this.tools.ip, ['-s', 'link', 'show']),
      run(this.tools.ip, ['-d', 'link', 'show']),
      run(this.tools.ip, ['route', 'show']),
      run(this.tools.ip, ['neigh', 'show']),
      // 'bridge' (iproute2) is not user-configurable like ip/nft/sysctl
      // above -- it is only used here, best-effort, for diagnostics.
      run('bridge', ['fdb', 'show']),
      // The forward chain's own accept rules key off `ct state`
      // (established/related/new). If the *outbound* leg of a flow is
      // accepted (new) but the *return* leg never matches the
      // established/related accept rule, the conntrack table itself is
      // the only place that can show whether the kernel ever recognized
      // the two directions as the same tracked flow (vs. the return
      // packet arriving as an unrelated/untracked packet that the
      // default-drop policy then silently discards).
      run('conntrack', ['-L']),
      // Squid's own reply (SYN-ACK) has been directly observed via packet
      // capture reaching this namespace's host-side veth peer, yet it
      // never appears in *any* forward-chain counter above (not even the
      // ct-state-invalid drop) -- meaning it never reaches nftables
      // evaluation at all. Linux's reverse-path filtering (rp_filter) can
      // silently drop a packet before any netfilter hook ever sees it if
      // strict mode considers the route asymmetric; this is evaluated
      // per-interface (plus the "all"/"default" umbrella, whichever is
      // stricter) so every interface actually present in this namespace
      // must be enumerated at runtime rather than named statically.
      run('sh', [
        '-c',
        'for f in /proc/sys/net/ipv4/conf/*/rp_filter; do printf "%s=%s\\n" "$f" "$(cat "$f" 2>/dev/null)"; done',
      ]),
    ]);
    return [
      '--- nft -a list ruleset (handles + hit counters) ---',
      nftRuleset.trim() || '(empty or unavailable)',
      '--- ip -s link show (packet/byte/error counters) ---',
      linkStats.trim() || '(empty or unavailable)',
      '--- ip -d link show (detailed link info, incl. vnet_hdr/multiqueue flags) ---',
      linkDetail.trim() || '(empty or unavailable)',
      '--- ip route show ---',
      routes.trim() || '(empty or unavailable)',
      '--- ip neigh show (ARP/neighbor table) ---',
      neighbors.trim() || '(empty or unavailable)',
      '--- bridge fdb show (forwarding database) ---',
      fdb.trim() || '(empty or unavailable)',
      '--- conntrack -L (connection tracking table state for this namespace) ---',
      conntrack.trim() || '(empty, unavailable, or conntrack tool not installed)',
      '--- rp_filter (reverse-path filter mode) per interface in this namespace: 0=off 1=strict 2=loose ---',
      rpFilter.trim() || '(empty or unavailable)',
    ].join('\n');
  }

  /**
   * Best-effort, read-only diagnostic dump of the host-side (outside any
   * netns) bridge forwarding database for the infrastructure bridge that
   * Squid/API-proxy containers are attached to. MAC learning for
   * guest<->container traffic happens on this bridge, not inside the
   * microVM's own namespace, so this is a separate capture point. Never
   * throws -- folds any command failure into an empty string.
   */
  async captureHostBridgeDiagnostics(bridgeName: string): Promise<string> {
    const run = async (tool: string, args: readonly string[]): Promise<string> => {
      const result = await this.execute(tool, args, { reject: false }).catch(() => undefined);
      const stdout = (result as { stdout?: unknown } | undefined)?.stdout;
      return typeof stdout === 'string' ? stdout.trim() : '';
    };
    const [fdb, hostNftRuleset, hostIptablesRules, bridgeNfSysctls, bridgeLinkState, hostLinkStats] =
      await Promise.all([
        run('bridge', ['fdb', 'show', 'br', bridgeName]),
      // Docker (and any other host-level firewall) manages its own
      // iptables/nftables rules in the *default* (root) network
      // namespace -- the same namespace this bridge and the container
      // side of the microVM's veth pair live in. Those rules are
      // completely separate from (and evaluated in addition to) the
      // microVM's own table captured in captureDiagnosticsInNamespace,
      // and could independently drop/alter traffic on this bridge that
      // our own table's counters would never show as blocked. Docker may
      // configure either the modern nftables backend or legacy
      // iptables/xtables depending on the host, so both are captured.
      run(this.tools.nft, ['-a', 'list', 'ruleset']),
      run('iptables', ['-S']),
      // If bridge-netfilter isn't wired up (kernel module not loaded, or
      // its sysctls disabled), bridged traffic never traverses the
      // iptables/nftables FORWARD hook at all -- it is forwarded purely
      // at L2 -- which would make every rule/counter captured above
      // (both ours and Docker's) irrelevant to what is actually
      // happening to this bridge's traffic, and would explain a
      // correctly-installed, correctly-targeted accept rule never
      // matching any packets.
      run('sysctl', [
        'net.bridge.bridge-nf-call-iptables',
        'net.bridge.bridge-nf-call-ip6tables',
        'net.bridge.bridge-nf-call-arptables',
      ]),
      // Bridge-netfilter is confirmed inactive (empty sysctl output),
      // meaning bridged traffic is being switched purely at L2: STP port
      // state (forwarding/learning/blocking) can independently and
      // silently drop traffic through a bridge port regardless of any
      // netfilter/nftables/iptables rule -- a newly-created port that
      // hasn't yet finished STP's listening->learning->forwarding
      // transition would exhibit exactly this symptom (an otherwise
      // correctly wired-up port through which nothing gets forwarded).
      run('bridge', ['link', 'show']),
      // The microVM-side (in-namespace) `ip -s link show` capture only
      // shows this bridge port's *peer* (the veth end inside our own
      // namespace). Whether the *container* side (e.g. Squid's veth,
      // which is not attached to our namespace) ever actually received
      // an RX frame is a completely separate, host-root-namespace-only
      // fact: if the bridge/container veth's RX counter never
      // increments across a request while our own TX counter does, the
      // frame left our port but was never delivered onto the
      // container's port -- narrowing the failure to something the
      // bridge itself is doing (or not doing) between those two ports.
      run(this.tools.ip, ['-s', 'link', 'show']),
    ]);
    return [
      `--- bridge fdb show br ${bridgeName} (host-side, outside any netns) ---`,
      fdb || '(empty or unavailable)',
      '--- nft -a list ruleset (host/default namespace, e.g. Docker-managed nftables rules) ---',
      hostNftRuleset || '(empty or unavailable)',
      '--- iptables -S (host/default namespace, e.g. Docker-managed legacy iptables rules) ---',
      hostIptablesRules || '(empty or unavailable)',
      '--- sysctl net.bridge.bridge-nf-call-* (is bridged traffic even seen by netfilter?) ---',
      bridgeNfSysctls || '(empty, unavailable, or the bridge kernel module is not loaded)',
      '--- bridge link show (STP port state: forwarding/learning/blocking) ---',
      bridgeLinkState || '(empty or unavailable)',
      '--- ip -s link show (host/default namespace: per-port RX/TX counters, incl. container veths) ---',
      hostLinkStats || '(empty or unavailable)',
    ].join('\n');
  }
}
