import { describe, expect, it, vi } from "vitest";
import {
  codexNativeSubagentRunId,
  CodexNativeSubagentTaskMirror,
} from "./native-subagent-task-mirror.js";
import type { CodexServerNotification } from "./protocol.js";

type TaskLifecycleRuntime = ConstructorParameters<typeof CodexNativeSubagentTaskMirror>[1];

function createRuntime() {
  return {
    tryCreateRunningTaskRun: vi.fn((params) => ({ taskId: "task-native-subagent", ...params })),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn(() => []),
  } as unknown as TaskLifecycleRuntime;
}

function createMirror(runtime: TaskLifecycleRuntime) {
  return new CodexNativeSubagentTaskMirror(
    {
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      agentId: "main",
      now: () => 20_000,
    },
    runtime,
  );
}

function threadStarted(childThreadId = "child-thread"): CodexServerNotification {
  return {
    method: "thread/started",
    params: {
      thread: {
        id: childThreadId,
        preview: "inspect the repo",
        createdAt: 10,
        status: { type: "active", activeFlags: [] },
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              depth: 1,
              agent_nickname: "Poincare",
            },
          },
        },
      },
    },
  };
}

function collabState(
  childThreadId: string,
  status: string,
  message: string,
): CodexServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      item: {
        type: "collabAgentToolCall",
        tool: "spawn_agent",
        prompt: "inspect one thing",
        agentsStates: {
          [childThreadId]: { status, message },
        },
      },
    },
  };
}

describe("CodexNativeSubagentTaskMirror Path A", () => {
  it("creates one silent not-applicable telemetry row per native child", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime);

    mirror.handleNotification(threadStarted());
    mirror.handleNotification(threadStarted());

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledTimes(1);
    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith({
      sourceId: "codex-thread:child-thread",
      agentId: "main",
      runId: "codex-thread:child-thread",
      label: "Poincare",
      task: "inspect the repo",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 10_000,
      lastEventAt: 20_000,
      progressSummary: "Codex native subagent started.",
    });
  });

  it("keeps every child-side terminal state as progress while a native envelope is expected", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime);
    mirror.markAuthoritativeCompletionExpected("child-thread");

    mirror.handleNotification(collabState("child-thread", "completed", "done"));
    mirror.handleNotification(collabState("child-thread", "blocked", "waiting"));
    mirror.handleNotification(collabState("child-thread", "failed", "failed locally"));
    mirror.handleNotification({
      method: "thread/status/changed",
      params: { threadId: "child-thread", status: { type: "systemError" } },
    });

    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 20_000,
      progressSummary: "done",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 20_000,
      progressSummary: "waiting",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 20_000,
      progressSummary: "failed locally",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 20_000,
      progressSummary: "Codex native subagent hit a system error; awaiting recovery.",
    });
  });

  it("suppresses delivery on every non-native telemetry fallback finalizer", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime);

    mirror.handleNotification({
      method: "thread/status/changed",
      params: { threadId: "system-child", status: { type: "systemError" } },
    });
    mirror.handleNotification(collabState("completed-child", "completed", "done"));
    mirror.handleNotification(collabState("blocked-child", "blocked", "waiting"));
    mirror.handleNotification(collabState("failed-child", "failed", "failed"));

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(4);
    for (const [params] of vi.mocked(runtime.finalizeTaskRunByRunId).mock.calls) {
      expect(params).toEqual(expect.objectContaining({ suppressDelivery: true }));
    }
  });

  it("stops later lifecycle rewrites after the trusted native path finalizes telemetry", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime);
    mirror.handleNotification(threadStarted());
    mirror.markAuthoritativeCompletionExpected("child-thread");
    mirror.markAuthoritativeCompletion("child-thread");
    vi.mocked(runtime.recordTaskRunProgressByRunId).mockClear();

    mirror.handleNotification(collabState("child-thread", "failed", "late failure"));
    mirror.handleNotification({
      method: "thread/status/changed",
      params: { threadId: "child-thread", status: { type: "systemError" } },
    });

    expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });
});
