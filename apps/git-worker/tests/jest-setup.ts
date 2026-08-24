import { jest } from '@jest/globals';

// apps/git-worker is native ESM ("type": "module"). Jest injects describe/it/expect as globals in ESM
// but NOT the `jest` object, so specs using jest.fn()/jest.mock()/jest.useFakeTimers() would throw
// "jest is not defined". Expose it globally here (loaded via setupFilesAfterEnv) so the existing
// specs work without importing it in every file. ts-jest still hoists jest.mock() above imports.
(globalThis as typeof globalThis & { jest: typeof jest }).jest = jest;
