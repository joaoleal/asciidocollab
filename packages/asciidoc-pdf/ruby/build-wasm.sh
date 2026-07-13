#!/usr/bin/env bash
#
# Build the client-side Asciidoctor-PDF WebAssembly engine.
#
# Compiles CRuby (wasm32-wasip1) together with the pinned gem closure from ./Gemfile.lock into a
# single self-contained `asciidoctor-pdf.wasm`, with the Ruby stdlib and all gems baked into an
# in-image virtual filesystem under /usr via wasi-vfs. The emitted binary is the verbatim, re-syncable
# artifact the web app vendors and serves same-origin — never hand-edit the `.wasm`.
#
# Sandbox invariant: the engine runs inside WASI with no subprocess, no socket, and no native
# extension loading. This script FAILS CLOSED if any compiled native extension enters the gem
# closure — a native `.so`/`.bundle`/`.dylib` in the packed tree, or a gem carrying an `extconf.rb`
# build recipe, aborts the build rather than shipping something that cannot load in the sandbox.
#
# Reproducibility: a fixed SOURCE_DATE_EPOCH and pinned tool/ruby versions keep the output stable for
# identical inputs. Bump the pins deliberately and re-run; do not edit the artifact.
#
# Prerequisites: a host Ruby 3.3 toolchain (with RubyGems/Bundler) on PATH — CI provides it via
# ruby/setup-ruby; locally use your Ruby version manager (rbenv/asdf/rvm) or system Ruby. The pinned
# `ruby_wasm` builder gem (which provides the `rbwasm` CLI and bundles its own wasi-vfs) is installed
# automatically below if absent. Runs directly on the host — no container. Override pins/paths via env.

set -euo pipefail

# ── Pins (bump deliberately; keep in lockstep with the JS-side @ruby/wasm-wasi version) ──────────
: "${RUBY_WASM_VERSION:=2.8.1}"            # ruby.wasm / ruby_wasm builder release
# rbwasm expects a major.minor Ruby source (e.g. 3.3), not a patch version. Use a dedicated variable
# name — NOT the plain RUBY_VERSION, which the base CRuby image exports as a full patch version
# (e.g. 3.3.11) that rbwasm rejects.
: "${RBWASM_RUBY_VERSION:=3.3}"            # CRuby major.minor compiled to wasm32-wasip1
# rbwasm expects the canonical target triplet (wasm32-unknown-wasip1); the short wasm32-wasip1 form
# is rejected by its toolchain selector.
: "${WASI_TARGET:=wasm32-unknown-wasip1}"
: "${SOURCE_DATE_EPOCH:=1700000000}"       # fixed epoch → deterministic timestamps in the artifact
export SOURCE_DATE_EPOCH

# ── Paths ────────────────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUBY_DIR="$HERE"
# Bundler vendors the pinned gem closure here; rbwasm's own CRuby/wasi-sdk build cache lives under
# ./build and ./rubies (both relative to RUBY_DIR — override via BUNDLE_PATH; in CI these two dirs are
# restored/saved by actions/cache so the slow CRuby→wasm compile only runs once per lockfile change).
GEM_VENDOR_DIR="${GEM_VENDOR_DIR:-$RUBY_DIR/.wasm-build/vendor/bundle}"
OUTPUT_WASM="${OUTPUT_WASM:-$RUBY_DIR/asciidoctor-pdf.wasm}"

# Run from RUBY_DIR: rbwasm writes its CRuby/wasi-sdk build cache to ./build and ./rubies RELATIVE TO
# CWD, so anchoring here keeps those caches next to the Gemfile (matching the actions/cache paths and
# the .gitignore entries) regardless of where this script was invoked from.
cd "$RUBY_DIR"

echo "==> Building Asciidoctor-PDF wasm engine"
echo "    ruby.wasm      : $RUBY_WASM_VERSION (CRuby $RBWASM_RUBY_VERSION, target $WASI_TARGET)"
echo "    lockfile       : $RUBY_DIR/Gemfile.lock"
echo "    output         : $OUTPUT_WASM"
echo "    SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"

# The ruby.wasm builder gem (`ruby_wasm`) provides the `rbwasm` CLI and carries its own bundled
# wasi-vfs; Bundler (ships with Ruby) vendors the pinned gem closure. Ruby itself must come from the
# environment; the pinned builder is installed here if missing, so RUBY_WASM_VERSION is the single
# source of truth for the builder version (CI does not need to restate it).
if ! command -v ruby >/dev/null 2>&1 || ! command -v gem >/dev/null 2>&1; then
  echo "ERROR: a host Ruby $RBWASM_RUBY_VERSION toolchain (ruby + gem) was not found on PATH." >&2
  echo "       CI installs it with ruby/setup-ruby; locally use rbenv/asdf/rvm or your system Ruby." >&2
  exit 1
fi
if ! command -v rbwasm >/dev/null 2>&1; then
  echo "==> Installing the ruby.wasm builder (ruby_wasm $RUBY_WASM_VERSION → rbwasm CLI)"
  # --user-install so this NEVER needs root/sudo — even against a system Ruby whose gem dir is
  # root-owned, it installs into the user's gem home instead. (No sudo is required anywhere in this
  # build.)
  gem install ruby_wasm -v "$RUBY_WASM_VERSION" --no-document --user-install
  # Make the freshly-installed rbwasm discoverable — the user-install bindir (and the default gem
  # bindir) may not be on PATH yet.
  command -v rbwasm >/dev/null 2>&1 || {
    PATH="$(ruby -e 'print Gem.user_dir')/bin:$(ruby -e 'print Gem.bindir'):$PATH"; export PATH
  }
fi
for tool in rbwasm bundle; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found after setup." >&2; exit 1; }
done

# ── 1. Vendor the pinned gem closure (frozen lockfile, pure-Ruby platform) ────────────────────────
# Install from the committed lockfile only (no dependency drift). force_ruby_platform keeps every gem
# on its pure-Ruby variant. The wasm target has no host compiler, so a gem needing a native extension
# surfaces at the gate below (step 2) — or, if it hard-requires a system library, fails the rbwasm
# compile (step 3).
echo "==> Vendoring pinned gems (frozen lockfile)"
export BUNDLE_GEMFILE="$RUBY_DIR/Gemfile"
bundle config set --local frozen true
bundle config set --local force_ruby_platform true
bundle config set --local path "$GEM_VENDOR_DIR"
bundle install

# ── 2. Fail closed on any native extension in the closure (except the sanctioned JS host bridge) ──
# Nothing host-compiled may enter the sandbox. Reject prebuilt shared objects and any gem shipping a
# native build recipe. The sole allowed exception is the `js` gem: it is the ruby.wasm host bridge,
# and its C extension is compiled to wasm and statically linked into the engine by rbwasm (step 3) —
# it never loads a host `.so`. This is the hard sandbox gate; its failure must abort the whole build.
echo "==> Verifying the gem closure is free of native extensions (js host bridge excepted)"
native_hits="$(find "$GEM_VENDOR_DIR" \
  \( -name '*.so' -o -name '*.bundle' -o -name '*.dylib' -o -name 'extconf.rb' \) \
  -print 2>/dev/null | grep -v '/gems/js-[^/]*/' || true)"
if [ -n "$native_hits" ]; then
  echo "ERROR: native extension(s) entered the gem closure — cannot run in the WASI sandbox:" >&2
  echo "$native_hits" | sed 's/^/       /' >&2
  echo "       Remove or replace the offending gem in Gemfile/Gemfile.lock (prefer a pure-Ruby" >&2
  echo "       path), or gate the optional capability that pulls it in, then rebuild." >&2
  exit 2
fi
echo "    OK — no host-loaded native extensions found."

# ── 2b. Drop the host CRuby headers so the wasm compile below uses the wasm headers ───────────────
# LOAD-BEARING (verified by experiment) — do not drop. The js host bridge is the one gem with a C
# extension, and it is compiled TWICE against different Ruby headers: for the host during the
# `bundle install` above (Bundler compiles native extensions as it vendors, and mkmf needs the host
# Ruby's headers — a clean vendor FAILS without them), then for wasm by rbwasm below. If the host
# headers stay visible to the wasm compile, it grabs the host ruby.h and dies:
#     js/ext/js/js-core.c → <host rubyhdrdir>/ruby/internal/config.h:
#       fatal error: 'ruby/config.h' file not found
# (the host header pulls in a wasm config.h that isn't on that path). So drop the host header dir now —
# after vendoring, before rbwasm. This DELETES the runner's Ruby dev headers, so it is gated to CI (an
# ephemeral runner) or an explicit opt-in — we never silently mutate a developer's machine. Nothing
# compiles a host extension after this point, so the removal is otherwise a no-op. The dir is resolved
# from the running Ruby's own RbConfig, so it is correct for any install prefix (ruby/setup-ruby's
# /opt/hostedtoolcache, a system /usr, an rbenv shim, …) — not tied to any one layout.
if [ -n "${CI:-}" ] || [ "${WASM_STRIP_HOST_HEADERS:-}" = "1" ]; then
  echo "==> Removing host CRuby headers so they can't shadow the wasm headers"
  for hdr_var in rubyhdrdir rubyarchhdrdir; do
    host_hdr="$(ruby -e "print RbConfig::CONFIG['$hdr_var']" 2>/dev/null || true)"
    if [ -n "$host_hdr" ] && [ -d "$host_hdr" ]; then
      echo "    removing $host_hdr"
      rm -rf "$host_hdr"
    fi
  done
else
  echo "==> Keeping host CRuby headers (local run). If the js wasm compile fails with"
  echo "    \"'ruby/config.h' file not found\", re-run with WASM_STRIP_HOST_HEADERS=1."
fi

# ── 3. Compile CRuby + bake stdlib and the gem closure into the final artifact ────────────────────
# rbwasm compiles CRuby (and the js host-bridge extension) to $WASI_TARGET, then bakes the full stdlib
# and the vendored gem closure into the engine's in-image virtual filesystem via its built-in
# wasi-vfs. It discovers the gem set from the Bundler definition of $BUNDLE_GEMFILE; `-rbundler` makes
# that definition visible without `bundle exec` (rbwasm/ruby_wasm are intentionally not in the closure
# and are auto-excluded from the bake). The first run downloads the wasi-sdk and builds CRuby, which
# is slow; ./build and ./rubies cache it for subsequent runs.
echo "==> Compiling CRuby + baking stdlib and gems into the wasm engine (first run is slow)"
RUBYOPT="${RUBYOPT:-} -rbundler" \
rbwasm build \
  --ruby-version "$RBWASM_RUBY_VERSION" \
  --target "$WASI_TARGET" \
  -o "$OUTPUT_WASM"

echo "==> Done: $OUTPUT_WASM"
ls -l "$OUTPUT_WASM"
