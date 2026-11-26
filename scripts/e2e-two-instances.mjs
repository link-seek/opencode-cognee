#!/usr/bin/env node
/**
 * Two-instance end-to-end check for opencode-cognee.
 *
 * Env:
 *   OC_A_URL / OC_A_PASSWORD   OpenCode instance A (xieyucheng namespace)
 *   OC_B_URL / OC_B_PASSWORD   OpenCode instance B (yingxin namespace)
 *   COGNEE_URL                 Cognee REST API (…:8001)
 *   COGNEE_USERS               JSON map identity -> {email,password}
 *
 * Flow:
 *   A[xie] prompt a unique secret -> wait for idle capture -> Cognee recall hit
 *   B[xie] ask for the secret    -> recall must inject it (same identity across instances)
 *   B[ying] ask for the secret   -> no xie memory (isolation)
 *   ying token reads xie dataset -> 403 (Cognee ACL)
 */
const A = required("OC_A_URL").replace(/\/+$/, "")
const A_PW = required("OC_A_PASSWORD")
const B = required("OC_B_URL").replace(/\/+$/, "")
const B_PW = required("OC_B_PASSWORD")
const COGNEE = required("COGNEE_URL").replace(/\/+$/, "")
const USERS = JSON.parse(required("COGNEE_USERS"))

const SECRET = process.argv[2] || `PINEAPPLE-${Math.floor(Math.random() * 9000 + 1000)}`
const facts = []

function required(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`missing ${name}`)
    process.exit(2)
  }
  return v
}

function auth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

async function api(base, password, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: auth(password),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  if (!res.ok && res.status !== 403) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`)
  return { status: res.status, body }
}

async function createSession(base, password, title) {
  const { body } = await api(base, password, "/api/session", {
    method: "POST",
    body: JSON.stringify({ title }),
  })
  return body.data.id
}

async function setIdentity(base, password, sessionID, identity) {
  const { status } = await api(
    base,
    password,
    `/api/experimental/session/${sessionID}/instructions/entries/auth.user_id`,
    { method: "PUT", body: JSON.stringify({ value: identity }) },
  )
  if (status !== 204) throw new Error(`identity entry ${status}`)
}

async function prompt(base, password, sessionID, text) {
  await api(base, password, `/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  })
}

async function waitAssistant(base, password, sessionID, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { body } = await api(base, password, `/api/session/${sessionID}/context`)
    const messages = body.data ?? []
    const last = [...messages]
      .reverse()
      .find((m) => m.type === "assistant" && m.time?.completed && m.finish !== "tool-calls")
    if (last) {
      const text = last.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      if (text.trim()) return text
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error("assistant did not complete")
}

async function cogneeLogin(identity) {
  const creds = USERS[identity]
  if (!creds) throw new Error(`no creds for ${identity}`)
  const res = await fetch(`${COGNEE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: creds.email, password: creds.password, grant_type: "password" }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`cognee login ${identity} ${res.status}`)
  return (await res.json()).access_token
}

async function datasetId(token, identity) {
  const res = await fetch(`${COGNEE}/api/v1/datasets`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  const list = await res.json()
  return list.find((d) => d.name === `u_${identity}`)?.id
}

async function recall(token, ds, query) {
  const res = await fetch(`${COGNEE}/api/v1/recall`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, datasetIds: [ds], searchType: "CHUNKS", onlyContext: true, topK: 5 }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : [] }
}

function check(name, ok, detail = "") {
  facts.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

async function main() {
  console.log(`secret=${SECRET}`)
  const xieToken = await cogneeLogin("xieyucheng")
  const e2eToken = await cogneeLogin("e2e")
  const yingToken = await cogneeLogin("yingxin")
  const xieDs = await datasetId(xieToken, "xieyucheng")
  const e2eDs = await datasetId(e2eToken, "e2e")
  const yingDs = await datasetId(yingToken, "yingxin")
  console.log(`xie dataset=${xieDs} ying dataset=${yingDs} e2e dataset=${e2eDs}`)

  // 1. Capture on instance A as xieyucheng.
  const s1 = await createSession(A, A_PW, "e2e capture")
  await setIdentity(A, A_PW, s1, "e2e")
  await prompt(
    A,
    A_PW,
    s1,
    `请记住这个项目事实：生产集群的证书签发机构是 ${SECRET}。只回复 OK。`,
  )
  const a1 = await waitAssistant(A, A_PW, s1)
  check("A[xie] assistant replied", Boolean(a1), a1.slice(0, 80))

  // 2. Wait until the capture is searchable in Cognee.
  let hit = false
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const r = await recall(e2eToken, e2eDs, SECRET)
    hit = Array.isArray(r.body) && r.body.some((x) => String(x.text ?? "").includes(SECRET))
    if (hit) break
    await new Promise((res) => setTimeout(res, 5_000))
  }
  check("capture reached Cognee", hit, hit ? "secret found in u_xieyucheng" : "timeout")
  if (hit) {
    // Let the background graph extraction finish so the API is not blocked for the cross-instance recall.
    await new Promise((res) => setTimeout(res, 30_000))
  }

  // 3. Same identity on instance B -> recall.
  const s2 = await createSession(B, B_PW, "e2e same identity")
  await setIdentity(B, B_PW, s2, "e2e")
  await prompt(B, B_PW, s2, "我们的项目徽章编号是什么？只回答代号；如果不知道就回答 UNKNOWN。")
  const b1 = await waitAssistant(B, B_PW, s2)
  check("B[xie] recalled across instances", b1.includes(SECRET), b1.slice(0, 120))

  // 4. Different identity on instance B -> no xie memory.
  const s3 = await createSession(B, B_PW, "e2e isolation")
  await setIdentity(B, B_PW, s3, "yingxin")
  await prompt(B, B_PW, s3, "我们的项目徽章编号是什么？只回答代号；如果不知道就回答 UNKNOWN。")
  const b2 = await waitAssistant(B, B_PW, s3)
  check("B[ying] isolated from xie memory", !b2.includes(SECRET), b2.slice(0, 120))

  // 5. Direct Cognee ACL: ying cannot read xie's dataset by id.
  const denied = await recall(yingToken, xieDs, SECRET)
  check("ying token reading xie dataset denied", denied.status === 403, `HTTP ${denied.status}`)

  // 6. And ying can read its own dataset.
  const own = await recall(yingToken, yingDs, "deployment")
  check("ying token reads own dataset", own.status === 200, `HTTP ${own.status}`)

  const failed = facts.filter((f) => !f.ok)
  console.log(`\n${facts.length - failed.length}/${facts.length} checks passed`)
  if (failed.length) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
