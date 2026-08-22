import type { UIMessage as AIV5UIMessage } from '@internal/ai-sdk-v5';
import type { UIMessage as AIV6UIMessage } from '@internal/ai-v6';
import { describe, expect, it } from 'vitest';
import { AIV5Adapter } from './AIV5Adapter';
import { AIV6Adapter } from './AIV6Adapter';

describe('data-part identity adapters', () => {
  it('preserves ids through AI SDK v5 UI and database conversions', () => {
    const input = {
      id: 'assistant-v5',
      role: 'assistant',
      parts: [{ type: 'data-progress', id: 'progress-1', data: { step: 1 } }],
    } as AIV5UIMessage;

    const dbMessage = AIV5Adapter.fromUIMessage(input);
    expect(dbMessage.content.parts).toEqual([{ type: 'data-progress', id: 'progress-1', data: { step: 1 } }]);
    expect(AIV5Adapter.toUIMessage(dbMessage).parts).toEqual(input.parts);
  });

  it('preserves ids through AI SDK v6 UI and database conversions', () => {
    const input = {
      id: 'assistant-v6',
      role: 'assistant',
      parts: [{ type: 'data-progress', id: 'progress-1', data: { step: 1 } }],
    } as AIV6UIMessage;

    const dbMessage = AIV6Adapter.fromUIMessage(input);
    expect(dbMessage.content.parts).toEqual([{ type: 'data-progress', id: 'progress-1', data: { step: 1 } }]);
    expect(AIV6Adapter.toUIMessage(dbMessage).parts).toEqual(input.parts);
  });
});
