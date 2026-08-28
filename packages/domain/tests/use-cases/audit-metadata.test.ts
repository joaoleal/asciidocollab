import { withOrigin } from '../../src/use-cases/audit-metadata';
import type { RequestContext } from '../../src/types/request-context';

describe('withOrigin', () => {
  it('omits origin entirely for a background action with no request context', () => {
    expect(withOrigin({ before: 'a', after: 'b' })).toEqual({ before: 'a', after: 'b' });
  });

  it('omits origin when the context carries neither address nor user agent', () => {
    const context: RequestContext = {};

    expect(withOrigin({ before: 'a' }, context)).toEqual({ before: 'a' });
  });

  it('folds in the address alone when that is all the request carried', () => {
    const context: RequestContext = { ipAddress: '203.0.113.7' };

    expect(withOrigin({ before: 'a' }, context)).toEqual({
      before: 'a',
      origin: { ipAddress: '203.0.113.7', userAgent: undefined },
    });
  });

  it('folds in the user agent alone when that is all the request carried', () => {
    const context: RequestContext = { userAgent: 'curl/8.6.0' };

    expect(withOrigin({ before: 'a' }, context)).toEqual({
      before: 'a',
      origin: { ipAddress: undefined, userAgent: 'curl/8.6.0' },
    });
  });

  it('folds in both parts of the origin under a stable key', () => {
    const context: RequestContext = { ipAddress: '203.0.113.7', userAgent: 'curl/8.6.0' };

    expect(withOrigin({ before: 'a' }, context)).toEqual({
      before: 'a',
      origin: { ipAddress: '203.0.113.7', userAgent: 'curl/8.6.0' },
    });
  });

  it('never mutates the metadata it was handed', () => {
    const metadata: Record<string, unknown> = { before: 'a' };

    const result = withOrigin(metadata, { ipAddress: '203.0.113.7' });

    expect(metadata).toEqual({ before: 'a' });
    expect(result).not.toBe(metadata);
  });
});
