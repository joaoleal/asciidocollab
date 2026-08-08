// apps/collab is native ESM, and `tests/jest-setup.ts` installs the `jest` object exported by
// `@jest/globals` as a global so every spec can use it without importing it. That object carries the
// ESM-only mocking entry point `unstable_mockModule` — `jest.mock()` cannot intercept a static
// import under ESM — but the ambient `jest` namespace from @types/jest does not declare it, so the
// specs that call it fail to type-check against a global that really does have the method.
//
// Describe the gap here rather than importing `{ jest }` from '@jest/globals' in each spec: that
// import would shadow the ambient namespace, and the specs also use `jest.Mock` as a TYPE, which
// only exists on the namespace.
declare namespace jest {
  /**
   * Registers a mock factory for `moduleName`, to be applied to the next dynamic `import()` of it.
   * The ESM counterpart of `jest.mock()`; the factory may be async.
   */
  function unstable_mockModule(
    moduleName: string,
    factory: () => unknown,
    options?: { virtual?: boolean },
  ): typeof jest;
}
