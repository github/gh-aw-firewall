# syntax=docker/dockerfile:1.7

ARG VERSION=0.2.0

# The builder runs on the build machine and cross-compiles, so multi-platform builds need no
# emulation. The runtime image has no shell, so every check runs here.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS build

ARG VERSION
ARG OPENAPI_SHA256
# Go's default. Builds behind a module mirror can override it.
ARG GOPROXY=https://proxy.golang.org,direct
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local

WORKDIR /src
COPY go.* ./
RUN go mod download && go mod verify
COPY *.go ./
RUN grep -qxF "const version = \"${VERSION}\"" main.go \
    || { echo "VERSION must match the version constant in main.go" >&2; exit 1; }
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/usr/local/bin/gh-aw-router .

# Fails the build unless the label matches the shipped contract, so the label cannot drift from it.
COPY openapi.yaml /out/app/openapi.yaml
RUN printf '%s  /out/app/openapi.yaml\n' "${OPENAPI_SHA256}" | sha256sum -c -s
COPY routing/cost-*.json /out/routing/
# AWF's CA distrust policy filters the bundle the runtime image ships.
COPY trust/ /opt/awf/trust/
RUN apk add --no-cache openssl ca-certificates \
    && sh /opt/awf/trust/install-system-trust.sh
RUN mkdir -p /out/etc/ssl/certs \
    && cp /etc/ssl/certs/ca-certificates.crt /out/etc/ssl/certs/ \
    && find /out -type d -exec chmod 0555 {} + \
    && find /out -type f -exec chmod 0444 {} + \
    && chmod 0555 /out/usr/local/bin/gh-aw-router

FROM scratch

ARG VERSION
ARG VCS_REF=unknown
ARG OPENAPI_SHA256
LABEL org.opencontainers.image.title="gh-aw-router HTTP sidecar" \
    org.opencontainers.image.description="Stateless classification planning and model routing" \
    org.opencontainers.image.source="https://github.com/github/gh-aw-firewall" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.licenses="MIT" \
    io.github.gh-aw-router.openapi-sha256="${OPENAPI_SHA256}"

COPY --from=build /out/ /

# AWF limits the container to 512 MiB and 100 processes, without a CPU quota.
ENV GH_AW_ROUTER_ROUTING_TABLES=/routing \
    GOMAXPROCS=2 \
    GOMEMLIMIT=384MiB

USER 10001:10001

EXPOSE 8737
STOPSIGNAL SIGTERM

# No HEALTHCHECK, like the other AWF images: AWF's compose config runs
# /usr/local/bin/gh-aw-router healthcheck.
ENTRYPOINT ["/usr/local/bin/gh-aw-router"]
CMD ["serve", "--bind", "0.0.0.0:8737", "--log-level", "info"]
