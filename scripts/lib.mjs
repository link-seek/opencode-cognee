/**
 * Shared helpers for the node scripts (provision/migrate/e2e).
 *
 * Single home for: CLI arg parsing, Cognee login/dataset/remember calls, and
 * the canonical dataset-name + scrub implementations (re-exported from the
 * plugin's lib.ts so scripts and the plugin can never diverge).
 */
import { readFileSync } from "node:fs"
import { safeDatasetName as canonicalDatasetName, scrub as baseScrub } from "../.opencode/plugins/cognee/lib.ts"

export { canonicalDatasetName as datasetName }

/** Plugin scrub + migration extras (Chinese punctuation, bare `root:pw` pairs). */
export function scrub(text) {
  return baseScrub(String(text ?? ""))
    .replace(/(密码|口令)\s*[:：=]\s*['"]?[^\s'"'，。]+/gi, "$1=[REDACTED]")
    .replace(/\b(root|admin|administrator)\s*[/:：]\s*[^\s,，。;；]+/gi, "$1/[REDACTED]")
}

const rawArgs = process.argv.slice(2)

export function arg(name, dflt) {
  const i = rawArgs.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < rawArgs.length) return rawArgs[i + 1]
  return dflt
}

export function flag(name) {
  return rawArgs.includes(`--${name}`)
}

export function required(name) {
  const value = arg(name)
  if (!value) {
    console.error(`missing --${name}`)
    process.exit(2)
  }
  return value
}

/** Numeric CLI arg: fail fast instead of looping forever on NaN downstream. */
export function num(name, dflt, { min = 0 } = {}) {
  const raw = arg(name, String(dflt))
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) {
    console.error(`invalid --${name}=${raw}: must be a number >= ${min}`)
    process.exit(2)
  }
  return value
}

/** Read a JSON map from a file (0600-friendly) or, with a warning, from a flag. */
export function readJsonMap({ file, inline, label, fileFlag }) {
  if (file) {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      console.error(`cannot read ${label} from ${file}: ${String(error)}`)
      process.exit(2)
    }
  }
  if (inline) {
    console.error(`WARNING: passing ${label} on the command line exposes secrets via ps; prefer ${fileFlag}`)
    return JSON.parse(inline)
  }
  console.error(`missing ${label}: use ${fileFlag}`)
  process.exit(2)
}

export async function cogneeLogin(baseUrl, email, password, timeoutMs = 20_000) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email, password, grant_type: "password" }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  if (!res.ok || !body.access_token) {
    throw new Error(`cognee login ${email} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body.access_token
}

export async function apiAuthed(baseUrl, token, path, init = {}, timeoutMs = 30_000) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

export async function ensureDataset(baseUrl, token, name) {
  const listed = await apiAuthed(baseUrl, token, "/api/v1/datasets")
  const found = listed.find((d) => d.name === name)
  if (found) return found.id
  const created = await apiAuthed(baseUrl, token, "/api/v1/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })
  return created.id
}

export function rememberForm(datasetId, text, nodeSets) {
  const form = new FormData()
  form.append("raw_data", text)
  form.append("datasetId", datasetId)
  for (const tag of nodeSets) form.append("node_set", tag)
  form.append("self_improvement", "false")
  form.append("run_in_background", "true")
  return form
}
