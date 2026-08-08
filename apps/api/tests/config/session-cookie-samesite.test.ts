import { createConfig } from '../../src/config/schema';

/** A node of convict's internal schema tree. */
interface CvtNode {
  format?: unknown;
  default?: unknown;
  _cvtProperties?: Record<string, CvtNode>;
}

/** Walks convict's internal schema tree to the node at `path`. */
function schemaNode(root: CvtNode, path: string[]): CvtNode {
  let node = root;
  for (const key of path) {
    const next = node._cvtProperties?.[key];
    if (!next) throw new Error(`no schema node at ${path.join('.')} (missing "${key}")`);
    node = next;
  }
  return node;
}

// Defence-in-depth against cross-site WebSocket hijacking — the
// session cookie must be issued with SameSite=Lax or stricter so the browser does
// not attach it to cross-site WebSocket handshakes by default.
describe('session cookie SameSite', () => {
  it('defaults to "strict" (>= Lax)', () => {
    const config = createConfig();
    const sameSite = config.default('auth.session.cookie.sameSite');
    expect(['strict', 'lax']).toContain(sameSite);
  });

  it('only permits strict | lax | none (no arbitrary values)', () => {
    const config = createConfig();
    // `_cvtProperties` is convict's internal schema tree and is not in its published types, so the
    // shape it is walked with is declared here rather than left to inference — which resolved the
    // sameSite node to `{ default: string }` and made `format` unreachable.
    const schema = config.getSchema() as unknown as CvtNode;
    const node = schemaNode(schema, ['auth', 'session', 'cookie', 'sameSite']);
    expect(node.format).toEqual(['strict', 'lax', 'none']);
  });
});
