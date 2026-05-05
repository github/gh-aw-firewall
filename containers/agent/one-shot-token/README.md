# One-Shot Token Library

## Overview

The one-shot token library is an `LD_PRELOAD` shared library that provides **cached access** to sensitive environment variables containing GitHub, OpenAI, Anthropic/Claude, and Codex API tokens. When a process reads a protected token via `getenv()`, the library caches the value in memory and immediately unsets the environment variable. Subsequent `getenv()` calls return the cached value, allowing the process to read tokens multiple times while `/proc/self/environ` is cleared.

This protects against exfiltration via `/proc/self/environ` inspection while allowing legitimate multi-read access patterns that programs like the Copilot CLI require.

## Configuration

### Debug Logging

By default, the library operates **silently** with no output to stderr. To enable debug logging, set the `AWF_ONE_SHOT_TOKEN_DEBUG` environment variable:

```bash
# Enable debug logging
export AWF_ONE_SHOT_TOKEN_DEBUG=1
# or
export AWF_ONE_SHOT_TOKEN_DEBUG=true

# Run your command with the library preloaded
LD_PRELOAD=/usr/local/lib/one-shot-token.so ./your-program
```

**Important notes:**
- Debug logging is **off by default** to reduce noise in production environments
- When enabled, the library logs initialization messages and token access events to stderr
- The `AWF_ONE_SHOT_TOKEN_DEBUG` variable is never cached or cleared (prevents infinite recursion)
- Set to `"1"` or `"true"` (case-insensitive) to enable debug logging

### Default Protected Tokens

By default, the library protects these token variables:

**GitHub:**
- `COPILOT_GITHUB_TOKEN`
- `GITHUB_TOKEN`
- `GH_TOKEN`
- `GITHUB_API_TOKEN`
- `GITHUB_PAT`
- `GH_ACCESS_TOKEN`

**OpenAI:**
- `OPENAI_API_KEY`
- `OPENAI_KEY`

**Anthropic/Claude:**
- `ANTHROPIC_API_KEY`
- `CLAUDE_API_KEY`

**Codex:**
- `CODEX_API_KEY`

### Custom Token List

You can configure a custom list of tokens to protect using the `AWF_ONE_SHOT_TOKENS` environment variable:

```bash
# Protect custom tokens instead of defaults
export AWF_ONE_SHOT_TOKENS="MY_API_KEY,MY_SECRET_TOKEN,CUSTOM_AUTH_KEY"

# Run your command with the library preloaded
LD_PRELOAD=/usr/local/lib/one-shot-token.so ./your-program
```

**Important notes:**
- When `AWF_ONE_SHOT_TOKENS` is set with valid tokens, **only** those tokens are protected (defaults are not included)
- If `AWF_ONE_SHOT_TOKENS` is set but contains only whitespace or commas (e.g., `"   "` or `",,,"`), the library falls back to the default token list to maintain protection
- Use comma-separated token names (whitespace is automatically trimmed)
- Maximum of 100 tokens can be protected
- The configuration is read once at library initialization (first `getenv()` call)
- Uses `strtok_r()` internally, which is thread-safe and won't interfere with application code using `strtok()`

## How It Works

### The LD_PRELOAD Mechanism

Linux's dynamic linker (`ld.so`) supports an environment variable called `LD_PRELOAD` that specifies shared libraries to load **before** all others. When a library is preloaded:

1. Its symbols take precedence over symbols in subsequently loaded libraries
2. This allows "interposing" or replacing standard library functions
3. The original function remains accessible via `dlsym(RTLD_NEXT, ...)`

```
┌─────────────────────────────────────────────────────────────────┐
│  Process Memory                                                 │
│                                                                 │
│  ┌──────────────────────┐                                       │
│  │ one-shot-token.so    │  ← Loaded first via LD_PRELOAD        │
│  │   getenv() ──────────┼──┐                                    │
│  └──────────────────────┘  │                                    │
│                            │ dlsym(RTLD_NEXT, "getenv")         │
│  ┌──────────────────────┐  │                                    │
│  │ libc.so              │  │                                    │
│  │   getenv() ←─────────┼──┘                                    │
│  └──────────────────────┘                                       │
│                                                                 │
│  Application calls getenv("GITHUB_TOKEN"):                      │
│  1. Resolves to one-shot-token.so's getenv()                    │
│  2. We check if it's a sensitive token                          │
│  3. If yes: cache value, unsetenv(), return cached value        │
│  4. If no: pass through to real getenv()                        │
└─────────────────────────────────────────────────────────────────┘
```

### Token Access Flow

```
First getenv("GITHUB_TOKEN") call:
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Application │────→│ one-shot-token.so │────→│ Real getenv │
│             │     │                    │     │             │
│             │←────│ Returns: "ghp_..." │←────│ "ghp_..."   │
└─────────────┘     │                    │     └─────────────┘
                    │ Then: unsetenv()   │
                    │ Mark as accessed   │
                    └──────────────────────┘

Second getenv("GITHUB_TOKEN") call:
┌─────────────┐     ┌──────────────────┐
│ Application │────→│ one-shot-token.so │
│             │     │                    │
│             │←────│ Returns: "ghp_..." │  (from in-memory cache)
└─────────────┘     └──────────────────────┘
```

### Thread Safety

The library uses a pthread mutex to ensure thread-safe access to the token state. Multiple threads calling `getenv()` simultaneously will be serialized for sensitive tokens, ensuring only one thread receives the actual value.

## Why This Works

### 1. Symbol Interposition

When `LD_PRELOAD=/usr/local/lib/one-shot-token.so` is set, the dynamic linker loads our library first. Any subsequent call to `getenv()` from the application or its libraries resolves to **our** implementation, not libc's.

### 2. Access to Original Function

We use `dlsym(RTLD_NEXT, "getenv")` to get a pointer to the **next** `getenv` in the symbol search order (libc's implementation). This allows us to:
- Call the real `getenv()` to retrieve the actual value
- Cache the value in an in-memory array
- Call `unsetenv()` to remove it from the environment (clears `/proc/self/environ`)
- Return the cached value to the caller

### 3. State Tracking and Caching

We maintain an array of flags (`token_accessed[]`) and a parallel cache array (`token_cache[]`). On first access, the token value is cached and the environment variable is unset. Subsequent calls return the cached value directly.

### 4. Memory Management

When we retrieve a token value, we `strdup()` it into the cache before calling `unsetenv()`. This is necessary because:
- `getenv()` returns a pointer to memory owned by the environment
- `unsetenv()` invalidates that pointer
- The caller expects a valid string, so we must copy it first

Note: This memory is intentionally never freed—it must remain valid for the lifetime of the caller's use.

## Integration with AWF

### Container Mode (non-chroot)

The library is built into the agent container image and loaded via:

```bash
export LD_PRELOAD=/usr/local/lib/one-shot-token.so
exec capsh --drop=$CAPS_TO_DROP -- -c "exec gosu awfuser $COMMAND"
```

### Chroot Mode

In chroot mode, the library must be accessible from within the chroot (host filesystem). The entrypoint:

1. Copies the library from container to `/host/tmp/awf-lib/one-shot-token.so`
2. Sets `LD_PRELOAD=/tmp/awf-lib/one-shot-token.so` inside the chroot
3. Cleans up the library on exit

## Building

### In Docker (automatic)

The Dockerfile compiles the library during image build with hardened flags:

```dockerfile
RUN gcc -shared -fPIC -fvisibility=hidden -O2 -Wall -s \
    -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
    -o /usr/local/lib/one-shot-token.so \
    /tmp/one-shot-token.c \
    -ldl -lpthread && \
    strip --strip-unneeded /usr/local/lib/one-shot-token.so
```

The `-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0` flags disable glibc's fortified I/O
wrappers (e.g. `__fprintf_chk`), which avoids that specific missing-symbol
failure on musl-based hosts such as Alpine Linux (used by ARC self-hosted
runners). Loading may still depend on host compatibility (for example,
`gcompat` availability), and without these flags the dynamic linker can fail
with `symbol not found: __fprintf_chk`.

### Locally (for testing)

Requires Rust toolchain (install via [rustup](https://rustup.rs/)):

```bash
./build.sh
```

This builds `target/release/libone_shot_token.so` and creates a symlink `one-shot-token.so` for backwards compatibility.

### Binary Hardening

The build applies several hardening measures to reduce reconnaissance value:

- **XOR-obfuscated token names**: Default token names are stored as XOR-encoded byte arrays
  and decoded at runtime. This prevents extraction via `strings` or `objdump -s -j .rodata`.
- **Hidden symbol visibility**: `-fvisibility=hidden` hides all internal symbols by default.
  Only `getenv` and `secure_getenv` are exported (required for LD_PRELOAD interposition).
- **Stripped binary**: `-s` flag and `strip --strip-unneeded` remove the symbol table,
  debug sections, and build metadata.

To regenerate the obfuscated byte arrays after changing default token names:

```bash
./encode-tokens.sh
# Paste the output into one-shot-token.c, replacing the OBFUSCATED_DEFAULTS section
```

## Testing

### Basic Test (Default Tokens)

```bash
# Build the library
./build.sh

# Create a simple C program that calls getenv twice
cat > test_getenv.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    const char *token1 = getenv("GITHUB_TOKEN");
    printf("First read: %s\n", token1 ? token1 : "");

    const char *token2 = getenv("GITHUB_TOKEN");
    printf("Second read: %s\n", token2 ? token2 : "");

    return 0;
}
EOF

# Compile the test program
gcc -o test_getenv test_getenv.c

# Test with the one-shot token library preloaded (with debug logging)
export GITHUB_TOKEN="test-token-12345"
export AWF_ONE_SHOT_TOKEN_DEBUG=1
LD_PRELOAD=./one-shot-token.so ./test_getenv
```

Expected output (with debug logging enabled):
```
[one-shot-token] Initialized with 11 default token(s)
[one-shot-token] Token GITHUB_TOKEN accessed and cached (length: 16)
[one-shot-token] INFO: Token GITHUB_TOKEN cleared from process environment
First read: test-token-12345
Second read: test-token-12345
```

**Note:** Without `AWF_ONE_SHOT_TOKEN_DEBUG=1`, the library operates silently with no stderr output.

### Custom Token Test

```bash
# Build the library
./build.sh

# Test with custom tokens (with debug logging)
export AWF_ONE_SHOT_TOKENS="MY_API_KEY,SECRET_TOKEN"
export AWF_ONE_SHOT_TOKEN_DEBUG=1
export MY_API_KEY="secret-value-123"
export SECRET_TOKEN="another-secret"

LD_PRELOAD=./one-shot-token.so bash -c '
  echo "First MY_API_KEY: $(printenv MY_API_KEY)"
  echo "Second MY_API_KEY: $(printenv MY_API_KEY)"
  echo "First SECRET_TOKEN: $(printenv SECRET_TOKEN)"
  echo "Second SECRET_TOKEN: $(printenv SECRET_TOKEN)"
'
```

Expected output (with debug logging enabled):
```
[one-shot-token] Initialized with 2 custom token(s) from AWF_ONE_SHOT_TOKENS
[one-shot-token] Token MY_API_KEY accessed and cached (length: 16)
[one-shot-token] INFO: Token MY_API_KEY cleared from process environment
First MY_API_KEY: secret-value-123
Second MY_API_KEY: secret-value-123
[one-shot-token] Token SECRET_TOKEN accessed and cached (length: 14)
[one-shot-token] INFO: Token SECRET_TOKEN cleared from process environment
First SECRET_TOKEN: another-secret
Second SECRET_TOKEN: another-secret
```

### Integration with AWF

When using the library with AWF (Agentic Workflow Firewall):

```bash
# Use default tokens (silent mode)
sudo awf --allow-domains github.com -- your-command

# Use custom tokens with debug logging
export AWF_ONE_SHOT_TOKENS="MY_TOKEN,CUSTOM_API_KEY"
export AWF_ONE_SHOT_TOKEN_DEBUG=1
sudo -E awf --allow-domains github.com -- your-command
```

**Important notes:**
- The `AWF_ONE_SHOT_TOKENS` variable must be exported before running `awf` so it's available when the library initializes
- Set `AWF_ONE_SHOT_TOKEN_DEBUG=1` to enable debug logging; otherwise the library operates silently
- Use `sudo -E` to preserve environment variables when running with sudo

## Security Considerations

### What This Protects Against

- **Token leakage via environment inspection**: `/proc/self/environ` and tools like `printenv` (in the same process) will not show the token after first access — the environment variable is unset
- **Token exfiltration via /proc**: Other processes reading `/proc/<pid>/environ` cannot see the token

### What This Does NOT Protect Against

- **Memory inspection**: The token exists in process memory (in the cache array)
- **Interception before first read**: If malicious code runs before the legitimate code reads the token, it gets the value
- **In-process getenv() calls**: Since values are cached, any code in the same process can still call `getenv()` and get the cached token
- **Static linking**: Programs statically linked with libc bypass LD_PRELOAD
- **Direct syscalls**: Code that reads `/proc/self/environ` directly (without getenv) bypasses this protection
- **Task-level /proc exposure**: `/proc/PID/task/TID/environ` may still expose tokens even after `unsetenv()`. The library checks and logs warnings about this exposure.

### Environment Verification

After calling `unsetenv()` to clear tokens, the library automatically verifies whether the token was successfully removed by directly checking the process's environment pointer. This works correctly in both regular and chroot modes.

**Log messages:**
- `INFO: Token <name> cleared from process environment` - Token successfully cleared (✓ secure)
- `WARNING: Token <name> still exposed in process environment` - Token still visible (⚠ security concern)
- `INFO: Token <name> cleared (environ is null)` - Environment pointer is null

This verification runs automatically after `unsetenv()` on first access to each sensitive token and helps identify potential security issues with environment exposure.

**Note on chroot mode:** The verification uses the process's `environ` pointer directly rather than reading from `/proc/self/environ`. This is necessary because in chroot mode, `/proc` may be bind-mounted from the host and show stale environment data.

### Defense in Depth

This library is one layer in AWF's security model:
1. **Network isolation**: iptables rules redirect traffic through Squid proxy
2. **Domain allowlisting**: Squid blocks requests to non-allowed domains
3. **Capability dropping**: CAP_NET_ADMIN is dropped to prevent iptables modification
4. **Token environment cleanup**: This library clears tokens from `/proc/self/environ` while caching for legitimate use

## Limitations

- **Linux only**: The library is compiled for Linux (x86_64 and potentially other architectures via Rust cross-compilation)
- **glibc programs only**: Programs using musl libc or statically linked programs are not affected by the interception (they do not load the library); AWF degrades gracefully by falling back to tokens remaining in the environment
- **Single process**: Child processes inherit the LD_PRELOAD but have their own token state and cache (each starts fresh)

## Files

- `one-shot-token.c` - Library source code (token names are XOR-obfuscated)
- `build.sh` - Local build script (includes hardening flags and verification)
- `encode-tokens.sh` - Generates XOR-encoded byte arrays for default token names
- `README.md` - This documentation
