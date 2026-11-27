/**
 * Cognee token broker.
 *
 * Maps an OpenCode SSO identity to a Cognee user and returns a short-lived JWT.
 * The OpenCode pods hold only a broker token, never the Cognee passwords.
 *
 * Identity binding (fixes cross-tenant impersonation): when BROKER_TOKENS is set
 * (JSON map identity -> token), the caller's bearer token must equal the entry for
 * the requested identity. Each pod holds only its own identity's token, so a leaked
 * pod token cannot mint another tenant's Cognee JWT. The legacy single BROKER_TOKEN
 * global fallback is deprecated and warns loudly.
 *
 * POST /token  Authorization: Bearer <per-identity token>  {"identity":"xieyucheng"}
 *   -> {"token":"<cognee jwt>","expiresAt":<ms>}
 *   401 unauthorized | 403 identity_mismatch | 404 unknown_identity | 502 cognee_unavailable
 * GET /health -> {"status":"ok"}
 *
 * Env: BROKER_PORT, BROKER_TOKEN (legacy global), BROKER_TOKENS (JSON map),
 *      COGNEE_BASE_URL, COGNEE_USERS (JSON map).
 */
import http from "node:http"
import { createHash, timingSafeEqual } from "node:crypto"
import { pathToFileURL } from "node:url"

const MAX_BODY_BYTES = 8 * 1024

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest()
}

/** Constant-time bearer comparison (hash both sides so lengths match). */
function bearerOk(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false
  const a = sha256Hex(header.slice("Bearer ".length))
  const b = sha256Hex(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createBroker({ brokerToken, brokerTokens, cogneeBase, users, fetchImpl = fetch }) {
  if (!cogneeBase) throw new Error("COGNEE_BASE_URL is required")
  if (!brokerToken && !brokerTokens) throw new Error("BROKER_TOKEN or BROKER_TOKENS is required")
  const tokens = brokerTokens && typeof brokerTokens === "object" ? brokerTokens : null
  if (tokens) {
    for (const [identity, t] of Object.entries(tokens)) {
      if (typeof t !== "string" || !t) throw new Error(`BROKER_TOKENS[${identity}] must be a non-empty string`)
    }
  } else {
    console.error("[token-broker] WARNING: using legacy global BROKER_TOKEN; set BROKER_TOKENS (per-identity) to prevent cross-tenant minting")
  }
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

  /** null = unknown identity; throws = Cognee upstream failure. */
  async function login(identity) {
    const creds = users[identity]
    if (!creds) return null
    const cached = cache.get(identity)
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached
    let res
    try {
      res = await fetchImpl(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: creds.email, password: creds.password, grant_type: "password" }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new Error(`cognee login unreachable: ${String(error)}`)
    }
    if (!res.ok) throw new Error(`cognee login failed: ${res.status}`)
    const data = await res.json()
    if (!data.access_token) throw new Error("cognee login returned no access_token")
    const entry = { token: data.access_token, expiresAt: jwtExpiry(data.access_token) || Date.now() + 50 * 60_000 }
    cache.set(identity, entry)
    return entry
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify(body))
    }
    let pathname = req.url || "/"
    try {
      pathname = new URL(req.url || "/", "http://x").pathname
    } catch {
      return send(400, { error: "bad_url" })
    }
    if (req.method === "GET" && pathname === "/health") {
      return send(200, { status: "ok" })
    }
    if (req.method !== "POST" || pathname !== "/token") return send(404, { error: "not_found" })
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk) // bounded: drain the rest without storing
    }
    if (size > MAX_BODY_BYTES) return send(413, { error: "body_too_large" })
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    } catch {
      return send(400, { error: "bad_json" })
    }
    const identity = typeof body.identity === "string" ? body.identity.trim() : ""
    if (!identity) return send(400, { error: "identity_required" })
    const auth = req.headers.authorization ?? ""
    if (tokens) {
      const expected = tokens[identity]
      if (!expected) return send(404, { error: "unknown_identity" })
      if (!bearerOk(auth, expected)) return send(401, { error: "unauthorized" })
    } else {
      if (!bearerOk(auth, brokerToken)) return send(401, { error: "unauthorized" })
    }
    try {
      const entry = await login(identity)
      if (!entry) return send(404, { error: "unknown_identity" })
      return send(200, entry)
    } catch (error) {
      console.error(`[token-broker] login failed for ${identity}: ${String(error)}`)
      return send(502, { error: "cognee_unavailable" })
    }
  })

  return { server, users: Object.keys(users) }
}

function parseMap(raw, name) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
    return parsed
  } catch (error) {
    console.error(`[token-broker] invalid ${name}: ${String(error)}`)
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BROKER_PORT ?? 8787)
  const users = parseMap(process.env.COGNEE_USERS ?? "{}", "COGNEE_USERS") ?? {}
  const brokerTokens = parseMap(process.env.BROKER_TOKENS ?? "", "BROKER_TOKENS")
  const broker = createBroker({
    brokerToken: process.env.BROKER_TOKEN ?? "",
    brokerTokens,
    cogneeBase: process.env.COGNEE_BASE_URL ?? "",
    users,
  })
  broker.server.listen(port, "0.0.0.0", () => {
    console.log(`token-broker listening on :${port} users=${broker.users.length} bound=${brokerTokens ? "per-identity" : "legacy-global"}`)
  })
}
