import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"

const mod = await import("../.opencode/plugins/cognee/index.ts")
const { scrub, truncate, safeDatasetName, parseUsers, hash, buildTranscript, renderMemory, CogneeClient, loadConfig } = mod

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/**
 * Fake Cognee REST server with per-user datasets and EBAC-like ownership checks.
 * Users: xieyucheng / yingxin, password "pw".
 */
function startFakeCognee() {
  const users = new Map([
    ["xieyucheng@link-seek.dev", { identity: "xieyucheng", password: "pw" }],
    ["yingxin@link-seek.dev", { identity: "yingxin", password: "pw" }],
  ])
  const tokens = new Map()
  const datasets = new Map() // id -> {name, owner}
  const memories = [] // {owner, datasetId, text}
  const calls = []
  const seeds = new Map() // owner -> text inserted into the first dataset created

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x")
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const auth = req.headers.authorization ?? ""
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""
    const who = tokens.get(token)
    calls.push({ method: req.method, path: url.pathname, who })

    if (req.method === "POST" && url.pathname === "/api/v1/auth/login") {
      const params = new URLSearchParams(body.toString())
      const user = users.get(params.get("username"))
      if (!user || params.get("password") !== user.password) return json(res, 400, { detail: "LOGIN_BAD_CREDENTIALS" })
      const t = `tok-${user.identity}-${randomUUID()}`
      tokens.set(t, user.identity)
      return json(res, 200, { access_token: t, token_type: "bearer" })
    }

    if (!who) return json(res, 401, { detail: "Authentication required" })

    if (req.method === "GET" && url.pathname === "/api/v1/datasets") {
      return json(
        res,
        200,
        [...datasets.entries()].filter(([, d]) => d.owner === who).map(([id, d]) => ({ id, name: d.name, ownerId: who })),
      )
    }

    if (req.method === "POST" && url.pathname === "/api/v1/datasets") {
      const { name } = JSON.parse(body.toString() || "{}")
      const id = randomUUID()
      datasets.set(id, { name, owner: who })
      if (seeds.has(who)) memories.push({ owner: who, datasetId: id, text: seeds.get(who) })
      return json(res, 200, { id, name, ownerId: who })
    }

    if (req.method === "POST" && url.pathname === "/api/v1/remember") {
      const text = body.toString()
      const datasetId = /name="datasetId"\r\n\r\n([^\r]+)/.exec(text)?.[1]
      const raw = /name="raw_data"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1]
      const ds = datasets.get(datasetId)
      if (!ds || ds.owner !== who) return json(res, 403, { detail: "PermissionDeniedError" })
      memories.push({ owner: who, datasetId, text: raw ?? "" })
      return json(res, 200, { status: "running" })
    }

    if (req.method === "POST" && url.pathname === "/api/v1/recall") {
      const payload = JSON.parse(body.toString() || "{}")
      // Test hook: deterministic ACL denial independent of dataset state.
      if (payload.query === "forbidden") return json(res, 403, { detail: "PermissionDeniedError: [read]" })
      const ids = payload.datasetIds ?? []
      for (const id of ids) {
        const ds = datasets.get(id)
        if (!ds || ds.owner !== who) return json(res, 403, { detail: "PermissionDeniedError: [read]" })
      }
      const hits = memories
        .filter((m) => ids.includes(m.datasetId))
        .map((m) => ({ kind: "chunk", text: m.text, dataset_id: m.datasetId, source: "graph" }))
      return json(res, 200, hits)
    }

    return json(res, 404, { detail: "not found" })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, calls, datasets, memories, seeds, tokens })
    })
  })
}

function cfgFor(port, extra = {}) {
  return loadConfig({
    COGNEE_BASE_URL: `http://127.0.0.1:${port}`,
    COGNEE_USERS: JSON.stringify({
      xieyucheng: { email: "xieyucheng@link-seek.dev", password: "pw" },
      yingxin: { email: "yingxin@link-seek.dev", password: "pw" },
    }),
    COGNEE_DEFAULT_USER: "",
    COGNEE_ALLOW_DEFAULT_IDENTITY: "0",
    COGNEE_DEBUG: "0",
    ...extra,
  })
}

test("export shape: V2 plugin (id + setup), loads without a host", () => {
  assert.equal(typeof mod.default, "object")
  assert.equal(mod.default.id, "cognee")
  assert.equal(typeof mod.default.setup, "function")
})

test("scrub redacts private keys, tokens and JWTs, keeps normal text", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----"
  assert.match(scrub(`k=${key}`), /REDACTED PRIVATE KEY/)
  assert.match(scrub("api_key=sk-live-123"), /REDACTED/)
  assert.match(scrub("ghp_abcdefghij1234567890"), /REDACTED/)
  assert.match(scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"), /REDACTED JWT/)
  assert.equal(scrub("remember to buy milk"), "remember to buy milk")
})

test("truncate caps length", () => {
  assert.equal(truncate("abcdef", 3), "abc\n[truncated]")
  assert.equal(truncate("ab", 3), "ab")
})

test("dataset names are isolated per identity and safe", () => {
  assert.equal(safeDatasetName("xieyucheng", "u_"), "u_xieyucheng")
  assert.equal(safeDatasetName("Xie Yucheng@corp", "u_"), "u_xie_yucheng_corp")
  assert.notEqual(safeDatasetName("alice", "u_"), safeDatasetName("bob", "u_"))
  assert.equal(safeDatasetName("../etc/passwd", "u_"), "u_etc_passwd")
})

test("parseUsers drops malformed entries", () => {
  const users = parseUsers('{"a":{"email":"a@x.dev","password":"p"},"b":{"email":"b@x.dev"},"c":null}')
  assert.deepEqual(Object.keys(users), ["a"])
})

test("config defaults stay conservative", () => {
  const cfg = loadConfig({})
  assert.equal(cfg.defaultUser, "")
  assert.equal(cfg.allowDefaultIdentity, false)
  assert.equal(cfg.recallEveryTurn, false)
  assert.equal(cfg.capture, true)
  assert.equal(cfg.recall, true)
})

test("Cognee client: login, create dataset, remember, recall", async () => {
  const fake = await startFakeCognee()
  try {
    const cfg = cfgFor(fake.port)
    const client = new CogneeClient(cfg, "xieyucheng")
    const ds = await client.ensureDataset()
    assert.match(ds, /^[0-9a-f-]{36}$/)
    await client.remember("xie prefers dark mode", ["episode"])
    const hits = await client.recall("what does xie prefer?", 5)
    assert.equal(hits.length, 1)
    assert.match(hits[0].text, /dark mode/)
    assert.equal(fake.memories[0].owner, "xieyucheng")
  } finally {
    fake.server.close()
  }
})

test("Cognee client: a second identity cannot read the first identity's dataset", async () => {
  const fake = await startFakeCognee()
  try {
    const cfg = cfgFor(fake.port)
    const xie = new CogneeClient(cfg, "xieyucheng")
    const ying = new CogneeClient(cfg, "yingxin")
    const xieDs = await xie.ensureDataset()
    await xie.remember("secret xie memory", ["episode"])

    const yingDs = await ying.ensureDataset()
    assert.notEqual(xieDs, yingDs)
    // The fake server enforces ownership; the public API has no way to pass a foreign dataset.
    const hits = await ying.recall("secret", 5)
    assert.equal(hits.length, 0)
  } finally {
    fake.server.close()
  }
})

test("buildTranscript keeps user/assistant text and drops tool output", () => {
  const transcript = buildTranscript(
    [
      { type: "user", text: "deploy on k3s" },
      { type: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool", text: "noise" }] },
      { type: "tool", text: "ignored" },
    ],
    1000,
  )
  assert.match(transcript, /\[user\] deploy on k3s/)
  assert.match(transcript, /\[assistant\] ok/)
  assert.doesNotMatch(transcript, /noise/)
})

test("renderMemory keeps a clipped long hit", () => {
  const out = renderMemory([{ text: "x".repeat(5000) }], 4000)
  assert.match(out, /x{240}/)
  assert.ok(out.length < 4200)
})

test("renderMemory wraps hits and respects the char budget", () => {
  const out = renderMemory([{ text: "a".repeat(100) }, { text: "b".repeat(100) }], 160)
  assert.match(out, /长期记忆/)
  assert.match(out, /可作为事实参考/)
  assert.ok(out.length < 400)
})

test("Cognee client: broker token provider", async () => {
  const fake = await startFakeCognee()
  fake.tokens.set("broker-token", "xieyucheng")
  const brokerCalls = []
  const broker = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    brokerCalls.push({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ token: "broker-token", expiresAt: Date.now() + 3_600_000 }))
  })
  await new Promise((r) => broker.listen(0, "127.0.0.1", r))
  const brokerPort = broker.address().port
  try {
    const cfg = cfgFor(fake.port, {
      COGNEE_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
      COGNEE_BROKER_TOKEN: "broker-secret",
      COGNEE_USERS: "{}",
    })
    const client = new CogneeClient(cfg, "xieyucheng")
    const ds = await client.ensureDataset()
    assert.match(ds, /^[0-9a-f-]{36}$/)
    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].auth, "Bearer broker-secret")
    assert.match(brokerCalls[0].body, /xieyucheng/)
    // The client must use the broker token, not a direct /auth/login call.
    assert.equal(fake.calls.filter((c) => c.path === "/api/v1/auth/login").length, 0)
  } finally {
    broker.close()
    fake.server.close()
  }
})

/** Minimal plugin host that records hooks and tools. */
function fakeHost({ identity, users, model = { providerID: "p", id: "m" } } = {}) {
  const hooks = {}
  const tools = []
  const requests = []
  const host = {
    hooks,
    tools,
    requests,
    ctx: {
      session: {
        hook: async (name, cb) => {
          hooks[name] = cb
        },
        instructions: {
          entry: {
            list: async () => (identity ? [{ key: "auth.user_id", value: identity }] : []),
          },
        },
        context: async () => [
          { type: "user", text: "we decided to deploy on k3s with Flux" },
          { type: "assistant", content: [{ type: "text", text: "understood" }] },
        ],
        get: async () => ({ model }),
      },
      model: { default: async () => ({ data: model }) },
      experimental: {
        generate: {
          text: async () => ({ text: "## Request\nk3s deploy\n## Tags\nk3s,flux" }),
        },
      },
      tool: {
        transform: async (cb) => cb({ namespace: () => {}, add: (t) => tools.push(t) }),
      },
      storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
    },
  }
  return host
}

async function loadPluginWithHost(host, port) {
  // setup() reads env once; point it at the fake server for this call only.
  const prev = { ...process.env }
  Object.assign(process.env, {
    COGNEE_BASE_URL: `http://127.0.0.1:${port}`,
    COGNEE_USERS: JSON.stringify({
      xieyucheng: { email: "xieyucheng@link-seek.dev", password: "pw" },
      yingxin: { email: "yingxin@link-seek.dev", password: "pw" },
    }),
    COGNEE_DEFAULT_USER: "",
    COGNEE_ALLOW_DEFAULT_IDENTITY: "0",
    COGNEE_DEBUG: "0",
    COGNEE_IDLE_DEBOUNCE_MS: "1",
    COGNEE_MIN_TRANSCRIPT_CHARS: "10",
  })
  try {
    await mod.default.setup(host.ctx)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prev)) delete process.env[key]
    Object.assign(process.env, prev)
  }
}

test("plugin: no identity -> no recall and no capture", async () => {
  const fake = await startFakeCognee()
  const host = fakeHost()
  const before = fake.calls.length
  try {
    await loadPluginWithHost(host, fake.port)
    const event = { sessionID: "s1", system: [], messages: [{ role: "user", content: "hello" }] }
    await host.hooks.context(event)
    assert.equal(event.system.length, 0)
    await host.hooks["experimental.idle"]({ sessionID: "s1", background: [] })
    assert.equal(fake.calls.length, before)
  } finally {
    fake.server.close()
  }
})

test("plugin: injected identity -> recall uses that identity and injects memory", async () => {
  const fake = await startFakeCognee()
  fake.seeds.set("xieyucheng", "xie prefers dark mode and k3s with Flux")
  const host = fakeHost({ identity: "xieyucheng" })
  try {
    await loadPluginWithHost(host, fake.port)
    const event = { sessionID: "s2", system: [], messages: [{ role: "user", content: "what did we decide about k3s?" }] }
    await host.hooks.context(event)
    assert.equal(event.system.length, 1)
    assert.match(event.system[0].text, /长期记忆/)
    const injected = event.messages.find((m) => m.role === "user" && JSON.stringify(m.content).includes("长期记忆"))
    assert.ok(injected)
    assert.match(injected.content[0].text, /长期记忆/)
    // Recall must use the xieyucheng token and its own dataset.
    assert.ok(fake.calls.some((c) => c.path === "/api/v1/recall" && c.who === "xieyucheng"))
  } finally {
    fake.server.close()
  }
})

test("plugin: idle capture writes only to the bound identity's dataset", async () => {
  const fake = await startFakeCognee()
  const host = fakeHost({ identity: "yingxin" })
  try {
    await loadPluginWithHost(host, fake.port)
    await host.hooks["experimental.idle"]({ sessionID: "s3", background: [] })
    assert.equal(fake.memories.length, 1)
    assert.equal(fake.memories[0].owner, "yingxin")
    assert.match(fake.memories[0].text, /k3s/)
  } finally {
    fake.server.close()
  }
})

test("plugin: unknown identity fails closed (no fallback, no network)", async () => {
  const fake = await startFakeCognee()
  const host = fakeHost({ identity: "mallory" })
  const before = fake.calls.length
  try {
    await loadPluginWithHost(host, fake.port)
    const event = { sessionID: "s4", system: [], messages: [{ role: "user", content: "hello" }] }
    await host.hooks.context(event)
    await host.hooks["experimental.idle"]({ sessionID: "s4", background: [] })
    assert.equal(event.system.length, 0)
    assert.equal(fake.calls.length, before)
  } finally {
    fake.server.close()
  }
})

test("plugin: tools never accept an identity argument", async () => {
  const host = fakeHost({ identity: "xieyucheng" })
  await loadPluginWithHost(host, 1)
  assert.equal(host.tools.length, 2)
  for (const tool of host.tools) {
    const props = Object.keys(tool.input.properties ?? {})
    assert.ok(!props.includes("user_id"))
    assert.ok(!props.includes("identity"))
    assert.ok(!props.includes("datasetId"))
  }
})

test("client: opaque broker token without expiresAt is cached (single broker hit)", async () => {
  const fake = await startFakeCognee()
  const brokerCalls = []
  const broker = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    brokerCalls.push(Buffer.concat(chunks).toString())
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ token: "opaque-token" })) // no expiresAt, no JWT exp
  })
  await new Promise((r) => broker.listen(0, "127.0.0.1", r))
  try {
    // Route the stub broker at the fake Cognee: login must never be called.
    const cfg = cfgFor(fake.port, {
      COGNEE_BROKER_URL: `http://127.0.0.1:${broker.address().port}`,
      COGNEE_BROKER_TOKEN: "broker-secret",
      COGNEE_USERS: "{}",
    })
    fake.tokens.set("opaque-token", "xieyucheng")
    const client = new CogneeClient(cfg, "xieyucheng")
    await client.ensureDataset()
    client.dropDataset()
    await client.recall("k3s", 5)
    assert.equal(brokerCalls.length, 1)
    assert.equal(fake.calls.filter((c) => c.path === "/api/v1/auth/login").length, 0)
  } finally {
    broker.close()
    fake.server.close()
  }
})

test("client: 401 refresh rebuilds the FormData body", async () => {
  const bodies = []
  let remembers = 0
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const url = new URL(req.url, "http://x")
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === "/api/v1/auth/login") return json(200, { access_token: "tok-1", token_type: "bearer" })
    if (url.pathname === "/api/v1/datasets") return json(200, [{ id: "d1", name: "u_xieyucheng" }])
    if (url.pathname === "/api/v1/remember") {
      remembers++
      bodies.push(Buffer.concat(chunks).toString())
      if (remembers === 1) return json(401, { detail: "expired" })
      return json(200, { status: "running" })
    }
    return json(404, {})
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    const cfg = cfgFor(server.address().port)
    const client = new CogneeClient(cfg, "xieyucheng")
    await client.remember("hello-memory-marker", ["episode"])
    assert.equal(remembers, 2)
    assert.match(bodies[1], /hello-memory-marker/)
  } finally {
    server.close()
  }
})

test("client: repeated 403 does not open the breaker", async () => {
  const fake = await startFakeCognee()
  try {
    const cfg = cfgFor(fake.port)
    const client = new CogneeClient(cfg, "xieyucheng")
    for (let i = 0; i < 3; i++) {
      await assert.rejects(client.recall("forbidden", 5), /403/)
    }
    // A healthy call must still go through: the circuit must be closed.
    const hits = await client.recall("nothing", 5)
    assert.deepEqual(hits, [])
  } finally {
    fake.server.close()
  }
})

test("renderMemory respects maxChars including the header", async () => {
  const text = renderMemory([{ text: "a".repeat(500) }], 200)
  assert.ok(text.length <= 200)
  assert.match(text, /长期记忆/)
})

test("recall cache: rebound session never sees the previous identity's text", async () => {
  const fake = await startFakeCognee()
  fake.seeds.set("xieyucheng", "alice-dark-mode-secret")
  let current = "xieyucheng"
  const host = fakeHost({})
  host.ctx.session.instructions.entry.list = async () => [{ key: "auth.user_id", value: current }]
  try {
    await loadPluginWithHost(host, fake.port)
    const query = "还记得 k3s 吗"
    const e1 = { sessionID: "rebound", system: [], messages: [{ role: "user", content: query }] }
    await host.hooks.context(e1)
    assert.ok(JSON.stringify(e1).includes("alice-dark-mode-secret"))
    current = "yingxin" // rebind the same session to another tenant
    await new Promise((r) => setTimeout(r, 5_100)) // outlive the 5s identity cache
    const e2 = { sessionID: "rebound", system: [], messages: [{ role: "user", content: query }] }
    await host.hooks.context(e2)
    assert.ok(!JSON.stringify(e2).includes("alice-dark-mode-secret"))
    assert.ok(fake.calls.some((c) => c.path === "/api/v1/recall" && c.who === "yingxin"))
  } finally {
    fake.server.close()
  }
})

test("capture: concurrent idle hooks store a single episode", async () => {
  const fake = await startFakeCognee()
  const host = fakeHost({ identity: "yingxin" })
  try {
    await loadPluginWithHost(host, fake.port)
    await Promise.all([
      host.hooks["experimental.idle"]({ sessionID: "race", background: [] }),
      host.hooks["experimental.idle"]({ sessionID: "race", background: [] }),
    ])
    assert.equal(fake.memories.length, 1)
  } finally {
    fake.server.close()
  }
})
