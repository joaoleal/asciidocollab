import { Input, Label } from '@asciidocollab/web';

export const Default = () => (
  <div style={{ maxWidth: 320 }}>
    <Input placeholder="Search documents…" />
  </div>
);

export const WithLabel = () => (
  <div style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Label htmlFor="doc-title">Document title</Label>
    <Input id="doc-title" defaultValue="Getting started" />
  </div>
);

export const States = () => (
  <div style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Input placeholder="Enabled" />
    <Input disabled placeholder="Disabled" />
    <Input type="password" defaultValue="secret" />
  </div>
);
