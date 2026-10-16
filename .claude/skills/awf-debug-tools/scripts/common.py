#!/usr/bin/env python3
"""
Common utilities for awf debugging scripts.
No external dependencies - Python stdlib only.
"""

import os
import re
import json
import subprocess
import glob
from typing import Optional, Dict, List, Tuple, Any


# ============================================================================
# Log Discovery and Parsing
# ============================================================================

def find_squid_logs() -> Optional[str]:
    """
    Auto-discover Squid logs (running container or preserved).

    Returns:
        Path to access.log file, or None if not found
    """
    # Try running container first
    result = run_command(
        ['docker', 'inspect', 'awf-squid', '--format={{.State.Running}}'],
        capture=True,
        check=False
    )
    if result and result.strip() == 'true':
        return 'docker:awf-squid:/var/log/squid/access.log'

    # Try preserved logs (most recent)
    log_dirs = glob.glob('/tmp/squid-logs-*')
    if log_dirs:
        # Sort by timestamp in directory name (descending)
        log_dirs.sort(reverse=True)
        access_log = os.path.join(log_dirs[0], 'access.log')
        if os.path.exists(access_log):
            return access_log

    # Try work directories
    work_dirs = glob.glob('/tmp/awf-*')
    for work_dir in sorted(work_dirs, reverse=True):
        access_log = os.path.join(work_dir, 'squid-logs', 'access.log')
        if os.path.exists(access_log):
            return access_log

    return None


def read_squid_logs(log_path: str) -> List[str]:
    """
    Read Squid logs from file or running container.

    Args:
        log_path: Path to log file or docker:container:path format

    Returns:
        List of log lines
    """
    if log_path.startswith('docker:'):
        # Format: docker:awf-squid:/var/log/squid/access.log
        parts = log_path.split(':', 2)
        container = parts[1]
        path = parts[2]
        result = run_command(['docker', 'exec', container, 'cat', path], capture=True)
        return result.splitlines() if result else []
    else:
        # Regular file path
        try:
            with open(log_path, 'r') as f:
                return f.readlines()
        except (OSError, UnicodeError):
            return []


def parse_squid_log_line(line: str) -> Optional[Dict[str, Any]]:
    """
    Parse firewall_detailed format line.

    Format: timestamp clientIP:port host:port destIP:port protocol method status decision url userAgent

    Returns:
        Dict with parsed fields or None if parse failed
    """
    # Regex for firewall_detailed format
    pattern = r'(\d+\.\d+) ([\d.]+):(\d+) ([^:\s]+):(\d+) ([^:\s]+):(\d+) ([\S]+) (\w+) (\d+) ([^:]+):(\S+) (\S+) "([^"]*)"'

    match = re.match(pattern, line.strip())
    if not match:
        return None

    timestamp, client_ip, client_port, host, host_port, dest_ip, dest_port, \
        protocol, method, status, decision, hierarchy, url, user_agent = match.groups()

    # Extract domain from host field
    domain = host.split(':')[0] if ':' in host else host
    if domain == '-':
        # Try to extract from URL
        url_match = re.search(r'(?:https?://)?([^:/\s]+)', url)
        domain = url_match.group(1) if url_match else '-'

    # Determine if allowed
    is_allowed = 'DENIED' not in decision

    return {
        'timestamp': float(timestamp),
        'client_ip': client_ip,
        'client_port': client_port,
        'domain': domain,
        'host': host,
        'dest_ip': dest_ip,
        'dest_port': dest_port,
        'protocol': protocol,
        'method': method,
        'status_code': int(status),
        'decision': decision,
        'url': url,
        'user_agent': user_agent,
        'is_allowed': is_allowed,
        'is_https': method == 'CONNECT'
    }


# ============================================================================
# Container Operations
# ============================================================================

def get_container_status(name: str) -> Tuple[str, int]:
    """
    Get container running/stopped/missing status.

    Returns:
        Tuple of (status, exit_code) where status is 'running', 'stopped', or 'missing'
    """
    try:
        # Check if container exists
        result = run_command(
            ['docker', 'ps', '-a', '--filter', f'name=^{name}$', '--format={{.Names}}'],
            capture=True,
            check=False
        )

        if not result or result.strip() != name:
            return ('missing', -1)

        # Check if running
        result = run_command(
            ['docker', 'inspect', name, '--format={{.State.Running}}'],
            capture=True,
            check=False
        )

        if result and result.strip() == 'true':
            return ('running', 0)

        # Get exit code
        result = run_command(
            ['docker', 'inspect', name, '--format={{.State.ExitCode}}'],
            capture=True,
            check=False
        )

        exit_code = int(result.strip()) if result else -1
        return ('stopped', exit_code)

    except ValueError:
        return ('missing', -1)


def get_container_ip(name: str) -> Optional[str]:
    """
    Get container IP address.

    Returns:
        IP address or None if container not found/not connected
    """
    result = run_command(
        ['docker', 'inspect', name, '--format={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'],
        capture=True,
        check=False
    )
    ip = result.strip() if result else None
    return ip if ip and ip != '' else None


def check_container_health(name: str) -> Optional[str]:
    """
    Get health check status.

    Returns:
        'healthy', 'unhealthy', 'starting', or None if no healthcheck
    """
    result = run_command(
        ['docker', 'inspect', name, '--format={{.State.Health.Status}}'],
        capture=True,
        check=False
    )
    status = result.strip() if result else None

    # If no healthcheck, result is '<no value>'
    if status and status != '<no value>':
        return status
    return None


def get_container_processes(name: str, limit: int = 5) -> List[Dict[str, str]]:
    """
    Get top N processes from container.

    Returns:
        List of dicts with 'name', 'pid', 'cpu' keys
    """
    result = run_command(
        ['docker', 'exec', name, 'ps', 'aux'],
        capture=True,
        check=False
    )

    if not result:
        return []

    lines = result.splitlines()[1:]  # Skip header
    processes = []

    for line in lines[:limit]:
        parts = line.split()
        if len(parts) >= 11:
            processes.append({
                'name': parts[10],
                'pid': parts[1],
                'cpu': parts[2]
            })

    return processes


def get_container_logs(name: str, tail: int = 5) -> List[str]:
    """
    Get recent container logs.

    Returns:
        List of log lines
    """
    result = run_command(
        ['docker', 'logs', '--tail', str(tail), name],
        capture=True,
        check=False
    )
    return result.splitlines() if result else []


# ============================================================================
# Squid Configuration
# ============================================================================

def find_squid_config() -> Optional[str]:
    """
    Find Squid config file.

    Returns:
        Path to squid.conf or None if not found
    """
    # Try work directories (most recent)
    work_dirs = glob.glob('/tmp/awf-*')
    for work_dir in sorted(work_dirs, reverse=True):
        squid_conf = os.path.join(work_dir, 'squid.conf')
        if os.path.exists(squid_conf):
            return squid_conf

    return None


def read_squid_config(config_path: Optional[str] = None) -> Optional[str]:
    """
    Read Squid config.

    Args:
        config_path: Path to squid.conf, or None to auto-discover

    Returns:
        Config content or None if not found
    """
    if config_path is None:
        config_path = find_squid_config()

    if config_path is None:
        return None

    try:
        with open(config_path, 'r') as f:
            return f.read()
    except (OSError, UnicodeError):
        return None


def get_allowed_domains(squid_config: str) -> List[str]:
    """
    Extract allowed domains from Squid config.

    Returns:
        List of allowed domain patterns
    """
    domains = []

    # Look for ACL lines defining allowed_domains
    for line in squid_config.splitlines():
        line = line.strip()
        if line.startswith('acl allowed_domains') and 'dstdomain' in line:
            # Format: acl allowed_domains dstdomain "/etc/squid/allowed_domains.txt"
            # or: acl allowed_domains dstdomain .github.com github.com
            parts = line.split()
            if len(parts) > 3:
                # Check if it's a file reference
                if parts[3].startswith('"'):
                    continue
                # Inline domains
                domains.extend(parts[3:])

    # Also check for inline domain definitions after the ACL line
    in_acl_block = False
    for line in squid_config.splitlines():
        line = line.strip()
        if 'acl allowed_domains dstdomain' in line:
            in_acl_block = True
            parts = line.split()
            if len(parts) > 3 and not parts[3].startswith('"'):
                domains.extend(parts[3:])
        elif in_acl_block and line and not line.startswith('#'):
            # Continuation lines
            if line.startswith('acl') or line.startswith('http_access'):
                in_acl_block = False
            else:
                domains.extend(line.split())

    return [d.strip('"') for d in domains if d and not d.startswith('#')]


# ============================================================================
# Utility Functions
# ============================================================================

def run_command(cmd: List[str], capture: bool = True, check: bool = True) -> Optional[str]:
    """
    Run shell command with error handling.

    Args:
        cmd: Command as list of strings
        capture: Whether to capture output
        check: Whether to raise on error

    Returns:
        Command output (stdout) if capture=True, else None
    """
    try:
        if capture:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=check
            )
            return result.stdout
        else:
            subprocess.run(cmd, check=check)
            return None
    except subprocess.CalledProcessError:
        if check:
            raise
        return None if capture else None
    except (OSError, UnicodeError):
        return None


def format_table(headers: List[str], rows: List[List[str]], align: Optional[List[str]] = None) -> str:
    """
    Format data as aligned table.

    Args:
        headers: Column headers
        rows: Data rows
        align: List of 'left' or 'right' for each column (default: all left)

    Returns:
        Formatted table string
    """
    if not rows:
        return ""

    if align is None:
        align = ['left'] * len(headers)

    # Calculate column widths
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))

    # Format header
    header_line = "  ".join(
        h.ljust(widths[i]) if align[i] == 'left' else h.rjust(widths[i])
        for i, h in enumerate(headers)
    )
    separator = "  ".join("=" * w for w in widths)

    # Format rows
    lines = [header_line, separator]
    for row in rows:
        line = "  ".join(
            str(cell).ljust(widths[i]) if align[i] == 'left' else str(cell).rjust(widths[i])
            for i, cell in enumerate(row)
        )
        lines.append(line)

    return "\n".join(lines)


def format_json(data: Any, pretty: bool = True) -> str:
    """
    Format data as JSON.

    Args:
        data: Data to serialize
        pretty: Whether to pretty-print

    Returns:
        JSON string
    """
    if pretty:
        return json.dumps(data, indent=2, ensure_ascii=False)
    else:
        return json.dumps(data, ensure_ascii=False)


def check_network_exists(network_name: str = 'awf-net') -> bool:
    """
    Check if Docker network exists.

    Returns:
        True if network exists
    """
    try:
        result = run_command(
            ['docker', 'network', 'ls', '--filter', f'name=^{network_name}$', '--format={{.Name}}'],
            capture=True,
            check=False
        )
        return result and result.strip() == network_name
    except OSError:
        return False


def test_connectivity(host: str, port: int, container: str = 'awf-agent') -> bool:
    """
    Test network connectivity from container.

    Returns:
        True if connection successful
    """
    result = run_command(
        ['docker', 'exec', container, 'nc', '-zv', '-w', '2', host, str(port)],
        capture=True,
        check=False
    )
    # nc returns 0 on success
    # Check if "succeeded" or "open" in output
    return result is not None and ('succeeded' in result.lower() or 'open' in result.lower())
