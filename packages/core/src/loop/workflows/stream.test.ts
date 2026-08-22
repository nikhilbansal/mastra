import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../agent/message-list';
import type { Processor, ProcessorStreamWriter } from '../../processors';
import { ChunkFrom } from '../../stream/types';
import type { ChunkType } from '../../stream/types';

// Capture the outputWriter passed to createAgenticLoopWorkflow so we can
// invoke it directly in tests without spinning up a real agentic loop.
let capturedOutputWriter: ((chunk: ChunkType, options?: { messageId?: string }) => Promise<void>) | undefined;
let capturedCreateRunArgs: any;
let emittedChunks: ChunkType[] | undefined;

vi.mock('./agentic-loop', () => ({
  createAgenticLoopWorkflow: (params: any) => {
    capturedOutputWriter = params.outputWriter;

    return {
      __registerMastra: vi.fn(),
      deleteWorkflowRunById: vi.fn().mockResolvedValue(undefined),
      createRun: vi.fn().mockImplementation(async (args: any) => {
        capturedCreateRunArgs = args;
        return {
          start: vi.fn().mockImplementation(async () => {
            for (const chunk of emittedChunks ?? [
              {
                type: 'data-moderation',
                data: { flagged: true },
                runId: 'run-1',
                from: ChunkFrom.AGENT,
              } as ChunkType,
            ]) {
              await capturedOutputWriter!(chunk, { messageId: 'rotated-msg' });
            }

            return {
              status: 'success',
              result: {
                output: { steps: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
                stepResult: { reason: 'stop', warnings: [], isContinued: false },
                metadata: {},
                messages: { nonUser: [], all: [] },
              },
            };
          }),
        };
      }),
    };
  },
}));

const { workflowLoopStream } = await import('./stream');

describe('workflowLoopStream', () => {
  beforeEach(() => {
    emittedChunks = undefined;
  });

  it('should pass a defined writer to output processors when processing data-* chunks', async () => {
    let receivedWriter: ProcessorStreamWriter | undefined;

    const processor: Processor = {
      id: 'writer-capture',
      name: 'Writer Capture',
      processOutputStream: async ({ part, writer }) => {
        receivedWriter = writer;
        return part;
      },
    };

    const messageList = new MessageList({ threadId: 'test-thread' });

    const stream = workflowLoopStream({
      messageId: 'msg-1',
      runId: 'run-1',
      startTimestamp: Date.now(),
      agentId: 'test-agent',
      messageList,
      models: [{ model: {} as any, toolChoice: undefined }],
      outputProcessors: [processor],
      _internal: {},
      streamState: { serialize: () => ({}), deserialize: () => {} },
      methodType: 'stream',
    });

    // Consume the stream
    const reader = stream.getReader();
    const chunks: ChunkType[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (value) chunks.push(value);
      if (done) break;
    }

    // The processor should have received a defined writer
    expect(receivedWriter).toBeDefined();
    expect(typeof receivedWriter!.custom).toBe('function');

    // Verify the data-* chunk was emitted and persisted with the supplied response message id.
    const dataChunk = chunks.find(c => c.type === 'data-moderation');
    expect(dataChunk).toBeDefined();
    expect(messageList.get.response.db().map(message => message.id)).toEqual(['rotated-msg']);
  });

  it('preserves data-part ids and reconciles same-id persistence in authored order', async () => {
    emittedChunks = [
      { type: 'data-progress', id: 'progress-1', data: { step: 1 }, runId: 'run-1', from: ChunkFrom.AGENT },
      { type: 'data-card', id: 'card-1', data: { title: 'Card' }, runId: 'run-1', from: ChunkFrom.AGENT },
      { type: 'data-progress', id: 'progress-1', data: { step: 2 }, runId: 'run-1', from: ChunkFrom.AGENT },
      { type: 'data-progress', data: { legacy: 1 }, runId: 'run-1', from: ChunkFrom.AGENT },
      { type: 'data-progress', id: 'progress-1', data: { step: 3 }, runId: 'run-1', from: ChunkFrom.AGENT },
      { type: 'data-progress', data: { legacy: 2 }, runId: 'run-1', from: ChunkFrom.AGENT },
      { type: 'data-progress', id: '', data: { malformed: 1 }, runId: 'run-1', from: ChunkFrom.AGENT },
      { type: 'data-progress', id: '', data: { malformed: 2 }, runId: 'run-1', from: ChunkFrom.AGENT },
    ] as ChunkType[];

    const messageList = new MessageList({ threadId: 'test-thread' });
    const stream = workflowLoopStream({
      messageId: 'msg-identity',
      runId: 'run-1',
      startTimestamp: Date.now(),
      agentId: 'test-agent',
      messageList,
      models: [{ model: {} as any, toolChoice: undefined }],
      _internal: {},
      streamState: { serialize: () => ({}), deserialize: () => {} },
      methodType: 'stream',
    });

    const reader = stream.getReader();
    while (!(await reader.read()).done) {}

    const parts = messageList.get.response.db()[0]?.content.parts ?? [];
    expect(parts).toHaveLength(6);
    expect(parts).toMatchObject([
      { type: 'data-progress', id: 'progress-1', data: { step: 3 } },
      { type: 'data-card', id: 'card-1', data: { title: 'Card' } },
      { type: 'data-progress', data: { legacy: 1 } },
      { type: 'data-progress', data: { legacy: 2 } },
      { type: 'data-progress', id: '', data: { malformed: 1 } },
      { type: 'data-progress', id: '', data: { malformed: 2 } },
    ]);
  });

  it('preserves ids for data parts emitted by an output processor writer', async () => {
    const processor: Processor = {
      id: 'writer-identity',
      name: 'Writer Identity',
      processOutputStream: async ({ part, writer }) => {
        await writer?.custom({ type: 'data-progress', id: 'progress-1', data: { step: 1 } });
        await writer?.custom({ type: 'data-progress', id: 'progress-1', data: { step: 2 } });
        await writer?.custom({ type: 'data-progress', id: 'progress-1', data: { step: 3 } });
        return part;
      },
    };
    const messageList = new MessageList({ threadId: 'test-thread' });
    const stream = workflowLoopStream({
      messageId: 'msg-processor-identity',
      runId: 'run-1',
      startTimestamp: Date.now(),
      agentId: 'test-agent',
      messageList,
      models: [{ model: {} as any, toolChoice: undefined }],
      outputProcessors: [processor],
      _internal: {},
      streamState: { serialize: () => ({}), deserialize: () => {} },
      methodType: 'stream',
    });

    const reader = stream.getReader();
    while (!(await reader.read()).done) {}

    const progressParts =
      messageList.get.response.db()[0]?.content.parts.filter(part => part.type === 'data-progress') ?? [];
    expect(progressParts).toHaveLength(1);
    expect(progressParts).toMatchObject([{ type: 'data-progress', id: 'progress-1', data: { step: 3 } }]);
  });

  it('should forward resourceId from _internal to createRun()', async () => {
    const messageList = new MessageList({ threadId: 'test-thread' });

    const stream = workflowLoopStream({
      messageId: 'msg-2',
      runId: 'run-2',
      startTimestamp: Date.now(),
      agentId: 'test-agent',
      messageList,
      models: [{ model: {} as any, toolChoice: undefined }],
      _internal: { resourceId: 'user-abc-123' },
      streamState: { serialize: () => ({}), deserialize: () => {} },
      methodType: 'stream',
    });

    // Consume the stream to trigger createRun
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(capturedCreateRunArgs).toBeDefined();
    expect(capturedCreateRunArgs.resourceId).toBe('user-abc-123');
  });
});
