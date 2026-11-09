ARG PROXY_IMAGE
FROM ${PROXY_IMAGE}
USER root
RUN mkdir -m 700 /evidence && chown apiproxy:apiproxy /evidence
COPY scripts/ci/reflect-smoke/fixture.cjs /fixture.cjs
USER apiproxy
HEALTHCHECK NONE
CMD ["node", "/fixture.cjs"]
