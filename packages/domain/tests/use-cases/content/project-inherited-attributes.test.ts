import {
  projectInheritedAttributes,
  ScannedDocument,
} from '../../../src/use-cases/content/project-inherited-attributes';

const document = (fileId: string, path: string, content: string): ScannedDocument => ({ fileId, path, content });

describe('projectInheritedAttributes', () => {
  it('inherits nothing anywhere when no main file is configured', () => {
    const documents = [document('main', 'main.adoc', ':idprefix:\ninclude::child.adoc[]\n')];
    expect(projectInheritedAttributes(documents, null).size).toBe(0);
  });

  it('inherits nothing when the configured main file is not among the scanned documents', () => {
    const documents = [document('child', 'child.adoc', '= Child\n')];
    expect(projectInheritedAttributes(documents, 'missing-main').size).toBe(0);
  });

  it('gives the root document an empty inherited scope', () => {
    const documents = [document('main', 'main.adoc', ':idprefix:\n')];
    const inherited = projectInheritedAttributes(documents, 'main');
    expect(inherited.get('main')?.size).toBe(0);
  });

  it('passes attributes a parent set above the include down to the included document', () => {
    const documents = [
      document('main', 'main.adoc', ':idprefix: sec-\n:idseparator: -\ninclude::child.adoc[]\n'),
      document('child', 'child.adoc', '== Child\n'),
    ];
    const inherited = projectInheritedAttributes(documents, 'main');
    expect(inherited.get('child')?.get('idprefix')).toBe('sec-');
    expect(inherited.get('child')?.get('idseparator')).toBe('-');
  });

  it('resolves an include relative to the including document', () => {
    const documents = [
      document('main', 'book/main.adoc', ':lang: en\ninclude::part.adoc[]\n'),
      document('part', 'book/part.adoc', '== Part\n'),
    ];
    const inherited = projectInheritedAttributes(documents, 'main');
    expect(inherited.get('part')?.get('lang')).toBe('en');
  });

  it('does not walk an include whose target escapes the project sandbox', () => {
    const documents = [
      document('main', 'main.adoc', ':lang: en\ninclude::../outside.adoc[]\n'),
      document('outside', 'outside.adoc', '== Outside\n'),
    ];
    const inherited = projectInheritedAttributes(documents, 'main');
    expect(inherited.has('outside')).toBe(false);
    expect([...inherited.keys()]).toEqual(['main']);
  });

  it('does not walk an include whose target matches no document in the project', () => {
    const documents = [document('main', 'main.adoc', ':lang: en\ninclude::nowhere.adoc[]\n')];
    const inherited = projectInheritedAttributes(documents, 'main');
    expect([...inherited.keys()]).toEqual(['main']);
  });
});
