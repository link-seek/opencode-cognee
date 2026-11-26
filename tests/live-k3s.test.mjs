// Live test against the deployed cognee-trial backend in k3s.
// Run in CI (live-k3s.yml) after port-forward; also runnable anywhere with
// COGNEE_BASE_URL pointing at a cognee-mcp. Never runs on PR (needs secrets).
// Exit 0 = remember + recall round-trip verified. Dataset per run, cleaned after.
import { test } from "node:test"
import assert from "node:assert/strict"
import { McpClient, remember, recall, scrub } from "../.opencode/plugins/cognee/index.ts"

const BASE = process.env.COGNEE_BASE_URL ?? "http://127.0.0.1:18000"
const RUN = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`
const DATASET = `live_${RUN}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)
const cfg = {
  baseUrl: BASE,
  apiKey: process.env.COGNEE_API_KEY ?? "",
  dataset: DATASET,
  capture: true,
  recall: true,
  timeoutMs: 20000,
  maxChars: 8000,
}
const stamp = `live-probe ${RUN} ${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("live round-trip: remember(bg) -> poll recall -> forget dataset", async (t) => {
  const client = new McpClient(cfg)
  await t.test("backend reachable", async () => {
    const res = await fetch(`${BASE}/health`)
    assert.equal(res.status, 200)
  })
  await t.test("remember accepted", async () => {
    const out = await remember(cfg, client, stamp, true)
    assert.match(out, /Saved/)
  })
  await t.test("recall hits within 12 min", async () => {
    let hit = ""
    for (let i = 0; i < 24; i++) {
      await sleep(30000)
      try {
        const out = await recall(cfg, client, stamp, 3, "CHUNKS")
        // server "warming up" (no graph yet) is not a hit
        if (out.length > 100 && !out.includes("warming up") && !out.includes("no matching memories")) {
          hit = out
          break
        }
      } catch (e) {
        console.log(`poll ${i + 1}: ${e.message}`)
      }
    }
    assert.ok(hit.length > 100, "recall never returned the probe entry")
    assert.match(hit, /live-probe/)
  })
  await t.test("cleanup: forget dataset (best-effort)", async () => {
    try {
      await client.callTool("forget", { dataset: DATASET }, 30000)
    } catch (e) {
      console.log(`cleanup warn: ${e.message}`)
    }
  })
})
