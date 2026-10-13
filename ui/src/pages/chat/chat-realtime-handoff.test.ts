// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  stopChatRealtimeTalk,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import { useRealtimeTalkMicrophoneFixture } from "./talk/input.test-support.ts";
import type { RealtimeTalkTransportContext } from "./talk/shared.ts";

const transports = vi.hoisted(() => ({
  contexts: [] as RealtimeTalkTransportContext[],
  stop: vi.fn(),
}));

vi.mock("./talk/transport.runtime.ts", () => ({
  createRealtimeTalkTransport: vi.fn((_session: unknown, context: RealtimeTalkTransportContext) => {
    transports.contexts.push(context);
    return { start: async () => "ready", stop: transports.stop };
  }),
}));

useRealtimeTalkMicrophoneFixture();

function fixture() {
  const transcript = createDeferred();
  const close = createDeferred();
  const closeStarted = createDeferred();
  const replacementStarted = createDeferred();
  const transportStopped = createDeferred();
  transports.stop.mockImplementation(() => transportStopped.resolve());
  const saved: string[] = [];
  const snapshots: string[][] = [];
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const request = vi.fn(async (method: string, params?: { text?: string }) => {
    if (method === "talk.catalog") {
      return { realtime: { activeProvider: "openai", providers: [{ id: "openai" }] } };
    }
    if (method === "talk.client.create") {
      snapshots.push([...saved]);
      if (snapshots.length === 2) {
        replacementStarted.resolve();
      }
      return {
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: `voice-${snapshots.length}`,
        clientSecret: "synthetic-session",
      };
    }
    if (method === "talk.client.transcript") {
      await transcript.promise;
      saved.push(String(params?.text));
    }
    if (method === "talk.client.close") {
      closeStarted.resolve();
      await close.promise;
      saved.push("Provider final speech");
    }
    return { ok: true };
  });
  const client = {
    request,
    addEventListener: (listener: (event: GatewayEventFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as GatewayBrowserClient;
  const state = {
    client,
    connected: true,
    sessionKey: "main",
    settings: loadSettings(),
    ...createInitialChatRealtimeState(),
    requestUpdate: vi.fn(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(state);
  return {
    state,
    transcript,
    close,
    closeStarted,
    replacementStarted,
    transportStopped,
    request,
    snapshots,
    changeVoice: () => {
      for (const listener of listeners) {
        listener({
          type: "event",
          event: "talk.voice.change",
          payload: {
            sessionKey: "main",
            voiceSessionId: "voice-1",
            voice: "alloy",
            changeId: "change-1",
            phase: "requested",
          },
        });
      }
    },
  };
}

describe("browser voice handoff history", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    transports.contexts.length = 0;
    transports.stop.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["none", "transcript", "provider-close"])(
    "drains finalized speech before replacement and honors Stop during %s",
    async (stopDuring) => {
      const f = fixture();
      let original = f.state.realtimeTalkSession;
      try {
        await f.state.toggleRealtimeTalk();
        original = expectDefined(f.state.realtimeTalkSession, "initial realtime session");
        expectDefined(
          transports.contexts[0],
          "initial realtime transport",
        ).callbacks.onTranscript?.({
          role: "user",
          text: "Remember the blue bicycle.",
          final: true,
        });
        f.changeVoice();
        await f.transportStopped.promise;
        expect(transports.stop).toHaveBeenCalledOnce();
        expect(f.snapshots).toEqual([[]]);
        expect(f.state.realtimeTalkSession).toBeNull();

        if (stopDuring === "transcript") {
          await f.state.toggleRealtimeTalk();
          expect(f.state.realtimeTalkActive).toBe(false);
        }
        f.transcript.resolve();
        await f.closeStarted.promise;
        expect(f.snapshots).toHaveLength(1);
        if (stopDuring === "provider-close") {
          await f.state.toggleRealtimeTalk();
          expect(f.state.realtimeTalkActive).toBe(false);
        }
        f.close.resolve();
        await original.stop();
        if (stopDuring === "none") {
          await f.replacementStarted.promise;
        }
        expect(f.snapshots).toEqual(
          stopDuring === "none"
            ? [[], ["Remember the blue bicycle.", "Provider final speech"]]
            : [[]],
        );
        expect(
          f.request.mock.calls.some(
            ([method]) => method === "chat.abort" || method === "agent.wait",
          ),
        ).toBe(false);
      } finally {
        f.transcript.resolve();
        f.close.resolve();
        const active = f.state.realtimeTalkSession;
        stopChatRealtimeTalk(f.state);
        await original?.stop();
        await active?.stop();
      }
    },
  );
});
