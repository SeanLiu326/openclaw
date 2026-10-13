/** Real Gateway restart proof: a same-ID retry with edited text must conflict, not execute. */
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { createDeferred } from "./helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const TOKEN = "text-conflict-proof-token";
const RUN_ID = "proof-retry-run-1";
const SESSION_KEY = "agent:main:text-conflict-proof";
const ORIGINAL_MESSAGE = "What is the capital of France?";
const EDITED_MESSAGE = "What is the capital of France? Answer with the country name only.";
const REPLY_MARKER = "TEXT_CONFLICT_PROOF_REPLY";

const epoch = performance.now();
function proof(event: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      proof: "chat-send-retry-text-conflict",
      event,
      utc: new Date().toISOString(),
      ms: Number((performance.now() - epoch).toFixed(1)),
      pid: process.pid,
      ...data,
    }),
  );
}

function anthropicSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function textTurn(text: string): string {
  return anthropicSse([
    {
      type: "message_start",
      message: {
        id: `msg_${MODEL_ID}`,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 64, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("chat.send same-ID retry input comparison across a real gateway restart", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it(
    "rejects an edited retry instead of executing it after the gateway restarts",
    { timeout: 900_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      type ProviderRequest = { model: string; lastUserText: string; allUserText: string };
      const requests: ProviderRequest[] = [];
      let holdNext = false;
      let heldResponse: ServerResponse | undefined;
      const heldRequestSeen = createDeferred();
      const releaseHeld = () => {
        const response = heldResponse;
        heldResponse = undefined;
        if (!response) {
          return;
        }
        try {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
          response.end(textTurn(REPLY_MARKER));
        } catch {
          // The aborted first-turn client no longer owns this socket.
        }
      };
      const sendChat = (message: string) =>
        gateway!.client.request<{ status?: string; runId?: string }>("chat.send", {
          sessionKey: SESSION_KEY,
          message,
          deliver: false,
          idempotencyKey: RUN_ID,
        });
      try {
        const tempHome = tempDirs.make("openclaw-text-conflict-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(stateDir, { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }
        providerServer = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const parsed = JSON.parse(body) as {
              model?: string;
              messages?: Array<{ role?: string; content?: unknown }>;
            };
            // The agent harness appends runtime-context messages after the human
            // turn, so capture every user text instead of only the last one.
            const userTexts = (parsed.messages ?? [])
              .filter((message) => message.role === "user")
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content ?? null),
              );
            requests.push({
              model: parsed.model ?? "",
              lastUserText: userTexts[userTexts.length - 1] ?? "",
              allUserText: userTexts.join("\n---\n"),
            });
            proof("provider_request_observed", {
              index: requests.length,
              model: parsed.model,
              sawOriginal: requests[requests.length - 1]!.allUserText.includes(ORIGINAL_MESSAGE),
              sawEdited: requests[requests.length - 1]!.allUserText.includes(EDITED_MESSAGE),
            });
            if (holdNext) {
              holdNext = false;
              heldResponse = response;
              heldRequestSeen.resolve();
              return;
            }
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            response.end(textTurn(REPLY_MARKER));
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer!.once("error", reject);
          providerServer!.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("loopback provider did not bind");
        }
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: `${PROVIDER_ID}/${MODEL_ID}` },
            },
            entries: { main: {} },
          },
          models: {
            mode: "merge" as const,
            providers: {
              [PROVIDER_ID]: {
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: "fixture-key",
                api: "anthropic-messages",
                models: [
                  {
                    id: MODEL_ID,
                    name: "Mock Claude Opus 5",
                    api: "anthropic-messages",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        const startGateway = () =>
          startGatewayWithClient({
            cfg,
            configPath,
            token: TOKEN,
            clientDisplayName: "text-conflict-proof",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            hotReloadRecovery: () => ({ status: "emitted" as const }),
          });

        // Turn 1: admitted, held in flight at the provider, then a real restart-mode
        // shutdown marks it durably for restart recovery and aborts it.
        gateway = await startGateway();
        holdNext = true;
        const started = await sendChat(ORIGINAL_MESSAGE);
        proof("first_turn_admitted", { runId: started.runId, status: started.status });
        expect(started.status).toBe("started");
        await heldRequestSeen.promise;
        proof("first_turn_in_flight_at_provider", { requests: requests.length });

        // The same restart-mode close a real gateway restart runs: in-flight runs are
        // marked durably for restart recovery before abort.
        await gateway.server.close({ restartExpectedMs: 30_000 });
        releaseHeld();
        await disconnectGatewayClient(gateway.client);
        proof("first_gateway_stopped", { providerRequests: requests.length });
        gateway = undefined;

        // Gateway #2: fresh RAM on the same durable state. Restart recovery settles
        // the aborted first turn so its run id becomes durably terminal.
        gateway = await startGateway();
        let redelivered = false;
        const recoveryDeadline = Date.now() + 45_000;
        while (Date.now() < recoveryDeadline) {
          if (requests.length >= 2) {
            redelivered = true;
            break;
          }
          await sleep(500);
        }
        proof("recovery_redelivery_observed", { redelivered, requests: requests.length });
        // A legitimate same-ID resend of the original text must stay admitted: the
        // durable record replays the turn's acceptance without executing it again.
        try {
          const adopted = await sendChat(ORIGINAL_MESSAGE);
          proof("legitimate_resend_admitted", {
            status: adopted.status,
            runId: adopted.runId,
          });
        } catch (error) {
          proof("legitimate_resend_rejected", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const history = await gateway.client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 20,
        });
        proof("first_turn_settled", {
          providerRequests: requests.length,
          historyHasReply: JSON.stringify(history.messages).includes(REPLY_MARKER),
        });

        // The proof: resend the SAME idempotency key with EDITED text.
        let conflictObserved: { code?: unknown; message?: string; details?: unknown } | undefined;
        let editedExecuted = false;
        try {
          const resend = await sendChat(EDITED_MESSAGE);
          proof("edited_resend_admitted_by_gateway", {
            status: resend.status,
            runId: resend.runId,
          });
          const editedDeadline = Date.now() + 120_000;
          while (Date.now() < editedDeadline) {
            if (requests.some((request) => request.allUserText.includes(EDITED_MESSAGE))) {
              editedExecuted = true;
              break;
            }
            await sleep(500);
          }
        } catch (error) {
          conflictObserved = error as { code?: unknown; message?: string; details?: unknown };
          proof("edited_resend_rejected_by_gateway", {
            code: conflictObserved.code ?? null,
            message: conflictObserved.message ?? null,
            details: JSON.stringify(conflictObserved.details ?? null),
          });
        }
        proof("verdict", {
          editedResendConflicted: conflictObserved !== undefined,
          editedTurnExecutedAtProvider: editedExecuted,
          providerRequests: requests.map((request) => ({
            sawOriginal: request.allUserText.includes(ORIGINAL_MESSAGE),
            sawEdited: request.allUserText.includes(EDITED_MESSAGE),
          })),
        });
        expect(conflictObserved).toBeDefined();
        expect(
          JSON.stringify({
            code: conflictObserved!.code,
            message: conflictObserved!.message,
            details: conflictObserved!.details,
          }),
        ).toContain("chat-request-conflict");
        expect(editedExecuted).toBe(false);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close({ reason: "proof complete" }).catch(() => undefined);
        }
        releaseHeld();
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer!.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
