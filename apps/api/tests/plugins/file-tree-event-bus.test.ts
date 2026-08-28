import Fastify from 'fastify';
import { fileTreeEventBusPlugin } from '../../src/plugins/file-tree-event-bus';
import type { FileTreeEventDto, ProjectEventDto } from '@asciidocollab/shared';

const makeEvent = (overrides: Partial<FileTreeEventDto> = {}): FileTreeEventDto => ({
  type: 'created',
  fileNodeId: 'node-1',
  nodeType: 'file',
  name: 'test.txt',
  path: '/test.txt',
  parentId: 'folder-1',
  ...overrides,
});

async function buildTestServer() {
  const app = Fastify();
  await app.register(fileTreeEventBusPlugin);
  await app.ready();
  return app;
}

describe('FileTreeEventBus', () => {
  it('subscribed listener receives emitted event for same project', async () => {
    const app = await buildTestServer();
    const received: ProjectEventDto[] = [];
    app.fileTreeEventBus.subscribe('project-1', (event) => received.push(event));
    app.fileTreeEventBus.emit('project-1', makeEvent());
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('created');
    await app.close();
  });

  it('multiple listeners on same project all receive the event', async () => {
    const app = await buildTestServer();
    const received1: ProjectEventDto[] = [];
    const received2: ProjectEventDto[] = [];
    app.fileTreeEventBus.subscribe('project-1', (event) => received1.push(event));
    app.fileTreeEventBus.subscribe('project-1', (event) => received2.push(event));
    app.fileTreeEventBus.emit('project-1', makeEvent());
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    await app.close();
  });

  it('listener for project A does not receive events for project B', async () => {
    const app = await buildTestServer();
    const received: ProjectEventDto[] = [];
    app.fileTreeEventBus.subscribe('project-A', (event) => received.push(event));
    app.fileTreeEventBus.emit('project-B', makeEvent());
    expect(received).toHaveLength(0);
    await app.close();
  });

  it('returned unsubscribe function stops delivery', async () => {
    const app = await buildTestServer();
    const received: ProjectEventDto[] = [];
    const unsubscribe = app.fileTreeEventBus.subscribe('project-1', (event) => received.push(event));
    unsubscribe();
    app.fileTreeEventBus.emit('project-1', makeEvent());
    expect(received).toHaveLength(0);
    await app.close();
  });

  it('carries content-changed and main-file-changed union members to subscribers', async () => {
    const app = await buildTestServer();
    const received: ProjectEventDto[] = [];
    app.fileTreeEventBus.subscribe('project-1', (event) => received.push(event));
    app.fileTreeEventBus.emit('project-1', { type: 'content-changed', fileNodeId: 'node-9' });
    app.fileTreeEventBus.emit('project-1', { type: 'main-file-changed', mainFileNodeId: null });
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: 'content-changed', fileNodeId: 'node-9' });
    expect(received[1]).toEqual({ type: 'main-file-changed', mainFileNodeId: null });
    await app.close();
  });

  it('emitter is cleaned up when last subscriber unsubscribes', async () => {
    const app = await buildTestServer();
    const unsub = app.fileTreeEventBus.subscribe('project-1', () => {});
    unsub();
    // No error when emitting after all listeners removed
    expect(() => app.fileTreeEventBus.emit('project-1', makeEvent())).not.toThrow();
    await app.close();
  });

  it('keeps delivering to the remaining listeners after one of several unsubscribes', async () => {
    const app = await buildTestServer();
    const stillSubscribed: ProjectEventDto[] = [];
    const leaving: ProjectEventDto[] = [];
    app.fileTreeEventBus.subscribe('project-1', (event) => stillSubscribed.push(event));
    const unsubscribe = app.fileTreeEventBus.subscribe('project-1', (event) => leaving.push(event));

    unsubscribe();
    app.fileTreeEventBus.emit('project-1', makeEvent());

    expect(stillSubscribed).toHaveLength(1);
    expect(leaving).toHaveLength(0);
    await app.close();
  });

  it('tolerates the same unsubscribe being called twice', async () => {
    const app = await buildTestServer();
    const received: ProjectEventDto[] = [];
    const unsubscribe = app.fileTreeEventBus.subscribe('project-1', (event) => received.push(event));

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();

    app.fileTreeEventBus.emit('project-1', makeEvent());
    expect(received).toHaveLength(0);
    await app.close();
  });

  it('ignores a dispatched event that is not a CustomEvent', async () => {
    const app = await buildTestServer();
    const received: ProjectEventDto[] = [];
    app.fileTreeEventBus.subscribe('project-1', (event) => received.push(event));

    // `emit` builds its event through the global CustomEvent. Swapping in a plain Event subclass —
    // one that puts the real class back while it is being constructed, so the bus's own guard is
    // checked against the genuine CustomEvent — proves the subscriber drops anything that is not one.
    const realCustomEvent = globalThis.CustomEvent;
    const restoreCustomEvent = () => {
      Object.defineProperty(globalThis, 'CustomEvent', {
        value: realCustomEvent,
        configurable: true,
        writable: true,
      });
    };
    class PlainEventShim extends Event {
      constructor(type: string) {
        super(type);
        restoreCustomEvent();
      }
    }
    Object.defineProperty(globalThis, 'CustomEvent', {
      value: PlainEventShim,
      configurable: true,
      writable: true,
    });

    try {
      app.fileTreeEventBus.emit('project-1', makeEvent());
    } finally {
      restoreCustomEvent();
    }

    expect(received).toHaveLength(0);
    await app.close();
  });
});
