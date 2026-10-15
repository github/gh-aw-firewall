# syntax=docker/dockerfile:1.7

FROM python:3.12.14-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

ARG VERSION=0.1.3
ARG VCS_REF=unknown
ARG OPENAPI_SHA256
ARG PIP_INDEX_URL=https://pypi.org/simple
LABEL org.opencontainers.image.title="gh-aw-router HTTP sidecar" \
    org.opencontainers.image.description="Stateless classification planning and model routing" \
    org.opencontainers.image.source="https://github.com/githubnext/gh-aw-router" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.licenses="MIT" \
    io.github.gh-aw-router.openapi-sha256="${OPENAPI_SHA256}"

ENV HOME=/home/gh-aw-router \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    GH_AW_ROUTER_ROUTING_TABLES=/routing

RUN apt-get update \
    && apt-get upgrade --yes --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 gh-aw-router \
    && useradd --system --uid 10001 --gid gh-aw-router \
        --create-home --home-dir /home/gh-aw-router \
        --shell /usr/sbin/nologin gh-aw-router \
    && mkdir --parents /app/src /routing

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
RUN printf '%s  /app/openapi.yaml\n' "${OPENAPI_SHA256}" | sha256sum --check --strict --quiet
COPY LICENSE /usr/share/doc/gh-aw-router/LICENSE

RUN find /app /routing -type d -exec chmod 0555 {} + \
    && find /app /routing -type f -exec chmod 0444 {} + \
    && chmod 0444 /usr/share/doc/gh-aw-router/LICENSE

USER 10001:10001
WORKDIR /home/gh-aw-router

EXPOSE 8737
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=2s --start-period=2s --retries=12 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8737/healthz', timeout=1).close()"]

ENTRYPOINT ["python", "-m", "gh_aw_router"]
CMD ["serve", "--bind", "0.0.0.0:8737", "--log-level", "info"]
