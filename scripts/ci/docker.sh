#!/usr/bin/env bash
# Job — production image build.
#
# docker/Dockerfile builds the four runtime images the production stack ships (migrate, api, collab,
# web) from a context that is the whole repository, so almost any source change can break it — while
# nothing else in CI or the local gate compiles it. Without this job a broken Dockerfile surfaces at
# deploy time, on the machine least convenient to debug it on.
#
# SCOPE, so a pass is not over-read: this proves the images BUILD. It does not run them, so it says
# nothing about whether a service starts, connects to Postgres, or serves a request. The e2e job
# covers runtime behaviour, but against the dev stack rather than against these images.
#
# Built with buildx directly rather than `docker compose -f docker-compose.prod.yml build`, because
# the compose file requires ADC_DOMAIN (`:?run ./docker/generate-secrets.sh first`) to interpolate
# the web target's public URLs. The Dockerfile declares its own defaults for those ARGs, so building
# the targets directly needs no secrets and no generated env — this checks the build, not a
# deployment. The trade-off is that compose's build-args are NOT exercised here; a change to those
# is only covered by an actual `docker compose build`.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "${CYAN}[ci-docker]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ci-docker]${RESET} $*"; }
die()  { echo -e "${RED}[ci-docker]${RESET} $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v docker &>/dev/null || die "docker is required."
docker buildx version &>/dev/null || die "docker buildx is required (Docker 23+ ships it; otherwise: docker buildx install)."

# Every runtime target in docker/Dockerfile's stage graph. Keep in step with the `target:` values in
# docker/docker-compose.prod.yml — a target added there and not here would go unbuilt and untested.
TARGETS=(migrate api collab web)

# CI passes --cache-from/--cache-to type=gha to share layers between runs; locally the daemon's own
# build cache already does that, so the caller supplies whatever it needs and this script adds none.
CACHE_ARGS=("$@")

for target in "${TARGETS[@]}"; do
  step "Building target: $target"
  # `type=cacheonly` — nothing here runs the images, and materialising four of them costs runner disk
  # and time for no added signal. Swap to `--load` if you want to poke at one locally.
  docker buildx build \
    --file docker/Dockerfile \
    --target "$target" \
    --output type=cacheonly \
    "${CACHE_ARGS[@]}" \
    .
done

ok "All production image targets built (${TARGETS[*]})."
