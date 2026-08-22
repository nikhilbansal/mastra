import { convertArrayToReadableStream, MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { Agent } from '../../agent';
import { Mastra } from '../../mastra';
import { MockMemory } from '../../memory/mock';
import { TaskSignalProvider } from '../../signals';
import { InMemoryStore } from '../../storage/mock';
import { createTool } from '../tool';

import { TaskStateProcessor } from './task-state-processor';
import { taskCheckTool, taskCompleteTool, taskUpdateTool, taskWriteTool } from './task-tools';

/**
 * End-to-end repro: write tasks in one step, then update one in the next step,
 * within a single agent run. Mirrors the failing MC Scenario 1.
 */
function stepParts(call: number) {
  if (call === 1) {
    return [
      {
        type: 'tool-call' as const,
        id: 'tc-1',
        toolCallId: 'call-write',
        toolName: 'task_write',
        args: JSON.stringify({
          tasks: [
            { content: 'Alpha', status: 'pending', activeForm: 'Alpha' },
            { content: 'Beta', status: 'pending', activeForm: 'Beta' },
          ],
        }),
      },
    ];
  }
  if (call === 2) {
    return [
      {
        type: 'tool-call' as const,
        id: 'tc-2',
        toolCallId: 'call-update',
        toolName: 'task_update',
        args: JSON.stringify({ id: 'task_alpha', status: 'in_progress' }),
      },
    ];
  }
  return [{ type: 'text' as const, text: 'Done' }];
}

function multiStepTaskModel() {
  let streamCall = 0;
  let genCall = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      genCall++;
      const parts = stepParts(genCall);
      const isToolStep = genCall < 3;
      return {
        content: parts as any,
        finishReason: isToolStep ? ('tool-calls' as const) : ('stop' as const),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        rawCall: { rawPrompt: [], rawSettings: {} },
        warnings: [],
      };
    },
    doStream: async () => {
      streamCall++;
      const parts = stepParts(streamCall);
      const isToolStep = streamCall < 3;
      const chunks: any[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: `r${streamCall}`, modelId: 'mock', timestamp: new Date(0) },
      ];
      if (isToolStep) {
        const part = parts[0] as { toolCallId: string; toolName: string; args: string };
        chunks.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.args,
        });
        chunks.push({
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
      } else {
        chunks.push({ type: 'text-start', id: 't1' });
        chunks.push({ type: 'text-delta', id: 't1', delta: 'Done' });
        chunks.push({ type: 'text-end', id: 't1' });
        chunks.push({
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
      }
      return {
        stream: convertArrayToReadableStream(chunks),
        rawCall: { rawPrompt: [], rawSettings: {} },
        warnings: [],
      };
    },
  });
}

describe('task tools e2e (multi-step within one run)', () => {
  it('task_update finds a task written in a prior step of the same run', async () => {
    const agent = new Agent({
      id: 'task-agent',
      name: 'task-agent',
      instructions: 'You manage tasks.',
      model: multiStepTaskModel(),
      memory: new MockMemory(),
      tools: {
        task_write: taskWriteTool,
        task_update: taskUpdateTool,
        task_complete: taskCompleteTool,
        task_check: taskCheckTool,
      },
      inputProcessors: [new TaskStateProcessor()],
    });

    // Register the agent with a Mastra that has storage so the task tools and
    // processor can resolve the thread-scoped `threadState` store.
    new Mastra({ agents: { 'task-agent': agent }, storage: new InMemoryStore(), logger: false });

    const stream = await agent.stream('Create Alpha and Beta, then mark Alpha in progress.', {
      memory: { resource: 'resource-1', thread: { id: 'thread-1' } },
      maxSteps: 5,
    });

    const toolResults: any[] = [];
    for await (const chunk of stream.fullStream) {
      if (chunk.type === 'tool-result') toolResults.push(chunk);
    }

    const byName = (name: string) => toolResults.find(r => r.payload?.toolName === name);
    const resultOf = (r: any) => r?.payload?.result;

    const writeResult = byName('task_write');
    const updateResult = byName('task_update');

    expect(resultOf(writeResult)?.isError).toBe(false);
    expect(updateResult).toBeDefined();
    expect(resultOf(updateResult)?.isError).toBe(false);
    expect(resultOf(updateResult)?.tasks?.find((t: any) => t.id === 'task_alpha')?.status).toBe('in_progress');
  });

  it('keeps task bookkeeping beside business work and reserves the close for receipt-backed prose', async () => {
    const receiptTools = Object.fromEntries(
      ['collection', 'section', 'cta'].map(deliverable => [
        `deliver_${deliverable}`,
        createTool({
          id: `deliver_${deliverable}`,
          description: `Complete the ${deliverable} deliverable`,
          inputSchema: z.object({}),
          outputSchema: z.object({ receipt: z.object({ deliverable: z.string(), status: z.literal('success') }) }),
          execute: async () => ({ receipt: { deliverable, status: 'success' as const } }),
        }),
      ]),
    );

    const taskDefinitions = [
      ['collection', 'Create the collection', 'Creating the collection'],
      ['section', 'Add the collection section', 'Adding the collection section'],
      ['cta', 'Link the section CTA', 'Linking the section CTA'],
    ] as const;
    const taskInput = (statuses: Array<'pending' | 'in_progress' | 'completed'>) =>
      JSON.stringify({
        tasks: taskDefinitions.map(([id, content, activeForm], index) => ({
          id,
          content,
          activeForm,
          status: statuses[index],
        })),
      });
    const rounds = [
      [
        {
          toolCallId: 'tasks-initial',
          toolName: 'task_write',
          input: taskInput(['in_progress', 'pending', 'pending']),
        },
        { toolCallId: 'deliver-collection', toolName: 'deliver_collection', input: '{}' },
      ],
      [
        {
          toolCallId: 'tasks-section',
          toolName: 'task_write',
          input: taskInput(['completed', 'in_progress', 'pending']),
        },
        { toolCallId: 'deliver-section', toolName: 'deliver_section', input: '{}' },
      ],
      [
        {
          toolCallId: 'tasks-cta',
          toolName: 'task_write',
          input: taskInput(['completed', 'completed', 'in_progress']),
        },
        { toolCallId: 'deliver-cta', toolName: 'deliver_cta', input: '{}' },
      ],
    ];

    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        call += 1;
        const calls = rounds[call - 1] ?? [];

        const chunks: any[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `r${call}`, modelId: 'mock', timestamp: new Date(0) },
        ];
        if (calls.length > 0) {
          chunks.push(...calls.map(toolCall => ({ type: 'tool-call', ...toolCall })));
          chunks.push({
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
        } else {
          chunks.push(
            { type: 'text-start', id: 'final-text' },
            {
              type: 'text-delta',
              id: 'final-text',
              delta: 'The collection, section, and CTA are complete.',
            },
            { type: 'text-end', id: 'final-text' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          );
        }
        return {
          stream: convertArrayToReadableStream(chunks),
          rawCall: { rawPrompt: [], rawSettings: {} },
          warnings: [],
        };
      },
    });

    const storage = new InMemoryStore();
    const agent = new Agent({
      id: 'deliverable-agent',
      name: 'deliverable-agent',
      instructions: 'Complete three user-visible deliverables.',
      model,
      memory: new MockMemory(),
      tools: receiptTools,
      signals: [new TaskSignalProvider()],
    });
    new Mastra({ agents: { 'deliverable-agent': agent }, storage, logger: false });

    const stream = await agent.stream('Create a collection, add its section, and link the CTA.', {
      memory: { resource: 'resource-1', thread: { id: 'deliverable-thread' } },
      maxSteps: 15,
    });
    await stream.consumeStream();
    await expect(stream.text).resolves.toBe('The collection, section, and CTA are complete.');

    const taskToolNames = new Set(['task_write', 'task_update', 'task_complete', 'task_check']);
    const steps = await stream.steps;
    const toolSteps = steps.filter(step => step.toolCalls.length > 0);
    expect(toolSteps).toHaveLength(3);
    for (const step of toolSteps) {
      const names = step.toolCalls.map(call => call.payload.toolName);
      expect(names.some(name => !taskToolNames.has(name))).toBe(true);
    }

    // The list contains only the three user-visible outcomes; the model does
    // not mint internal discovery/selection tasks.
    const initialWrite = steps[0]!.toolCalls.find(call => call.payload.toolName === 'task_write');
    expect(initialWrite?.payload.args.tasks.map((task: { id: string }) => task.id)).toEqual([
      'collection',
      'section',
      'cta',
    ]);

    // Completion calls occur only after the matching business receipt exists.
    expect(
      steps[0]!.toolResults.find(result => result.payload.toolName === 'deliver_collection')?.payload.result,
    ).toEqual({ receipt: { deliverable: 'collection', status: 'success' } });
    expect(steps[1]!.toolCalls.find(call => call.payload.toolCallId === 'tasks-section')?.payload.args.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'collection', status: 'completed' }),
        expect.objectContaining({ id: 'section', status: 'in_progress' }),
      ]),
    );
    expect(steps[1]!.toolResults.find(result => result.payload.toolName === 'deliver_section')?.payload.result).toEqual(
      { receipt: { deliverable: 'section', status: 'success' } },
    );
    expect(steps[2]!.toolCalls.find(call => call.payload.toolCallId === 'tasks-cta')?.payload.args.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'section', status: 'completed' }),
        expect.objectContaining({ id: 'cta', status: 'in_progress' }),
      ]),
    );
    expect(steps[2]!.toolResults.find(result => result.payload.toolName === 'deliver_cta')?.payload.result).toEqual({
      receipt: { deliverable: 'cta', status: 'success' },
    });

    // The final receipt is followed directly by prose. TaskSignalProvider owns
    // terminal cleanup, so no final task-only round is required.
    expect(steps).toHaveLength(4);
    expect(steps.at(-1)?.toolCalls).toHaveLength(0);
    const taskStore = await storage.getStore('threadState');
    await expect(taskStore.getState({ threadId: 'deliverable-thread', type: 'task' })).resolves.toEqual([]);
  });
});
