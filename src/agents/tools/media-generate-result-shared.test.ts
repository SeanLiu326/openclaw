import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { STAGED_INPUT_GITIGNORE } from "../../media/staged-inputs.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import * as announceDelivery from "../subagents/announce/subagent-announce-delivery.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";
import { resolveMediaGenerateToolContext } from "./media-generate-background.js";
import { buildMediaGenerateToolExecutionResult } from "./media-generate-result-shared.js";
import { loadMediaToolReferences } from "./media-tool-shared.js";

const { resolveSandboxContext } = vi.hoisted(() => ({
  resolveSandboxContext: vi.fn<typeof import("../sandbox/context.js").resolveSandboxContext>(),
}));
// mock-isolation: Provisioning stays synthetic so this test never opens real sandbox state.
vi.mock("../sandbox/context.js", () => ({ resolveSandboxContext }));

afterEach(() => {
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);

async function fixture() {
  const root = tempDirs.make("generated-media-result-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const mediaPath = path.join(root, "image.png");
  await fs.writeFile(mediaPath, png);
  const sandbox = { root: workspace, bridge: createHostSandboxFsBridge(workspace) };
  const acquireSandbox = async () => ({ ...sandbox, [Symbol.dispose]() {} });
  const params = {
    kind: "image" as const,
    result: { provider: "test", model: "test", attempts: [] },
    attachments: [{ type: "image" as const, path: mediaPath }],
    mediaUrls: [mediaPath],
    maxBytes: 1024,
    details: {},
  };
  return { root, workspace, mediaPath, sandbox, acquireSandbox, params };
}

describe("generated media sandbox access", () => {
  it("stages only the current outputs for follow-up references and retains delivery paths", async () => {
    const { root, workspace, mediaPath, sandbox, acquireSandbox, params } = await fixture();
    await fs.writeFile(path.join(root, "other-session.png"), png);
    const result = await buildMediaGenerateToolExecutionResult({
      ...params,
      sandbox: acquireSandbox,
    });
    const [relativePath] = result.details.sandboxPaths as string[];
    if (!relativePath) {
      throw new Error("Expected a sandbox path for the generated image");
    }

    expect(relativePath).toMatch(/^media\/inbound\/openclaw-staged-[^/]+\/image\.png$/);
    await expect(fs.readFile(path.join(workspace, relativePath))).resolves.toEqual(png);
    await expect(fs.readdir(path.dirname(path.join(workspace, relativePath)))).resolves.toEqual([
      ".gitignore",
      "image.png",
    ]);
    await expect(
      fs.readFile(path.join(workspace, path.dirname(relativePath), ".gitignore"), "utf8"),
    ).resolves.toBe(STAGED_INPUT_GITIGNORE);
    expect(result.attachments).toEqual(params.attachments);
    expect(result.details.paths).toEqual([mediaPath]);
    expect(result.contentText).toContain(`Sandbox file: "${relativePath}"`);
    expect(result.wakeResult).toBe(result.contentText);

    const references = await loadMediaToolReferences({
      inputs: [relativePath],
      toolName: "image_generate",
      expectedKind: "image",
      sandbox: { ...sandbox, workspaceOnly: true },
      maxBytes: 1024,
      mapMedia: (media) => media.buffer,
    });
    expect(references[0]?.source).toEqual(png);
  });

  it("leaves non-sandboxed results and remote-only video outputs unchanged", async () => {
    const { workspace, acquireSandbox, params } = await fixture();
    const result = await buildMediaGenerateToolExecutionResult(params);
    expect(result.details.sandboxPaths).toBeUndefined();
    expect(result.contentText).not.toContain("Sandbox");

    const url = "https://example.com/generated.mp4";
    const remote = await buildMediaGenerateToolExecutionResult({
      ...params,
      kind: "video",
      sandbox: acquireSandbox,
      attachments: [{ type: "video", url }],
      mediaUrls: [url],
    });
    expect(remote.details.paths).toEqual([url]);
    expect(remote.contentText).not.toContain("Sandbox");
    await expect(fs.readdir(workspace)).resolves.toEqual([]);
  });

  it.each(["size limit", "read-only workspace"])(
    "keeps delivery and reports unavailable copies on %s",
    async (failure) => {
      const { workspace, sandbox, acquireSandbox, params } = await fixture();
      if (failure === "read-only workspace") {
        vi.spyOn(sandbox.bridge, "createFileExclusive").mockRejectedValue(
          new Error("Sandbox path is read-only"),
        );
      }
      const result = await buildMediaGenerateToolExecutionResult({
        ...params,
        sandbox: acquireSandbox,
        maxBytes: failure === "size limit" ? 1 : params.maxBytes,
      });
      expect(result.attachments).toEqual(params.attachments);
      expect(result.details.paths).toEqual(params.mediaUrls);
      expect(result.details.sandboxPaths).toBeUndefined();
      expect(result.wakeResult).toContain("Sandbox copy unavailable:");
      await expect(fs.readdir(workspace)).resolves.toEqual([]);
    },
  );

  it.each([
    "current",
    "reset-during-generation",
    "recreate-during-generation",
    "reset-during-acquisition",
    "reset-after-gitignore",
    "reset-after-first-output",
  ] as const)("binds detached staging to the admitted session: %s", async (transition) => {
    await withOpenClawTestState({ prefix: "media-staging-lifecycle-" }, async (state) => {
      const { workspace, sandbox, acquireSandbox, params } = await fixture();
      const sessionKey = "agent:main:media-staging";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const scope = { agentId: "main", sessionKey, storePath };
      const entry = { sessionId: "original", lifecycleRevision: "original", updatedAt: 1 };
      const config = {
        agents: { ownership: "explicit" as const, entries: { main: { workspace } } },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      await replaceSessionEntry(scope, entry);
      const lifecycle = createMediaGenerationTaskLifecycle("image");
      const handle = await lifecycle.createTaskRun({
        sessionKey,
        requesterAgentId: "main",
        prompt: "synthetic images",
      });
      if (!handle?.detach) {
        throw new Error("Expected an admitted detached generation");
      }
      const invalidate = async () => {
        if (transition === "recreate-during-generation") {
          await deleteSessionEntryLifecycle({
            storePath,
            agentId: "main",
            archiveTranscript: false,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
          await replaceSessionEntry(scope, {
            sessionId: "successor",
            lifecycleRevision: "successor",
            updatedAt: 2,
          });
        } else {
          await resetSessionEntryLifecycle({
            storePath,
            agentId: "main",
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            resetBoundary: { context: "clear", reason: "reset", cwd: workspace },
            buildNextEntry: () => ({ ...entry, lifecycleRevision: "successor", updatedAt: 2 }),
          });
        }
      };
      const secondPath = path.join(path.dirname(params.mediaUrls[0]!), "second.png");
      await fs.writeFile(secondPath, png);
      const attachments = [...params.attachments, { type: "image" as const, path: secondPath }];
      const createFile = sandbox.bridge.createFileExclusive!.bind(sandbox.bridge);
      const written = vi
        .spyOn(sandbox.bridge, "createFileExclusive")
        .mockImplementation(async (request) => {
          const result = await createFile(request);
          if (
            (transition === "reset-after-gitignore" && request.filePath.endsWith(".gitignore")) ||
            (transition === "reset-after-first-output" && request.filePath.endsWith("/image.png"))
          ) {
            await invalidate();
          }
          return result;
        });
      const acquire = vi.fn(async () => {
        if (transition === "reset-during-acquisition") {
          await invalidate();
        }
        return acquireSandbox();
      });
      const deliver = vi.spyOn(announceDelivery, "deliverSubagentAnnouncement").mockResolvedValue({
        delivered: true,
        path: "direct",
      });
      const scheduled: Array<() => Promise<void>> = [];
      const results: Array<Awaited<ReturnType<typeof buildMediaGenerateToolExecutionResult>>> = [];
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating synthetic images",
        toolName: "image_generate",
        onWakeFailure: vi.fn(),
        run: async () => {
          if (transition.endsWith("during-generation")) {
            await invalidate();
          }
          const result = await buildMediaGenerateToolExecutionResult({
            ...params,
            attachments,
            mediaUrls: attachments.map((attachment) => attachment.path),
            sandbox: acquire,
            taskHandle: handle,
          });
          results.push(result);
          return result;
        },
      });
      expect(scheduled).toHaveLength(1);
      await scheduled[0]!();
      const result = results[0];
      if (!result) {
        throw new Error("Expected generated media to survive staging refusal");
      }
      expect(result.attachments).toEqual(attachments);
      for (const attachment of attachments) {
        await expect(fs.readFile(attachment.path)).resolves.toEqual(png);
      }
      if (transition === "current") {
        expect(deliver).toHaveBeenCalledOnce();
        expect(written).toHaveBeenCalledTimes(3);
        const paths = result.details.sandboxPaths as string[];
        expect(paths).toHaveLength(2);
        for (const relativePath of paths) {
          await expect(fs.readFile(path.join(workspace, relativePath))).resolves.toEqual(png);
        }
      } else {
        expect(deliver).not.toHaveBeenCalled();
        expect(result.wakeResult).toContain(
          "Sandbox copy unavailable: Error: The requesting session is no longer current",
        );
        const writesBeforeReset =
          transition === "reset-after-first-output"
            ? 2
            : transition === "reset-after-gitignore"
              ? 1
              : 0;
        expect(written).toHaveBeenCalledTimes(writesBeforeReset);
        if (transition === "reset-after-first-output") {
          expect(result.details.sandboxPaths).toHaveLength(1);
        } else {
          expect(result.details.sandboxPaths).toBeUndefined();
        }
        if (transition.endsWith("during-generation")) {
          expect(acquire).not.toHaveBeenCalled();
        }
        if (writesBeforeReset === 0) {
          await expect(fs.readdir(workspace)).resolves.toEqual([]);
        }
      }
    });
  });

  it.each([
    { requesterAgentId: "main", projectionClosed: true },
    { requesterAgentId: "work", projectionClosed: false },
    { requesterAgentId: "work", projectionClosed: true },
  ])(
    "reacquires the admitted policy owner for $requesterAgentId (projection closed: $projectionClosed) and rejects rerouting",
    async ({ requesterAgentId, projectionClosed }) => {
      const { workspace, sandbox, params } = await fixture();
      const originalWrite = vi.spyOn(sandbox.bridge, "createFileExclusive");
      if (projectionClosed) {
        originalWrite.mockRejectedValue(new Error("Originating projection has closed"));
      }
      const dispose = vi.fn();
      const skillsSnapshot = {
        prompt: "",
        skills: [],
        librarySelections: [
          {
            skillId: "00000000-0000-4000-8000-000000000001",
            revision: "a".repeat(64),
            name: "skill",
            ownerProfileId: "owner",
          },
        ],
      };
      const config = { agents: { entries: { main: {}, work: {} } } };
      resolveSandboxContext.mockImplementation(async (selection) => {
        resolveSessionAgentIds({ ...selection, config });
        return createSandboxTestContext({
          overrides: {
            workspaceDir: workspace,
            fsBridge: createHostSandboxFsBridge(workspace),
            [Symbol.dispose]: dispose,
          },
        });
      });
      const context = resolveMediaGenerateToolContext(
        "imageGenerationProviders",
        {
          config,
          agentSessionKey: `agent:${requesterAgentId}:cron:generated:run:current`,
          sandboxSessionKey: "agent:main:policy",
          sandboxAgentId: "main",
          requesterAgentId,
          workspaceDir: "/closed/projection",
          spawnWorkspaceDir: "/canonical/worktree",
          skillsSnapshot,
          sandbox,
        },
        { warn: vi.fn(), error: vi.fn() },
        true,
      );
      if (!context) {
        throw new Error("Expected a media tool context");
      }
      expect(context.taskOptions()).toMatchObject({
        requesterAgentId,
        sessionKey: `agent:${requesterAgentId}:cron:generated:run:current`,
      });
      const result = await buildMediaGenerateToolExecutionResult({
        ...params,
        sandbox: context.acquireOutputSandbox,
      });
      expect(resolveSandboxContext).toHaveBeenCalledWith({
        config,
        sessionKey: "agent:main:policy",
        agentId: "main",
        workspaceDir: "/canonical/worktree",
        skillsSnapshot,
        execOverrides: undefined,
        assertCurrent: expect.any(Function),
      });
      const [relativePath] = result.details.sandboxPaths as string[];
      if (!relativePath) {
        throw new Error("Expected a sandbox path after reacquisition");
      }
      await expect(fs.readFile(path.join(workspace, relativePath))).resolves.toEqual(png);
      expect(originalWrite).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();

      const otherWorkspace = tempDirs.make("other-sandbox-");
      resolveSandboxContext.mockResolvedValue(
        createSandboxTestContext({
          overrides: {
            workspaceDir: otherWorkspace,
            fsBridge: createHostSandboxFsBridge(otherWorkspace),
            [Symbol.dispose]: dispose,
          },
        }),
      );
      const refused = await buildMediaGenerateToolExecutionResult({
        ...params,
        sandbox: context.acquireOutputSandbox,
      });
      expect(refused.details.sandboxPaths).toBeUndefined();
      expect(refused.wakeResult).toContain("Sandbox copy unavailable");
      await expect(fs.readdir(otherWorkspace)).resolves.toEqual([]);
      expect(dispose).toHaveBeenCalledTimes(2);
    },
  );
});
