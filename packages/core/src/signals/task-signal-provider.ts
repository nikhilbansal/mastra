import type { AgentRunLifecycleEvent } from '../agent/agent.types';
import type { AgentSignal } from '../agent/types';
import type { InputProcessorOrWorkflow } from '../processors';
import { TaskStateProcessor } from '../tools/builtin/task-state-processor';
import {
  clearTaskListForRunSettlement,
  TASKS_STATE_ID,
  taskCheckTool,
  taskCompleteTool,
  taskUpdateTool,
  taskWriteTool,
} from '../tools/builtin/task-tools';

import { SignalProvider } from './signal-provider';

/**
 * Bundles the built-in task tools and the {@link TaskStateProcessor} behind a
 * single agent registration.
 *
 * The task list is held in the thread-scoped `tasks` storage domain (the
 * TaskStore) and projected onto the agent state-signal lane by
 * `TaskStateProcessor`. Wiring task tracking by hand means registering all four
 * task tools **and** the processor, and keeping them in sync — forget the
 * processor and the tools work for a single turn but silently lose the list
 * across turns. This provider wires both together so that cannot happen.
 *
 * Task tracking requires a memory-backed thread (`threadId` + `resourceId`) and
 * a Mastra `storage` instance (the `tasks` domain is always wired in-memory by
 * default). Without memory the tools no-op and report that task tracking
 * requires agent memory.
 *
 * @example
 * ```ts
 * import { Agent } from '@mastra/core/agent';
 * import { TaskSignalProvider } from '@mastra/core/signals';
 *
 * const agent = new Agent({
 *   name: 'coder',
 *   instructions: '...',
 *   model,
 *   memory,
 *   signals: [new TaskSignalProvider()],
 * });
 * ```
 *
 * The Agent automatically merges the tools into its toolset and registers the
 * processor on its input-processor chain (which propagates the Mastra instance
 * so the processor can resolve the TaskStore).
 *
 * A successful, failed, or canceled run clears its task working state and
 * persists one empty state snapshot. Suspended runs retain their exact state
 * until a resumed leg reaches a real terminal outcome.
 *
 * @experimental Agent signals are experimental and may change in a future release.
 */
export class TaskSignalProvider extends SignalProvider<'task-signals'> {
  readonly id = 'task-signals';

  static readonly #SETTLEMENT_SIGNAL_ID_KEY = 'mastra:tasks:settlement-signal-id';
  static readonly #SETTLED_KEY = 'mastra:tasks:settled';

  readonly #processor = new TaskStateProcessor();

  getInputProcessors(): InputProcessorOrWorkflow[] {
    return [this.#processor];
  }

  getTools() {
    return {
      task_write: taskWriteTool,
      task_update: taskUpdateTool,
      task_complete: taskCompleteTool,
      task_check: taskCheckTool,
    };
  }

  async onRunLifecycle(event: AgentRunLifecycleEvent): Promise<void> {
    if (
      event.phase !== 'finish' ||
      event.outcome === 'suspended' ||
      !event.threadId ||
      !event.resourceId ||
      !this.mastra ||
      !this.agent ||
      event.requestContext.get(TaskSignalProvider.#SETTLED_KEY) === true
    ) {
      return;
    }

    const cleared = await clearTaskListForRunSettlement({
      agent: { threadId: event.threadId, resourceId: event.resourceId },
      mastra: this.mastra,
      requestContext: event.requestContext,
    });
    if (!cleared) {
      event.requestContext.set(TaskSignalProvider.#SETTLED_KEY, true);
      return;
    }

    const carriedSignalId = event.requestContext.get(TaskSignalProvider.#SETTLEMENT_SIGNAL_ID_KEY);
    const signalId = typeof carriedSignalId === 'string' && carriedSignalId ? carriedSignalId : crypto.randomUUID();
    event.requestContext.set(TaskSignalProvider.#SETTLEMENT_SIGNAL_ID_KEY, signalId);

    // This is deliberately sent as a persisted state signal rather than via
    // sendStateSignal(): the latter may dedupe against thread metadata that
    // still says "empty" even when the model wrote tasks after the last input
    // step. A unique terminal signal must always follow the task tool result.
    const emptyTaskSignal: AgentSignal = {
      id: signalId,
      type: 'state',
      tagName: 'current-task-list',
      contents: '',
      attributes: { count: 0 },
      metadata: {
        state: {
          id: TASKS_STATE_ID,
          threadId: event.threadId,
          cacheKey: 'tasks:',
          mode: 'snapshot',
        },
        value: { tasks: [] },
      },
    };
    const delivery = this.agent.sendSignal(emptyTaskSignal, {
      resourceId: event.resourceId,
      threadId: event.threadId,
      ifActive: { behavior: 'persist' },
      ifIdle: {
        behavior: 'persist',
        streamOptions: { requestContext: event.requestContext },
      },
    });
    const accepted = await delivery.accepted;
    if (accepted.action !== 'persist') {
      throw new Error(`Task settlement signal was not persisted (received ${accepted.action}).`);
    }
    await delivery.persisted;
    event.requestContext.set(TaskSignalProvider.#SETTLED_KEY, true);
  }
}
