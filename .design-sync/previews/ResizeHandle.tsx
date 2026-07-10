import { ResizeHandle } from '@asciidocollab/web';

const Panels = ({ resizing }: { resizing?: boolean }) => (
  <div
    style={{
      display: 'flex',
      height: 140,
      maxWidth: 420,
      border: '1px solid hsl(var(--border))',
      borderRadius: 8,
      overflow: 'hidden',
    }}
  >
    <div style={{ flex: '0 0 40%', padding: 12, fontSize: 13, background: 'hsl(var(--muted))' }}>File tree</div>
    <ResizeHandle ariaLabel="Resize file tree" isResizing={resizing} onPointerDown={() => {}} />
    <div style={{ flex: 1, padding: 12, fontSize: 13 }}>Editor</div>
  </div>
);

export const Idle = () => <Panels />;
export const Resizing = () => <Panels resizing />;
