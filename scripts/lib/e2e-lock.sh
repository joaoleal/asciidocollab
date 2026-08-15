#!/usr/bin/env bash
# Mutual exclusion for the ISOLATED e2e stack.
#
# ─── The invariant ───────────────────────────────────────────────────────────
# The `asciidocollab-e2e` Compose project and its fixed host ports (5433, 1126,
# 8126, 3100, 4100, 4101, 4102, 4103) are ONE machine-wide resource; a script may
# create, use or destroy that stack only while it holds the machine-scoped e2e
# lock, and it must never destroy a stack whose recorded owner process is still
# alive.
#
# ─── Why the lock is not keyed to the checkout ───────────────────────────────
# docker/docker-compose.e2e.yml pins `name: asciidocollab-e2e`, which is unique
# per Docker DAEMON, and publishes fixed host ports. A lock file under $ROOT is
# therefore keyed to the wrong thing: a second clone or a `git worktree` (this
# repo's tooling makes those routinely) gets a DIFFERENT inode, `flock -n`
# succeeds instantly, and the newcomer's startup `docker compose down -v` wipes
# the first run's Postgres and Mailpit. That run then serves against no database
# and every result it reports afterwards is meaningless. So the lock lives on a
# path derived from the RESOURCE, not from the working copy.
#
# ─── Two mechanisms, not one ────────────────────────────────────────────────
#  1. flock on a per-user, machine-scoped path — serialises every run by the same
#     user, whatever checkout it starts from. This is the common case.
#  2. An owner label baked into the containers themselves — the backstop for the
#     cases a per-user lock cannot see: another Unix user driving the same Docker
#     daemon, or the same user with a different lock directory (a cron/CI shell
#     with no XDG_RUNTIME_DIR resolves to the $HOME fallback). Before the
#     destructive `down -v`, a script asks the running stack who owns it and
#     refuses if that owner process is still alive.
# The lock cannot be shared between Unix users: doing so needs a world-writable
# directory, where another user can pre-create the path, hold the lock forever,
# or point it at a symlink. Mechanism 2 exists precisely because mechanism 1 is
# deliberately per-user.
#
# ASSUMES LINUX: mechanism 2's liveness test reads /proc (see _e2e_proc_starttime
# and e2e_owner_alive below). Without procfs every owner token reads as dead, so a
# LIVE stack is classified as debris and destroyed. Not fixed because this repo and
# its CI are Linux-only; recorded so it is a known limit rather than a surprise if
# that ever changes.

E2E_COMPOSE_PROJECT="asciidocollab-e2e"
E2E_OWNER_LABEL="com.asciidocollab.e2e.owner"
E2E_LOCK_BASENAME="asciidocollab-e2e.lock"

_e2e_lock_say() { echo -e "\033[0;36m[e2e-lock]\033[0m $*"; }
_e2e_lock_die() { echo -e "\033[0;31m[e2e-lock]\033[0m $*" >&2; exit 1; }

# ─── Where the lock file lives ───────────────────────────────────────────────
# Ordered candidates, first writable one wins. NEVER /tmp: it is world-writable,
# so another user could pre-create the path (holding the lock forever) or replace
# it with a symlink we would then open. Both candidates below are private to the
# user — /run/user/$UID is 0700 and created by systemd, ~/.cache is the user's own
# home — so neither can be squatted by anyone else.
#
# If NEITHER is usable the run ABORTS. It must never fall through to "no mutual
# exclusion": that is the failure this file exists to prevent, and it would be
# silent. ASCIIDOCOLLAB_E2E_LOCK_DIR is the escape hatch for a host where both
# defaults are unwritable — pointing every run on that host at the same directory
# keeps the guarantee, whereas continuing without a lock would not.
_e2e_lock_dir_usable() {
  mkdir -p "$1" 2>/dev/null || return 1
  [ -w "$1" ]
}

# Prints the directory. Exit 2 = the explicit override is unusable, 1 = no
# candidate is usable. (Messaging lives in the caller: this runs inside a command
# substitution, where an `exit` would only end the subshell.)
e2e_lock_dir() {
  # An EXPLICIT override never falls back: the point of setting it is that every
  # run on the host agrees on one directory, and quietly using a different one
  # would hand out two locks over one stack — the very failure being prevented.
  if [ -n "${ASCIIDOCOLLAB_E2E_LOCK_DIR:-}" ]; then
    _e2e_lock_dir_usable "$ASCIIDOCOLLAB_E2E_LOCK_DIR" || return 2
    printf '%s\n' "$ASCIIDOCOLLAB_E2E_LOCK_DIR"
    return 0
  fi
  local candidate
  for candidate in \
    "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
    "${XDG_CACHE_HOME:-${HOME:-/nonexistent}/.cache}/asciidocollab"
  do
    _e2e_lock_dir_usable "$candidate" || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

# ─── Owner identity ──────────────────────────────────────────────────────────
# A bare PID is not an identity: PIDs are reused, both across a reboot and within
# one boot. The token is boot_id:pid:starttime, so a stale record can never be
# mistaken for a live process — which matters because "is the owner still alive?"
# is exactly what decides whether a stack may be destroyed.

# Process start time (jiffies since boot) — 0 when the process is gone.
# /proc/<pid>/stat field 22 is starttime, but field 2 (comm) may itself contain
# spaces and parentheses, so split after the LAST ')' and count from there.
# Kept free of pipelines on purpose: under `set -o pipefail` a vanished PID would
# otherwise make the command substitution fail and `set -e` would kill the caller
# with no message, in a helper whose whole job is answering "is it gone?".
_e2e_proc_starttime() {
  local line fields
  line="$(cat "/proc/${1}/stat" 2>/dev/null || true)"
  [ -n "$line" ] || { printf '0'; return 0; }
  read -r -a fields <<<"${line##*) }"
  printf '%s' "${fields[19]:-0}"
}

e2e_owner_token() {
  local pid="${1:-$$}" boot
  boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"
  printf '%s:%s:%s' "$boot" "$pid" "$(_e2e_proc_starttime "$pid")"
}

# True when the process named by an owner token is still running.
e2e_owner_alive() {
  local boot pid start now_boot
  IFS=: read -r boot pid start <<<"${1:-}"
  [ -n "${pid:-}" ] || return 1
  now_boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"
  [ "$boot" = "$now_boot" ] || return 1          # recorded before a reboot
  [ -d "/proc/$pid" ] || return 1                 # readable even for another user
  [ "$start" != "0" ] && [ "$start" = "$(_e2e_proc_starttime "$pid")" ]  # PID reuse
}

# ─── The lock ────────────────────────────────────────────────────────────────
# e2e_lock_guard <kind> <absolute-path-to-caller> [caller args…]
#
# Returns only in stage 2 (the re-invoked copy that does the work). Stage 1 holds
# the lock, runs stage 2 and exits with its status.
#
# The lock lives on an open file DESCRIPTOR, never on the existence of a file —
# the kernel drops it the moment the owning process dies by any means (normal
# exit, `set -e`, a failure inside the EXIT trap, SIGINT, SIGTERM, even SIGKILL).
# There is no release path to get wrong, and a killed run cannot leave a stale
# lock that wedges the next one.
#
# That guarantee only holds if NOTHING ELSE inherits the descriptor, and children
# inherit open descriptors by default — bash has no close-on-exec for them. A
# leaked next-server, or a Playwright process orphaned by `kill -9` on the script,
# would otherwise go on holding the lock and wedge every later run: exactly the
# stale lock we are trying to avoid. So the run is split in two:
#
#   stage 1 (this function)  holds the lock and does nothing else
#   stage 2 (the caller, re-invoked)  does the work, with the descriptor
#                                     explicitly CLOSED — {E2E_LOCK_FD}>&-
#
# Nothing in stage 2, or anything it spawns, can hold the lock. Stage 1 also
# survives INT/TERM, so it keeps the lock for the whole of stage 2's teardown:
# releasing it while `docker compose down -v` is still running would let the next
# run start building a stack this one is about to destroy — the original bug,
# reintroduced through the fix.
#
# Contention policy: an e2e-local run WAITS for another e2e-local run, because
# that one ends by itself. Everything else fails fast with a message naming the
# holder. A persistent stack (e2e-stack-up / e2e-stack-persist) lives until a
# human presses Ctrl-C, so waiting on it is unbounded — `pnpm gate` hanging with
# a heartbeat forever is worse than a refusal that says what to stop.
e2e_lock_guard() {
  local kind="$1" self="$2"
  shift 2
  [ -n "${ASCIIDOCOLLAB_E2E_LOCK_HELD:-}" ] && return 0

  # Checked explicitly: without flock the `until flock …` wait below would spin on
  # exit status 127 and print a heartbeat forever instead of failing.
  command -v flock &>/dev/null || _e2e_lock_die "flock (util-linux) is required for the e2e stack lock."

  local dir file rc=0
  dir="$(e2e_lock_dir)" || rc=$?
  case "$rc" in
    0) ;;
    2) _e2e_lock_die "ASCIIDOCOLLAB_E2E_LOCK_DIR=${ASCIIDOCOLLAB_E2E_LOCK_DIR} is not a writable directory.\n    Refusing to fall back to another one: two runs holding two different locks over the same stack\n    is exactly what this lock exists to prevent." ;;
    *) _e2e_lock_die "No writable directory for the e2e stack lock (tried \${XDG_RUNTIME_DIR:-/run/user/$(id -u)}\n    and \${XDG_CACHE_HOME:-\$HOME/.cache}/asciidocollab).\n    Refusing to run without it: two concurrent runs would silently destroy each other's stack.\n    Set ASCIIDOCOLLAB_E2E_LOCK_DIR to a writable directory used by EVERY run on this host." ;;
  esac
  file="$dir/$E2E_LOCK_BASENAME"

  # `>>` not `>`: `>` truncates on open, which would erase the CURRENT holder's
  # record before we even find out whether we are allowed in.
  exec {E2E_LOCK_FD}>>"$file"
  if ! flock -n "$E2E_LOCK_FD"; then
    local holder_token="" holder_kind="" holder_root=""
    read -r holder_token holder_kind holder_root < "$file" 2>/dev/null || true
    local holder_pid="${holder_token#*:}"; holder_pid="${holder_pid%%:*}"
    local who="${holder_kind:-another run}${holder_pid:+ (PID $holder_pid${holder_root:+, $holder_root})}"

    if [ "$kind" = "e2e-local" ] && [ "$holder_kind" = "e2e-local" ]; then
      _e2e_lock_say "Another e2e-local run owns this stack — $who — waiting for it to finish …"
      local waited=0
      # Blocking wait with a heartbeat, so a queued run looks queued, not hung.
      until flock -w 30 "$E2E_LOCK_FD"; do
        waited=$((waited + 30))
        _e2e_lock_say "… still waiting for the lock (${waited}s elapsed)."
      done
      _e2e_lock_say "Lock acquired — the other run finished."
    elif [ "$holder_kind" = "e2e-stack-up" ] || [ "$holder_kind" = "e2e-stack-persist" ]; then
      _e2e_lock_die "A persistent isolated e2e stack is running — $who.\n    It owns the ${E2E_COMPOSE_PROJECT} Compose project and the fixed host ports, and starting\n    ${kind} would tear it down (its first step is \`docker compose down -v\`).\n    Stop it with Ctrl-C in that shell, or run your specs against the stack it already provides."
    else
      _e2e_lock_die "The isolated e2e stack is in use — $who.\n    ${kind} cannot start: the two would share the ${E2E_COMPOSE_PROJECT} Compose project and the same\n    host ports, and whichever finishes first would destroy the other's containers.\n    Wait for it to finish, or stop it."
    fi
  fi

  # Safe to truncate now: we hold the lock, so no other run is reading this.
  printf '%s %s %s\n' "$(e2e_owner_token $$)" "$kind" "$PWD" > "$file"
  # A no-op HANDLER, deliberately not `trap '' INT TERM`: an IGNORED signal is
  # inherited across exec, which would leave stage 2 unable to see Ctrl-C at all
  # and its cleanup trap would never run. A handler is reset to the default on
  # exec, so stage 2 handles signals exactly as it does today, while stage 1
  # survives them and holds the lock until stage 2 has finished tearing down.
  trap ':' INT TERM
  ASCIIDOCOLLAB_E2E_LOCK_HELD=1 "$self" "$@" {E2E_LOCK_FD}>&-
  exit $?
}

# ─── The owner label ─────────────────────────────────────────────────────────
# Export the identity stamped onto every container of the stack we are about to
# bring up (docker/docker-compose.e2e.yml interpolates it into a label). Call
# this in stage 2 — the process whose death tears the stack down — before
# `docker compose up`.
e2e_export_stack_owner() {
  local token
  token="$(e2e_owner_token $$)"
  export ASCIIDOCOLLAB_E2E_OWNER="$token ${1:-unknown} $PWD"
}

# Refuse to touch a stack somebody else is still using.
#
# MUST be called before the destructive startup `docker compose down -v`, and
# before installing any EXIT trap that itself runs `down -v` — otherwise the
# refusal path would destroy on the way out the very stack it just declined to
# destroy.
#
# A stack with no owner label, or one whose owner is gone, is leftover debris
# (a `kill -9`'d run never reaches its teardown) and is destroyed as before: that
# self-healing is why this is a liveness check and not a mere existence check.
e2e_assert_stack_not_in_use() {
  local kind="${1:-this script}"
  command -v docker &>/dev/null || return 0
  local ids id owner token owner_kind owner_root
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$E2E_COMPOSE_PROJECT" 2>/dev/null || true)"
  [ -n "$ids" ] || return 0
  for id in $ids; do
    owner="$(docker inspect -f "{{index .Config.Labels \"$E2E_OWNER_LABEL\"}}" "$id" 2>/dev/null || true)"
    [ -n "$owner" ] || continue
    read -r token owner_kind owner_root <<<"$owner"
    if e2e_owner_alive "$token"; then
      local pid="${token#*:}"; pid="${pid%%:*}"
      _e2e_lock_die "The ${E2E_COMPOSE_PROJECT} stack is already up and its owner is still running —\n    ${owner_kind:-unknown} (PID ${pid}${owner_root:+, $owner_root}).\n    ${kind} would destroy it (\`docker compose down -v\`), taking that run's Postgres and Mailpit\n    with it. Stop that process first.\n    (Seen despite the lock, so the two are not sharing one lock file: a different Unix user, or a\n    different ASCIIDOCOLLAB_E2E_LOCK_DIR / XDG_RUNTIME_DIR.)"
    fi
  done
}
