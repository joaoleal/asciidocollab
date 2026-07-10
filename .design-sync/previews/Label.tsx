import { Input, Label } from '@asciidocollab/web';

export const WithInput = () => (
  <div style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Label htmlFor="branch">Branch name</Label>
    <Input id="branch" defaultValue="review/intro-edits" />
  </div>
);

export const Standalone = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <Label>Visibility</Label>
    <Label style={{ color: 'hsl(var(--muted-foreground))' }}>Optional — leave blank to inherit</Label>
  </div>
);
