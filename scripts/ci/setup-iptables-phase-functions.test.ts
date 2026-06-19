import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const setupIptablesPath = path.resolve(__dirname, '../../containers/agent/setup-iptables.sh');

describe('setup-iptables phase functions', () => {
  it('defines expected phase functions', () => {
    const source = fs.readFileSync(setupIptablesPath, 'utf-8');

    const requiredFunctions = [
      'is_ipv6',
      'is_valid_ipv4',
      'has_ip6tables',
      'is_valid_port_spec',
      'allow_service_ports_to_ip',
      'check_ip6tables_availability',
      'disable_ipv6',
      'resolve_squid_ip',
      'preserve_docker_dns_rules',
      'configure_nat_bypasses',
      'configure_dns_nat_rules',
      'configure_host_access_rules',
      'configure_http_dnat',
      'configure_filter_chain',
      'dump_nat_rules_for_debugging',
      'dump_audit_state',
      'main',
    ];

    for (const fn of requiredFunctions) {
      expect(source).toMatch(new RegExp(`^${fn}\\(\\) \\{`, 'm'));
    }
  });

  it('calls rule setup phases in main() order', () => {
    const source = fs.readFileSync(setupIptablesPath, 'utf-8');
    const match = source.match(/^main\(\) \{\n([\s\S]*?)^\}/m);

    expect(match).not.toBeNull();
    const mainBlock = match?.[1] ?? '';

    const requiredCalls = [
      'check_ip6tables_availability',
      'disable_ipv6',
      'resolve_squid_ip',
      'preserve_docker_dns_rules',
      'configure_nat_bypasses',
      'configure_dns_nat_rules',
      'configure_host_access_rules',
      'configure_http_dnat',
      'configure_filter_chain',
      'dump_nat_rules_for_debugging',
      'dump_audit_state',
    ];

    let lastIndex = -1;
    for (const call of requiredCalls) {
      const index = mainBlock.indexOf(call);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('passes bash syntax check', () => {
    expect(() => execFileSync('bash', ['-n', setupIptablesPath])).not.toThrow();
  });
});
