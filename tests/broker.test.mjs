import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createBroker } from "../broker/token-broker.mjs"

function fakeCognee({ fail = 0 } = {}) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (req.method === "POST" && req.url === "/api/v1/auth/login") {
      calls.push("login")
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      if (fail > 0 && calls.length <= fail) {
        res.writeHead(500, { "content-type": "application/json" })
        return res.end(JSON.stringify({ detail: "boom" }))
      }
      if (form.get("password") !== "pw") {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ detail: "bad" }))
      }
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ access_token: "tok-xie", token_type: "bearer" }))
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, calls })),
  )
}

function post(port, path, headers, body, raw) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  })
}

async function startBroker(cogneePort, opts) {
  const broker = createBroker({ cogneeBase: `http://127.0.0.1:${cogneePort}`, ...opts })
  await new Promise((r) => broker.server.listen(0, "127.0.0.1", r))
  return { broker, port: broker.server.address().port }
}

const USERS = { xieyucheng: { email: "xie@x.dev", password: "pw" } }

test("broker: legacy global token still mints, warns", async () => {
  const cognee = await fakeCognee()
  const { broker, port } = await startBroker(cognee.port, { brokerToken: "global-secret", users: USERS })
  try {
    const ok = await post(port, "/token", { authorization: "Bearer global-secret" }, { identity: "xieyucheng" })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).token, "tok-xie")
    const bad = await post(port, "/token", { authorization: "Bearer wrong" }, { identity: "xieyucheng" })
    assert.equal(bad.status, 401)
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: "ok" })
  } finally {
    broker.server.close()
    cognee.server.close()
  }
})

test("broker: per-identity tokens bind caller to subject", async () => {
  const cognee = await fakeCognee()
  const { broker, port } = await startBroker(cognee.port, {
    brokerTokens: { xieyucheng: "tok-for-xie", yingxin: "tok-for-ying" },
    users: { ...USERS, yingxin: { email: "ying@x.dev", password: "pw" } },
  })
  try {
    const ok = await post(port, "/token", { authorization: "Bearer tok-for-xie" }, { identity: "xieyucheng" })
    assert.equal(ok.status, 200)
    // Cross-tenant: ying's token cannot mint xie's JWT.
    const cross = await post(port, "/token", { authorization: "Bearer tok-for-ying" }, { identity: "xieyucheng" })
    assert.equal(cross.status, 401)
    // Unknown identity -> 404 even with a valid token shape.
    const unknown = await post(port, "/token", { authorization: "Bearer tok-for-xie" }, { identity: "mallory" })
    assert.equal(unknown.status, 404)
    const noAuth = await post(port, "/token", {}, { identity: "xieyucheng" })
    assert.equal(noAuth.status, 401)
  } finally {
    broker.server.close()
    cognee.server.close()
  }
})

test("broker: upstream failure is 502, not 404", async () => {
  const cognee = await fakeCognee({ fail: 99 })
  const { broker, port } = await startBroker(cognee.port, { brokerToken: "s", users: USERS })
  try {
    const r = await post(port, "/token", { authorization: "Bearer s" }, { identity: "xieyucheng" })
    assert.equal(r.status, 502)
    assert.equal((await r.json()).error, "cognee_unavailable")
  } finally {
    broker.server.close()
    cognee.server.close()
  }
})

test("broker: oversized body rejected, query string tolerated", async () => {
  const cognee = await fakeCognee()
  const { broker, port } = await startBroker(cognee.port, { brokerToken: "s", users: USERS })
  try {
    const big = await post(port, "/token", { authorization: "Bearer s" }, null, "x".repeat(16 * 1024))
    assert.equal(big.status, 413)
    const qs = await post(port, "/token?x=1", { authorization: "Bearer s" }, { identity: "xieyucheng" })
    assert.equal(qs.status, 200)
  } finally {
    broker.server.close()
    cognee.server.close()
  }
})

test("broker: requires a token and valid entrada", async () => {
  assert.throws(() => createBroker({ cogneeBase: "http://x", users: {} }), /BROKER_TOKEN/)
  const cognee = await fakeCognee()
  const { broker, port } = await startBroker(cognee.port, { brokerToken: "s", users: USERS })
  try {
    const empty = await post(port, "/token", { authorization: "Bearer s" }, { identity: " " })
    assert.equal(empty.status, 400)
  } finally {
    broker.server.close()
    cognee.server.close()
  }
})
