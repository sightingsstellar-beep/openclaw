// Live proof for the Codex-native completion boundary against a real app-server:
// the parent mailbox receives the result while OpenClaw records silent telemetry only.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const CodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.Monitor;

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_NATIVE_SUBAGENT === "1";
const describeLive = LIVE ? describe : describe.skip;

type FinalizedTelemetry = {
  runId?: string;
  status?: string;
  terminalSummary?: string;
  suppressDelivery?: boolean;
  detail?: JsonObject;
};

function createTelemetryRecorder(options: { onFinalize?: () => void } = {}) {
  const created: Record<string, unknown>[] = [];
  const finalized: FinalizedTelemetry[] = [];
  const deliveryAttempts: unknown[] = [];
  let listCalls = 0;
  const taskRuntime = {
    tryCreateRunningTaskRun: (params: Record<string, unknown>) => {
      created.push(params);
      return {
        taskId: String(params.sourceId ?? params.runId),
        runtime: "subagent",
        taskKind: "codex-native",
        requesterSessionKey: "live:native-only",
        ownerKey: "live:native-only",
        scopeKind: "session",
        runId: params.runId,
        task: typeof params.task === "string" ? params.task : "Codex native subagent",
        status: "running",
        deliveryStatus: params.deliveryStatus ?? "not_applicable",
        notifyPolicy: params.notifyPolicy ?? "silent",
        createdAt: Number(params.startedAt ?? Date.now()),
      } as AgentHarnessTaskRecord;
    },
    recordTaskRunProgressByRunId: () => [],
    finalizeTaskRunByRunId: (params: FinalizedTelemetry) => {
      finalized.push(params);
      options.onFinalize?.();
      return [];
    },
    // Deliberately outside the monitor contract. These counters prove the
    // monitor neither scans old rows nor calls the retired delivery path.
    listTaskRecords: () => {
      listCalls += 1;
      return [];
    },
    deliverAgentHarnessTaskCompletion: (params: unknown) => {
      deliveryAttempts.push(params);
      return Promise.resolve({ delivered: true, path: "steered" as const });
    },
  };
  return {
    created,
    finalized,
    deliveryAttempts,
    get listCalls() {
      return listCalls;
    },
    runtime: {
      createAgentHarnessTaskRuntime: () => taskRuntime,
      deliverAgentHarnessTaskCompletion: taskRuntime.deliverAgentHarnessTaskCompletion,
    } as never,
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describeLive("codex native subagent monitor live", () => {
  it("observes a late native result without synthesizing a recovery turn", async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for this live test");
    }
    await withTempDir("openclaw-codex-native-subagent-", async (root) => {
      let client: CodexAppServerClient | undefined;
      try {
        const codexHome = path.join(root, "codex-home");
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace, { recursive: true });
        const runtime = resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { homeScope: "user" } },
          env: {},
        });
        client = await createIsolatedCodexAppServerClient({
          startOptions: {
            ...runtime.start,
            env: { CODEX_HOME: codexHome },
            clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          },
          agentDir: path.join(root, "agent"),
          authProfileId: null,
          timeoutMs: 120_000,
        });
        await client.request(
          "account/login/start",
          { type: "apiKey", apiKey },
          { timeoutMs: 60_000 },
        );

        let parentThreadId = "";
        let parentTurnCompletions = 0;
        client.addNotificationHandler((notification) => {
          if (notification.method !== "turn/completed") {
            return;
          }
          const params = isJsonObject(notification.params) ? notification.params : undefined;
          if (params?.threadId === parentThreadId) {
            parentTurnCompletions += 1;
          }
        });

        const started = await client.request(
          "thread/start",
          {
            model: "gpt-5.5",
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            threadSource: "user",
            experimentalRawEvents: true,
            config: { "features.multi_agent": true },
          },
          { timeoutMs: 120_000 },
        );
        parentThreadId = started.thread.id;

        const lifecycleEvents: string[] = [];
        const telemetry = createTelemetryRecorder({
          onFinalize: () => lifecycleEvents.push("finalize"),
        });
        const monitor = new CodexNativeSubagentMonitor(client as never, telemetry.runtime, {
          retainClient: () => () => lifecycleEvents.push("release"),
        });
        const parentRegistration = monitor.registerParent({
          parentThreadId,
          requesterSessionKey: "live:native-only",
          taskRuntimeScope: {
            requesterSessionKey: "live:native-only",
          } as AgentHarnessTaskRuntimeScope,
          agentId: "live",
        });

        await client.request(
          "turn/start",
          {
            threadId: parentThreadId,
            input: [
              {
                type: "text",
                text: "Spawn exactly one subagent with this exact task: 'First run the shell command sleep 20 and wait for it to finish. Then reply with exactly the word BANANA42.' Do not wait for the subagent to finish. Reply DONE immediately after spawning it.",
              },
            ],
          },
          { timeoutMs: 300_000 },
        );

        await waitFor(
          () => (parentTurnCompletions === 1 ? true : undefined),
          300_000,
          "initial parent turn completion",
        );
        parentRegistration.unregister();
        expect(telemetry.deliveryAttempts).toHaveLength(0);

        const finalization = await waitFor(
          () => telemetry.finalized.find((entry) => entry.terminalSummary?.includes("BANANA42")),
          420_000,
          "native-parent telemetry finalization",
        );
        expect(finalization).toMatchObject({
          status: "succeeded",
          suppressDelivery: true,
          detail: { disposition: "native_parent", parentThreadId },
        });
        expect(telemetry.deliveryAttempts).toHaveLength(0);
        expect(parentTurnCompletions).toBe(1);
        expect(lifecycleEvents).toEqual(["finalize", "release"]);

        const childThreadId = finalization.detail?.childThreadId;
        if (typeof childThreadId !== "string") {
          throw new Error("native-parent telemetry did not include a child thread id");
        }
        const read = await client.request(
          "thread/read",
          { threadId: childThreadId, includeTurns: true },
          { timeoutMs: 60_000 },
        );
        expect((read.thread as unknown as JsonObject).parentThreadId).toBe(parentThreadId);
        expect(read.thread.turns?.at(-1)?.status).toBe("completed");

        const freshTelemetry = createTelemetryRecorder();
        const freshMonitor = new CodexNativeSubagentMonitor(
          client as never,
          freshTelemetry.runtime,
        );
        freshMonitor.registerParent({
          parentThreadId,
          requesterSessionKey: "live:fresh-monitor",
          taskRuntimeScope: {
            requesterSessionKey: "live:fresh-monitor",
          } as AgentHarnessTaskRuntimeScope,
          agentId: "live",
        });
        await delay(1_000);
        expect(freshTelemetry.listCalls).toBe(0);
        expect(freshTelemetry.finalized).toHaveLength(0);
        expect(freshTelemetry.deliveryAttempts).toHaveLength(0);
      } finally {
        await client?.closeAndWait();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  }, 900_000);
});
