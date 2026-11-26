#!/usr/bin/env node
/**
 * Migrate opencode-mem (SQLite / libsql) memories into Cognee.
 *
 * Usage:
 *   node scripts/migrate-mem.mjs \
 *     --dir /path/to/opencode-mem \
 *     --identity xieyucheng \
 *     --base-url http://cognee.cognee-trial.svc.cluster.local:8001 \
 *     --email xieyucheng@link-seek.dev --password '...' \
 *     [--batch 40] [--limit 0] [--dry-run] [--delay-ms 500] \
 *     [--state ./migration-xieyucheng.json] [--jsonl ./legacy-xieyucheng.jsonl] \
 *     [--profile-user xieyucheng@outlook.com]
 *
 * Reads `projects/*.db` (table `memories`) and optionally `user-profiles.db`.
 * Every memory keeps its id as an HTML comment so re-runs can be audited.
 * Imported ids are recorded in the state file; re-running skips them.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs"
import { join, basename } from "node:path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

const args = process.argv.slice(2)
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < args.length) return args[i + 1]
  return dflt
}
function flag(name) {
  return args.includes(`--${name}`)
}
function required(name) {
  const value = arg(name)
  if (!value) {
    console.error(`missing --${name}`)
    process.exit(2)
  }
  return value
}

const dir = required("dir")
const identity = required("identity")
const baseUrl = required("base-url").replace(/\/+$/, "")
const email = required("email")
const password = required("password")
const batchSize = Number(arg("batch", "40"))
const limit = Number(arg("limit", "0"))
const delayMs = Number(arg("delay-ms", "500"))
const dryRun = flag("dry-run")
const statePath = arg("state", `./migration-${identity}.json`)
const jsonlPath = arg("jsonl", "")
const profileUsers = args.flatMap((a, i) => (a === "--profile-user" ? [args[i + 1]] : [])).filter(Boolean)

function scrub(text) {
  return String(text ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]")
    .replace(/(api[_-]?key|token|secret|password|passwd|pwd|auth|bearer|access[_-]?key|密码|口令)\s*[:：=]\s*['"]?[^\s'"'"'，。]+/gi, "$1=[REDACTED]")
    .replace(/\b(AKIA|SK|ghp_|gho_|ghu_|xox[abp]|sk-)[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED]")
    .replace(/\b(root|admin|administrator)\s*[/:：]\s*[^\s,，。;；]+/gi, "$1/[REDACTED]")
}

function openDb(path) {
  return new DatabaseSync(path, { readOnly: true })
}

function listProjectDbs(root) {
  const projects = join(root, "projects")
  if (!existsSync(projects)) return []
  return readdirSync(projects)
    .filter((name) => name.endsWith(".db") && !name.endsWith("-tshm"))
    .map((name) => join(projects, name))
}

function collectMemories(root) {
  const out = []
  for (const path of listProjectDbs(root)) {
    const db = openDb(path)
    const rows = db
      .prepare(
        `SELECT id, content, type, tags, project_name, project_path, session_id, created_at, metadata, display_name, user_name, user_email
         FROM memories WHERE deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .all()
    for (const row of rows) out.push({ ...row, source_db: basename(path) })
    db.close()
  }
  return out.sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))
}

function collectProfiles(root) {
  const path = join(root, "user-profiles.db")
  if (!existsSync(path)) return []
  const db = openDb(path)
  let rows = []
  try {
    rows = db.prepare("SELECT user_id, user_name, user_email, profile_data, total_prompts_analyzed FROM user_profiles").all()
  } finally {
    db.close()
  }
  if (profileUsers.length > 0) {
    const wanted = new Set(profileUsers.map((v) => v.toLowerCase()))
    rows = rows.filter((r) => wanted.has(String(r.user_email).toLowerCase()) || wanted.has(String(r.user_name).toLowerCase()))
  } else {
    // Default: drop placeholder profiles; keep the instance owner plus real-email profiles.
    rows = rows.filter((r) => !/^(unknown|anonymous)$/i.test(String(r.user_email ?? "")) && !/^(unknown|anonymous)$/i.test(String(r.user_name ?? "")))
  }
  return rows
}

function renderProfile(row) {
  let data
  try {
    data = JSON.parse(row.profile_data)
  } catch {
    return ""
  }
  const section = (title, items) => {
    if (!Array.isArray(items) || items.length === 0) return ""
    const lines = items.slice(0, 40).map((item) => {
      const evidence = Array.isArray(item.evidence) ? scrub(item.evidence.slice(0, 3).join(" / ")) : ""
      const conf = typeof item.confidence === "number" ? ` confidence=${item.confidence.toFixed(2)}` : ""
      return `- **${item.category ?? title}**${conf}: ${scrub(item.description ?? "")}${evidence ? `\n  - 证据: ${evidence}` : ""}`
    })
    return `## ${title}\n${lines.join("\n")}\n`
  }
  return [
    `# User profile: ${row.user_email ?? row.user_name ?? row.user_id}`,
    `<!-- mem-profile: ${row.user_id} analyzed=${row.total_prompts_analyzed ?? 0} -->`,
    section("偏好", data.preferences),
    section("模式", data.patterns),
    section("工作流", data.workflows),
  ]
    .filter(Boolean)
    .join("\n")
}

function iso(ts) {
  const n = Number(ts)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : "unknown"
}

function renderMemory(memory) {
  return [
    `### ${memory.display_name || memory.id} (${memory.type || "memory"})`,
    `<!-- mem-id: ${memory.id} session: ${memory.session_id ?? ""} created: ${iso(memory.created_at)} -->`,
    "",
    scrub(memory.content).trim(),
    "",
    `- project: ${memory.project_name || memory.project_path || "unknown"}`,
    `- tags: ${memory.tags || ""}`,
    "",
  ].join("\n")
}

function batches(items, size, charBudget) {
  const out = []
  let current = []
  let chars = 0
  for (const item of items) {
    const text = renderMemory(item)
    if (current.length > 0 && (current.length >= size || chars + text.length > charBudget)) {
      out.push(current)
      current = []
      chars = 0
    }
    current.push(item)
    chars += text.length
  }
  if (current.length) out.push(current)
  return out
}

async function login() {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email, password, grant_type: "password" }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`login ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json()).access_token
}

async function api(path, token, init = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} ${res.status}: ${(await res.text()).slice(0, 400)}`)
  return res
}

async function ensureDataset(token) {
  const name = `u_${identity.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`
  const listed = await (await api("/api/v1/datasets", token)).json()
  const found = listed.find((d) => d.name === name)
  if (found) return found.id
  const created = await (
    await api("/api/v1/datasets", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ).json()
  return created.id
}

async function remember(token, datasetId, text, nodeSets) {
  const form = new FormData()
  form.append("raw_data", text)
  form.append("datasetId", datasetId)
  for (const tag of nodeSets) form.append("node_set", tag)
  form.append("self_improvement", "false")
  form.append("run_in_background", "true")
  await api("/api/v1/remember", token, { method: "POST", body: form })
}

function loadState() {
  if (!existsSync(statePath)) return { imported: [] }
  try {
    return JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    return { imported: [] }
  }
}

async function main() {
  if (!existsSync(dir)) throw new Error(`directory not found: ${dir}`)
  if (statSync(dir).isFile()) throw new Error(`--dir must be the opencode-mem directory, not a db file`)

  let memories = collectMemories(dir)
  if (limit > 0) memories = memories.slice(0, limit)
  const profiles = collectProfiles(dir)

  const state = loadState()
  const imported = new Set(state.imported)
  memories = memories.filter((m) => !imported.has(m.id))

  console.log(
    `identity=${identity} memories=${memories.length} profiles=${profiles.length} batch=${batchSize} state=${statePath}`,
  )

  const docs = []
  if (profiles.length > 0) {
    for (const profile of profiles) {
      const text = renderProfile(profile)
      if (text) docs.push({ kind: "profile", text, id: `profile:${profile.user_id}` })
    }
  }
  for (const batch of batches(memories, batchSize, 12_000)) {
    docs.push({
      kind: "memories",
      ids: batch.map((m) => m.id),
      text: [
        `# Legacy opencode-mem import (${identity})`,
        `<!-- batch: ${createHash("sha256").update(batch.map((m) => m.id).join(",")).digest("hex").slice(0, 16)} -->`,
        "",
        ...batch.map(renderMemory),
      ].join("\n"),
    })
  }

  const totalChars = docs.reduce((n, d) => n + d.text.length, 0)
  console.log(`documents=${docs.length} chars=${totalChars}`)
  if (dryRun) {
    console.log(docs[0]?.text?.slice(0, 2_000) ?? "(nothing to import)")
    return
  }

  if (jsonlPath) {
    mkdirSync(join(jsonlPath, ".."), { recursive: true })
    const lines = docs.map((d) => JSON.stringify(d)).join("\n")
    writeFileSync(jsonlPath, lines + "\n")
    console.log(`wrote ${jsonlPath}`)
  }

  const token = await login()
  const datasetId = await ensureDataset(token)
  console.log(`dataset=${datasetId}`)

  let done = 0
  for (const [index, doc] of docs.entries()) {
    const nodeSets = doc.kind === "profile" ? ["legacy", "profile"] : ["legacy", "episode"]
    try {
      await remember(token, datasetId, doc.text, nodeSets)
      if (doc.kind === "memories") for (const id of doc.ids) imported.add(id)
      if (doc.kind === "profile") imported.add(doc.id)
      state.imported = [...imported]
      writeFileSync(statePath, JSON.stringify(state, null, 2))
      done++
      console.log(`[${index + 1}/${docs.length}] imported ${doc.kind} (${doc.text.length} chars)`)
    } catch (error) {
      console.error(`[${index + 1}/${docs.length}] failed: ${String(error)}`)
      throw error
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  }
  console.log(`done: ${done}/${docs.length} documents`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
