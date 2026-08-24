# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Production image build for AsciiDoCollab (pnpm monorepo).
#
# Multi-stage, with one runtime image PER SERVICE. Build-only stages are shared
# so the workspace compiles once; no runtime image contains another service, the
# monorepo source, dev dependencies or a compiler toolchain.
#
#   target: migrate     → one-shot job: applies the Prisma schema, then exits
#   target: api         → apps/api         (Fastify REST + internal auth server)
#   target: collab      → apps/collab      (Hocuspocus WebSocket + internal edit server)
#   target: git-worker  → apps/git-worker  (sandboxed git CLI runner; skeleton — no run loop yet)
#   target: web         → apps/web         (Next.js standalone)
#
# Stage graph:
#   base ─┬─ toolchain ── manifests ─┬─ deps ── build-backend ─┬─ build-web
#         │                          │                         └─ artifacts
#         │                          ├─ prod-api ────────┐
#         │                          ├─ prod-collab──────┤
#         │                          ├─ prod-git-worker──┤
#         │                          └─ prod-db ─────────┤
#         └─ runtime ──────────────────────────────────── ┴─ api / collab / git-worker / migrate / web
#
# Build context is the REPOSITORY ROOT (compose sets `context: ..`).
# ─────────────────────────────────────────────────────────────────────────────

# Alpine rather than Debian slim: ~106MB smaller per runtime image. This was
# verified, not assumed — the musl risk here is the native addons, so argon2
# (hash + verify), re2, and the Prisma client issuing a real query against
# Postgres were all exercised at runtime on musl before switching. Prisma 7 uses
# driver adapters with no engine binary, which is why it needs no libc-specific
# build target.
#
# Pinned BY DIGEST, not just tag: a tag is mutable, so `node:24-alpine` can point
# at different content tomorrow. The digest makes the base immutable and the
# build reproducible. Refresh deliberately with:
#   docker pull node:24-alpine && docker image inspect node:24-alpine \
#     --format '{{index .RepoDigests 0}}'
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack activates the pnpm version pinned in the root package.json.
RUN corepack enable
WORKDIR /app

# ─── toolchain: native-addon build tools (build-time only, never in runtime) ──
# argon2 / re2 / sharp ship prebuilds for common targets; the toolchain stays so
# an install still succeeds when a prebuild is unavailable.
FROM base AS toolchain
RUN apk add --no-cache python3 make g++ pkgconfig ca-certificates openssl libc6-compat

# ─── manifests: just the package manifests, for maximum install-layer caching ─
# Shared by the dev install and by each per-service production install.
FROM toolchain AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/collab/package.json     apps/collab/package.json
COPY apps/git-worker/package.json apps/git-worker/package.json
COPY apps/web/package.json        apps/web/package.json
COPY packages/asciidoc-core/package.json   packages/asciidoc-core/package.json
COPY packages/asciidoc-pdf/package.json    packages/asciidoc-pdf/package.json
COPY packages/db/package.json              packages/db/package.json
COPY packages/domain/package.json          packages/domain/package.json
COPY packages/infrastructure/package.json  packages/infrastructure/package.json
COPY packages/primitives/package.json      packages/primitives/package.json
COPY packages/shared/package.json          packages/shared/package.json
COPY packages/testing/package.json         packages/testing/package.json

# ─── deps: full workspace install (incl. dev deps — needed to compile) ────────
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile

# ─── build-backend: compile shared packages + the two Node services ───────────
# `pnpm -r build` for the db package also runs `prisma generate`.
FROM deps AS build-backend
COPY . .
RUN pnpm --filter '!@asciidocollab/web' -r build

# ─── artifacts: the compiled output ONLY (no src, no tests, no tsbuildinfo) ────
# Collected into a clean tree so production stages can take build output without
# dragging the source tree along behind it.
FROM build-backend AS artifacts
RUN set -eu; \
    for p in packages/asciidoc-core packages/asciidoc-pdf \
             packages/db packages/domain packages/infrastructure packages/primitives packages/shared \
             apps/api apps/collab apps/git-worker; do \
      if [ -d "/app/$p/dist" ]; then \
        mkdir -p "/artifacts/$p"; \
        cp -R "/app/$p/dist" "/artifacts/$p/dist"; \
      fi; \
    done; \
    # Runtime assets that live outside dist/.
    cp -R /app/apps/api/config  /artifacts/apps/api/config; \
    cp -R /app/apps/api/data    /artifacts/apps/api/data; \
    cp -R /app/packages/db/prisma /artifacts/packages/db/prisma; \
    cp /app/packages/db/prisma.config.ts /artifacts/packages/db/prisma.config.ts; \
    # The first-party PDF converter extensions, copied in beside the other runtime assets. They are
    # Ruby, so no dist/ ever contains them, and they live in the engine gem — but `pnpm deploy`
    # flattens apps/api to the image root and does not bring the monorepo tree along, and the API
    # deliberately does not depend on the engine package. Copying them here is what puts them
    # somewhere the API can still read at runtime; apps/api/src/lib/pdf-extensions.ts looks here
    # first and falls back to the gem for a development checkout.
    # Fail loudly if absent: the loader reads a missing directory as "nothing ships", which is right
    # for a checkout without the gem and silently wrong here — it would ship an image on which every
    # project's stored selection reads back as unavailable and every PDF renders unextended.
    e=/app/packages/asciidoc-pdf/ruby/extensions/asciidocollab-pdf-extensions/lib; \
    [ -d "$e" ] || { echo "FATAL: shipped PDF extensions not found at $e." >&2; exit 1; }; \
    mkdir -p /artifacts/apps/api/pdf-extensions; \
    cp -R "$e/." /artifacts/apps/api/pdf-extensions/; \
    # The Prisma client is generated INTO THE PNPM STORE, beside @prisma/client —
    # not into /app/node_modules/.prisma. Lift it to a stable path. Fail loudly if
    # it is missing: a silent skip here ships an image whose database layer is dead.
    d="$(find /app/node_modules/.pnpm -maxdepth 3 -type d -name .prisma | head -1)"; \
    [ -n "$d" ] || { echo "FATAL: generated Prisma client not found — did 'prisma generate' run?" >&2; exit 1; }; \
    mkdir -p /artifacts/.prisma; \
    cp -R "$d/." /artifacts/.prisma/

# ─── build-web: Next.js production build (standalone output) ──────────────────
# NEXT_PUBLIC_* is inlined into the browser bundle at build time, so the public
# URLs must be build args. NOTHING SECRET MAY BE PASSED HERE — build args are
# recoverable from image history.
FROM build-backend AS build-web
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_COLLAB_URL=ws://localhost:4002
ARG NEXT_PUBLIC_EDITOR_AUTOSAVE_DEBOUNCE_MS=4000
ARG NEXT_PUBLIC_EDITOR_POLL_INTERVAL_MS=30000
ARG NEXT_PUBLIC_PREVIEW_DEBOUNCE_MS=1500
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_COLLAB_URL=$NEXT_PUBLIC_COLLAB_URL \
    NEXT_PUBLIC_EDITOR_AUTOSAVE_DEBOUNCE_MS=$NEXT_PUBLIC_EDITOR_AUTOSAVE_DEBOUNCE_MS \
    NEXT_PUBLIC_EDITOR_POLL_INTERVAL_MS=$NEXT_PUBLIC_EDITOR_POLL_INTERVAL_MS \
    NEXT_PUBLIC_PREVIEW_DEBOUNCE_MS=$NEXT_PUBLIC_PREVIEW_DEBOUNCE_MS \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN pnpm --filter @asciidocollab/web build

# ─── Production dependency trees, one per service ─────────────────────────────
# Each is a CLEAN production-only install filtered to that service's subgraph, so
# dev dependencies are never present to begin with (rather than installed and
# then pruned). `deploy --node-linker=hoisted` then emits a flat, self-contained
# node_modules with no .pnpm store indirection.
#
# The subsequent `rm -rf` removes @prisma/client's OPTIONAL peer dependencies:
# pnpm auto-installs `prisma` (the CLI) and `typescript`, and the CLI drags in
# @prisma/studio-core + effect + pglite — ~145MB of tooling a running service
# never loads. They are declared optional by @prisma/client, so removing them is
# safe; the smoke test in docker/README.md verifies the client still works.
# re2's vendored C++ sources and object files are likewise build residue.
FROM manifests AS prod-api
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod --filter "@asciidocollab/api..."
COPY --from=artifacts /artifacts/ ./
RUN pnpm --filter @asciidocollab/api --prod --legacy --node-linker=hoisted deploy /prod/api \
 && rm -rf /prod/api/node_modules/prisma \
           /prod/api/node_modules/typescript \
           /prod/api/node_modules/@prisma/studio-core \
           /prod/api/node_modules/effect \
           /prod/api/node_modules/@electric-sql \
           /prod/api/node_modules/re2/vendor \
           /prod/api/node_modules/re2/build/Release/obj.target

FROM manifests AS prod-collab
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod --filter "@asciidocollab/collab..."
COPY --from=artifacts /artifacts/ ./
RUN pnpm --filter @asciidocollab/collab --prod --legacy --node-linker=hoisted deploy /prod/collab \
 && rm -rf /prod/collab/node_modules/prisma \
           /prod/collab/node_modules/typescript \
           /prod/collab/node_modules/@prisma/studio-core \
           /prod/collab/node_modules/effect \
           /prod/collab/node_modules/@electric-sql \
           /prod/collab/node_modules/re2/vendor \
           /prod/collab/node_modules/re2/build/Release/obj.target

# git-worker has no Prisma dependency yet (skeleton only — see apps/git-worker), so its production
# install needs none of the @prisma/client optional-peer pruning the api/collab stages do above.
FROM manifests AS prod-git-worker
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod --filter "@asciidocollab/git-worker..."
COPY --from=artifacts /artifacts/ ./
RUN pnpm --filter @asciidocollab/git-worker --prod --legacy --node-linker=hoisted deploy /prod/git-worker

# The migrate job is the one place that legitimately needs the Prisma CLI, so
# this install keeps dev dependencies for the db package only.
FROM manifests AS prod-db
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --filter "@asciidocollab/db..."
COPY --from=artifacts /artifacts/ ./
RUN pnpm --filter @asciidocollab/db --legacy --node-linker=hoisted deploy /prod/db

# ─── Runtime base: no toolchain, no package manager work, non-root ────────────
FROM base AS runtime
ENV NODE_ENV=production
# openssl for the Prisma client; ca-certificates for outbound TLS (SMTP, HIBP).
# tini gives correct PID-1 signal handling and zombie reaping for Node.
RUN apk add --no-cache openssl ca-certificates tini libc6-compat
# Default to non-root here, not just in the leaf stages: building --target runtime
# (or adding a stage that forgets USER) would otherwise produce a root container.
# The two stages that need root re-escalate explicitly and drop back.
USER node
ENTRYPOINT ["tini", "--"]

# ─── api ──────────────────────────────────────────────────────────────────────
FROM runtime AS api
WORKDIR /app
COPY --from=prod-api  --chown=node:node /prod/api ./
COPY --from=artifacts --chown=node:node /artifacts/.prisma ./node_modules/.prisma
# Docker seeds a fresh named volume from the image's mount point, including its
# ownership. Without this the volume is created root-owned and the non-root
# process cannot write to it. Creating /data needs root, so escalate for exactly
# this one step and drop straight back.
USER root
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4000 4001
CMD ["node", "dist/index.js"]

# ─── collab ───────────────────────────────────────────────────────────────────
FROM runtime AS collab
WORKDIR /app
COPY --from=prod-collab --chown=node:node /prod/collab ./
COPY --from=artifacts   --chown=node:node /artifacts/.prisma ./node_modules/.prisma
# Must match the api image: both mount the same volume at this path.
USER root
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4002 4003
CMD ["node", "dist/index.js"]

# ─── git-worker (sandboxed git CLI runner) ────────────────────────────────────
# Skeleton only for now (see apps/git-worker): no run loop or RPC port yet, so nothing is EXPOSEd.
# This is the one image that runs the real `git`/`git-lfs` CLIs, which is why they are installed HERE
# rather than in the shared `runtime` base — no other service ships them.
FROM runtime AS git-worker
WORKDIR /app
USER root
RUN apk add --no-cache git git-lfs
COPY --from=prod-git-worker --chown=node:node /prod/git-worker ./
# Mirrors the api/collab volume mount: a git-worker job operates on the same per-project storage root.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
CMD ["node", "dist/index.js"]

# ─── migrate: applies the schema to Postgres, then exits ──────────────────────
FROM runtime AS migrate
WORKDIR /app
COPY --from=prod-db   --chown=node:node /prod/db ./
COPY --from=artifacts --chown=node:node /artifacts/.prisma ./node_modules/.prisma
USER node
# `migrate deploy`, NOT `db push`. It applies the reviewed, version-controlled
# migrations in prisma/migrations/ and never invents a schema diff of its own, so
# it cannot silently drop a column to make the database match the schema file.
# It is idempotent: already-applied migrations are skipped.
#
# Upgrading an instance first deployed with `db push`? Baseline it once — see
# "Upgrading" in docker/README.md.
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ─── web (Next.js standalone) ─────────────────────────────────────────────────
FROM runtime AS web
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# The standalone bundle carries its own traced node_modules and server.js.
COPY --from=build-web --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build-web --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
