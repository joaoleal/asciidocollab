#!/usr/bin/env node
/**
 * Architecture guard — enforces the layer rules in `onion.config.json`.
 *
 * This replaces `fresh-onion`, which could not enforce anything in this repository. Its
 * `getImportsInTsFile` bails on any specifier that does not start with `.` or `/`, and a scan found
 * ZERO relative cross-package imports in `apps/` + `packages/` — every cross-layer import here is a
 * bare workspace specifier (`@asciidocollab/domain`). Proven with a fixture: a blatant low→high
 * violation written as `import from '@scope/high'` reported "👍 Fresh"; the same violation written
 * relatively reported "👎 Rotten". It also located its config with a recursive DESCENDING search from
 * the cwd and took the first readdir hit, so a leftover `onion.config.json` inside an agent worktree
 * under `.claude/worktrees/` could win and get a stale tree validated instead — non-deterministically,
 * since readdir order is not stable.
 *
 * Both problems are structural rather than configuration, so the check lives here now:
 *  - Bare workspace specifiers are resolved to their layer via each package's own `name`, read from
 *    the package.json above the layer directory. Nothing is hardcoded, so renaming a package cannot
 *    silently un-govern it.
 *  - Relative specifiers are still resolved and checked, so the coverage fresh-onion did have is kept.
 *  - The config path is derived from THIS FILE's location, so there is no search to go wrong.
 *
 * Scope, stated plainly rather than implied: only the directories listed in `layers` are governed, and
 * those point at `src`, so tests are deliberately out of scope (a test importing across layers is not
 * a production coupling). Workspace packages that are not a layer at all — `@asciidocollab/db`,
 * `@asciidocollab/testing` — cannot be governed by rules that never mention them; they are reported
 * as ungoverned so the gap stays visible instead of reading as a clean pass.
 *
 * Usage: `node scripts/ci/architecture-guard.mjs` (or `pnpm run architecture`). Exits 1 on violation.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = join(ROOT, 'onion.config.json');

/** Directories never worth walking: dependencies, build output, and agent worktrees. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.claude', 'coverage']);

/** Source extensions that carry imports. Declaration files are generated, so they are skipped. */
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Every import-like specifier in a source file: static `import`/`export … from`, bare side-effect
 * `import 'x'`, dynamic `import('x')`, and `require('x')`. Deliberately a regex rather than a real
 * parser: this runs on every gate and only ever needs the specifier string, and a missed exotic form
 * fails open (an unreported import) rather than blocking a correct build.
 */
const SPECIFIER_RE =
  /(?:\bimport\b|\bexport\b)[^'"();]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Reads the layer configuration and derives, for each layer, the workspace package name that owns it.
 *
 * @returns The layers (name → absolute source dir), the allow-lists, package-name → layer, and each
 *   layer's package root (needed to read its manifest and tsconfig).
 */
function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const layers = new Map();
  const packageToLayer = new Map();
  const packageRoots = new Map();

  for (const [layer, dir] of Object.entries(config.layers)) {
    const absolute = resolve(ROOT, dir);
    if (!existsSync(absolute)) {
      throw new Error(`onion.config.json: layer "${layer}" points at a missing directory (${dir})`);
    }
    layers.set(layer, absolute);

    // Walk up from the layer directory to the package that contains it, and take its declared name.
    for (let current = absolute; current.startsWith(ROOT); current = dirname(current)) {
      const manifest = join(current, 'package.json');
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (name) packageToLayer.set(name, layer);
      packageRoots.set(layer, current);
      break;
    }
  }

  const allowed = new Map();
  for (const rule of config.rules) {
    if (!layers.has(rule.from)) {
      throw new Error(`onion.config.json: rule "from" names an unknown layer (${rule.from})`);
    }
    for (const target of rule.allowedImports) {
      if (!layers.has(target)) {
        throw new Error(`onion.config.json: rule ${rule.from} allows an unknown layer (${target})`);
      }
    }
    allowed.set(rule.from, new Set(rule.allowedImports));
  }
  for (const layer of layers.keys()) {
    if (!allowed.has(layer)) {
      throw new Error(`onion.config.json: layer "${layer}" has no rule — every layer must declare one`);
    }
  }

  return { layers, allowed, packageToLayer, packageRoots };
}

/**
 * Blanks out `//` and block comments, preserving length so nothing else shifts.
 *
 * Necessary because this file's own prose is a counter-example: a doc comment that mentions being
 * "re-exported from `@asciidocollab/domain`" matches the import pattern, and the guard would fail the
 * build over a sentence. Comments discussing layering are exactly what a codebase with this much
 * architectural commentary is full of.
 *
 * String literals are respected so a real specifier is never eaten. A regex literal containing `//`
 * (`/^https?:\/\//`) can still be mistaken for a comment start, which blanks the rest of that line —
 * that direction is harmless: it can only DROP an import from consideration, never invent one, and a
 * line defining a regex is not a line importing a package.
 *
 * @param text - The source text.
 * @returns The same text with comment bodies replaced by spaces.
 */
function stripComments(text) {
  let out = '';
  let state = 'code';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; out += '  '; index++; continue; }
      if (char === '/' && next === '*') { state = 'block'; out += '  '; index++; continue; }
      if (char === "'" || char === '"' || char === '`') state = char;
      out += char;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char; continue; }
      out += ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; index++; continue; }
      out += char === '\n' ? char : ' ';
      continue;
    }
    // Inside a string or template literal: copy through, honouring escapes.
    out += char;
    if (char === '\\') { out += text[index + 1] ?? ''; index++; continue; }
    if (char === state) state = 'code';
  }
  return out;
}

/**
 * Collects every source file under a directory.
 *
 * @param dir - Directory to walk.
 * @param out - Accumulator.
 * @returns The absolute paths of the source files found.
 */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) sourceFiles(path, out);
    } else if (SOURCE_RE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The layer a bare workspace specifier belongs to, if any. Handles subpath imports
 * (`@scope/pkg/deep`) by matching the longest declared package name that prefixes the specifier.
 *
 * @param specifier - The bare import specifier.
 * @param packageToLayer - Package name → layer.
 * @returns The layer name, or undefined for a third-party or ungoverned package.
 */
function layerOfPackage(specifier, packageToLayer) {
  if (packageToLayer.has(specifier)) return packageToLayer.get(specifier);
  for (const [name, layer] of packageToLayer) {
    if (specifier.startsWith(`${name}/`)) return layer;
  }
  return undefined;
}

/**
 * The layer that owns a path on disk, if any.
 *
 * @param path - An absolute path.
 * @param layers - Layer name → absolute source dir.
 * @returns The layer name, or undefined when the path is outside every layer.
 */
function layerOfPath(path, layers) {
  for (const [layer, dir] of layers) {
    // Compare on a path boundary so `…/api` never matches `…/api-extras`.
    if (path === dir || path.startsWith(dir + sep)) return layer;
  }
  return undefined;
}

const { layers, allowed, packageToLayer, packageRoots } = loadConfig();
const violations = [];
const ungoverned = new Map();
let filesScanned = 0;
let importsScanned = 0;

/**
 * Checks what each layer DECLARES, not just what it imports.
 *
 * An import is the symptom; a declared `dependencies` entry or a tsconfig `references` entry is the
 * standing permission that lets one reappear — and both are invisible to an import scan. Two live
 * examples: `packages/shared` kept `@asciidocollab/domain` in `dependencies` after its last domain
 * import was removed (so every consumer still installed the domain behind it), and
 * `packages/domain/tsconfig.json` still declared a project reference to `../shared`, wiring the
 * inverted edge at the compiler level with no import to show for it.
 *
 * `devDependencies` are deliberately not checked: tests are outside the governed `src` directories, so
 * a test-only workspace dependency (`@asciidocollab/testing`) is not a production coupling.
 */
function checkDeclarations() {
  for (const [layer, root] of packageRoots) {
    const manifestPath = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const declared = { ...manifest.dependencies, ...manifest.peerDependencies };
    for (const name of Object.keys(declared)) {
      const target = packageToLayer.get(name);
      if (target === undefined || target === layer) continue;
      if (allowed.get(layer).has(target)) continue;
      violations.push({
        layer,
        target,
        file: relative(ROOT, manifestPath),
        specifier: `declared dependency "${name}"`,
      });
    }

    const tsconfigPath = join(root, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) continue;
    // Comment-tolerant: a tsconfig may carry `//` or `/* */` notes, which JSON.parse would reject.
    // A parse failure is reported as itself rather than as a stack trace, so a stray trailing comma in
    // someone's tsconfig does not look like a broken architecture guard.
    let tsconfig;
    try {
      tsconfig = JSON.parse(stripComments(readFileSync(tsconfigPath, 'utf8')));
    } catch (error) {
      console.error(`[architecture] cannot read ${relative(ROOT, tsconfigPath)}: ${error.message}`);
      process.exit(1);
    }
    for (const reference of tsconfig.references ?? []) {
      const target = layerOfPath(resolve(root, reference.path), layers) ?? layerOfReferenceRoot(root, reference.path);
      if (target === undefined || target === layer) continue;
      if (allowed.get(layer).has(target)) continue;
      violations.push({
        layer,
        target,
        file: relative(ROOT, tsconfigPath),
        specifier: `tsconfig project reference "${reference.path}"`,
      });
    }
  }
}

/**
 * The layer owning a tsconfig `references` path. Those point at a package ROOT (`../shared`) while
 * layers are declared as source directories (`packages/shared/src`), so a prefix test alone misses
 * them — resolve through the referenced package's declared name instead.
 *
 * @param root - The referring package's root directory.
 * @param referencePath - The `references[].path` value.
 * @returns The referenced layer, or undefined when it is not a layer.
 */
function layerOfReferenceRoot(root, referencePath) {
  const manifest = join(resolve(root, referencePath), 'package.json');
  if (!existsSync(manifest)) return undefined;
  const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
  return name ? packageToLayer.get(name) : undefined;
}

checkDeclarations();

for (const [layer, dir] of layers) {
  for (const file of sourceFiles(dir)) {
    filesScanned++;
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!specifier) continue;
      importsScanned++;

      let target;
      if (specifier.startsWith('.')) {
        target = layerOfPath(resolve(dirname(file), specifier), layers);
      } else if (specifier.startsWith('/')) {
        target = layerOfPath(specifier, layers);
      } else {
        target = layerOfPackage(specifier, packageToLayer);
        // A workspace package with no layer cannot be checked — surface it rather than pass silently.
        if (target === undefined && specifier.startsWith('@asciidocollab/')) {
          const key = specifier.split('/').slice(0, 2).join('/');
          if (!ungoverned.has(key)) ungoverned.set(key, new Set());
          ungoverned.get(key).add(layer);
        }
      }

      if (target === undefined || target === layer) continue;
      if (allowed.get(layer).has(target)) continue;
      violations.push({ layer, target, file: relative(ROOT, file), specifier });
    }
  }
}

if (ungoverned.size > 0) {
  const summary = [...ungoverned]
    .map(([name, from]) => `${name} (imported by ${[...from].sort().join(', ')})`)
    .sort()
    .join('; ');
  console.log(`[architecture] note: workspace packages with no layer, therefore ungoverned: ${summary}`);
}

if (violations.length > 0) {
  console.error(`\n[architecture] ${violations.length} layer violation(s):\n`);
  const byRule = new Map();
  for (const violation of violations) {
    const key = `${violation.layer} → ${violation.target}`;
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key).push(violation);
  }
  for (const [key, group] of [...byRule].sort()) {
    const permitted = [...allowed.get(group[0].layer)].sort();
    console.error(
      `  ${key} is not allowed — "${group[0].layer}" may import: ${permitted.length > 0 ? permitted.join(', ') : '(nothing)'}`,
    );
    for (const violation of group) console.error(`      ${violation.file}  →  ${violation.specifier}`);
    console.error('');
  }
  console.error(
    'Either the import is wrong, or onion.config.json no longer describes the intended design.\n' +
      'Change the code or change the rule deliberately — do not silence this by widening a rule in passing.\n',
  );
  process.exit(1);
}

console.log(
  `[architecture] clean — ${layers.size} layers, ${filesScanned} files, ${importsScanned} imports ` +
    `(bare + relative), plus every layer's declared dependencies and tsconfig references.`,
);
