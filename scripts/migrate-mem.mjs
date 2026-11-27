#!/usr/bin/env node
/**
 * Migrate opencode-mem (SQLite / libsql) memories into Cognee.
 *
 * Usage:
 *   node scripts/migrate-mem.mjs \
 *     --dir /path/to/opencode-mem \
 *     --identity xieyucheng \
 *     --base-url http://cognee.cognee-trial.svc.cluster.local:8001 \
 *     --email xieyucheng@link-seek.dev --password-env COGNEE_PW_XIE \
 *     [--batch 40] [--limit 0] [--dry-run] [--delay-ms 500] \
 *     [--state ./migration-xieyucheng.json] [--jsonl ./legacy-xieyucheng.jsonl] \
 *     [--profile-user xieyucheng@outlook.com]
 *
 * Reads `projects/*.db` (table `memories`) and optionally `user-profiles.db`.
 * Every memory keeps its id as an HTML comment so re-runs can be audited.
 * Imported ids are recorded in the state file; re-running skips them.
 */
import { join, basename, dirname } from "node:path"
import { createHash } from "node:crypto"
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import {
  arg,
  flag,
  required,
  num,
  scrub,
  datasetName,
  cogneeLogin,
  apiAuthed,
  ensureDataset as ensureCogneeDataset,
  rememberForm,
} from "./lib.mjs"

const dir = required("dir")
const identity = required("identity")
const baseUrl = required("base-url").replace(/\/+$/, "")
const email = required("email")
const passwordEnv = arg("password-env")
const password = (passwordEnv ? process.env[passwordEnv] : undefined) ?? (() => {
  console.error("missing Cognee password: use --password-env <ENV_VAR> (the --password flag was removed: it leaks via ps)")
  process.exit(2)
})()
const batchSize = num("batch", 40, { min: 1 })
const limit = num("limit", 0)
const delayMs = num("delay-ms", 500)
const maxPending = num("max-pending", 3)
const queueTimeoutMs = num("queue-timeout", 900, { min: 1 }) * 1000
const dryRun = flag("dry-run")
const statePath = arg("state", `./migration-${identity}.json`)
const jsonlPath = arg("jsonl", "")
const profileUsers = process.argv.slice(2).flatMap((a, i, all) => (a === "--profile-user" ? [all[i + 1]] : [])).filter(Boolean)

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

const login = () => cogneeLogin(baseUrl, email, password)
const ensureDataset = (token) => ensureCogneeDataset(baseUrl, token, datasetName(identity, "u_"))

async function waitForQueue(token, datasetId) {
  const deadline = Date.now() + queueTimeoutMs
  for (;;) {
    const status = await apiAuthed(baseUrl, token, `/api/v1/datasets/${datasetId}/processing-status`, {}, 30_000)
    const pending = Number(status.pending ?? 0)
    if (pending <= maxPending) return
    if (Date.now() > deadline) {
      console.warn(`queue still has ${pending} pending items after ${queueTimeoutMs / 1000}s; continuing`)
      return
    }
    console.log(`queue pending=${pending}; waiting...`)
    await new Promise((r) => setTimeout(r, 5_000))
  }
}

async function remember(token, datasetId, text, nodeSets) {
  await apiAuthed(baseUrl, token, "/api/v1/remember", { method: "POST", body: rememberForm(datasetId, text, nodeSets) }, 180_000)
}

function loadState() {
  if (!existsSync(statePath)) return { imported: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"))
  } catch (error) {
    console.error(`state file ${statePath} is not valid JSON: ${String(error)}`)
    process.exit(2)
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.imported)) {
    console.error(`state file ${statePath} is corrupt: expected {"imported": [...]}`)
    process.exit(2)
  }
  return parsed
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
      const id = `profile:${profile.user_id}`
      if (imported.has(id)) continue // idempotent: profiles are skipped like memories
      const text = renderProfile(profile)
      if (text) docs.push({ kind: "profile", text, id })
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
    mkdirSync(dirname(jsonlPath), { recursive: true })
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
      await waitForQueue(token, datasetId)
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
