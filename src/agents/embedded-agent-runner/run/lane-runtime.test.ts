import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../../sessions/input-provenance.js";
import {
  EMBEDDED_RUN_LANE_HEARTBEAT_MS,
  resolveEmbeddedRunGlobalQueuePriority,
  resolveEmbeddedRunSessionQueuePriority,
  shouldDeferAgentHarnessCompletionForGlobalLane,
  withEmbeddedRunLaneProgressHeartbeat,
} from "./lane-runtime.js";

afterEach(() => {
  vi.useRealTimers();
  resetCommandQueueStateForTest();
});

describe("embedded run lane priority", () => {
  it("runs a foreground user turn before queued restart recovery", async () => {
    const lane = "test:restart-recovery-priority";
    setCommandLaneConcurrency(lane, 1);
    let releaseBlocker: () => void = () => {};
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = enqueueCommandInLane(lane, async () => {
      await blockerGate;
    });
    const order: string[] = [];
    const restartRecovery = enqueueCommandInLane(
      lane,
      async () => {
        order.push("restart-recovery");
      },
      {
        priority: resolveEmbeddedRunSessionQueuePriority("user", {
          kind: "internal_system",
          sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
        }),
      },
    );
    const foreground = enqueueCommandInLane(
      lane,
      async () => {
        order.push("foreground-user");
      },
      { priority: resolveEmbeddedRunSessionQueuePriority("user") },
    );

    releaseBlocker();
    await Promise.all([blocker, foreground, restartRecovery]);

    expect(order).toEqual(["foreground-user", "restart-recovery"]);
  });

  it("orders native harness completions behind foreground session work", () => {
    expect(
      resolveEmbeddedRunSessionQueuePriority("user", {
        kind: "inter_session",
        sourceTool: "agent_harness_task",
      }),
    ).toBe("background");
    expect(
      resolveEmbeddedRunSessionQueuePriority("user", {
        kind: "external_user",
        sourceTool: "agent_harness_task",
      }),
    ).toBe("foreground");
  });

  it("applies background ordering only at session admission", () => {
    expect(resolveEmbeddedRunGlobalQueuePriority("background")).toBe("normal");
    expect(resolveEmbeddedRunGlobalQueuePriority("foreground")).toBe("foreground");
    expect(resolveEmbeddedRunGlobalQueuePriority("normal")).toBe("normal");
  });

  it("defers native harness completions before a busy nested global lane", () => {
    const busySnapshot = {
      lane: "main",
      queuedCount: 0,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    };
    expect(
      shouldDeferAgentHarnessCompletionForGlobalLane(
        { kind: "inter_session", sourceTool: "agent_harness_task" },
        busySnapshot,
      ),
    ).toBe(true);
    expect(
      shouldDeferAgentHarnessCompletionForGlobalLane(
        { kind: "inter_session", sourceTool: "image_generate" },
        busySnapshot,
      ),
    ).toBe(false);
    expect(
      shouldDeferAgentHarnessCompletionForGlobalLane(
        { kind: "inter_session", sourceTool: "agent_harness_task" },
        { ...busySnapshot, activeCount: 0 },
      ),
    ).toBe(false);
  });
});

describe("embedded run lane progress heartbeat", () => {
  it("notes progress immediately and at the heartbeat cadence", async () => {
    vi.useFakeTimers();
    const noteLaneTaskProgress = vi.fn();
    let finish: ((value: string) => void) | undefined;
    const task = withEmbeddedRunLaneProgressHeartbeat(
      noteLaneTaskProgress,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS - 1);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS * 2 + 1);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(4);

    finish?.("done");
    await expect(task).resolves.toBe("done");
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS * 2);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(5);
  });

  it("clears the heartbeat after rejection and propagates the error", async () => {
    vi.useFakeTimers();
    const noteLaneTaskProgress = vi.fn();
    const expectedError = new Error("runtime acquisition failed");
    let fail: ((error: Error) => void) | undefined;
    const task = withEmbeddedRunLaneProgressHeartbeat(
      noteLaneTaskProgress,
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );

    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(2);
    fail?.(expectedError);
    await expect(task).rejects.toBe(expectedError);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS * 2);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(3);
  });

  it("keeps a slow lane task alive while runtime acquisition makes progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const lane = `test:embedded-run-runtime-heartbeat:${Date.now()}`;
    setCommandLaneConcurrency(lane, 1);
    let progressAtMs = Date.now();

    const task = enqueueCommandInLane(
      lane,
      () =>
        withEmbeddedRunLaneProgressHeartbeat(
          () => {
            progressAtMs = Date.now();
          },
          () =>
            new Promise<string>((resolve) => {
              setTimeout(() => resolve("completed"), 52_000);
            }),
        ),
      {
        taskTimeoutMs: 25_000,
        taskTimeoutProgressAtMs: () => progressAtMs,
      },
    );

    await vi.advanceTimersByTimeAsync(52_000);
    await expect(task).resolves.toBe("completed");
  });
});
