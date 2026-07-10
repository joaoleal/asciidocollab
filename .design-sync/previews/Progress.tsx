import { Progress } from '@asciidocollab/web';

export const Values = () => (
  <div style={{ maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Progress value={25} />
    <Progress value={60} />
    <Progress value={100} />
  </div>
);
