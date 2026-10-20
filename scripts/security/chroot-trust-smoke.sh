#!/bin/bash
# Run only inside a disposable Linux container with CAP_SYS_ADMIN, repository
# mounted read-only at /work, and containers/trust mounted at /opt/awf/trust.
set -euo pipefail
[ -f /.dockerenv ] && [ ! -e /host ] || {
  echo "This test requires a disposable container without an existing /host" >&2
  exit 1
}
mkdir -p /fixtures/etc/ssl/certs /host/etc/ssl /host/run/awf-lib
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=private-awf \
  -keyout /fixtures/private.key -out /fixtures/private.pem >/dev/null 2>&1
cat /fixtures/private.pem /work/scripts/security/fixtures/emsign-ecc-g3.pem \
  > /fixtures/etc/ssl/certs/ca-certificates.crt
cp /work/scripts/security/fixtures/emsign-ecc-g3.pem /fixtures/etc/ssl/certs/compromised.pem
openssl rehash /fixtures/etc/ssl/certs 2>/dev/null
before="$(sha256sum /fixtures/etc/ssl/certs/ca-certificates.crt)"
mount --bind /fixtures/etc/ssl /host/etc/ssl
mount -o remount,ro,bind /host/etc/ssl
# shellcheck source=../../containers/agent/entrypoint.sh
source /work/containers/agent/entrypoint.sh
AWF_CA_CHROOT=""
unset NODE_EXTRA_CA_CERTS NODE_OPTIONS
copy_system_ca_bundle
openssl verify -CAfile /host/etc/ssl/certs/ca-certificates.crt \
  -CApath /host/etc/ssl/certs /fixtures/private.pem
if openssl verify -CAfile /host/etc/ssl/certs/ca-certificates.crt \
  -CApath /host/etc/ssl/certs /work/scripts/security/fixtures/emsign-ecc-g3.pem; then
  echo "Compromised trust survived the chroot overlay" >&2
  exit 1
fi
[ "$(sha256sum /fixtures/etc/ssl/certs/ca-certificates.crt)" = "$before" ]
if touch /host/etc/ssl/certs/should-not-write; then
  echo "Trust overlay is writable" >&2
  exit 1
fi
echo "Linux chroot CA overlays reject compromised trust, retain private trust, and leave source mounts unchanged"
