import { describe, expect, it } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById } from "../chat-abort.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

describe("chat.send persisted request identity", () => {
  it.each([true, false])(
    "replays unchanged input and rejects edits after SQLite reopens and RAM identity expires (original text retained: %s)",
    async (preserveContent) => {
      const fixture = await createFixture({ preserveContent });
      try {
        const first = await fixture.send();
        expect(first.mock.calls[0]?.[0]).toBe(true);
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(committed?.appended).toBe(true);
        expect(committed?.message.content).toBe(
          preserveContent ? fixture.params.message : fixture.approvedContent,
        );
        expect(
          abortChatRunById(createChatAbortOps(fixture.context), {
            sessionKey: fixture.scope.sessionKey,
            runId: fixture.params.idempotencyKey,
            stopReason: "rpc",
          }),
        ).toEqual({ aborted: true });
        await fixture.finishDispatch();
        fixture.context.dedupe.clear();
        await closeOpenClawAgentDatabaseByPathAsync(
          resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(fixture.scope))),
          fixture.scope.agentId,
        );
        dispatchInboundMessageMock.mockClear();

        const replay = await fixture.send();
        expect(replay).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId: fixture.params.idempotencyKey, status: "aborted" }),
          undefined,
          expect.objectContaining({ cached: true }),
        );
        fixture.context.dedupe.clear();
        fixture.params.message += " Edited input.";
        const conflict = await fixture.send();
        expect(conflict).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: { reason: "chat-request-conflict" },
          }),
        );
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
