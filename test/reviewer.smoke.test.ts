import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TransformerBridge } from "@hydra-acp/transformer";
import type { BridgeClient, JsonRpcId, JsonRpcRequest } from "@hydra-acp/transformer";
import { reviewerDefinition } from "../src/reviewer.js";

// ── Fake client (mirrors transformer/test/bridge.test.ts pattern) ──────────

interface RecordedCall {
  method: string;
  params?: unknown;
}

class FakeTransformerClient implements BridgeClient {
  readonly requests: RecordedCall[] = [];
  readonly notifications: RecordedCall[] = [];
  readonly replies: Array<{ id: JsonRpcId; result: unknown }> = [];
  private _connected = true;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private _responseMap = new Map<string, () => Promise<unknown>>();

  setResponse(method: string, fn: () => Promise<unknown>): void {
    this._responseMap.set(method, fn);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const responder = this._responseMap.get(method);
    if (responder) return responder();
    return Promise.resolve({ ok: true });
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  reply(id: JsonRpcId, result: unknown): void {
    this.replies.push({ id, result });
  }

  replyError(_id: JsonRpcId, _code: number, _message: string): void {}

  start(): void {
    this._connected = true;
    void (async () => {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "reviewer-smoke", version: "0.0.1" },
      });
      await this.request("hydra-acp/transformer/initialize", { intercepts: [] });
      this.emit("open");
    })();
  }

  stop(): void {
    this._connected = false;
    this.emit("close", { hadError: false });
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return undefined;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const arr = this.listeners.get(event);
    if (arr) for (const fn of arr) fn(...args);
    return true;
  }
}

function emitRequest(fake: FakeTransformerClient, req: JsonRpcRequest): void {
  fake.emit("request", req);
}

// ── Git fixture helper ─────────────────────────────────────────────────────

let tmpDir = "";
let origCwd = "";

function setupFixture(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "reviewer-smoke-"));
  mkdirSync(tmpDir, { recursive: true });

  spawnSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" });
  spawnSync("git", ["config", "user.email", "smoke@test.com"], { cwd: tmpDir, stdio: "pipe" });
  spawnSync("git", ["config", "user.name", "Smoke Test"], { cwd: tmpDir, stdio: "pipe" });

  const filePath = join(tmpDir, "src", "index.ts");
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, "export const hello = 'world';\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: tmpDir, stdio: "pipe" });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "pipe" });

  writeFileSync(filePath, "export const hello = 'world';\nexport const foo = 'bar';\n", "utf8");
}

function teardownFixture(): void {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

// ── Smoke test ─────────────────────────────────────────────────────────────

describe("reviewer — end-to-end smoke", () => {
  let fake: FakeTransformerClient;

  before(() => {
    setupFixture();
    origCwd = process.cwd();
    process.chdir(tmpDir);

    fake = new FakeTransformerClient();

    fake.setResponse("hydra-acp/agents/list", async () => ({
      agents: [{ id: "claude-acp", installed: "yes" }, { id: "gpt-acp", installed: "no" }],
    }));
    fake.setResponse("hydra-acp/session/fork", async () => ({
      sessionId: "forked-session-smoke123",
      lineageId: "lineage-456",
    }));
    fake.setResponse("hydra-acp/transformer/attach", async () => ({ ok: true }));
    fake.setResponse("hydra-acp/message/emit", async () => ({ ok: true }));

    new TransformerBridge({
      daemonWsUrl: "ws://localhost:55514/acp",
      token: "smoke-test-token",
      clientName: "reviewer-smoke",
      definition: reviewerDefinition,
      client: fake,
    }).start();
  });

  after(() => {
    process.chdir(origCwd);
    fake.stop();
    teardownFixture();
  });

  it("full /review flow: fork → attach → seed prompt → hydra:// emission", async () => {
    emitRequest(fake, {
      jsonrpc: "2.0",
      id: 1,
      method: "hydra-acp/commands/invoke",
      params: { sessionId: "parent-session-smoke", verb: "", args: "" },
    });

    await new Promise((r) => setTimeout(r, 300));

    // ── Assert: reply shape ────────────────────────────────────────────
    assert.equal(fake.replies.length, 1, "should have exactly one reply");
    const reply = fake.replies[0]!;
    assert.equal(reply.id, 1);
    const result = reply.result as Record<string, unknown>;
    assert.equal(result.text, "[Review session](hydra://sessions/forked-session-smoke123)");

    // ── Daemon RPCs (exclude WS handshake calls) ───────────────────────
    const daemonCalls = fake.requests.filter(
      (r) => r.method !== "initialize" && r.method !== "hydra-acp/transformer/initialize",
    );

    // Bridge registers commands on open, then handleReview makes 4 more
    // (no separate emitMessage — the daemon broadcasts result.text itself).
    assert.equal(daemonCalls.length, 5, "should make exactly 5 daemon RPC calls");

    // Call 0: hydra-acp/commands/register (bridge startup)
    assert.equal(daemonCalls[0].method, "hydra-acp/commands/register");

    // Call 1: agents/list — fetch installed agents
    assert.equal(daemonCalls[1].method, "hydra-acp/agents/list");
    assert.deepEqual(daemonCalls[1].params, {});

    // Call 2: session/fork — fork parent session for review
    assert.equal(daemonCalls[2].method, "hydra-acp/session/fork");
    const forkParams = daemonCalls[2].params as Record<string, unknown> | undefined;
    assert.equal(forkParams?.sessionId, "parent-session-smoke");

    // Call 3: transformer/attach — attach to forked session
    assert.equal(daemonCalls[3].method, "hydra-acp/transformer/attach");
    const attachParams = daemonCalls[3].params as Record<string, unknown> | undefined;
    assert.equal(attachParams?.sessionId, "forked-session-smoke123");

    // Call 4: message/emit — seed prompt (route=queue) to forked session
    assert.equal(daemonCalls[4].method, "hydra-acp/message/emit");
    const emitParams = daemonCalls[4].params as Record<string, unknown> | undefined;
    assert.equal(emitParams?.sessionId, "forked-session-smoke123");
    assert.equal(emitParams?.method, "session/prompt");
    assert.equal(emitParams?.route, "queue");

    // ── Assert: seed prompt contains the rubric text ───────────────────
    const envelope = emitParams?.envelope as { prompt?: Array<{ text?: string }> } | undefined;
    assert.ok(envelope?.prompt?.[0]?.text, "seed prompt should contain rubric text");
    assert.ok(
      envelope!.prompt![0]!.text!.includes("adversarial reviewer"),
      "seed should include the review rubric",
    );

    // ── Assert: hydra:// URL surfaced via CommandResult.text ────────────
    // The daemon broadcasts result.text as a synthetic agent_message_chunk
    // in the parent session (PROTOCOL.md:1325). No separate emitMessage —
    // that would duplicate the message.
    assert.equal(
      result.text,
      "[Review session](hydra://sessions/forked-session-smoke123)",
    );
  });
});
