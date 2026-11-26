import { test } from "node:test"
import assert from "node:assert/strict"

const sse = (id, result) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`

test("export shape: V2 plugin (id + setup), loads without a host", async () => {
  const mod = await import("../.opencode/plugins/cognee/index.ts")
  assert.equal(typeof mod.default, "object")
  assert.equal(mod.default.id, "cognee")
  assert.equal(typeof mod.default.setup, "function")
})

test("scrub redacts private keys and secrets, keeps normal text", async () => {
  const { scrub } = await import("../.opencode/plugins/cognee/index.ts")
  const key = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----"
  assert.match(scrub(`k=${key}`), /REDACTED PRIVATE KEY/)
  assert.match(scrub("api_key=sk-live-123"), /REDACTED/)
  assert.match(scrub("ghp_abcdefghij1234567890"), /REDACTED/)
  assert.equal(scrub("remember to buy milk"), "remember to buy milk")
})

test("truncate caps length", async () => {
  const { truncate } = await import("../.opencode/plugins/cognee/index.ts")
  assert.equal(truncate("abcdef", 3), "abc\n[truncated]")
  assert.equal(truncate("ab", 3), "ab")
})

test("MCP transport: init handshake then tools/call remember", async () => {
  const seen = []
  const orig = globalThis.fetch
  // @ts-ignore
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    seen.push(body.method)
    if (body.method === "initialize") {
      return { ok: true, headers: new Headers({ "mcp-session-id": "s1" }), text: async () => sse(body.id, { serverInfo: {} }) }
    }
    return {
      ok: true,
      headers: new Headers(),
      text: async () => sse(body.id, { content: [{ type: "text", text: "stored" }] }),
    }
  }
  try {
    const { McpClient, remember } = await import("../.opencode/plugins/cognee/index.ts")
    const cfg = { baseUrl: "http://x", apiKey: "", dataset: "d", capture: true, recall: true, timeoutMs: 1000, maxChars: 8000 }
    const out = await remember(cfg, new McpClient(cfg), "hello")
    assert.deepEqual(seen, ["initialize", "tools/call"])
    assert.match(out, /Saved/)
  } finally {
    globalThis.fetch = orig
  }
})

test("recall wraps hits in cognee_memories, blank query skips network", async () => {
  let calls = 0
  const orig = globalThis.fetch
  // @ts-ignore
  globalThis.fetch = async (url, init) => {
    calls++
    const body = JSON.parse(init.body)
    if (body.method === "initialize") {
      return { ok: true, headers: new Headers({ "mcp-session-id": "s1" }), text: async () => sse(body.id, {}) }
    }
    assert.equal(body.params.name, "recall")
    assert.equal(body.params.arguments.top_k, 5)
    return {
      ok: true,
      headers: new Headers(),
      text: async () => sse(body.id, { content: [{ type: "text", text: "hit1" }] }),
    }
  }
  try {
    const { McpClient, recall } = await import("../.opencode/plugins/cognee/index.ts")
    const cfg = { baseUrl: "http://x", apiKey: "", dataset: "d", capture: true, recall: true, timeoutMs: 1000, maxChars: 8000 }
    const out = await recall(cfg, new McpClient(cfg), "q")
    assert.match(out, /cognee_memories/)
    const before = calls
    assert.equal(await recall(cfg, new McpClient(cfg), "   "), "")
    assert.equal(calls, before)
  } finally {
    globalThis.fetch = orig
  }
})
