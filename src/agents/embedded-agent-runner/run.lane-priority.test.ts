import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../process/command-queue.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent lane priority", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("releases the session lane when a native completion finds the global lane busy", async () => {
    let releaseGlobal: () => void = () => {};
    const globalBlocker = enqueueCommandInLane(
      "main",
      () =>
        new Promise<void>((resolve) => {
          releaseGlobal = resolve;
        }),
    );
    await vi.waitFor(() => expect(getCommandLaneSnapshot("main").activeCount).toBe(1));

    try {
      const background = runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "run-background-completion",
        trigger: "user",
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "agent_harness_task",
        },
      });

      await expect(background).rejects.toMatchObject({
        name: "EmbeddedBackgroundLaneAdmissionDeferredError",
      });
      expect(getCommandLaneSnapshot("session:test-key").activeCount).toBe(0);
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();

      mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
      const foreground = runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "run-foreground-user",
        trigger: "user",
      });
      await vi.waitFor(() =>
        expect(getCommandLaneSnapshot("session:test-key").activeCount).toBe(1),
      );

      releaseGlobal();
      await globalBlocker;
      await foreground;

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    } finally {
      releaseGlobal();
      await globalBlocker;
    }
  });

  it("defers a native completion before invoking an injected global enqueuer", async () => {
    let releaseGlobal: () => void = () => {};
    const globalBlocker = enqueueCommandInLane(
      "main",
      () =>
        new Promise<void>((resolve) => {
          releaseGlobal = resolve;
        }),
    );
    await vi.waitFor(() => expect(getCommandLaneSnapshot("main").activeCount).toBe(1));
    const enqueue = vi.fn(async <T>(task: () => Promise<T> | T) => await task());

    try {
      await expect(
        runEmbeddedAgent({
          ...overflowBaseRunParams,
          runId: "run-injected-background-completion",
          trigger: "user",
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "agent_harness_task",
          },
          enqueue,
        }),
      ).rejects.toMatchObject({
        name: "EmbeddedBackgroundLaneAdmissionDeferredError",
      });

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    } finally {
      releaseGlobal();
      await globalBlocker;
    }
  });
});
