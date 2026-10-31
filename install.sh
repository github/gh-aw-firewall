#!/bin/bash
set -e

# Install script for awf (Agentic Workflow Firewall)
# 
# This script authenticates release provenance before installing the awf binary.
# Obtain this installer and the gh verifier through an independently trusted channel;
# piping an unauthenticated HTTPS download into a shell cannot authenticate itself.
#
# Obtain and review this script through an independently authenticated channel;
# do not pipe an unauthenticated download into a privileged shell. Authenticate
# gh as your user, then explicitly preserve its token across sudo:
#   export GH_TOKEN="$(gh auth token)"
#   sudo --preserve-env=GH_TOKEN bash ./install.sh
#   sudo --preserve-env=GH_TOKEN bash ./install.sh v1.0.0
# Alternatively, set GITHUB_TOKEN and preserve that variable instead.
#
# Security features:
#   - Uses curl -f to fail on HTTP errors (404, 403, etc.)
#   - Requires GitHub artifact attestations from the release workflow
#   - Authenticates the requested tag and checksums before checking the payload
#   - Validates downloaded file is a valid ELF executable
#   - Detects HTML error pages that may slip through
#
# Requirements:
#   - curl
#   - A trusted gh CLI with attestation verify support (and GitHub authentication)
#   - sha256sum
#   - file
#   - sudo/root access
#
# Repository: https://github.com/github/gh-aw-firewall
# Issue #107: https://github.com/github/gh-aw-firewall/issues/107

REPO="github/gh-aw-firewall"
BINARY_NAME=""  # Set dynamically by check_platform
INSTALL_DIR="/usr/local/bin"
INSTALL_NAME="awf"
USE_BUNDLE=false  # Set by check_node

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Check if running as root
check_sudo() {
    if [ "$EUID" -ne 0 ]; then 
        error "This script must be run with sudo or as root"
        exit 1
    fi
}

# Compute SHA256 hash portably (Linux uses sha256sum, macOS uses shasum)
sha256_portable() {
    local file="$1"
    if command -v sha256sum &> /dev/null; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum &> /dev/null; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        error "Neither sha256sum nor shasum found"
        exit 1
    fi
}

# Check required commands
check_requirements() {
    local missing=()

    for cmd in curl file gh; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done

    # Need at least one SHA256 tool
    if ! command -v sha256sum &> /dev/null && ! command -v shasum &> /dev/null; then
        missing+=("sha256sum or shasum")
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing required commands: ${missing[*]}"
        error "Please install them and try again"
        exit 1
    fi

    if ! gh attestation verify --help 2>/dev/null | grep -q -- '--signer-workflow'; then
        error "A trusted gh CLI with 'attestation verify --signer-workflow' support is required"
        error "Install or upgrade gh through an independently authenticated channel"
        exit 1
    fi
}

# Check OS and architecture
check_platform() {
    local os arch
    os=$(uname -s)
    arch=$(uname -m)

    case "$os" in
        Linux)
            case "$arch" in
                x86_64|amd64)
                    BINARY_NAME="awf-linux-x64"
                    ;;
                aarch64|arm64)
                    BINARY_NAME="awf-linux-arm64"
                    ;;
                *)
                    error "Unsupported architecture: $arch (supported: x86_64, aarch64)"
                    exit 1
                    ;;
            esac
            ;;
        Darwin)
            case "$arch" in
                x86_64)
                    BINARY_NAME="awf-darwin-x64"
                    ;;
                arm64)
                    BINARY_NAME="awf-darwin-arm64"
                    ;;
                *)
                    error "Unsupported architecture: $arch (supported: x86_64, arm64)"
                    exit 1
                    ;;
            esac
            ;;
        *)
            error "Unsupported OS: $os (supported: Linux, macOS)"
            exit 1
            ;;
    esac

    info "Detected platform: $os $arch (binary: $BINARY_NAME)"
}

# Check for Node.js >= 20.19.0 to decide between bundle and pkg binary
# (matches engines.node requirement in package.json)
check_node() {
    if [ "${AWF_FORCE_BINARY:-}" = "1" ]; then
        info "AWF_FORCE_BINARY=1 set, using standalone binary"
        USE_BUNDLE=false
        return
    fi
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | sed 's/^v//')
        NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
        NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
        if [ "$NODE_MAJOR" -gt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 19 ]; }; then
            info "Node.js v${NODE_VERSION} detected (>= 20.19.0), using lightweight bundle"
            USE_BUNDLE=true
            return
        fi
        warn "Node.js v${NODE_VERSION} detected but < 20.19.0, using standalone binary"
    fi
    USE_BUNDLE=false
}

# Validate version format (should be like v1.0.0, v1.2.3, etc.)
validate_version() {
    local version="$1"
    if ! echo "$version" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
        error "Invalid version format: $version"
        error "Version should be in format: v1.0.0"
        exit 1
    fi
}

# Get latest release version
get_latest_version() {
    info "Fetching latest release version..."
    
    # Try GitHub API with -f to fail on HTTP errors
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    
    if [ -z "$VERSION" ]; then
        error "Failed to fetch latest version from GitHub API"
        error "Please check your internet connection and try again"
        exit 1
    fi
    
    info "Latest version: $VERSION"
}

# Set version from argument, environment variable, or fetch latest
set_version() {
    # Priority: argument > environment variable > fetch latest
    if [ -n "$1" ]; then
        VERSION="$1"
        validate_version "$VERSION"
        info "Using specified version: $VERSION"
    elif [ -n "$AWF_VERSION" ]; then
        VERSION="$AWF_VERSION"
        validate_version "$VERSION"
        info "Using version from AWF_VERSION: $VERSION"
    else
        get_latest_version
    fi
    validate_version "$VERSION"
}

# Download file
download_file() {
    local url="$1"
    local output="$2"
    
    info "Downloading from $url..."
    
    # Use -f to fail on HTTP errors (like 404)
    if ! curl -fsSL "$url" -o "$output"; then
        error "Failed to download $url"
        error "Please check if the release exists and try again"
        if [ "$(basename "$output")" = "release-identity.txt" ]; then
            error "Legacy releases without attested release identity metadata are not supported"
        fi
        exit 1
    fi
    
    # Check if file is not empty
    if [ ! -s "$output" ]; then
        error "Downloaded file is empty"
        rm -f "$output"
        exit 1
    fi
    
    # Check if file is HTML (common for 404 pages)
    if file "$output" | grep -q "HTML"; then
        error "Downloaded file appears to be an HTML page (possibly 404)"
        error "Please check if the release exists: https://github.com/${REPO}/releases"
        rm -f "$output"
        exit 1
    fi
}

# A checksum fetched over the same TLS connection as a payload is not authentication.
verify_provenance() {
    local asset="$1"
    if ! gh attestation verify "$asset" \
        --hostname github.com \
        --repo "$REPO" \
        --signer-workflow "${REPO}/.github/workflows/release.yml" \
        --cert-oidc-issuer https://token.actions.githubusercontent.com \
        --deny-self-hosted-runners; then
        error "Release provenance verification failed for $(basename "$asset")"
        error "An attested release and a trusted, authenticated gh CLI are required; legacy unattested releases are not supported"
        exit 1
    fi
}

# The release workflow is dispatched on a branch and checks out a new tag.
# Its certificate therefore identifies the dispatch branch, not the checkout tag.
# Authenticate the signed tag-to-checksums binding instead of trusting TLS metadata.
verify_release_identity() {
    local checksums_file="$1"
    local identity_file="$2"
    verify_provenance "$identity_file"
    local expected_identity
    expected_identity="$(sha256_portable "$checksums_file")  refs/tags/${VERSION}"
    if [ "$(cat "$identity_file")" != "$expected_identity" ]; then
        error "Release identity does not bind checksums.txt to refs/tags/${VERSION}"
        exit 1
    fi
    verify_provenance "$checksums_file"
}

# Verify checksum
verify_checksum() {
    local file="$1"
    local checksums_file="$2"
    
    info "Verifying SHA256 checksum..."
    
    # Extract the checksum for our binary from checksums.txt
    # Format: "checksum  filename" (two spaces) - use exact filename match at end of line
    local expected_sum
    expected_sum=$(awk -v fname="$BINARY_NAME" '$2 == fname {print $1; exit}' "$checksums_file")
    
    if [ -z "$expected_sum" ]; then
        error "Could not find checksum for $BINARY_NAME in checksums.txt"
        exit 1
    fi
    
    # Validate checksum format (64 hex characters, case-insensitive)
    if ! echo "$expected_sum" | grep -qE '^[a-fA-F0-9]{64}$'; then
        error "Invalid checksum format: $expected_sum"
        exit 1
    fi

    # Normalize checksum case
    expected_sum=$(echo "$expected_sum" | tr 'A-F' 'a-f')
    
    # Calculate actual checksum
    local actual_sum
    actual_sum=$(sha256_portable "$file" | tr 'A-F' 'a-f')
    
    if [ "$expected_sum" != "$actual_sum" ]; then
        error "Checksum verification failed!"
        error "Expected: $expected_sum"
        error "Got:      $actual_sum"
        error "The downloaded file may be corrupted or tampered with"
        exit 1
    fi
    
    info "Checksum verification passed ✓"
}

# Only the authenticated, version-matched helper is authorized, never mount,
# chown, a shell, or an arbitrary Python script.
install_enclave_storage_helper() {
    [ "$(uname -s)" = Linux ] || return 0
    local helper="enclave-storage-helper.py"
    if ! awk -v fname="$helper" '$2 == fname { found=1 } END { exit !found }' "$TEMP_DIR/checksums.txt"; then
        warn "This authenticated legacy release has no unprivileged Docker enclave support; installing the ordinary CLI only"
        return 0
    fi
    download_file "${BASE_URL}/${helper}" "$TEMP_DIR/$helper"
    verify_provenance "$TEMP_DIR/$helper"
    local BINARY_NAME="$helper"
    verify_checksum "$TEMP_DIR/$helper" "$TEMP_DIR/checksums.txt"
    local missing=()
    [ -x /usr/bin/python3 ] || missing+=("/usr/bin/python3")
    if [ -n "${SUDO_UID:-}" ]; then
        [ -x /usr/bin/sudo ] || missing+=("/usr/bin/sudo")
        [ -x /usr/sbin/visudo ] || missing+=("/usr/sbin/visudo")
    fi
    if [ ${#missing[@]} -ne 0 ]; then
        warn "Installing ordinary CLI without unprivileged Docker enclave support; missing helper prerequisites: ${missing[*]}"
        return 0
    fi
    if ! /usr/bin/env -i PATH=/usr/bin:/bin LANG=C /usr/bin/python3 -I "$TEMP_DIR/$helper" check-install-host >/dev/null 2>&1; then
        warn "Installing ordinary CLI without unprivileged Docker enclave support; this is not a supported privileged storage host"
        return 0
    fi
    /usr/bin/python3 -I - "$TEMP_DIR/$helper" "${VERSION#v}" "${SUDO_UID:-}" <<'PY'
import os, re, stat, subprocess, sys
source, version, uid = sys.argv[1:]
os.umask(0o022)
payload = open(source, "rb").read()
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or (
        b'VERSION = "' + version.encode() + b'"') not in payload:
    raise SystemExit("Enclave storage helper version mismatch")
def directory(name):
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    for part in name.strip("/").split("/"):
        try:
            os.mkdir(part, 0o755, dir_fd=fd)
        except FileExistsError:
            pass
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        info = os.fstat(child)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit("Unsafe helper installation directory")
        os.close(fd)
        fd = child
    return fd
def publish(fd, name, data, mode):
    staging = name + ".new-" + os.urandom(16).hex()
    try:
        child = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
        try:
            os.fchown(child, 0, 0)
            os.fchmod(child, mode)
            if os.write(child, data) != len(data):
                raise SystemExit("Incomplete helper installation")
            os.fsync(child)
        finally:
            os.close(child)
        os.replace(staging, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(staging, dir_fd=fd)
        except FileNotFoundError:
            pass
subprocess.run(["/usr/bin/python3", "-I", source, "install"],
               env={"PATH": "/usr/bin:/bin", "LANG": "C"}, check=True)
fd = directory("/var/lib/awf")
os.fchmod(fd, 0o755)
publish(fd, "enclave-storage-helper.py", payload, 0o644)
os.close(fd)
if uid:
    if not re.fullmatch(r"[1-9][0-9]{0,9}", uid) or int(uid) > 2147483647:
        raise SystemExit("Invalid installing user")
    policy = (f"#{uid} ALL=(root) NOPASSWD: /usr/bin/python3 -I "
              "/var/lib/awf/enclave-storage-helper.py *\n").encode()
    fd = directory("/etc/sudoers.d")
    name = "awf-enclave-storage-" + uid
    # Validate a root-only staging policy before publishing authorization.
    publish(fd, name + ".pending", policy, 0o440)
    subprocess.run(["/usr/sbin/visudo", "-cf", "/etc/sudoers.d/" + name + ".pending"],
                   env={"PATH": "/usr/bin:/bin", "LANG": "C"}, check=True)
    os.replace(name + ".pending", name, src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)
    os.close(fd)
PY
}

# Main installation function
main() {
    info "Starting awf installation..."
    
    # Check requirements
    check_sudo
    check_requirements
    check_platform
    check_node

    # Get version (from argument, env var, or fetch latest)
    set_version "$1"

    # Create temp directory with prefix for identification
    # mktemp creates secure temporary directories with proper permissions (0700)
    TEMP_DIR=$(mktemp -d -t awf-install.XXXXXX)

    # Validate temp directory was created
    if [ -z "$TEMP_DIR" ] || [ ! -d "$TEMP_DIR" ]; then
        error "Failed to create temporary directory"
        exit 1
    fi

    # Set up cleanup trap (mktemp already ensures secure location)
    trap 'rm -rf "$TEMP_DIR"' EXIT

    # Download URLs
    BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
    CHECKSUMS_URL="${BASE_URL}/checksums.txt"
    download_file "$CHECKSUMS_URL" "$TEMP_DIR/checksums.txt"
    download_file "${BASE_URL}/release-identity.txt" "$TEMP_DIR/release-identity.txt"
    verify_release_identity "$TEMP_DIR/checksums.txt" "$TEMP_DIR/release-identity.txt"

    if [ "$USE_BUNDLE" = true ]; then
        # Lightweight bundle path — requires Node.js >= 20
        ASSET_NAME="awf-bundle.js"
        ASSET_URL="${BASE_URL}/${ASSET_NAME}"

        download_file "$ASSET_URL" "$TEMP_DIR/$ASSET_NAME"
        verify_provenance "$TEMP_DIR/$ASSET_NAME"

        # Verify checksum (reuse BINARY_NAME for the checksum lookup)
        BINARY_NAME="$ASSET_NAME"
        verify_checksum "$TEMP_DIR/$ASSET_NAME" "$TEMP_DIR/checksums.txt"

        # Validate the file starts with the expected shebang
        if head -c 20 "$TEMP_DIR/$ASSET_NAME" | grep -q '#!/usr/bin/env node'; then
            info "Valid Node.js bundle"
        else
            error "Downloaded file does not appear to be a valid Node.js bundle"
            exit 1
        fi

        install_enclave_storage_helper

        # Make executable and install
        chmod +x "$TEMP_DIR/$ASSET_NAME"
        info "Installing bundle to $INSTALL_DIR/$INSTALL_NAME..."
        mv "$TEMP_DIR/$ASSET_NAME" "$INSTALL_DIR/$INSTALL_NAME"
    else
        # Standalone pkg binary path
        BINARY_URL="${BASE_URL}/${BINARY_NAME}"

        # Download binary and checksums
        download_file "$BINARY_URL" "$TEMP_DIR/$BINARY_NAME"
        verify_provenance "$TEMP_DIR/$BINARY_NAME"

        # Verify checksum
        verify_checksum "$TEMP_DIR/$BINARY_NAME" "$TEMP_DIR/checksums.txt"

        # Make binary executable
        chmod +x "$TEMP_DIR/$BINARY_NAME"

        # Test if it's a valid executable (ELF on Linux, Mach-O on macOS)
        local file_type
        file_type=$(file "$TEMP_DIR/$BINARY_NAME")
        if echo "$file_type" | grep -q "ELF.*executable"; then
            info "Valid Linux ELF executable"
        elif echo "$file_type" | grep -q "Mach-O 64-bit"; then
            info "Valid macOS Mach-O executable"
        else
            error "Downloaded file is not a valid executable: $file_type"
            exit 1
        fi

        install_enclave_storage_helper

        # Install binary
        info "Installing to $INSTALL_DIR/$INSTALL_NAME..."
        mv "$TEMP_DIR/$BINARY_NAME" "$INSTALL_DIR/$INSTALL_NAME"
    fi

    # Verify installation
    if [ -x "$INSTALL_DIR/$INSTALL_NAME" ]; then
        info "Installation successful! ✓"
        info ""
        info "Run 'awf --help' to get started"
        info "Note: awf requires Docker to be installed and running"
    else
        error "Installation failed - binary not found at $INSTALL_DIR/$INSTALL_NAME"
        exit 1
    fi
}

# Run main function with all arguments
main "$@"
