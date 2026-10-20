# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown
# Bun only installs dependencies; keep in sync with "packageManager" in package.json.
ARG BUN_IMAGE=oven/bun:1.3.14-alpine

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

# Use the official Alpine mirror by default. A repository variable/build arg can
# override it for environments that require a regional mirror.
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS builder
ARG NPM_REGISTRY

RUN apk add --no-cache python3 make g++ linux-headers

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
# Frozen lockfile: the build fails instead of resolving new versions.
# better-sqlite3 is the only trusted install script (see trustedDependencies).
RUN --mount=type=cache,target=/root/.bun/install/cache \
    BUN_CONFIG_REGISTRY="${NPM_REGISTRY}" \
    bun install --frozen-lockfile

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
ARG FORKED_FROM_VERSION=unknown
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="regent" \
      org.opencontainers.image.version="${APP_VERSION}" \
      dev.regent.forked-from="decolua/9router@${FORKED_FROM_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Files outside src/mitm that it requires (tracing doesn't follow the child process).
# tests/unit/dockerfile-mitm-copy.test.js checks this set stays complete.
COPY --from=builder /app/src/lib/appDir.cjs ./src/lib/appDir.cjs
COPY --from=builder /app/src/shared/constants/mitmToolHosts.js ./src/shared/constants/mitmToolHosts.js
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# Optional per-account TLS fingerprint impersonation: wreq-js is external and lazily
# imported, and its musl native binding lives in a separate @wreq-js/* package tracing can't see.
COPY --from=builder /app/node_modules/wreq-js ./node_modules/wreq-js
COPY --from=builder /app/node_modules/@wreq-js ./node_modules/@wreq-js

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.regent 2>/dev/null || true

# Avoid a full distribution upgrade in the runtime image. It makes builds less
# reproducible and is unrelated to installing the runtime entrypoint helper.
RUN apk add --no-cache su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
