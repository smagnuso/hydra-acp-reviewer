import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleReview } from "../src/reviewer.js";
import type { CommandInvocation, Context } from "@hydra-acp/transformer";

// ── Temp file helper ───────────────────────────────────────────────────────

let tmpDir = "";

function setupTmp(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "reviewer-test-"));
}

function teardownTmp(): void {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

function writeTestFile(name: string, content: string): string {
  const absPath = join(tmpDir, name);
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content, "utf8");
  return absPath;
}

// ── Mock context builder ───────────────────────────────────────────────────

interface RpcCall {
  method: string;
  params?: unknown;
}

function makeRpc(calls: RpcCall[], fn: (method: string, params?: unknown) => Promise<unknown>) {
  return async (method: string, params?: unknown): Promise<unknown> => {
    const result = await fn(method, params);
    calls.push({ method, params });
    return result;
  };
}

function createMockCtx(): { ctx: Context; calls: RpcCall[] } {
  const calls: RpcCall[] = [];

  const ctx: Context = {
    sessionId: "parent-session-1",
    cwd: tmpDir,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    notify: () => {},
    state: new Map(),
    signal: new AbortController().signal,
    rpc: makeRpc(calls, async () => {}),
    registerCommand: () => {},
    emitMessage: async () => {},
  };

  return { ctx, calls };
}

function makeInvocation(argv: string[] = [], overrides?: Partial<CommandInvocation>): CommandInvocation {
  return { verb: "review", argv, sessionId: "parent-session-1", ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("handleReview", () => {
  let filePath = "";

  before(() => {
    setupTmp();
    filePath = writeTestFile("src/index.ts", "export const hello = 'world';\n");
  });

  after(() => {
    teardownTmp();
  });

  describe("happy path — file path specified", () => {
    it("forks the session, attaches to the fork, sends seed prompt, emits URL", async () => {
      const { ctx, calls } = createMockCtx();

      ctx.rpc = makeRpc(calls, async (method: string) => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }, { id: "gpt-acp", installed: "no" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { sessionId: "forked-session-xyz", lineageId: "lineage-123" };
        }
        if (method === "hydra-acp/transformer/attach") {
          return { ok: true };
        }
        if (method === "hydra-acp/message/emit") {
          return { ok: true };
        }
        return {};
      });

      const emitMessages: string[] = [];
      ctx.emitMessage = async (text: string): Promise<void> => {
        calls.push({ method: "__emitMessage__", params: text });
        emitMessages.push(text);
      };

      const result = await handleReview(makeInvocation([filePath]), ctx);

      assert.equal(result.ok, true);
      assert.ok(result.message?.includes("hydra://sessions/forked-session-xyz"));

      const rpcCalls = calls.filter((c) => c.method !== "__emitMessage__");
      assert.equal(rpcCalls.length, 4, "should make exactly 4 RPC calls");
      assert.equal(rpcCalls[0].method, "hydra-acp/agents/list");
      assert.deepEqual(rpcCalls[1].params, { sessionId: "parent-session-1" });
      assert.equal(rpcCalls[2].method, "hydra-acp/transformer/attach");
      const attachParams = rpcCalls[2].params as { sessionId?: string };
      assert.equal(attachParams.sessionId, "forked-session-xyz");
      assert.equal(rpcCalls[3].method, "hydra-acp/message/emit");
      const emitParams = rpcCalls[3].params as Record<string, unknown> | undefined;
      assert.equal(emitParams?.sessionId, "forked-session-xyz");
      assert.equal(emitParams?.method, "session/prompt");
      assert.equal(emitParams?.route, "queue");

      // emitMessage should NOT be called — the daemon broadcasts
      // result.message itself. Calling emitMessage would duplicate.
      assert.equal(emitMessages.length, 0);
      assert.equal(
        result.message,
        "[Review session](hydra://sessions/forked-session-xyz)",
      );
    });
  });

  describe("happy path — agent specified", () => {
    it("passes agentId to fork params", async () => {
      const { ctx, calls } = createMockCtx();

      ctx.rpc = makeRpc(calls, async (method: string) => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }, { id: "gpt-acp", installed: "yes" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { sessionId: "forked-session-abc" };
        }
        if (method === "hydra-acp/transformer/attach") {
          return { ok: true };
        }
        if (method === "hydra-acp/message/emit") {
          return { ok: true };
        }
        return {};
      });

      const result = await handleReview(makeInvocation(["gpt-acp", filePath]), ctx);
      assert.equal(result.ok, true);

      const rpcCalls = calls.filter((c) => c.method !== "__emitMessage__");
      const forkParams = rpcCalls[1].params as Record<string, unknown>;
      assert.equal(forkParams.agentId, "gpt-acp");
    });
  });

  describe("error cases", () => {
    it("returns error when agents list fails", async () => {
      const { ctx, calls } = createMockCtx();
      ctx.rpc = makeRpc(calls, async (): Promise<unknown> => { throw new Error("daemon unreachable"); });

      const result = await handleReview(makeInvocation([filePath]), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.message?.includes("failed to list agents"));
    });

    it("returns error when fork fails", async () => {
      const { ctx, calls } = createMockCtx();
      ctx.rpc = makeRpc(calls, async (method: string): Promise<unknown> => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }] };
        }
        throw new Error("source session not found");
      });

      const result = await handleReview(makeInvocation([filePath]), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.message?.includes("fork failed"));
    });

    it("returns error when attach fails", async () => {
      const { ctx, calls } = createMockCtx();
      ctx.rpc = makeRpc(calls, async (method: string): Promise<unknown> => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { sessionId: "forked-attach-fail" };
        }
        throw new Error("session not live");
      });

      const result = await handleReview(makeInvocation([filePath]), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.message?.includes("failed to attach to forked session"));
    });

    it("returns error when fork returns no sessionId", async () => {
      const { ctx, calls } = createMockCtx();
      ctx.rpc = makeRpc(calls, async (method: string): Promise<unknown> => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { lineageId: "lineage-123" };
        }
        return {};
      });

      const result = await handleReview(makeInvocation([filePath]), ctx);
      assert.equal(result.ok, false);
      assert.equal(result.message, "fork returned no sessionId");
    });

    it("returns error when file path does not exist", async () => {
      const { ctx, calls } = createMockCtx();
      ctx.rpc = makeRpc(calls, async (): Promise<unknown> => ({ agents: [{ id: "claude-acp", installed: "yes" }] }));

      const result = await handleReview(makeInvocation(["/nonexistent/file.txt"]), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.message?.includes("cannot read /nonexistent/file.txt"));
    });
  });

  describe("RPC method correctness", () => {
    it("uses hydra-acp/session/fork (not bare session/fork)", async () => {
      const { ctx, calls } = createMockCtx();

      ctx.rpc = makeRpc(calls, async (method: string) => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { sessionId: "fork-method-verify" };
        }
        if (method === "hydra-acp/transformer/attach") {
          return { ok: true };
        }
        if (method === "hydra-acp/message/emit") {
          return { ok: true };
        }
        return {};
      });

      await handleReview(makeInvocation([filePath]), ctx);

      const rpcCalls = calls.filter((c) => c.method !== "__emitMessage__");
      const forkCall = rpcCalls.find((c) => c.method === "hydra-acp/session/fork");
      assert.ok(forkCall, "should call hydra-acp/session/fork");
      assert.ok(!rpcCalls.some((c) => c.method === "session/fork"), "should NOT use bare session/fork");
    });

    it("uses hydra-acp/message/emit with route queue", async () => {
      const { ctx, calls } = createMockCtx();

      ctx.rpc = makeRpc(calls, async (method: string) => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { sessionId: "fork-emit-verify" };
        }
        if (method === "hydra-acp/transformer/attach") {
          return { ok: true };
        }
        if (method === "hydra-acp/message/emit") {
          return { ok: true };
        }
        return {};
      });

      await handleReview(makeInvocation([filePath]), ctx);

      const rpcCalls = calls.filter((c) => c.method !== "__emitMessage__");
      const emitCall = rpcCalls.find((c) => c.method === "hydra-acp/message/emit");
      assert.ok(emitCall, "should call hydra-acp/message/emit");
      const ep = emitCall!.params as Record<string, unknown> | undefined;
      assert.equal(ep?.method, "session/prompt");
      assert.equal(ep?.route, "queue");
    });

    it("attaches before emitting seed prompt", async () => {
      const { ctx, calls } = createMockCtx();

      ctx.rpc = makeRpc(calls, async (method: string) => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { sessionId: "fork-order-verify" };
        }
        if (method === "hydra-acp/transformer/attach") {
          return { ok: true };
        }
        if (method === "hydra-acp/message/emit") {
          return { ok: true };
        }
        return {};
      });

      await handleReview(makeInvocation([filePath]), ctx);

      const rpcCalls = calls.filter((c) => c.method !== "__emitMessage__");
      const attachIdx = rpcCalls.findIndex((c) => c.method === "hydra-acp/transformer/attach");
      const emitIdx = rpcCalls.findIndex((c) => c.method === "hydra-acp/message/emit");
      assert.ok(attachIdx < emitIdx, "attach should come before message/emit");
    });

    it("fork params include source sessionId", async () => {
      const { ctx, calls } = createMockCtx();

      ctx.rpc = makeRpc(calls, async (method: string) => {
        if (method === "hydra-acp/agents/list") {
          return { agents: [{ id: "claude-acp", installed: "yes" }] };
        }
        if (method === "hydra-acp/session/fork") {
          return { sessionId: "fork-sessionid-verify" };
        }
        if (method === "hydra-acp/transformer/attach") {
          return { ok: true };
        }
        if (method === "hydra-acp/message/emit") {
          return { ok: true };
        }
        return {};
      });

      await handleReview(makeInvocation([filePath]), ctx);

      const rpcCalls = calls.filter((c) => c.method !== "__emitMessage__");
      const forkParams = rpcCalls[1].params as Record<string, unknown>;
      assert.equal(forkParams.sessionId, "parent-session-1");
    });
  });
});
