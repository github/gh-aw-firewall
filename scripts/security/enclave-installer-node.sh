#!/bin/bash
# Run only from authenticated, root-protected staging, under env -i.
set -euo pipefail
export PATH=/usr/bin:/bin LC_ALL=C

fail() {
    printf 'Enclave Node setup: %s\n' "$*" >&2
    exit 1
}

# Resolve symlinks before checking every ancestor. Copying or chowning a
# runner-writable executable does not authenticate it.
trusted_path() {
    local resolved current owner mode
    resolved=$(/usr/bin/readlink -e -- "$1") || return 1
    [[ "$resolved" == /* && "$resolved" != *$'\n'* && "$resolved" != *$'\r'* ]] || return 1
    current=$resolved
    while :; do
        read -r owner mode < <(/usr/bin/stat -c '%u %a' -- "$current") || return 1
        [[ "$owner" == 0 && "$mode" =~ ^[0-7]+$ ]] || return 1
        (( (8#$mode & 8#022) == 0 )) || return 1
        [[ "$current" != / ]] || break
        current=${current%/*}
        [[ -n "$current" ]] || current=/
    done
    printf '%s\n' "$resolved"
}

probe_node() {
    local candidate metadata version major minor
    candidate=$(trusted_path "$1") || return 1
    [[ -f "$candidate" && -x "$candidate" ]] || return 1
    metadata=$(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
        "$candidate" --no-addons --no-global-search-paths \
        -p 'process.platform + ":" + process.arch + ":" + process.versions.node' 2>/dev/null) || return 1
    [[ "$metadata" == "linux:$node_arch:"* ]] || return 1
    version=${metadata##*:}
    [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
    major=${BASH_REMATCH[1]}
    minor=${BASH_REMATCH[2]}
    # Match AWF's minimum Node API baseline, without pinning a distribution.
    (( major > 20 || (major == 20 && minor >= 19) )) || return 1
    printf '%s\n' "$candidate"
}

find_node() {
    local candidate
    for candidate in "${node_paths[@]}" /usr/bin/node /usr/local/bin/node; do
        if probe_node "$candidate"; then return 0; fi
    done
    for candidate in "$tool_cache"/node/*/"$node_arch"/bin/node; do
        if probe_node "$candidate"; then return 0; fi
    done
    return 1
}

install_node() {
    local apt
    apt=$(trusted_path /usr/bin/apt-get) || fail 'No trusted apt-get; provision a root-managed Node >=20.19 installation or protected tool cache.'
    [[ -f "$apt" && -x "$apt" ]] || fail 'apt-get is not executable.'
    # APT owns repository authentication, architecture selection and download
    # caching. Never add a repository or run an installer fetched from PATH.
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C DEBIAN_FRONTEND=noninteractive \
        "$apt" update >&2 || fail 'Could not refresh authenticated Node packages.'
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C DEBIAN_FRONTEND=noninteractive \
        "$apt" install -y --no-install-recommends nodejs >&2 || fail 'Could not install Node through apt-get.'
}

node_architecture() {
    case "$1" in
        x86_64|amd64) printf 'x64\n' ;;
        aarch64|arm64) printf 'arm64\n' ;;
        *) fail 'Only Linux x64 and ARM64 are supported.' ;;
    esac
}

resolve_node() {
    local selected
    if selected=$(find_node); then
        printf '%s\n' "$selected"
        return
    fi
    if "$install"; then
        install_node
        if selected=$(find_node); then
            printf '%s\n' "$selected"
            return
        fi
    fi
    fail 'No trusted compatible Node >=20.19 runtime. Configure an authenticated system package source providing it, or a root-managed installation/cache; runner-writable PATH and setup-node caches cannot be elevated.'
}

main() {
    [[ "$EUID" == 0 ]] || fail 'Run as root from authenticated, protected staging with a clean environment.'
    local tool_cache=/opt/hostedtoolcache node_arch install=false
    local -a node_paths=()
    while (( $# )); do
        case "$1" in
            --node-path|--tool-cache)
                (( $# >= 2 )) || fail "Missing value for $1."
                [[ "$2" == /* ]] || fail "$1 requires an absolute path."
                if [[ "$1" == --node-path ]]; then node_paths+=("$2"); else tool_cache=$2; fi
                shift 2
                ;;
            --install) install=true; shift ;;
            *) fail "Unknown option: $1." ;;
        esac
    done
    [[ "$(/usr/bin/uname -s)" == Linux ]] || fail 'Only Linux is supported.'
    node_arch=$(node_architecture "$(/usr/bin/uname -m)")
    resolve_node
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
