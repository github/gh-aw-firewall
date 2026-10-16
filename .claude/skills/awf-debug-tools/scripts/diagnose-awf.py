#!/usr/bin/env python3
"""
Run automated diagnostic checks on awf firewall.
Reports issues concisely with actionable fixes.
"""

import sys
import os
import subprocess
import argparse
from typing import List, Dict, Tuple

# Add scripts directory to path
sys.path.insert(0, os.path.dirname(__file__))
import common


class DiagnosticCheck:
    """Represents a single diagnostic check."""

    def __init__(self, name: str, passed: bool, message: str, fix: str = ""):
        self.name = name
        self.passed = passed
        self.message = message
        self.fix = fix


def check_containers() -> DiagnosticCheck:
    """Check if awf containers exist and their status."""
    squid_status, squid_exit = common.get_container_status('awf-squid')
    agent_status, agent_exit = common.get_container_status('awf-agent')

    messages = []
    if squid_status == 'missing':
        messages.append("awf-squid (missing)")
    elif squid_status == 'running':
        messages.append("awf-squid (running)")
    else:
        messages.append(f"awf-squid (stopped, exit:{squid_exit})")

    if agent_status == 'missing':
        messages.append("awf-agent (missing)")
    elif agent_status == 'running':
        messages.append("awf-agent (running)")
    else:
        messages.append(f"awf-agent (exited:{agent_exit})")

    passed = squid_status != 'missing' and agent_status != 'missing'
    message = ", ".join(messages)

    fix = ""
    if not passed:
        fix = "Run awf command to start containers, or check if containers were cleaned up"

    return DiagnosticCheck("Containers", passed, message, fix)


def check_squid_health() -> DiagnosticCheck:
    """Check Squid container health."""
    health = common.check_container_health('awf-squid')

    if health is None:
        return DiagnosticCheck(
            "Health",
            True,
            "No healthcheck configured (normal for older versions)",
            ""
        )

    passed = health == 'healthy'
    message = f"Squid {health}"

    fix = ""
    if not passed:
        if health == 'unhealthy':
            fix = "Check Squid logs: docker logs awf-squid"
        elif health == 'starting':
            fix = "Wait for healthcheck to complete"

    return DiagnosticCheck("Health", passed, message, fix)


def check_network() -> DiagnosticCheck:
    """Check if awf network exists."""
    exists = common.check_network_exists('awf-net')

    if exists:
        # Get network details
        try:
            result = common.run_command(
                ['docker', 'network', 'inspect', 'awf-net', '--format={{.IPAM.Config}}'],
                capture=True,
                check=False
            )
            subnet = result.strip() if result else "unknown"
            return DiagnosticCheck(
                "Network",
                True,
                f"awf-net exists ({subnet})",
                ""
            )
        except (OSError, subprocess.SubprocessError, UnicodeError):
            return DiagnosticCheck(
                "Network",
                True,
                "awf-net exists",
                ""
            )
    else:
        return DiagnosticCheck(
            "Network",
            False,
            "awf-net does not exist",
            "Network is created automatically when running awf"
        )


def check_connectivity() -> DiagnosticCheck:
    """Check if agent can reach Squid."""
    agent_status, _ = common.get_container_status('awf-agent')
    squid_status, _ = common.get_container_status('awf-squid')

    if agent_status != 'running' or squid_status != 'running':
        return DiagnosticCheck(
            "Connectivity",
            True,
            "Skipped (containers not running)",
            ""
        )

    # Test connectivity
    reachable = common.test_connectivity('172.30.0.10', 3128, 'awf-agent')

    if reachable:
        return DiagnosticCheck(
            "Connectivity",
            True,
            "Squid reachable on 172.30.0.10:3128",
            ""
        )
    else:
        return DiagnosticCheck(
            "Connectivity",
            False,
            "Squid NOT reachable on 172.30.0.10:3128",
            "Check if Squid is listening: docker exec awf-squid netstat -ln | grep 3128"
        )


def check_dns_config() -> DiagnosticCheck:
    """Check DNS configuration in agent container."""
    agent_status, _ = common.get_container_status('awf-agent')

    if agent_status != 'running':
        return DiagnosticCheck(
            "DNS",
            True,
            "Skipped (agent not running)",
            ""
        )

    # Read /etc/resolv.conf
    try:
        result = common.run_command(
            ['docker', 'exec', 'awf-agent', 'cat', '/etc/resolv.conf'],
            capture=True,
            check=False
        )

        if result:
            nameservers = [line.split()[1] for line in result.splitlines() if line.strip().startswith('nameserver')]
            if nameservers:
                return DiagnosticCheck(
                    "DNS",
                    True,
                    f"DNS servers: {', '.join(nameservers)}",
                    ""
                )
    except (OSError, subprocess.SubprocessError, IndexError):
        # A bare nameserver line falls through to the failed-DNS result below.
        pass

    return DiagnosticCheck(
        "DNS",
        False,
        "Could not read DNS configuration",
        "Check agent container resolv.conf: docker exec awf-agent cat /etc/resolv.conf"
    )


def check_squid_config() -> DiagnosticCheck:
    """Check Squid configuration."""
    config = common.read_squid_config()

    if config is None:
        return DiagnosticCheck(
            "Config",
            False,
            "Squid config not found",
            "Config is in /tmp/awf-<timestamp>/squid.conf when containers running"
        )

    domains = common.get_allowed_domains(config)

    if domains:
        domain_count = len(domains)
        sample = domains[:3]
        sample_str = ", ".join(sample)
        if domain_count > 3:
            sample_str += f", ... ({domain_count} total)"

        return DiagnosticCheck(
            "Config",
            True,
            f"{domain_count} domains in allowlist ({sample_str})",
            ""
        )
    else:
        return DiagnosticCheck(
            "Config",
            False,
            "No domains in allowlist",
            "Check squid.conf for 'acl allowed_domains' lines"
        )


def check_common_issues() -> List[DiagnosticCheck]:
    """Check for common issues."""
    checks = []

    # Check for port conflicts
    result = common.run_command(
        ['lsof', '-i', ':3128'],
        capture=True,
        check=False
    )
    if result and 'squid' not in result.lower():
        checks.append(DiagnosticCheck(
            "Port 3128",
            False,
            "Port 3128 in use by another process",
            "Stop other process using port 3128"
        ))

    # Check for orphaned containers
    result = common.run_command(
        ['docker', 'ps', '-a', '--filter', 'name=awf-', '--format={{.Names}}'],
        capture=True,
        check=False
    )
    if result:
        containers = result.strip().splitlines()
        if len(containers) > 2:
            checks.append(DiagnosticCheck(
                "Orphaned",
                False,
                f"{len(containers)} awf containers found (expected 2)",
                "Clean up with: docker rm -f $(docker ps -a --filter name=awf- -q)"
            ))

    return checks


def run_diagnostics(verbose: bool = False) -> Tuple[List[DiagnosticCheck], int]:
    """
    Run all diagnostic checks.

    Returns:
        Tuple of (checks, issue_count)
    """
    checks = []

    checks.append(check_containers())
    checks.append(check_squid_health())
    checks.append(check_network())
    checks.append(check_connectivity())
    checks.append(check_dns_config())
    checks.append(check_squid_config())
    checks.extend(check_common_issues())

    issue_count = sum(1 for c in checks if not c.passed)

    return checks, issue_count


def format_text_output(checks: List[DiagnosticCheck], verbose: bool) -> str:
    """Format results as text."""
    lines = []
    lines.append("AWF Diagnostic Report")
    lines.append("=" * 40)

    for check in checks:
        status = "✓" if check.passed else "✗"
        lines.append(f"[{status}] {check.name}: {check.message}")

        if not check.passed and check.fix:
            lines.append(f"    Fix: {check.fix}")

        if verbose and check.passed:
            # Show more details in verbose mode
            pass

    lines.append("")

    issue_count = sum(1 for c in checks if not c.passed)
    if issue_count == 0:
        lines.append("Summary: All checks passed ✓")
    else:
        issues_word = "issue" if issue_count == 1 else "issues"
        lines.append(f"Summary: {issue_count} {issues_word} found")

    return "\n".join(lines)


def format_json_output(checks: List[DiagnosticCheck]) -> str:
    """Format results as JSON."""
    issue_count = sum(1 for c in checks if not c.passed)

    data = {
        'summary': {
            'total_checks': len(checks),
            'passed': len(checks) - issue_count,
            'failed': issue_count
        },
        'checks': [
            {
                'name': c.name,
                'passed': c.passed,
                'message': c.message,
                'fix': c.fix if c.fix else None
            }
            for c in checks
        ]
    }

    return common.format_json(data, pretty=True)


def main():
    parser = argparse.ArgumentParser(
        description='Run automated diagnostic checks on awf firewall',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run diagnostics
  %(prog)s

  # Verbose output
  %(prog)s --verbose

  # JSON output
  %(prog)s --format json
        """
    )

    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Show detailed check output'
    )
    parser.add_argument(
        '--format',
        choices=['text', 'json'],
        default='text',
        help='Output format (default: text)'
    )
    parser.add_argument(
        '--fix',
        action='store_true',
        help='Attempt to fix common issues (not yet implemented)'
    )

    args = parser.parse_args()

    # Run diagnostics
    checks, issue_count = run_diagnostics(args.verbose)

    # Output
    if args.format == 'json':
        print(format_json_output(checks))
    else:
        print(format_text_output(checks, args.verbose))

    # Exit code: 0 if all passed, 1 if issues found, 2 for error
    sys.exit(0 if issue_count == 0 else 1)


if __name__ == '__main__':
    main()
