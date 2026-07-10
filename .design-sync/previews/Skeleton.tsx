import { Skeleton } from '@asciidocollab/web';

export const Lines = () => (
  <div style={{ maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Skeleton className="h-6 w-48" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <Skeleton className="h-24 w-full" />
  </div>
);
