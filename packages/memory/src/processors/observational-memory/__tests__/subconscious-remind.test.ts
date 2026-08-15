import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import { applyExtractorHooks } from '../extracted-values';
import { buildExtractorOutputSections, Extractor } from '../extractor';
import { SubconsciousRemindExtractor } from '../subconscious';
import { createRemindAskTool } from '../subconscious/remind';

function createModel(response: string) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
      content: [{ type: 'text', text: response }],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'remind-1', modelId: 'remind-model', timestamp: new Date() },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: response },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ]),
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
    }),
  });
}

function createContext(response: string) {
  const requestContext = new RequestContext();
  requestContext.set('organizationId', 'acme');
  const memory = {
    storage: new InMemoryStore(),
    getKnowledgeSemanticIndex: vi.fn(),
  } as any;
  return {
    threadId: 'alpha',
    resourceId: 'user-42',
    mainAgent: { getModel: vi.fn(async () => createModel(response)) } as any,
    memory,
    requestContext,
    sendSignal: vi.fn(async () => undefined) as any,
    sendStateSignal: vi.fn(async () => ({ skipped: false })) as any,
  };
}

describe('Subconscious remind', () => {
  it('runs hook extractors without adding prompt output or requiring a parsed value', async () => {
    const onExtracted = vi.fn();
    const extractor = new Extractor({ name: 'Lifecycle hook', mode: 'hook', onExtracted });

    expect(() => new Extractor({ name: 'Invalid hook', mode: 'hook' })).toThrow(/onExtracted/);
    expect(() => new Extractor({ name: 'Invalid hook', mode: 'hook', instructions: 'Do work.', onExtracted })).toThrow(
      /cannot include instructions or a schema/,
    );
    expect(extractor.mode).toBe('hook');
    expect(extractor.metadataKeyPath).toBe(false);
    expect(buildExtractorOutputSections([extractor])).toBe('');

    await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user asked about Project Atlas.',
      threadId: 'alpha',
    });

    expect(onExtracted).toHaveBeenCalledOnce();
    expect(onExtracted).toHaveBeenCalledWith(
      expect.objectContaining({
        current: 'The user asked about Project Atlas.',
        rawObservations: 'The user asked about Project Atlas.',
      }),
    );
  });

  it('emits at most one remembered reactive signal for a relevant cycle', async () => {
    const extractor = new SubconsciousRemindExtractor({
      name: 'remind',
      maxSteps: 3,
      builtIn: true,
    });
    const context = createContext('Project Atlas launches January 15.');
    const store = await context.memory.storage.getStore('knowledge');
    const node = await store.createNode({
      name: 'Project Atlas',
      kind: 'project',
      scope: ['org:acme', 'resource:user-42'],
    });
    const item = await store.appendItem({
      parentNodeId: node.id,
      text: 'Project Atlas launches January 15.',
      scope: ['org:acme', 'resource:user-42'],
      sourceThreadId: 'beta',
      resolutionScope: ['org:acme', 'resource:user-42', 'thread:beta'],
      defaultScope: ['org:acme', 'resource:user-42'],
    });

    const result = await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user is scheduling Project Atlas.',
      ...context,
    });

    expect(result.failures).toBeUndefined();
    expect(context.sendSignal).toHaveBeenCalledOnce();
    expect(context.sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reactive',
        tagName: 'remembered',
        contents: expect.stringContaining(item.id),
        attributes: expect.objectContaining({
          source: 'subconscious',
          sourceIds: expect.stringContaining(item.id),
          agent: 'remind',
          threadId: 'alpha',
        }),
      }),
    );
  });

  it('stays quiet when the reminder agent finds nothing relevant', async () => {
    const extractor = new SubconsciousRemindExtractor({
      name: 'remind',
      maxSteps: 3,
      builtIn: true,
    });
    const context = createContext('<no-reminder />');

    await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user asked about the weather.',
      ...context,
    });

    expect(context.sendSignal).not.toHaveBeenCalled();
  });

  it('runs on the observational memory model when no main agent is available', async () => {
    const extractor = new SubconsciousRemindExtractor(
      { name: 'remind', maxSteps: 3, builtIn: true },
      createModel('Project Atlas launches January 15.') as any,
    );
    const context = createContext('unused');
    delete (context as any).mainAgent;
    const store = await context.memory.storage.getStore('knowledge');
    const node = await store.createNode({
      name: 'Project Atlas',
      kind: 'project',
      scope: ['org:acme', 'resource:user-42'],
    });
    const item = await store.appendItem({
      parentNodeId: node.id,
      text: 'Project Atlas launches January 15.',
      scope: ['org:acme', 'resource:user-42'],
      sourceThreadId: 'beta',
      resolutionScope: ['org:acme', 'resource:user-42', 'thread:beta'],
      defaultScope: ['org:acme', 'resource:user-42'],
    });

    const result = await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user is scheduling Project Atlas.',
      ...context,
    });

    expect(result.failures).toBeUndefined();
    expect(context.sendSignal).toHaveBeenCalledOnce();
    expect(context.sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ tagName: 'remembered', contents: expect.stringContaining(item.id) }),
    );
  });

  it("does not echo the thread's own freshly captured items back as reminders", async () => {
    const extractor = new SubconsciousRemindExtractor({
      name: 'remind',
      maxSteps: 3,
      builtIn: true,
    });
    const context = createContext('The launch happens January 15.');
    const store = await context.memory.storage.getStore('knowledge');
    const node = await store.createNode({
      name: 'Zeta initiative',
      kind: 'program',
      scope: ['org:acme', 'resource:user-42'],
    });
    // Captured by THIS thread, moments ago: the reminder must not whisper it back.
    await store.appendItem({
      parentNodeId: node.id,
      text: 'The launch happens January 15.',
      scope: ['org:acme', 'resource:user-42'],
      sourceThreadId: 'alpha',
      resolutionScope: ['org:acme', 'resource:user-42', 'thread:alpha'],
      defaultScope: ['org:acme', 'resource:user-42'],
    });

    const result = await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user is scheduling the launch.',
      ...context,
    });

    expect(result.failures).toBeUndefined();
    expect(context.sendSignal).not.toHaveBeenCalled();
  });

  it("does not echo fresh items written by the thread's own subconscious sub-agents", async () => {
    const extractor = new SubconsciousRemindExtractor({
      name: 'remind',
      maxSteps: 3,
      builtIn: true,
    });
    const context = createContext('The launch happens January 15.');
    const store = await context.memory.storage.getStore('knowledge');
    const node = await store.createNode({
      name: 'Zeta initiative',
      kind: 'program',
      scope: ['org:acme', 'resource:user-42'],
    });
    // Written moments ago by this thread's own curator sub-thread.
    await store.appendItem({
      parentNodeId: node.id,
      text: 'The launch happens January 15.',
      scope: ['org:acme', 'resource:user-42'],
      sourceThreadId: 'subconscious:alpha:curate',
      resolutionScope: ['org:acme', 'resource:user-42', 'thread:alpha'],
      defaultScope: ['org:acme', 'resource:user-42'],
    });

    const result = await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user is scheduling the launch.',
      ...context,
    });

    expect(result.failures).toBeUndefined();
    expect(context.sendSignal).not.toHaveBeenCalled();
  });

  it("still reminds about the thread's own older items once they age past the fresh window", async () => {
    vi.useFakeTimers();
    try {
      const extractor = new SubconsciousRemindExtractor({
        name: 'remind',
        maxSteps: 3,
        builtIn: true,
      });
      const context = createContext('The launch happens January 15.');
      const store = await context.memory.storage.getStore('knowledge');
      const node = await store.createNode({
        name: 'Zeta initiative',
        kind: 'program',
        scope: ['org:acme', 'resource:user-42'],
      });
      const item = await store.appendItem({
        parentNodeId: node.id,
        text: 'The launch happens January 15.',
        scope: ['org:acme', 'resource:user-42'],
        sourceThreadId: 'alpha',
        resolutionScope: ['org:acme', 'resource:user-42', 'thread:alpha'],
        defaultScope: ['org:acme', 'resource:user-42'],
      });

      vi.advanceTimersByTime(31 * 60 * 1000);

      const result = await applyExtractorHooks({
        source: 'observer',
        extractors: [extractor],
        rawObservations: 'The user is scheduling the launch.',
        ...context,
      });

      expect(result.failures).toBeUndefined();
      expect(context.sendSignal).toHaveBeenCalledOnce();
      expect(context.sendSignal).toHaveBeenCalledWith(
        expect.objectContaining({ tagName: 'remembered', contents: expect.stringContaining(item.id) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the reminder agent the recent messages so it can skip what is already visible', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const generateSpy = vi.spyOn(Agent.prototype, 'generate' as any);
    generateSpy.mockClear();
    try {
      const extractor = new SubconsciousRemindExtractor({
        name: 'remind',
        maxSteps: 3,
        builtIn: true,
      });
      const context = createContext('<no-reminder />');
      const store = await context.memory.storage.getStore('knowledge');
      const node = await store.createNode({
        name: 'Moon weather',
        kind: 'topic',
        scope: ['org:acme', 'resource:user-42'],
      });
      await store.appendItem({
        parentNodeId: node.id,
        text: 'The moon has no weather to speak of.',
        scope: ['org:acme', 'resource:user-42'],
        sourceThreadId: 'beta',
        resolutionScope: ['org:acme', 'resource:user-42', 'thread:beta'],
        defaultScope: ['org:acme', 'resource:user-42'],
      });

      await applyExtractorHooks({
        source: 'observer',
        extractors: [extractor],
        rawObservations: 'The user asked about the weather on the moon.',
        recentMessages: 'user: what is the weather like on the moon?',
        ...context,
      });

      expect(generateSpy).toHaveBeenCalledOnce();
      const prompt = generateSpy.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('user: what is the weather like on the moon?');
      expect(prompt).toContain('already visible');
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('stays silent when no main agent and no observational memory model are available', async () => {
    const extractor = new SubconsciousRemindExtractor({ name: 'remind', maxSteps: 3, builtIn: true });
    const context = createContext('unused');
    delete (context as any).mainAgent;

    const result = await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user is scheduling Project Atlas.',
      ...context,
    });

    expect(result.failures).toBeUndefined();
    expect(context.sendSignal).not.toHaveBeenCalled();
  });

  describe('continuity: the reminder agent keeps one conversation per session', () => {
    async function seedRelevantItem(context: ReturnType<typeof createContext>) {
      const store = await context.memory.storage.getStore('knowledge');
      const node = await store.createNode({
        name: 'Project Atlas',
        kind: 'project',
        scope: ['org:acme', 'resource:user-42'],
      });
      return store.appendItem({
        parentNodeId: node.id,
        text: 'Project Atlas launches January 15.',
        scope: ['org:acme', 'resource:user-42'],
        sourceThreadId: 'beta',
        resolutionScope: ['org:acme', 'resource:user-42', 'thread:beta'],
        defaultScope: ['org:acme', 'resource:user-42'],
      });
    }

    /** Runs the hook with `generate` stubbed, so the assertions are about wiring, not model output. */
    async function runWithGenerateSpy(options: {
      createRemindMemory?: () => any;
      threadId?: string;
      response?: string;
    }) {
      const { Agent } = await import('@mastra/core/agent');
      const generateSpy = vi
        .spyOn(Agent.prototype, 'generate' as any)
        .mockResolvedValue({ text: options.response ?? '<no-reminder />' } as any);
      try {
        const extractor = new SubconsciousRemindExtractor({ name: 'remind', maxSteps: 3, builtIn: true }, undefined, {
          createRemindMemory: options.createRemindMemory,
        });
        const context = createContext('unused');
        if (options.threadId) context.threadId = options.threadId;
        await seedRelevantItem(context);

        const result = await applyExtractorHooks({
          source: 'observer',
          extractors: [extractor],
          rawObservations: 'The user is scheduling Project Atlas.',
          ...context,
        });

        // Snapshot the recorded calls before restoring — mockRestore clears them.
        return {
          result,
          context,
          calls: [...generateSpy.mock.calls] as any[][],
          agents: [...((generateSpy.mock as any).contexts ?? [])],
        };
      } finally {
        generateSpy.mockRestore();
      }
    }

    it('generates against the shared remind thread derived from the parent thread id', async () => {
      const remindMemory = { id: 'remind-memory' } as any;
      const { result, calls } = await runWithGenerateSpy({ createRemindMemory: () => remindMemory });

      expect(result.failures).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toMatchObject({
        memory: { thread: 'subconscious:alpha:remind', resource: 'user-42' },
      });
    });

    it('keys the thread off the parent thread id, never off the agent id', async () => {
      const { calls } = await runWithGenerateSpy({
        createRemindMemory: () => ({}) as any,
        threadId: 'gamma',
      });

      const thread = (calls[0]?.[1] as any).memory.thread;
      expect(thread).toBe('subconscious:gamma:remind');
      // The agent id convention is `subconscious-remind-<threadId>`; confusing the two produces a
      // thread that looks plausible and groups wrongly.
      expect(thread).not.toContain('subconscious-remind-');
    });

    it('hands the reminder agent the memory its owner built', async () => {
      const remindMemory = { id: 'remind-memory' } as any;
      const createRemindMemory = vi.fn(() => remindMemory);
      const { agents } = await runWithGenerateSpy({ createRemindMemory });

      expect(createRemindMemory).toHaveBeenCalledOnce();
      const agent = agents[0] as any;
      expect(await agent.getMemory()).toBe(remindMemory);
    });

    it('passes the same thread on every run, so passive reminders and questions share one conversation', async () => {
      const first = await runWithGenerateSpy({ createRemindMemory: () => ({}) as any });
      const second = await runWithGenerateSpy({ createRemindMemory: () => ({}) as any });

      expect((first.calls[0]?.[1] as any).memory.thread).toBe((second.calls[0]?.[1] as any).memory.thread);
    });

    it('omits the memory option entirely when no remind memory is available', async () => {
      const { result, calls } = await runWithGenerateSpy({});

      expect(result.failures).toBeUndefined();
      expect(calls[0]?.[1]).not.toHaveProperty('memory');
    });

    it('still drops the thread\u2019s own fresh items when a remind memory is attached', async () => {
      const extractor = new SubconsciousRemindExtractor({ name: 'remind', maxSteps: 3, builtIn: true }, undefined, {
        createRemindMemory: () => ({}) as any,
      });
      const context = createContext('The launch happens January 15.');
      const store = await context.memory.storage.getStore('knowledge');
      const node = await store.createNode({
        name: 'Zeta initiative',
        kind: 'program',
        scope: ['org:acme', 'resource:user-42'],
      });
      await store.appendItem({
        parentNodeId: node.id,
        text: 'The launch happens January 15.',
        scope: ['org:acme', 'resource:user-42'],
        sourceThreadId: 'alpha',
        resolutionScope: ['org:acme', 'resource:user-42', 'thread:alpha'],
        defaultScope: ['org:acme', 'resource:user-42'],
      });

      const result = await applyExtractorHooks({
        source: 'observer',
        extractors: [extractor],
        rawObservations: 'The user is scheduling the launch.',
        ...context,
      });

      // Continuity fixes repetition; freshness is a different failure and its guard must survive.
      expect(result.failures).toBeUndefined();
      expect(context.sendSignal).not.toHaveBeenCalled();
    });

    it('keeps the no-reminder contract when a remind memory is attached', async () => {
      const { result, context } = await runWithGenerateSpy({ createRemindMemory: () => ({}) as any });

      expect(result.failures).toBeUndefined();
      expect(context.sendSignal).not.toHaveBeenCalled();
    });

    it('routes a remind memory construction failure into the extractor failure path', async () => {
      const extractor = new SubconsciousRemindExtractor({ name: 'remind', maxSteps: 3, builtIn: true }, undefined, {
        createRemindMemory: () => {
          throw new Error('remind memory unavailable');
        },
      });
      const context = createContext('Project Atlas launches January 15.');
      await seedRelevantItem(context);

      const result = await applyExtractorHooks({
        source: 'observer',
        extractors: [extractor],
        rawObservations: 'The user is scheduling Project Atlas.',
        ...context,
      });

      expect(result.failures).toEqual([{ slug: 'remind', error: 'remind memory unavailable' }]);
      expect(context.sendSignal).not.toHaveBeenCalled();
      expect(context.sendStateSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'subconscious-activity',
          value: expect.objectContaining({ errors: ['remind: remind memory unavailable'] }),
        }),
      );
    });
  });

  it('isolates reminder failures from the observation lifecycle', async () => {
    const extractor = new SubconsciousRemindExtractor({
      name: 'remind',
      maxSteps: 3,
      builtIn: true,
    });
    const context = createContext('unused');
    context.mainAgent.getModel = vi.fn(async () => {
      throw new Error('reminder provider unavailable');
    });
    const store = await context.memory.storage.getStore('knowledge');
    const node = await store.createNode({
      name: 'Project Atlas',
      kind: 'project',
      scope: ['org:acme', 'resource:user-42'],
    });
    await store.appendItem({
      parentNodeId: node.id,
      text: 'Project Atlas launches January 15.',
      scope: ['org:acme', 'resource:user-42'],
      sourceThreadId: 'beta',
      resolutionScope: ['org:acme', 'resource:user-42', 'thread:beta'],
      defaultScope: ['org:acme', 'resource:user-42'],
    });

    const result = await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user asked about Project Atlas.',
      ...context,
    });

    expect(result.failures).toEqual([{ slug: 'remind', error: 'reminder provider unavailable' }]);
    expect(context.sendSignal).not.toHaveBeenCalled();
    expect(context.sendStateSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'subconscious-activity',
        value: expect.objectContaining({ errors: ['remind: reminder provider unavailable'] }),
      }),
    );
  });
});

describe('Subconscious remind ask lane', () => {
  function createAskTool(
    options: {
      response?: string;
      omModel?: any;
      createRemindMemory?: () => any;
      generate?: (prompt: string, args: any) => Promise<{ text: string }>;
    } = {},
  ) {
    const memory = { storage: new InMemoryStore(), getKnowledgeSemanticIndex: vi.fn() } as any;
    const generateSpy = vi.spyOn(Agent.prototype, 'generate' as any);
    if (options.generate) {
      generateSpy.mockImplementation(options.generate as any);
    } else {
      generateSpy.mockImplementation((async () => ({ text: options.response ?? 'That happened on Tuesday.' })) as any);
    }
    const tools = createRemindAskTool({
      memory,
      config: { name: 'remind', maxSteps: 3, builtIn: true },
      omModel: 'omModel' in options ? options.omModel : createModel('unused'),
      createRemindMemory: options.createRemindMemory,
    });
    return { tools, generateSpy, memory };
  }

  function askContext(overrides: Record<string, unknown> = {}) {
    const requestContext = new RequestContext();
    requestContext.set('organizationId', 'acme');
    return {
      agent: { agentId: 'main', threadId: 'alpha', resourceId: 'user-42' },
      requestContext,
      ...overrides,
    } as any;
  }

  function signalCapture() {
    const sent: any[] = [];
    const sender = {
      sendSignal: vi.fn((signal: any) => {
        sent.push(signal);
        return { persisted: Promise.resolve() };
      }),
    };
    return {
      sent,
      sender,
      mastra: { getAgentById: vi.fn(async () => sender) },
    };
  }

  async function settle() {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
  }

  it('returns the answer as the tool result when wait is true', async () => {
    const { tools, generateSpy } = createAskTool({ response: 'The deploy happened on Tuesday.' });
    try {
      const result: any = await tools.ask_memory.execute!({ question: 'when did that happen?' } as any, askContext());
      expect(result.ok).toBe(true);
      expect(result.answer).toBe('The deploy happened on Tuesday.');
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('asks on the shared remind thread, not a thread of its own', async () => {
    const calls: any[] = [];
    const { tools, generateSpy } = createAskTool({
      createRemindMemory: () => ({}) as any,
      generate: async (_prompt, args) => {
        calls.push(args);
        return { text: 'Tuesday.' };
      },
    });
    try {
      await tools.ask_memory.execute!({ question: 'when?' } as any, askContext());
      expect(calls[0]?.memory).toEqual({ thread: 'subconscious:alpha:remind', resource: 'user-42' });
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('returns immediately when wait is false, before the answer settles', async () => {
    let release: (value: { text: string }) => void = () => {};
    const deferred = new Promise<{ text: string }>(resolve => (release = resolve));
    const { tools, generateSpy } = createAskTool({
      generate: async () => deferred,
      createRemindMemory: () => ({}) as any,
    });
    const capture = signalCapture();
    try {
      const result: any = await tools.ask_memory.execute!(
        { question: 'when?', wait: false } as any,
        askContext({ mastra: capture.mastra }),
      );
      expect(result.accepted).toBe(true);
      expect(capture.sent).toHaveLength(0);
      release({ text: 'Tuesday.' });
      await settle();
      expect(capture.sent).toHaveLength(1);
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('delivers the non-blocking answer as a remembered signal', async () => {
    const { tools, generateSpy } = createAskTool({ response: 'Tuesday.' });
    const capture = signalCapture();
    try {
      await tools.ask_memory.execute!(
        { question: 'when?', wait: false } as any,
        askContext({ mastra: capture.mastra }),
      );
      await settle();
      expect(capture.sent[0]).toEqual(
        expect.objectContaining({
          type: 'reactive',
          tagName: 'remembered',
          attributes: expect.objectContaining({ source: 'subconscious', agent: 'remind', threadId: 'alpha' }),
        }),
      );
      expect(capture.sender.sendSignal).toHaveBeenCalledWith(expect.anything(), {
        threadId: 'alpha',
        resourceId: 'user-42',
      });
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('round-trips the correlation id from the acknowledgement to the late signal', async () => {
    const { tools, generateSpy } = createAskTool({ response: 'Tuesday.' });
    const capture = signalCapture();
    try {
      const result: any = await tools.ask_memory.execute!(
        { question: 'when?', wait: false } as any,
        askContext({ mastra: capture.mastra }),
      );
      await settle();
      expect(result.correlationId).toBeTruthy();
      expect(capture.sent[0].attributes.correlationId).toBe(result.correlationId);
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('keeps the question and the answer in the shared thread', async () => {
    const generated: any[] = [];
    const { tools, generateSpy } = createAskTool({
      createRemindMemory: () => ({}) as any,
      generate: async (prompt, args) => {
        generated.push({ prompt, args });
        return { text: 'Tuesday.' };
      },
    });
    try {
      await tools.ask_memory.execute!({ question: 'when did the deploy happen?' } as any, askContext());
      expect(generated[0].prompt).toContain('when did the deploy happen?');
      expect(generated[0].args.memory.thread).toBe('subconscious:alpha:remind');
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('isolates a blocking failure into an error result instead of throwing', async () => {
    const { tools, generateSpy } = createAskTool({
      generate: async () => {
        throw new Error('reminder provider unavailable');
      },
    });
    try {
      const result: any = await tools.ask_memory.execute!({ question: 'when?' } as any, askContext());
      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'reminder provider unavailable' }));
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('reports a non-blocking failure on the signal channel carrying the correlation id', async () => {
    const { tools, generateSpy } = createAskTool({
      generate: async () => {
        throw new Error('reminder provider unavailable');
      },
    });
    const capture = signalCapture();
    const writer = { custom: vi.fn(async () => undefined) };
    try {
      const result: any = await tools.ask_memory.execute!(
        { question: 'when?', wait: false } as any,
        askContext({ mastra: capture.mastra, writer }),
      );
      await settle();
      expect(writer.custom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data-subconscious-error',
          data: expect.objectContaining({ agent: 'remind' }),
        }),
      );
      expect(capture.sent[0].attributes.correlationId).toBe(result.correlationId);
      expect(capture.sent[0].contents).toEqual(expect.anything());
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('gives concurrent non-blocking questions distinct correlation ids', async () => {
    const { tools, generateSpy } = createAskTool({
      generate: async prompt => ({ text: prompt.includes('first') ? 'answer one' : 'answer two' }),
    });
    const capture = signalCapture();
    try {
      const context = askContext({ mastra: capture.mastra });
      const [one, two]: any[] = await Promise.all([
        tools.ask_memory.execute!({ question: 'the first one?', wait: false } as any, context),
        tools.ask_memory.execute!({ question: 'the second one?', wait: false } as any, context),
      ]);
      await settle();
      expect(one.correlationId).not.toBe(two.correlationId);
      const byId = new Map(capture.sent.map(signal => [signal.attributes.correlationId, signal]));
      expect(byId.get(one.correlationId)?.attributes.question).toBe('the first one?');
      expect(byId.get(two.correlationId)?.attributes.question).toBe('the second one?');
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('leaves the passive reminder path unregressed when the ask tool exists', async () => {
    const extractor = new SubconsciousRemindExtractor({ name: 'remind', maxSteps: 3, builtIn: true });
    const context = createContext('Project Atlas launches January 15.');
    const store = await context.memory.storage.getStore('knowledge');
    const node = await store.createNode({
      name: 'Project Atlas',
      kind: 'project',
      scope: ['org:acme', 'resource:user-42'],
    });
    await store.appendItem({
      parentNodeId: node.id,
      text: 'Project Atlas launches January 15.',
      scope: ['org:acme', 'resource:user-42'],
      sourceThreadId: 'beta',
      resolutionScope: ['org:acme', 'resource:user-42', 'thread:beta'],
      defaultScope: ['org:acme', 'resource:user-42'],
    });
    createRemindAskTool({
      memory: context.memory,
      config: { name: 'remind', maxSteps: 3, builtIn: true },
      omModel: createModel('unused'),
    });

    const result = await applyExtractorHooks({
      source: 'observer',
      extractors: [extractor],
      rawObservations: 'The user is scheduling Project Atlas.',
      ...context,
    });

    expect(result.failures).toBeUndefined();
    expect(context.sendSignal).toHaveBeenCalledOnce();
    expect(context.sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reactive', tagName: 'remembered' }),
    );
  });

  it('returns an explicit unavailable result when no model can be resolved', async () => {
    const { tools, generateSpy } = createAskTool({ omModel: undefined });
    try {
      const result: any = await tools.ask_memory.execute!({ question: 'when?' } as any, askContext());
      expect(result.ok).toBe(false);
      expect(result.unavailable).toBe(true);
      expect(result.error).toMatch(/model/i);
      expect(generateSpy).not.toHaveBeenCalled();
    } finally {
      generateSpy.mockRestore();
    }
  });
});
