/**
 * Cognee token broker (MVP).
 *
 * Maps an OpenCode SSO identity to a Cognee user and returns a short-lived JWT.
 * The OpenCode pods hold only the broker token, never the Cognee passwords.
 *
 * POST /token  Authorization: Bearer <BROKER_TOKEN>  {"identity":"xieyucheng"}
 *   -> {"token":"<cognee jwt>","expiresAt":<ms>}
 * GET /health -> {"status":"ok","users":N}
 *
 * Env: BROKER_PORT, BROKER_TOKEN, COGNEE_BASE_URL, COGNEE_USERS (JSON map).
 */
import http from "node:http"
import { pathToFileURL } from "node:url"

export function createBroker({ port = 8787, brokerToken, cogneeBase, users, fetchImpl = fetch }) {
  if (!brokerToken) throw new Error("BROKER_TOKEN is required")
  if (!cogneeBase) throw new Error("COGNEE_BASE_URL is required")
  const base = cogneeBase.replace(/\/+$/, "")
  const cache = new Map()

  const jwtExpiry = (token) => {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
      return typeof payload.exp === "number" ? payload.exp * 1000 : 0
    } catch {
      return 0
    }
  }

  async function login(identity) {
    const creds = users[identity]
    if (!creds) return null
    const cached = cache.get(identity)
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached
    const res = await fetchImpl(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: creds.email, password: creds.password, grant_type: "password" }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.access_token) return null
    const entry = { token: data.access_token, expiresAt: jwtExpiry(data.access_token) || Date.now() + 50 * 60_000 }
    cache.set(identity, entry)
    return entry
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { status: "ok", users: Object.keys(users).length })
    }
    if (req.method !== "POST" || req.url !== "/token") return send(404, { error: "not_found" })
    if (req.headers.authorization !== `Bearer ${brokerToken}`) return send(401, { error: "unauthorized" })
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    } catch {
      return send(400, { error: "bad_json" })
    }
    const identity = typeof body.identity === "string" ? body.identity.trim() : ""
    if (!identity) return send(400, { error: "identity_required" })
    try {
      const entry = await login(identity)
      if (!entry) return send(404, { error: "unknown_identity" })
      return send(200, entry)
    } catch {
      return send(502, { error: "cognee_unavailable" })
    }
  })

  return { server, users: Object.keys(users) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BROKER_PORT ?? 8787)
  const users = JSON.parse(process.env.COGNEE_USERS ?? "{}")
  const broker = createBroker({
    port,
    brokerToken: process.env.BROKER_TOKEN ?? "",
    cogneeBase: process.env.COGNEE_BASE_URL ?? "",
    users,
  })
  broker.server.listen(port, "0.0.0.0", () => {
    console.log(`token-broker listening on :${port} users=${broker.users.length}`)
  })
}
