#!/bin/sh
# Create a new private store; never rewrite the supplied host/container inputs.
set -eu
output=$1
shift
policy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
policy_file="$policy_dir/distrusted-spki.txt"
[ -f "$policy_file" ] && [ -s "$policy_file" ] && [ -r "$policy_file" ] || {
    echo "AWF trust policy: missing, empty, or unreadable distrust policy: $policy_file" >&2
    exit 1
}
mkdir -p "$output"
work=$(mktemp -d "$output/.filter.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
: > "$work/input.pem"
for input in "$@"; do
    if [ -d "$input" ]; then
        for cert in "$input"/*; do
            [ -f "$cert" ] || continue
            case "$cert" in
                *.trust.crt) continue ;; # RHEL AUX trust is represented by its extracted TLS PEM bundle.
                *.crt|*.pem|*.[0-9]) cat "$cert" >> "$work/input.pem"; printf '\n' >> "$work/input.pem" ;;
            esac
        done
    elif [ -f "$input" ]; then
        cat "$input" >> "$work/input.pem"
        printf '\n' >> "$work/input.pem"
    else
        echo "AWF trust policy: missing CA input: $input" >&2
        exit 1
    fi
done
awk -v dir="$work" '
  /-----BEGIN CERTIFICATE-----/ { if (active) exit 1; active=1; block="" }
  active { block=block $0 "\n" }
  /-----END CERTIFICATE-----/ {
    if (!active) exit 1
    if (!seen[block]++) {
      count++
      unique=dir "/cert-" count ".pem"
      print block > unique
      close(unique)
    }
    active=0
  }
  /-----BEGIN TRUSTED CERTIFICATE-----/ { exit 1 }
  END { if (active || !count) exit 1 }
' "$work/input.pem" || { echo "AWF trust policy: invalid or empty PEM CA store" >&2; exit 1; }
mkdir "$work/certs"
: > "$work/bundle.pem"
for cert in "$work"/cert-*.pem; do
    openssl x509 -in "$cert" -pubkey -noout > "$work/key.pem"
    openssl pkey -pubin -in "$work/key.pem" -outform DER -out "$work/key.der"
    openssl dgst -sha256 "$work/key.der" > "$work/digest"
    key=$(awk '{print $NF}' "$work/digest")
    if grep -Fqx "$key" "$policy_file"; then
        grep_status=0
    else
        grep_status=$?
    fi
    case "$grep_status" in
        0)
            echo "AWF trust policy: removed distrusted CA key $key" >&2
            continue
            ;;
        1) ;;
        *)
            echo "AWF trust policy: failed to read distrust policy: $policy_file" >&2
            exit 1
            ;;
    esac
    openssl x509 -in "$cert" -outform DER -out "$work/cert.der"
    openssl dgst -sha256 "$work/cert.der" > "$work/digest"
    fingerprint=$(awk '{print $NF}' "$work/digest")
    if [ ! -f "$work/certs/$fingerprint.pem" ]; then
        cp "$cert" "$work/certs/$fingerprint.pem"
        cat "$cert" >> "$work/bundle.pem"
    fi
done
[ -s "$work/bundle.pem" ] || { echo "AWF trust policy: no trusted certificates remain" >&2; exit 1; }
openssl rehash "$work/certs"
# A fresh destination is required so stale hash links cannot restore trust.
[ ! -e "$output/certs" ] && [ ! -e "$output/ca-certificates.crt" ] || {
    echo "AWF trust policy: destination store already exists: $output" >&2
    exit 1
}
mv "$work/certs" "$output/certs"
mv "$work/bundle.pem" "$output/ca-certificates.crt"
