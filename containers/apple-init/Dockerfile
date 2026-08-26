# AWF Apple Container init image.
#
# Apple's containerization runtime executes `/sbin/vminitd` from a *separate*
# init image (`container run --init-image ...`), not from the workload image.
# That is the only place AWF can install code that runs inside a NIC-less guest
# before the workload starts, so it is where the layer-2 capability relay lives.
#
# The transformation is deliberately minimal and auditable:
#
#   1. Take Apple's own `vminit` image, unmodified and digest-pinned.
#   2. Move Apple's `/sbin/vminitd` aside to `/sbin/vminitd.apple`.
#   3. Install the AWF shim at `/sbin/vminitd`.
#
# The shim binds every capability's loopback listener and then `syscall.Exec`s
# `/sbin/vminitd.apple`, so Apple's real init keeps PID 1 and its reaping,
# signal, and lifecycle semantics are exactly what Apple shipped. Nothing else
# in the image is added, removed, or rewritten.
#
# Version coupling: the shim execs Apple's init from a fixed path inside this
# image, so the image is only valid for the `container` CLI range the host half
# validates (`APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION` ..
# `APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE`). Both bounds and the
# transport contract version are recorded as labels so a built image can be
# checked against the CLI it will run under without unpacking it.
#
# Reproducibility: every base image is digest-pinned, the shim module has no
# third-party dependencies, and the build uses `-trimpath -buildvcs=false` with
# cgo disabled — the same flags as `guest/apple-container-init/build.sh`. That
# script remains the local/CI determinism harness (it pins its own Go toolchain
# and verifies a stable digest); this Dockerfile is the release artifact path
# and uses the repository's shared pinned Go image, so the two produce
# functionally identical binaries from identical sources rather than
# byte-identical ones across differing toolchains.
#
# Build with `scripts/build-apple-init-image.sh`, which enforces the
# digest-pinned `AWF_VMINIT_IMAGE` requirement before invoking Docker.

# Apple's unmodified init image. MUST be a digest-pinned reference: a floating
# tag would let the base image move underneath a shim that hard-codes where
# Apple's init lives, turning a silent mismatch into a guest with no
# capabilities. Enforced by the assemble stage below.
ARG AWF_VMINIT_IMAGE

# Supported Apple `container` CLI range this init image is validated against.
# Kept in sync with src/apple-container/transport-capabilities.ts.
ARG AWF_CLI_MIN_VERSION=0.4.0
ARG AWF_CLI_MAX_VERSION_EXCLUSIVE=1.0.0
ARG AWF_TRANSPORT_CONTRACT_VERSION=1

FROM golang:1.26.6-alpine@sha256:af8d6740070b8906d12eae1c3e3ea0957fb63f492051ea05e354c38ef9fe88df AS toolchain

# ── Guest relay shim ─────────────────────────────────────────────────────────
FROM toolchain AS shim-build
WORKDIR /src
# Sources only; the module declares no third-party requirements, so there is no
# download step and nothing outside this repository enters the binary.
COPY guest/apple-container-init/go.mod ./
COPY guest/apple-container-init/*.go ./
# GOARCH is hard-coded rather than taken from TARGETARCH: an Apple Container
# guest is always native arm64 and Rosetta translation is never used, so an
# amd64 build would be a silently wrong artifact rather than a useful one.
RUN set -eux; \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
      go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/vminitd .; \
    test -s /out/vminitd

FROM ${AWF_VMINIT_IMAGE} AS vminit

# ── Assemble ─────────────────────────────────────────────────────────────────
FROM toolchain AS assemble
ARG AWF_VMINIT_IMAGE
COPY --from=vminit / /rootfs
COPY --from=shim-build /out/vminitd /shim/vminitd
RUN set -eux; \
    case "${AWF_VMINIT_IMAGE}" in \
      *@sha256:*) : ;; \
      *) echo "AWF_VMINIT_IMAGE must be digest-pinned (got '${AWF_VMINIT_IMAGE}')" >&2; exit 1 ;; \
    esac; \
    # Apple's init must be present and executable, and must not already have
    # been relocated: rebuilding on top of an AWF init image would install the
    # shim over itself and lose Apple's binary entirely.
    test -x /rootfs/sbin/vminitd; \
    test ! -e /rootfs/sbin/vminitd.apple; \
    mv /rootfs/sbin/vminitd /rootfs/sbin/vminitd.apple; \
    install -m 0755 /shim/vminitd /rootfs/sbin/vminitd; \
    test -x /rootfs/sbin/vminitd; \
    test -x /rootfs/sbin/vminitd.apple

# ── Final image ──────────────────────────────────────────────────────────────
#
# `scratch` plus a single flattened copy: the init image is a small, purpose-
# built filesystem (Apple's init and its minimal support files), and flattening
# keeps the published artifact a faithful, inspectable snapshot of exactly what
# the assemble stage produced.
FROM scratch
ARG AWF_VMINIT_IMAGE
ARG AWF_CLI_MIN_VERSION
ARG AWF_CLI_MAX_VERSION_EXCLUSIVE
ARG AWF_TRANSPORT_CONTRACT_VERSION
COPY --from=assemble /rootfs/ /
LABEL org.opencontainers.image.title="AWF Apple Container init"
LABEL org.opencontainers.image.description="Apple vminit with the AWF capability relay shim installed at /sbin/vminitd"
LABEL org.opencontainers.image.source="https://github.com/github/gh-aw-firewall"
LABEL io.github.gh-aw-firewall.apple-init.base="${AWF_VMINIT_IMAGE}"
LABEL io.github.gh-aw-firewall.apple-init.contract-version="${AWF_TRANSPORT_CONTRACT_VERSION}"
LABEL io.github.gh-aw-firewall.apple-init.cli-min-version="${AWF_CLI_MIN_VERSION}"
LABEL io.github.gh-aw-firewall.apple-init.cli-max-version-exclusive="${AWF_CLI_MAX_VERSION_EXCLUSIVE}"
ENTRYPOINT ["/sbin/vminitd"]
