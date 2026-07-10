import { Badge } from '@asciidocollab/web';

export const ReviewStatuses = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
    <Badge>Open</Badge>
    <Badge variant="secondary">In review</Badge>
    <Badge variant="destructive">Blocking</Badge>
    <Badge variant="outline">Resolved</Badge>
  </div>
);

export const Variants = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
    <Badge variant="default">default</Badge>
    <Badge variant="secondary">secondary</Badge>
    <Badge variant="destructive">destructive</Badge>
    <Badge variant="outline">outline</Badge>
  </div>
);
