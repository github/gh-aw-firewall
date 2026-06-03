#!/bin/bash
# Generate XOR-obfuscated byte arrays for default token names.
# Run this script whenever the default token list changes, then paste
# the output into one-shot-token.c (replacing the OBFUSCATED_DEFAULTS section).
#
# The obfuscation prevents token names from appearing as cleartext strings
# in the .rodata section of the compiled binary. This is NOT cryptographic
# security -- a determined attacker can reverse the XOR. The goal is to
# defeat casual reconnaissance via strings(1) / objdump.

set -euo pipefail

KEY=0x5A

TOKENS=(
    "COPILOT_GITHUB_TOKEN"
    "GITHUB_TOKEN"
    "GH_TOKEN"
    "GITHUB_API_TOKEN"
    "GITHUB_PAT"
    "GH_ACCESS_TOKEN"
    "OPENAI_API_KEY"
    "OPENAI_KEY"
    "ANTHROPIC_API_KEY"
    "CLAUDE_API_KEY"
    "CODEX_API_KEY"
    "COPILOT_PROVIDER_API_KEY"
)

echo "/* --- BEGIN GENERATED OBFUSCATED DEFAULTS (key=0x$(printf '%02X' $KEY)) --- */"
echo "/* Re-generate with: containers/agent/one-shot-token/encode-tokens.sh */"
echo "#define NUM_DEFAULT_TOKENS ${#TOKENS[@]}"
echo ""

for i in "${!TOKENS[@]}"; do
    token="${TOKENS[$i]}"
    printf "static const unsigned char OBF_%d[] = { " "$i"
    for ((j=0; j<${#token}; j++)); do
        byte=$(printf '%d' "'${token:$j:1}")
        encoded=$((byte ^ KEY))
        if ((j > 0)); then
            printf ", "
        fi
        printf "0x%02x" "$encoded"
    done
    printf " }; /* length=%d */\n" "${#token}"
done

echo ""
echo "static const struct obf_entry OBFUSCATED_DEFAULTS[${#TOKENS[@]}] = {"
for i in "${!TOKENS[@]}"; do
    echo "    { OBF_${i}, sizeof(OBF_${i}) },"
done
echo "};"
echo "/* --- END GENERATED OBFUSCATED DEFAULTS --- */"
