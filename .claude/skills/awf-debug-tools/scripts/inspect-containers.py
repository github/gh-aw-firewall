#!/usr/bin/env python3
"""
Inspect awf containers with concise, noise-free output.
Shows status, health, processes, logs without verbose docker output.
"""

import sys
import os
import argparse
import subprocess
from typing import Dict, List

# Add scripts directory to path
sys.path.insert(0, os.path.dirname(__file__))
import common


def inspect_container(name: str, tail: int = 5) -> Dict:
    """
    Inspect single container.

    Returns:
        Dict with container info
    """
    status, exit_code = common.get_container_status(name)

    info = {
        'name': name,
        'status': status,
        'exit_code': exit_code if status == 'stopped' else None,
        'ip': None,
        'network': None,
        'health': None,
        'processes': [],
        'logs': []
    }

    if status == 'missing':
        return info

    # Get IP and network
    ip = common.get_container_ip(name)
    if ip:
        info['ip'] = ip
        info['network'] = 'awf-net'

    # Get health
    health = common.check_container_health(name)
    if health:
        info['health'] = health

    # Get processes (only if running)
    if status == 'running':
        processes = common.get_container_processes(name, limit=5)
        info['processes'] = processes

    # Get logs
    logs = common.get_container_logs(name, tail=tail)
    info['logs'] = logs

    return info


def get_network_info() -> Dict:
    """
    Get network information.

    Returns:
        Dict with network info
    """
    if not common.check_network_exists('awf-net'):
        return {'exists': False}

    try:
        # Get subnet
        result = common.run_command(
            ['docker', 'network', 'inspect', 'awf-net', '--format={{range .IPAM.Config}}{{.Subnet}}{{end}}'],
            capture=True,
            check=False
        )
        subnet = result.strip() if result else 'unknown'

        # Get gateway
        result = common.run_command(
            ['docker', 'network', 'inspect', 'awf-net', '--format={{range .IPAM.Config}}{{.Gateway}}{{end}}'],
            capture=True,
            check=False
        )
        gateway = result.strip() if result else 'unknown'

        # Get connected containers
        squid_ip = common.get_container_ip('awf-squid')
        agent_ip = common.get_container_ip('awf-agent')

        containers = []
        if squid_ip:
            containers.append(f"awf-squid ({squid_ip})")
        if agent_ip:
            containers.append(f"awf-agent ({agent_ip})")

        return {
            'exists': True,
            'subnet': subnet,
            'gateway': gateway,
            'containers': containers
        }
    except (OSError, subprocess.SubprocessError, ValueError):
        return {'exists': True, 'subnet': 'unknown'}


def format_text_output(containers: List[Dict], network: Dict, logs_only: bool) -> str:
    """Format results as text."""
    lines = []

    if logs_only:
        # Only show logs
        for container in containers:
            if container['logs']:
                lines.append(f"=== {container['name']} logs ===")
                lines.extend(container['logs'])
                lines.append("")
        return "\n".join(lines)

    # Full output
    for container in containers:
        lines.append(f"Container: {container['name']}")

        if container['status'] == 'missing':
            lines.append("  Status: Not found")
            lines.append("")
            continue

        # Status
        status_str = container['status']
        if container['status'] == 'stopped':
            status_str = f"Exited (code: {container['exit_code']})"
        elif container['status'] == 'running':
            if container['health']:
                status_str = f"Running ({container['health']})"
            else:
                status_str = "Running"

        lines.append(f"  Status: {status_str}")

        # IP and network
        if container['ip']:
            lines.append(f"  IP: {container['ip']}")
            if container['network']:
                lines.append(f"  Network: {container['network']}")

        # Processes
        if container['processes']:
            lines.append("")
            lines.append("  Top Processes:")
            for proc in container['processes']:
                lines.append(f"    {proc['name']:<15} PID {proc['pid']:<6} CPU {proc['cpu']}%")

        # Logs
        if container['logs']:
            lines.append("")
            lines.append("  Recent Logs:")
            for log in container['logs']:
                # Truncate long lines
                log_line = log[:100] + '...' if len(log) > 100 else log
                lines.append(f"    {log_line}")

        lines.append("")

    # Network info
    if network['exists']:
        lines.append("Network: awf-net")
        lines.append(f"  Subnet: {network['subnet']}")
        if network.get('gateway'):
            lines.append(f"  Gateway: {network['gateway']}")
        if network.get('containers'):
            lines.append(f"  Containers: {', '.join(network['containers'])}")
    else:
        lines.append("Network: awf-net (not found)")

    return "\n".join(lines)


def format_json_output(containers: List[Dict], network: Dict) -> str:
    """Format results as JSON."""
    data = {
        'containers': containers,
        'network': network
    }
    return common.format_json(data, pretty=True)


def main():
    parser = argparse.ArgumentParser(
        description='Inspect awf containers with concise output',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Inspect all containers
  %(prog)s

  # Inspect specific container
  %(prog)s --container awf-squid

  # Show only logs
  %(prog)s --logs-only

  # More log lines
  %(prog)s --tail 20

  # JSON output
  %(prog)s --format json
        """
    )

    parser.add_argument(
        '--container',
        choices=['awf-squid', 'awf-agent'],
        help='Inspect specific container only'
    )
    parser.add_argument(
        '--logs-only',
        action='store_true',
        help='Show only recent logs'
    )
    parser.add_argument(
        '--tail',
        type=int,
        default=5,
        metavar='N',
        help='Number of log lines to show (default: 5)'
    )
    parser.add_argument(
        '--format',
        choices=['text', 'json'],
        default='text',
        help='Output format (default: text)'
    )

    args = parser.parse_args()

    # Inspect containers
    container_names = [args.container] if args.container else ['awf-squid', 'awf-agent']
    containers = [inspect_container(name, args.tail) for name in container_names]

    # Get network info
    network = get_network_info()

    # Output
    if args.format == 'json':
        print(format_json_output(containers, network))
    else:
        print(format_text_output(containers, network, args.logs_only))

    # Exit code: 0 if all found, 1 if any missing, 2 for error
    missing_count = sum(1 for c in containers if c['status'] == 'missing')
    sys.exit(0 if missing_count == 0 else 1)


if __name__ == '__main__':
    main()
