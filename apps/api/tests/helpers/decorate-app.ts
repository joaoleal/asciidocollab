import type { FastifyInstance } from 'fastify';

/**
 * @file Type-checked partial decoration of a test Fastify instance.
 *
 * A route test builds an app carrying only the collaborators that route reaches — two methods of
 * one repository, not all twenty-odd repositories in full. `app.decorate('repos', { … })` demands
 * the complete declared type, so every such call used to be written either as a plain object (a
 * hard error, invisible while tests were excluded from `tsc`) or with `as never`, which erases the
 * type outright.
 *
 * Neither describes what the test means. `as never` in particular accepts ANY object, so a stub
 * naming a method the port does not have — `sendInvitationEmail` for `sendInvitation`,
 * `deleteAllForUser` on a repository without it — reads as a passing test that asserts on a
 * collaborator the production code never calls.
 *
 * This helper says the true thing instead: members may be OMITTED, but the ones present must exist
 * on the port and match its shape. Widening happens once, here.
 */

/**
 * One collaborator's stub: every member optional, and each present member may be either the real
 * signature or a bare `jest.Mock`.
 *
 * The `jest.Mock` alternative is deliberate and is where the guarantee stops. A route test commonly
 * resolves a mock with only the fields the route reads — `{ role: { value: 'editor' } }` for a
 * membership lookup — and demanding a fully-constructed entity at every stub would be a different,
 * much larger change. What this type DOES pin down is the member NAMES: an object literal naming a
 * method the port does not declare is an excess property and fails, which is the check that was
 * missing.
 */
type StubbedPort<T> = { [M in keyof T]?: T[M] | jest.Mock };

/** Every collaborator optional, one level into a decoration group (`repos`, `stores`, `services`). */
type PartialGroup<T> = { [K in keyof T]?: StubbedPort<T[K]> };

/** The grouped decorations a route test stubs collaborator-by-collaborator. */
type GroupedDecoration = 'repos' | 'stores' | 'services';

/**
 * Any Fastify instance, whatever logger or type-provider generics it was built with. Tests that pass
 * `loggerInstance` get an instance whose type no longer matches the bare `FastifyInstance`, and that
 * is irrelevant to installing a decoration. `never` parameters make every concrete `decorate`
 * overload assignable here.
 */
interface DecoratableApp {
  decorate(name: never, value: never): unknown;
}

/**
 * Decorates `app` with a partial `repos` / `stores` / `services` group.
 *
 * @param app - The test Fastify instance to decorate.
 * @param name - Which decoration group to install.
 * @param value - The collaborators this test supplies; omitted members stay absent.
 */
export function decorateApp<K extends GroupedDecoration>(
  app: DecoratableApp,
  name: K,
  value: PartialGroup<FastifyInstance[K]>,
): void;

/**
 * Decorates `app` with a partial value for any other decoration (`config`, `prisma`, an event bus).
 *
 * @param app - The test Fastify instance to decorate.
 * @param name - Which decoration to install.
 * @param value - The value this test supplies; nested members may be omitted, and `null` states
 * outright that the route under test never reaches this collaborator.
 */
export function decorateApp<K extends Exclude<keyof FastifyInstance, GroupedDecoration>>(
  app: DecoratableApp,
  name: K,
  value: DeepPartial<FastifyInstance[K]> | null,
): void;

export function decorateApp(app: DecoratableApp, name: string, value: unknown): void {
  // The single widening point. `decorate` is typed against the fully-populated declaration, and a
  // test deliberately supplies less than that.
  // Call it as a METHOD: fastify's `decorate` reads instance state off `this`, so detaching it into a
  // local first throws on `Symbol(fastify.state)`.
  const target = app as unknown as { decorate(property: string, value: unknown): void };
  target.decorate(name, value);
}

/**
 * Recursively optional. `config` is a nested tree of settings and a test names only the few branches
 * its route reads, so a one-level `Partial` is not enough — but the leaves still have to type-check.
 */
type DeepPartial<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
