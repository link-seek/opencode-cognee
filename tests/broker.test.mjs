import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createBroker } from "../broker/token-broker.mjs"

function fakeCognee() {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (req.method === "POST" && req.url === "/api/v1/auth/login") {
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      calls.push(form.get("username"))
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

function post(port, path, headers, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

test("broker: issues a Cognee JWT, rejects bad auth and unknown identities", async () => {
  const cognee = await fakeCognee()
  const broker = createBroker({
    brokerToken: "broker-secret",
    cogneeBase: `http://127.0.0.1:${cognee.port}`,
    users: { xieyucheng: { email: "xie@x.dev", password: "pw" } },
  })
  await new Promise((r) => broker.server.listen(0, "127.0.0.1", r))
  const port = broker.server.address().port
  try {
    const ok = await post(port, "/token", { authorization: "Bearer broker-secret" }, { identity: "xieyucheng" })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.token, "tok-xie")
    assert.ok(body.expiresAt > Date.now())

    const bad = await post(port, "/token", { authorization: "Bearer wrong" }, { identity: "xieyucheng" })
    assert.equal(bad.status, 401)

    const unknown = await post(port, "/token", { authorization: "Bearer broker-secret" }, { identity: "mallory" })
    assert.equal(unknown.status, 404)

    const health = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).users, 1)

    // Cached login: a second token request must not hit Cognee again.
    const again = await post(port, "/token", { authorization: "Bearer broker-secret" }, { identity: "xieyucheng" })
    assert.equal(again.status, 200)
    assert.equal(cognee.calls.length, 1)
  } finally {
    broker.server.close()
    cognee.server.close()
  }
})
