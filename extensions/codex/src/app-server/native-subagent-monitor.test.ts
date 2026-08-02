import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, vi } from "vitest";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";

const CodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.Monitor;
type MonitorInstance = InstanceType<typeof CodexNativeSubagentMonitor>;

function createClient() {
  type NotificationHandler = (notification: CodexServerNotification) => Promise<void> | void;
  const notificationHandlers = new Set<NotificationHandler>();
  const closeHandlers = new Set<() => void>();
  const threadReads = new Map<string, unknown>();
  const threadTurns = new Map<string, unknown>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    const threadId = (params as { threadId?: string } | undefined)?.threadId ?? "";
    if (method === "thread/read") {
      const response = threadReads.get(threadId);
      if (response instanceof Error) {
        throw response;
      }
      if (response === undefined) {
        throw new Error(`thread not loaded: ${threadId}`);
      }
      return response;
    }
    if (method === "thread/turns/list") {
      const response = threadTurns.get(threadId);
      if (response instanceof Error) {
        throw response;
      }
      if (response === undefined) {
        throw new Error(`thread turns not loaded: ${threadId}`);
      }
      return response;
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return {
    request,
    setThreadRead(threadId: string, response: unknown) {
      threadReads.set(threadId, response);
    },
    setThreadTurns(threadId: string, response: unknown) {
      threadTurns.set(threadId, response);
    },
    addNotificationHandler(handler: NotificationHandler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    addCloseHandler(handler: () => void) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    async notify(notification: CodexServerNotification) {
      for (const handler of notificationHandlers) {
        await handler(notification);
      }
    },
    close() {
      for (const handler of closeHandlers) {
        handler();
      }
    },
  };
}

function createRuntime(initialRows: AgentHarnessTaskRecord[] = []) {
  const rows = [...initialRows];
  const taskRuntime = {
    tryCreateRunningTaskRun: vi.fn((params: Record<string, unknown>) => ({
      taskId: String(params.sourceId ?? params.runId),
      runtime: "subagent",
      taskKind: "codex-native",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      status: "running",
      deliveryStatus: params.deliveryStatus ?? "not_applicable",
      notifyPolicy: params.notifyPolicy ?? "silent",
      createdAt: Number(params.startedAt ?? 1),
      ...params,
    })),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn((_params: Record<string, unknown>) => []),
    listTaskRecords: vi.fn(() => rows),
    setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
  };
  return {
    taskRuntime,
    createAgentHarnessTaskRuntime: vi.fn(() => taskRuntime),
    // Deliberately outside the monitor runtime contract. Keeping this spy proves
    // no legacy completion handoff survives through structural typing.
    deliverAgentHarnessTaskCompletion: vi.fn(),
  };
}

function createMonitor(
  client: ReturnType<typeof createClient>,
  runtime: ReturnType<typeof createRuntime>,
) {
  return new CodexNativeSubagentMonitor(client as never, runtime as never, {
    recoveryPollDelaysMs: [],
    now: () => 50_000,
  });
}

function registerParent(monitor: MonitorInstance) {
  return monitor.registerParent({
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:main",
    taskRuntimeScope: {
      requesterSessionKey: "agent:main:main",
    } as AgentHarnessTaskRuntimeScope,
    agentId: "main",
  });
}

async function notifyChildStarted(
  client: ReturnType<typeof createClient>,
  childThreadId = "child-thread",
  agentPath = childThreadId,
) {
  await client.notify({
    method: "thread/started",
    params: {
      thread: {
        id: childThreadId,
        parentThreadId: "parent-thread",
        preview: "inspect the repo",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              depth: 1,
              agent_path: agentPath,
            },
          },
        },
      },
    },
  });
}

function childTurnCompleted(
  childThreadId = "child-thread",
  options: { result?: string; status?: "completed" | "failed" | "interrupted" } = {},
): CodexServerNotification {
  const status = options.status ?? "completed";
  const result = options.result;
  return {
    method: "turn/completed",
    params: {
      threadId: childThreadId,
      turn: {
        id: `${childThreadId}-turn`,
        status,
        items: result
          ? [
              {
                id: `${childThreadId}-message`,
                type: "agentMessage",
                phase: "final_answer",
                text: result,
              },
            ]
          : [],
        error: status === "failed" ? { message: result ?? "child failed" } : null,
      },
    },
  };
}

function nativeCompletion(
  childThreadId = "child-thread",
  result = "child final result",
): CodexServerNotification {
  const content =
    `<subagent_notification>{"agent_path":${JSON.stringify(childThreadId)},` +
    `"status":{"completed":${JSON.stringify(result)}}}</subagent_notification>`;
  return {
    method: "rawResponseItem/completed",
    params: {
      threadId: "parent-thread",
      item: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              author: childThreadId,
              recipient: "/root",
              other_recipients: [],
              content,
              trigger_turn: false,
            }),
          },
        ],
      },
    },
  };
}

function parentWaitCompletion(
  agentsStates: Record<string, { status: string; message?: string | null }>,
  options: { senderThreadId?: string; status?: string; tool?: string } = {},
): CodexServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      item: {
        type: "collabAgentToolCall",
        tool: options.tool ?? "wait",
        status: options.status ?? "completed",
        ...(options.senderThreadId === undefined ? {} : { senderThreadId: options.senderThreadId }),
        agentsStates,
      },
    },
  };
}

function expectMonitorSilent(runtime: ReturnType<typeof createRuntime>) {
  expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
  expect(runtime.taskRuntime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalled();
}

describe("Codex native subagent monitor Path A", () => {
  it("creates silent not-applicable telemetry and lets only the trusted parent envelope finalize it", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = createMonitor(client, runtime);
    const registration = registerParent(monitor);
    await notifyChildStarted(client);
    expect(registration.hasPendingChildren()).toBe(true);

    expect(runtime.taskRuntime.tryCreateRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      }),
    );

    await client.notify(childTurnCompleted("child-thread", { result: "child final result" }));
    expect(runtime.taskRuntime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expectMonitorSilent(runtime);

    await client.notify(nativeCompletion());
    expect(runtime.taskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.taskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      status: "succeeded",
      endedAt: 50_000,
      lastEventAt: 50_000,
      progressSummary: "child final result",
      terminalSummary: "child final result",
      detail: {
        kind: "codex-native-subagent-completion",
        version: 1,
        parentThreadId: "parent-thread",
        childThreadId: "child-thread",
        disposition: "native_parent",
        statusLabel: "completed",
      },
      suppressDelivery: true,
    });
    expect(registration.hasPendingChildren()).toBe(false);
    expectMonitorSilent(runtime);
  });

  it("treats a completed parent wait item as the consumed-result boundary", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = createMonitor(client, runtime);
    const registration = registerParent(monitor);
    await notifyChildStarted(client, "child-a");
    await notifyChildStarted(client, "child-b");

    await client.notify(
      parentWaitCompletion({
        "child-a": { status: "completed", message: "A" },
        "child-b": { status: "errored", message: "B failed" },
      }),
    );

    expect(runtime.taskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
    expect(runtime.taskRuntime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runId: "codex-thread:child-a",
        status: "succeeded",
        terminalSummary: "A",
        suppressDelivery: true,
      }),
    );
    expect(runtime.taskRuntime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: "codex-thread:child-b",
        status: "failed",
        error: "B failed",
        terminalSummary: "B failed",
        suppressDelivery: true,
      }),
    );
    expect(registration.hasPendingChildren()).toBe(false);
    expectMonitorSilent(runtime);
  });

  it("rejects non-wait, nonterminal, wrong-parent, and unknown-child wait states", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = createMonitor(client, runtime);
    registerParent(monitor);
    await notifyChildStarted(client, "known-child");

    await client.notify(
      parentWaitCompletion(
        { "known-child": { status: "completed", message: "spoof" } },
        { tool: "spawnAgent" },
      ),
    );
    await client.notify(
      parentWaitCompletion(
        { "known-child": { status: "completed", message: "spoof" } },
        { status: "inProgress" },
      ),
    );
    await client.notify(
      parentWaitCompletion(
        { "known-child": { status: "completed", message: "spoof" } },
        { senderThreadId: "other-parent" },
      ),
    );
    await client.notify(
      parentWaitCompletion({ "unknown-child": { status: "completed", message: "spoof" } }),
    );
    await client.notify(
      parentWaitCompletion({ "known-child": { status: "running", message: "still running" } }),
    );

    expect(
      vi
        .mocked(runtime.taskRuntime.finalizeTaskRunByRunId)
        .mock.calls.filter(
          ([params]) =>
            isJsonObject(params.detail) && params.detail.disposition === "native_parent",
        ),
    ).toHaveLength(0);
    expectMonitorSilent(runtime);
  });

  it("keeps turn, no-final, system-error, and history terminal signals telemetry-only", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = createMonitor(client, runtime);
    registerParent(monitor);

    await notifyChildStarted(client, "turn-child");
    await client.notify(childTurnCompleted("turn-child", { result: "observed result" }));

    await notifyChildStarted(client, "no-final-child");
    await client.notify(childTurnCompleted("no-final-child"));

    await notifyChildStarted(client, "system-child");
    client.setThreadRead("system-child", {
      thread: {
        id: "system-child",
        parentThreadId: "parent-thread",
        status: { type: "systemError" },
      },
    });
    client.setThreadTurns("system-child", { data: [] });
    await client.notify({
      method: "thread/status/changed",
      params: { threadId: "system-child", status: { type: "systemError" } },
    });

    await notifyChildStarted(client, "history-child");
    client.setThreadRead("history-child", {
      thread: {
        id: "history-child",
        parentThreadId: "parent-thread",
        status: { type: "idle" },
        turns: [
          {
            id: "history-turn",
            status: "completed",
            completedAt: 40,
            items: [
              {
                id: "history-message",
                type: "agentMessage",
                phase: "final_answer",
                text: "history result",
              },
            ],
          },
        ],
      },
    });
    await monitor.reconcileChildThread("history-child");

    expect(runtime.taskRuntime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expectMonitorSilent(runtime);
  });

  it("does not bootstrap delivery from stale restart rows or mutate their delivery status", () => {
    const stalePending = {
      taskId: "stale-task",
      runtime: "subagent",
      taskKind: "codex-native",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "codex-thread:stale-child",
      label: "Codex subagent",
      task: "stale task",
      status: "succeeded",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      createdAt: 1,
    } as AgentHarnessTaskRecord;
    const client = createClient();
    const runtime = createRuntime([stalePending]);
    const monitor = createMonitor(client, runtime);

    registerParent(monitor);

    expect(runtime.taskRuntime.listTaskRecords).not.toHaveBeenCalled();
    expect(runtime.taskRuntime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expectMonitorSilent(runtime);
  });

  it("keeps two siblings and same-child follow-up signals monitor-silent", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const releaseRetention = vi.fn();
    const retainClient = vi.fn(() => releaseRetention);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime as never, {
      recoveryPollDelaysMs: [],
      now: () => 50_000,
      retainClient,
    });
    const registration = registerParent(monitor);

    await notifyChildStarted(client, "child-a");
    await notifyChildStarted(client, "child-b");
    expect(retainClient).toHaveBeenCalledTimes(1);
    await client.notify(childTurnCompleted("child-a", { result: "A" }));
    await client.notify(childTurnCompleted("child-b", { result: "B" }));
    await client.notify(nativeCompletion("child-a", "A"));
    expect(registration.hasPendingChildren()).toBe(true);
    expect(releaseRetention).not.toHaveBeenCalled();
    await client.notify(nativeCompletion("child-b", "B"));
    expect(registration.hasPendingChildren()).toBe(false);
    expect(releaseRetention).toHaveBeenCalledTimes(1);

    expect(runtime.taskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
    for (const [params] of runtime.taskRuntime.finalizeTaskRunByRunId.mock.calls) {
      expect(params).toMatchObject({
        suppressDelivery: true,
        detail: { disposition: "native_parent" },
      });
    }

    await client.notify(childTurnCompleted("child-a", { result: "follow-up" }));
    await client.notify(nativeCompletion("child-a", "follow-up"));
    expect(runtime.taskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
    expectMonitorSilent(runtime);
  });

  it("fails closed after unregister and client close", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = createMonitor(client, runtime);
    const registration = registerParent(monitor);
    await notifyChildStarted(client);

    registration.unregister();
    client.close();
    await client.notify(childTurnCompleted("child-thread", { result: "late" }));
    await client.notify(nativeCompletion("child-thread", "late"));

    expect(runtime.taskRuntime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expectMonitorSilent(runtime);
  });

  it("bounds client retention when the trusted native envelope never arrives", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const releaseRetention = vi.fn();
      const retainClient = vi.fn(() => releaseRetention);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime as never, {
        recoveryPollDelaysMs: [],
        nativeEnvelopeWaitMs: 25,
        retainClient,
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      await client.notify(childTurnCompleted("child-thread", { result: "observed result" }));
      expect(retainClient).toHaveBeenCalledTimes(1);
      expect(releaseRetention).not.toHaveBeenCalled();
      expectMonitorSilent(runtime);

      await vi.advanceTimersByTimeAsync(25);
      expect(releaseRetention).toHaveBeenCalledTimes(1);

      await client.notify(nativeCompletion("child-thread", "late result"));
      expect(runtime.taskRuntime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
      expectMonitorSilent(runtime);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the same bounded native-envelope grace to recovered history", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const releaseRetention = vi.fn();
      const retainClient = vi.fn(() => releaseRetention);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime as never, {
        recoveryPollDelaysMs: [],
        nativeEnvelopeWaitMs: 25,
        retainClient,
      });
      registerParent(monitor);
      client.setThreadRead("history-child", {
        thread: {
          id: "history-child",
          parentThreadId: "parent-thread",
          status: { type: "idle" },
          turns: [
            {
              id: "history-turn",
              status: "completed",
              completedAt: 40,
              items: [
                {
                  id: "history-message",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "recovered result",
                },
              ],
            },
          ],
        },
      });
      await notifyChildStarted(client, "history-child");

      await expect(monitor.reconcileChildThread("history-child")).resolves.toBe(true);
      expect(runtime.taskRuntime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
      expect(releaseRetention).not.toHaveBeenCalled();
      expectMonitorSilent(runtime);

      await vi.advanceTimersByTimeAsync(25);
      expect(releaseRetention).toHaveBeenCalledTimes(1);
      expect(runtime.taskRuntime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
      expectMonitorSilent(runtime);
    } finally {
      vi.useRealTimers();
    }
  });
});
