# syntax=docker/dockerfile:1.7

# Alpine, like the other AWF images: Debian slim carries High CVEs that Debian won't fix,
# which the blocking supply-chain scan rejects.
FROM python:3.12.15-alpine3.24@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4

ARG VERSION=0.1.3
ARG VCS_REF=unknown
ARG OPENAPI_SHA256
ARG PIP_INDEX_URL=https://pypi.org/simple
LABEL org.opencontainers.image.title="gh-aw-router HTTP sidecar" \
    org.opencontainers.image.description="Stateless classification planning and model routing" \
    org.opencontainers.image.source="https://github.com/github/gh-aw-firewall" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.licenses="MIT" \
    io.github.gh-aw-router.openapi-sha256="${OPENAPI_SHA256}"

ENV HOME=/home/gh-aw-router \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    GH_AW_ROUTER_ROUTING_TABLES=/routing

RUN apk upgrade --no-cache \
    && addgroup -S -g 10001 gh-aw-router \
    && adduser -S -D -u 10001 -G gh-aw-router \
        -h /home/gh-aw-router -s /sbin/nologin gh-aw-router \
    && mkdir -p /app/src /routing

COPY requirements.lock /tmp/requirements.lock
RUN python -m pip install \
    --disable-pip-version-check \
    --index-url "${PIP_INDEX_URL}" \
    --no-cache-dir \
    --require-hashes \
    --requirement /tmp/requirements.lock \
    && rm /tmp/requirements.lock

COPY src /app/src
RUN python -c "import sys; from gh_aw_router import __version__; sys.exit(0 if sys.argv[1] == __version__ else 'VERSION must match the package version')" "$VERSION"
COPY routing /routing
# Fails the build unless the label matches the shipped contract, so the label cannot drift from it.
COPY openapi.yaml /app/openapi.yaml
RUN printf '%s  /app/openapi.yaml\n' "${OPENAPI_SHA256}" | sha256sum -c -s

RUN find /app /routing -type d -exec chmod 0555 {} + \
    && find /app /routing -type f -exec chmod 0444 {} +

USER 10001:10001
WORKDIR /home/gh-aw-router

EXPOSE 8737
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=2s --start-period=2s --retries=12 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8737/healthz', timeout=1).close()"]

ENTRYPOINT ["python", "-m", "gh_aw_router"]
CMD ["serve", "--bind", "0.0.0.0:8737", "--log-level", "info"]
