#!/usr/bin/env python3
"""
Parse Squid access logs and extract blocked domains.
Provides actionable insights on blocked traffic.
"""

import sys
import os
import argparse
from collections import defaultdict
from datetime import datetime
from typing import Dict, List

# Add scripts directory to path
sys.path.insert(0, os.path.dirname(__file__))
import common


def parse_logs(log_path: str, options: Dict) -> Dict:
    """
    Parse logs and aggregate statistics.

    Returns:
        Dict with summary and per-domain statistics
    """
    lines = common.read_squid_logs(log_path)

    # Aggregate by domain
    stats = defaultdict(lambda: {'allowed': 0, 'blocked': 0, 'total': 0})
    total_requests = 0
    total_allowed = 0
    total_blocked = 0
    min_ts = None
    max_ts = None

    for line in lines:
        entry = common.parse_squid_log_line(line)
        if not entry:
            continue

        # Time range filtering
        if options.get('time_range'):
            # TODO: Implement time range filtering
            pass

        # Domain filtering
        if options.get('domain') and options['domain'] not in entry['domain']:
            continue

        # Blocked-only filtering
        if options.get('blocked_only') and entry['is_allowed']:
            continue

        # Update stats
        domain = entry['domain']
        if domain and domain != '-':
            if entry['is_allowed']:
                stats[domain]['allowed'] += 1
                total_allowed += 1
            else:
                stats[domain]['blocked'] += 1
                total_blocked += 1

            stats[domain]['total'] += 1
            total_requests += 1

            # Track time range
            ts = entry['timestamp']
            if min_ts is None or ts < min_ts:
                min_ts = ts
            if max_ts is None or ts > max_ts:
                max_ts = ts

    # Convert to list and sort
    domain_list = [
        {
            'domain': domain,
            'allowed': counts['allowed'],
            'blocked': counts['blocked'],
            'total': counts['total']
        }
        for domain, counts in stats.items()
    ]

    # Sort by total count (descending)
    domain_list.sort(key=lambda x: x['total'], reverse=True)

    # Apply top N limit
    if options.get('top'):
        domain_list = domain_list[:options['top']]

    return {
        'summary': {
            'total': total_requests,
            'allowed': total_allowed,
            'blocked': total_blocked,
            'time_range': {
                'start': datetime.fromtimestamp(min_ts).isoformat() if min_ts else None,
                'end': datetime.fromtimestamp(max_ts).isoformat() if max_ts else None
            } if min_ts else None
        },
        'domains': domain_list
    }


def format_table_output(data: Dict, blocked_only: bool) -> str:
    """Format results as table."""
    summary = data['summary']
    domains = data['domains']

    lines = []

    # Title
    if blocked_only:
        lines.append("Blocked Domains (sorted by count):")
    else:
        lines.append("Domain Statistics (sorted by total requests):")

    lines.append("")

    # Table
    if domains:
        headers = ['Domain', 'Blocked', 'Allowed', 'Total']
        rows = [
            [d['domain'], str(d['blocked']), str(d['allowed']), str(d['total'])]
            for d in domains
        ]
        lines.append(common.format_table(headers, rows))
    else:
        lines.append("No matching domains found.")

    lines.append("")

    # Summary
    lines.append(f"Total requests: {summary['total']}")
    if summary['total'] > 0:
        blocked_pct = (summary['blocked'] / summary['total']) * 100
        allowed_pct = (summary['allowed'] / summary['total']) * 100
        lines.append(f"Blocked: {summary['blocked']} ({blocked_pct:.1f}%)")
        lines.append(f"Allowed: {summary['allowed']} ({allowed_pct:.1f}%)")

    if summary.get('time_range'):
        tr = summary['time_range']
        lines.append("")
        lines.append(f"Time range: {tr['start']} to {tr['end']}")

    return "\n".join(lines)


def format_json_output(data: Dict) -> str:
    """Format results as JSON."""
    return common.format_json(data, pretty=True)


def main():
    parser = argparse.ArgumentParser(
        description='Parse Squid access logs and extract blocked domains',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Parse logs (auto-discover)
  %(prog)s

  # Parse specific log file
  %(prog)s --log-file /tmp/squid-logs-12345/access.log

  # Show only blocked domains
  %(prog)s --blocked-only

  # Filter by domain
  %(prog)s --domain github.com

  # Show top 10 domains
  %(prog)s --top 10

  # JSON output
  %(prog)s --format json
        """
    )

    parser.add_argument(
        '--log-file',
        help='Path to Squid access.log (auto-discovers if not specified)'
    )
    parser.add_argument(
        '--blocked-only',
        action='store_true',
        help='Show only blocked domains'
    )
    parser.add_argument(
        '--domain',
        help='Filter by specific domain'
    )
    parser.add_argument(
        '--top',
        type=int,
        metavar='N',
        help='Show top N domains by request count'
    )
    parser.add_argument(
        '--format',
        choices=['table', 'json'],
        default='table',
        help='Output format (default: table)'
    )
    parser.add_argument(
        '--time-range',
        metavar='HH:MM-HH:MM',
        help='Filter by time range (not yet implemented)'
    )

    args = parser.parse_args()

    # Find logs
    log_path = args.log_file
    if log_path is None:
        log_path = common.find_squid_logs()
        if log_path is None:
            print("Error: Could not find Squid logs.", file=sys.stderr)
            print("", file=sys.stderr)
            print("Squid logs are searched in:", file=sys.stderr)
            print("  1. Running awf-squid container", file=sys.stderr)
            print("  2. Preserved logs: /tmp/squid-logs-<timestamp>/", file=sys.stderr)
            print("  3. Work directories: /tmp/awf-<timestamp>/squid-logs/", file=sys.stderr)
            print("", file=sys.stderr)
            print("Use --log-file to specify a log file path.", file=sys.stderr)
            sys.exit(2)

    # Parse logs
    options = {
        'blocked_only': args.blocked_only,
        'domain': args.domain,
        'top': args.top,
        'time_range': args.time_range
    }

    try:
        data = parse_logs(log_path, options)
    except (OSError, UnicodeError, ValueError) as e:
        print(f"Error parsing logs: {e}", file=sys.stderr)
        sys.exit(2)

    # Output
    if args.format == 'json':
        print(format_json_output(data))
    else:
        print(format_table_output(data, args.blocked_only))

    # Exit code: 0 if no blocked, 1 if some blocked
    sys.exit(0 if data['summary']['blocked'] == 0 else 1)


if __name__ == '__main__':
    main()
