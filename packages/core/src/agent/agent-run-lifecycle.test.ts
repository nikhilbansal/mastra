import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';

import { SignalProvider } from '../signals/signal-provider';
import { Agent } from './agent';
import type { AgentRunLifecycleEvent } from './agent.types';

class LifecycleSignalProvider extends SignalProvider<'lifecycle-test'> {
  readonly id = 'lifecycle-test';

  constructor(
    private readonly events: string[],
    private readonly throwOnFinish = false,
  ) {
    super();
  }

  onRunLifecycle(event: AgentRunLifecycleEvent): void {
    this.events.push(`provider:${event.phase === 'start' ? 'start' : event.outcome}`);
    if (event.phase === 'finish' && this.throwOnFinish) throw new Error('provider cleanup failed');
  }
}

function textModel() {
  return new MockLanguageModelV2({
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'id-0', modelId: 'mock-model-id', timestamp: new Date(0) },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'done' },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]),
    }),
  });
}

describe('signal provider run lifecycle', () => {
  it('runs the configured lifecycle callback before provider observers', async () => {
    const events: string[] = [];
    const agent = new Agent({
      id: 'lifecycle-agent',
      name: 'Lifecycle agent',
      instructions: 'Reply briefly.',
      model: textModel(),
      signals: [new LifecycleSignalProvider(events)],
    });

    const output = await agent.stream('hello', {
      onRunLifecycle: event => {
        events.push(`configured:${event.phase === 'start' ? 'start' : event.outcome}`);
      },
    });
    await output.consumeStream();

    expect(events).toEqual(['configured:start', 'provider:start', 'configured:success', 'provider:success']);
  });

  it('does not let a provider cleanup failure corrupt a successful run', async () => {
    const events: string[] = [];
    const agent = new Agent({
      id: 'lifecycle-agent',
      name: 'Lifecycle agent',
      instructions: 'Reply briefly.',
      model: textModel(),
      signals: [new LifecycleSignalProvider(events, true)],
    });

    const output = await agent.stream('hello', {
      onRunLifecycle: event => {
        events.push(`configured:${event.phase === 'start' ? 'start' : event.outcome}`);
      },
    });
    await expect(output.consumeStream()).resolves.toBeUndefined();
    await expect(output.finishReason).resolves.toBe('stop');
    expect(events).toEqual(['configured:start', 'provider:start', 'configured:success', 'provider:success']);
  });
});
