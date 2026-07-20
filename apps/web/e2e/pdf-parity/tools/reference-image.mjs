/**
 * @file The ONE definition of the reference Docker image, shared by every tool that renders a
 * committed reference PDF.
 *
 * Three tools produce the corpus, and each used to name the image itself:
 *
 *   - `generate-reference.mjs`     — renders `source/` for most fixtures
 *   - `tools/build-references.mjs` — renders `reference-src/` and `reference-build/` fixtures
 *   - `emit-reference-inputs.spec.ts` — emits and renders the math + diagrams reference builds
 *
 * The latter two asked for `adc-pdf-ref:latest`, which is a moving tag over an image nothing rebuilds:
 * whatever a developer happened to have built, whenever they built it. That is the same drift the
 * pinned Dockerfile and lockfile exist to eliminate, reintroduced at the call site — and it is
 * invisible, because a stale image renders happily and produces a plausible PDF. Two developers could
 * regenerate the same fixture from two different toolchains and each get a "successful" result.
 *
 * So the tag is derived HERE, from the bytes of the definition, and every tool imports it. A changed
 * definition is a different image; an unchanged one is a guaranteed cache hit. There is no way to
 * name the image without also naming its contents.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The files that decide the toolchain's output bytes: base image, direct gems, locked transitives. */
const DEFINITION_FILES = [
  join(HERE, 'Dockerfile.reference'),
  join(HERE, 'Gemfile'),
  join(HERE, 'Gemfile.lock'),
];

/** Fixed epoch so committed reference PDFs carry no wall-clock metadata. */
export const SOURCE_DATE_EPOCH = '1704067200'; // 2024-01-01T00:00:00Z

/**
 * The content-addressed tag for the current toolchain definition.
 *
 * Keyed on the definition rather than on the engine version. The tag used to be
 * `asciidoc-pdf-reference:2.3.24`, and the build was skipped whenever it existed — so changing the
 * base image or a gem left the tag untouched and every machine reused a months-old image forever.
 *
 * @returns The image tag, e.g. `asciidoc-pdf-reference:7282936feafb89cc`.
 */
export function referenceImageTag() {
  const digest = createHash('sha256');
  for (const file of DEFINITION_FILES) digest.update(readFileSync(file));
  return `asciidoc-pdf-reference:${digest.digest('hex').slice(0, 16)}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

/**
 * Build the reference image unless this exact definition has already been built.
 *
 * Because the tag is a hash of the definition, an existing image is a sound cache hit: it was built
 * from these exact bytes, not merely named the same thing.
 *
 * @param tag - The tag to ensure, defaulting to {@link referenceImageTag}'s value.
 * @param log - Where progress goes; defaults to stderr so it never pollutes piped stdout.
 * @returns The tag that is now present locally.
 */
export function ensureReferenceImage(tag = referenceImageTag(), log = (m) => process.stderr.write(`${m}\n`)) {
  if (run('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) {
    log(`Reusing reference image ${tag}.`);
    return tag;
  }
  log(`Building reference image ${tag} (one-time)...`);
  const build = run('docker', ['build', '-t', tag, '-f', DEFINITION_FILES[0], HERE], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (build.status !== 0) {
    throw new Error(`Failed to build ${tag} (docker build exited ${String(build.status)}).`);
  }
  return tag;
}
