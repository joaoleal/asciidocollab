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
 *
 * There is now more than one reference toolchain — the page-format one defined beside this file, and
 * the web-format HTML oracle under `e2e/render-equivalence/harness/` — so what follows is written in
 * terms of *a* definition set. The page-format set stays the DEFAULT, and its tag stays byte-identical
 * to what it has always been, because every committed reference PDF was produced by an image with
 * that name: re-tagging it would put the whole page-format corpus in question. That is also why the
 * second toolchain has its own definition files rather than gems added to these ones.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A reference toolchain: where its definition lives, what the definition consists of, and what the
 * image it produces is called.
 *
 * @typedef {object} ReferenceDefinition
 * @property {string} name - The image repository name; the content hash becomes its tag.
 * @property {string} directory - The build context, and the directory the files are read from.
 * @property {readonly string[]} files - The files that decide the toolchain's output bytes, in a
 *   FIXED order (the hash is over their concatenation, so reordering renames the image). The first
 *   entry is the Dockerfile.
 */

/**
 * The page-format (PDF) toolchain: base image, direct gems, locked transitives.
 *
 * The default everywhere, and its `name` plus this exact file list are what make its tag
 * `asciidoc-pdf-reference:7282936feafb89cc` — the name under which every committed reference PDF in
 * `e2e/pdf-parity/fixtures/` was produced. Do not reorder, rename or extend this list to accommodate
 * another toolchain; give the other toolchain its own definition set instead.
 *
 * @type {ReferenceDefinition}
 */
export const PDF_REFERENCE_DEFINITION = {
  name: 'asciidoc-pdf-reference',
  directory: HERE,
  files: ['Dockerfile.reference', 'Gemfile', 'Gemfile.lock'],
};

/** Fixed epoch so committed reference output carries no wall-clock metadata. */
export const SOURCE_DATE_EPOCH = '1704067200'; // 2024-01-01T00:00:00Z

/**
 * The content-addressed tag for a toolchain definition.
 *
 * Keyed on the definition rather than on the engine version. The tag used to be
 * `asciidoc-pdf-reference:2.3.24`, and the build was skipped whenever it existed — so changing the
 * base image or a gem left the tag untouched and every machine reused a months-old image forever.
 *
 * @param {ReferenceDefinition} [definition] - The toolchain to name; the page-format one by default.
 * @returns The image tag, e.g. `asciidoc-pdf-reference:7282936feafb89cc`.
 */
export function referenceImageTag(definition = PDF_REFERENCE_DEFINITION) {
  const digest = createHash('sha256');
  for (const file of definition.files) digest.update(readFileSync(join(definition.directory, file)));
  return `${definition.name}:${digest.digest('hex').slice(0, 16)}`;
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
 * @param {ReferenceDefinition} [definition] - The toolchain to build; the page-format one by default.
 * @returns The tag that is now present locally.
 * @throws {Error} When `tag` is not this definition's tag. The two arguments are redundant on
 *   purpose — every existing caller passes a tag — but a tag that does not name the definition being
 *   built would produce exactly the silent staleness the content-addressed tag exists to prevent, so
 *   the redundancy is CHECKED rather than trusted.
 */
export function ensureReferenceImage(
  tag = referenceImageTag(),
  log = (m) => process.stderr.write(`${m}\n`),
  definition = PDF_REFERENCE_DEFINITION,
) {
  const expected = referenceImageTag(definition);
  if (tag !== expected) {
    throw new Error(`Asked to build ${tag} from the ${definition.name} definition, which is ${expected}.`);
  }
  if (run('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) {
    log(`Reusing reference image ${tag}.`);
    return tag;
  }
  log(`Building reference image ${tag} (one-time)...`);
  const dockerfile = join(definition.directory, definition.files[0]);
  const build = run('docker', ['build', '-t', tag, '-f', dockerfile, definition.directory], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (build.status !== 0) {
    throw new Error(`Failed to build ${tag} (docker build exited ${String(build.status)}).`);
  }
  return tag;
}
