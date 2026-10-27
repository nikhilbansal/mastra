import { describe, expect, it, vi } from 'vitest';
import type { ToolStepEntry } from '../types';
import { runToolEntry } from './run-tool-entry';
import type { EntryExecuteContext } from './types';

describe('runToolEntry', () => {
  it('forwards the step writer to the tool execution context', async () => {
    const writer = { write: vi.fn(), custom: vi.fn() };
    const execute = vi.fn(async (_input: unknown, context: { writer?: unknown }) => ({
      sawWriter: context.writer === writer,
    }));
    const entry = {
      type: 'tool',
      id: 'tool-step',
      toolId: 'tool-step',
      tool: { id: 'tool-step', execute },
    } as unknown as ToolStepEntry;
    const ctx = {
      inputData: { value: 1 },
      requestContext: { get: vi.fn() },
      writer,
    } as unknown as EntryExecuteContext;

    await expect(runToolEntry(entry, ctx)).resolves.toEqual({ sawWriter: true });
    expect(execute).toHaveBeenCalledWith({ value: 1 }, expect.objectContaining({ writer }));
  });
});
