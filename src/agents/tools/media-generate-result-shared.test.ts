import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { STAGED_INPUT_GITIGNORE } from "../../media/staged-inputs.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { buildMediaGenerateToolExecutionResult } from "./media-generate-result-shared.js";
import { loadMediaToolReferences } from "./media-tool-shared.js";

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
  const params = {
    kind: "image" as const,
    result: { provider: "test", model: "test", attempts: [] },
    attachments: [{ type: "image" as const, path: mediaPath }],
    mediaUrls: [mediaPath],
    maxBytes: 1024,
    details: {},
  };
  return { root, workspace, mediaPath, sandbox, params };
}

describe("generated media sandbox access", () => {
  it("stages only the current outputs for follow-up references and retains delivery paths", async () => {
    const { root, workspace, mediaPath, sandbox, params } = await fixture();
    await fs.writeFile(path.join(root, "other-session.png"), png);
    const result = await buildMediaGenerateToolExecutionResult({ ...params, sandbox });
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
    const { workspace, sandbox, params } = await fixture();
    const result = await buildMediaGenerateToolExecutionResult(params);
    expect(result.details.sandboxPaths).toBeUndefined();
    expect(result.contentText).not.toContain("Sandbox");

    const url = "https://example.com/generated.mp4";
    const remote = await buildMediaGenerateToolExecutionResult({
      ...params,
      kind: "video",
      sandbox,
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
      const { workspace, sandbox, params } = await fixture();
      if (failure === "read-only workspace") {
        vi.spyOn(sandbox.bridge, "createFileExclusive").mockRejectedValue(
          new Error("Sandbox path is read-only"),
        );
      }
      const result = await buildMediaGenerateToolExecutionResult({
        ...params,
        sandbox,
        maxBytes: failure === "size limit" ? 1 : params.maxBytes,
      });
      expect(result.attachments).toEqual(params.attachments);
      expect(result.details.paths).toEqual(params.mediaUrls);
      expect(result.details.sandboxPaths).toBeUndefined();
      expect(result.wakeResult).toContain("Sandbox copy unavailable:");
      await expect(fs.readdir(workspace)).resolves.toEqual([]);
    },
  );
});
