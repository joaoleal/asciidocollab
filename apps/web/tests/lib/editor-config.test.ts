describe('editor-config environment overrides', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  test('uses default timings when no environment variables are set', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NEXT_PUBLIC_EDITOR_AUTOSAVE_DEBOUNCE_MS;
    delete process.env.NEXT_PUBLIC_PREVIEW_DEBOUNCE_MS;
    delete process.env.NEXT_PUBLIC_PREVIEW_MAX_WAIT_MS;
    delete process.env.NEXT_PUBLIC_EDITOR_POLL_INTERVAL_MS;
    delete process.env.NEXT_PUBLIC_PREVIEW_ADAPTIVE_MIN_MS;
    delete process.env.NEXT_PUBLIC_PDF_PREVIEW_MAX_DEBOUNCE_MS;
    delete process.env.NEXT_PUBLIC_COLLAB_URL;
    delete process.env.NEXT_PUBLIC_COLLAB_SYNC_TIMEOUT_MS;
    const config = require('@/lib/editor-config');
    expect(config.AUTOSAVE_DEBOUNCE_MS).toBe(4000);
    expect(config.PREVIEW_DEBOUNCE_MS).toBe(500);
    expect(config.PREVIEW_MAX_WAIT_MS).toBe(2000);
    expect(config.EXTERNAL_CHANGE_POLL_INTERVAL_MS).toBe(30_000);
    expect(config.PREVIEW_ADAPTIVE_MIN_MS).toBe(120);
    expect(config.PDF_PREVIEW_MAX_DEBOUNCE_MS).toBe(1500);
    expect(config.COLLAB_URL).toBe('ws://localhost:4002');
    expect(config.COLLAB_SYNC_TIMEOUT_MS).toBe(10_000);
  });

  test('reads timings from NEXT_PUBLIC_* environment variables when provided', () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_EDITOR_AUTOSAVE_DEBOUNCE_MS: '1000',
      NEXT_PUBLIC_PREVIEW_DEBOUNCE_MS: '300',
      NEXT_PUBLIC_PREVIEW_MAX_WAIT_MS: '1200',
      NEXT_PUBLIC_EDITOR_POLL_INTERVAL_MS: '10000',
      NEXT_PUBLIC_PREVIEW_ADAPTIVE_MIN_MS: '80',
      NEXT_PUBLIC_PDF_PREVIEW_MAX_DEBOUNCE_MS: '2500',
      NEXT_PUBLIC_COLLAB_SYNC_TIMEOUT_MS: '4000',
    };
    const config = require('@/lib/editor-config');
    expect(config.AUTOSAVE_DEBOUNCE_MS).toBe(1000);
    expect(config.PREVIEW_DEBOUNCE_MS).toBe(300);
    expect(config.PREVIEW_MAX_WAIT_MS).toBe(1200);
    expect(config.EXTERNAL_CHANGE_POLL_INTERVAL_MS).toBe(10_000);
    expect(config.PREVIEW_ADAPTIVE_MIN_MS).toBe(80);
    expect(config.PDF_PREVIEW_MAX_DEBOUNCE_MS).toBe(2500);
    expect(config.COLLAB_SYNC_TIMEOUT_MS).toBe(4000);
  });

  test('points the collaboration socket at the configured server when one is given', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_COLLAB_URL: 'wss://collab.example.test' };
    const config = require('@/lib/editor-config');
    expect(config.COLLAB_URL).toBe('wss://collab.example.test');
  });
});
