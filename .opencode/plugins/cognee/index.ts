/**
 * OpenCode v2 -> Cognee long-term memory plugin (REST transport).
 *
 * Design notes (see the RFC in issue #2 and README.md):
 * - Identity comes from the session instruction entry `auth.user_id` (set by the SSO
 *   gateway), never from model/prompt input. No identity -> no recall, no capture.
 * - Every identity logs in to Cognee as its own user and writes to `u_<identity>`.
 *   Dataset isolation is enforced by Cognee EBAC, not by this plugin.
 * - Recall is retrieval-only (CHUNKS), no LLM call. Capture runs on session idle and
 *   is distilled with one transient model call (debounced).
 * - Secrets are scrubbed before anything leaves the process.
 */

import { createHash } from "node:crypto"
import type { Plugin as PluginNS } from "@opencode/plugin"

export const DEFAULT_IDENTITY_KEY = "auth.user_id"
export const DEFAULT_DATASET_PREFIX = "u_"

const INTENT_RE =
  /(上次|之前|以前|历史|记得|回忆|为什么|当初|当时|决定|结论|踩坑|教训|约定|规范|previous|last time|remember|earlier|decision|why did|what did we)/i

const EPISODE_PROMPT = `You are a memory distiller for a coding agent.
Turn the transcript into at most one durable memory entry.

Rules:
- Markdown, at most 1200 characters.
- Sections: "## Request", "## Outcome", "## Decisions", "## Errors", "## Tags".
- Keep only knowledge that cannot be derived from the repository: user preferences,
  decisions and their reasons, corrections, unresolved bugs, environment facts.
- Never include secrets, tokens, passwords, private keys, API keys, or personal data.
- Do not include tool output verbatim; summarize it.
- If nothing is worth keeping, output exactly: SKIP
- Write in the same language as the transcript.`

export interface UserCredential {
  email: string
  password: string
}

export interface Cfg {
  baseUrl: string
  users: Record<string, UserCredential>
  staticToken: string
  defaultUser: string
  allowDefaultIdentity: boolean
  identityKey: string
  datasetPrefix: string
  capture: boolean
  recall: boolean
  recallTopK: number
  recallEveryTurn: boolean
  idleDebounceMs: number
  minTranscriptChars: number
  timeoutMs: number
  maxInjectChars: number
  maxTranscriptChars: number
  debug: boolean
}

function envFlag(value: string | undefined, dflt: boolean) {
  if (value === undefined || value === "") return dflt
  return !["0", "false", "no", "off"].includes(value.toLowerCase())
}

function envInt(value: string | undefined, dflt: number) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

/** Parse `COGNEE_USERS` (JSON map of identity -> {email,password}). Invalid entries are dropped. */
export function parseUsers(raw: string | undefined): Record<string, UserCredential> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, UserCredential> = {}
    for (const [identity, value] of Object.entries(parsed)) {
      const v = value as Partial<UserCredential>
      if (typeof v?.email === "string" && typeof v?.password === "string" && v.email && v.password) {
        out[identity] = { email: v.email, password: v.password }
      }
    }
    return out
  } catch {
    return {}
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Cfg {
  const users = parseUsers(env.COGNEE_USERS)
  const singleEmail = env.COGNEE_USER_EMAIL
  const singlePassword = env.COGNEE_USER_PASSWORD
  const singleUser = env.COGNEE_USER || env.COGNEE_DEFAULT_USER
  if (singleUser && singleEmail && singlePassword && !users[singleUser]) {
    users[singleUser] = { email: singleEmail, password: singlePassword }
  }
  return {
    baseUrl: (env.COGNEE_BASE_URL ?? "http://cognee.cognee-trial.svc.cluster.local:8001").replace(/\/+$/, ""),
    users,
    staticToken: env.COGNEE_TOKEN ?? "",
    defaultUser: env.COGNEE_DEFAULT_USER ?? "",
    allowDefaultIdentity: envFlag(env.COGNEE_ALLOW_DEFAULT_IDENTITY, Boolean(env.COGNEE_DEFAULT_USER)),
    identityKey: env.COGNEE_IDENTITY_KEY ?? DEFAULT_IDENTITY_KEY,
    datasetPrefix: env.COGNEE_DATASET_PREFIX ?? DEFAULT_DATASET_PREFIX,
    capture: envFlag(env.COGNEE_CAPTURE, true),
    recall: envFlag(env.COGNEE_RECALL, true),
    recallTopK: envInt(env.COGNEE_RECALL_TOP_K, 8),
    recallEveryTurn: envFlag(env.COGNEE_RECALL_EVERY_TURN, false),
    idleDebounceMs: envInt(env.COGNEE_IDLE_DEBOUNCE_MS, 120_000),
    minTranscriptChars: envInt(env.COGNEE_MIN_TRANSCRIPT_CHARS, 240),
    timeoutMs: envInt(env.COGNEE_TIMEOUT_MS, 15_000),
    maxInjectChars: envInt(env.COGNEE_MAX_INJECT_CHARS, 4_000),
    maxTranscriptChars: envInt(env.COGNEE_MAX_TRANSCRIPT_CHARS, 24_000),
    debug: envFlag(env.COGNEE_DEBUG, false),
  }
}

function log(cfg: Cfg, ...args: unknown[]) {
  if (cfg.debug) console.error("[opencode-cognee]", ...args)
}

function warn(...args: unknown[]) {
  console.error("[opencode-cognee]", ...args)
}

/** Redact credential-shaped content before it leaves the process. */
export function scrub(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/(api[_-]?key|token|secret|password|passwd|pwd|auth|bearer|access[_-]?key)\s*[:=]\s*['"]?[^\s'"]+/gi, "$1=[REDACTED]")
    .replace(/\b(AKIA|SK|ghp_|gho_|ghu_|xox[abp]|sk-)[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]")
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n[truncated]" : text
}

export function safeDatasetName(identity: string, prefix: string): string {
  const safe = identity
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 64)
  return `${prefix}${safe}`
}

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

export class CogneeError extends Error {
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

interface RecallHit {
  text: string
  dataset?: string
  source?: string
}

/** Minimal Cognee REST client bound to one identity. */
export class CogneeClient {
  private token = ""
  private tokenExpiresAt = 0
  private readonly datasets = new Map<string, string>()
  private failures = 0
  private openUntil = 0
  readonly cfg: Cfg
  readonly identity: string

  constructor(cfg: Cfg, identity: string) {
    this.cfg = cfg
    this.identity = identity
  }

  private creds(): UserCredential | undefined {
    return this.cfg.users[this.identity]
  }

  private async login(): Promise<void> {
    if (this.cfg.staticToken) {
      if (this.identity !== this.cfg.defaultUser) {
        throw new CogneeError(`static token mode only allows identity ${this.cfg.defaultUser}`, 401, "")
      }
      this.token = this.cfg.staticToken
      const exp = tokenExpiry(this.token)
      this.tokenExpiresAt = exp || Date.now() + 50 * 60_000
      return
    }
    const creds = this.creds()
    if (!creds) throw new CogneeError(`no Cognee credentials for identity ${this.identity}`, 401, "")
    const body = new URLSearchParams({
      username: creds.email,
      password: creds.password,
      grant_type: "password",
    })
    const res = await fetch(`${this.cfg.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs, 20_000)),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new CogneeError(`Cognee login failed for ${this.identity}: ${res.status}`, res.status, text.slice(0, 300))
    }
    const data = (await res.json()) as { access_token?: string }
    if (!data.access_token) throw new CogneeError("Cognee login returned no access_token", 500, "")
    this.token = data.access_token
    this.tokenExpiresAt = tokenExpiry(this.token) || Date.now() + 50 * 60_000
    log(this.cfg, `logged in as ${this.identity}`)
  }

  private async ensureToken(force = false): Promise<void> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 30_000) return
    await this.login()
  }

  private breakerOpen(): boolean {
    return Date.now() < this.openUntil
  }

  private tripBreaker() {
    this.failures++
    if (this.failures >= 3) {
      this.openUntil = Date.now() + 60_000
      this.failures = 0
      warn(`Cognee circuit open for ${this.identity} (60s)`)
    }
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs?: number, retry = true): Promise<Response> {
    if (this.breakerOpen()) throw new CogneeError("Cognee circuit open", 503, "")
    await this.ensureToken()
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${this.token}`)
    let res: Response
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs ?? this.cfg.timeoutMs),
      })
    } catch (error) {
      this.tripBreaker()
      throw error
    }
    if (res.status === 401 && retry) {
      await this.ensureToken(true)
      return this.request(path, init, timeoutMs, false)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      this.tripBreaker()
      throw new CogneeError(`Cognee ${init.method ?? "GET"} ${path} -> ${res.status}`, res.status, text.slice(0, 500))
    }
    this.failures = 0
    return res
  }

  async ensureDataset(): Promise<string> {
    const name = safeDatasetName(this.identity, this.cfg.datasetPrefix)
    const cached = this.datasets.get(name)
    if (cached) return cached
    const listed = (await (await this.request("/api/v1/datasets")).json()) as Array<{ id: string; name: string }>
    const found = listed.find((d) => d.name === name)
    if (found) {
      this.datasets.set(name, found.id)
      return found.id
    }
    const res = await this.request("/api/v1/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
    const created = (await res.json()) as { id: string; name: string }
    this.datasets.set(created.name, created.id)
    log(this.cfg, `created dataset ${created.name}`)
    return created.id
  }

  async remember(text: string, nodeSets: string[]): Promise<void> {
    const datasetId = await this.ensureDataset()
    const form = new FormData()
    form.append("raw_data", text)
    form.append("datasetId", datasetId)
    for (const tag of nodeSets) form.append("node_set", tag)
    form.append("self_improvement", "false")
    form.append("run_in_background", "true")
    await this.request("/api/v1/remember", { method: "POST", body: form }, 150_000)
  }

  async recall(query: string, topK: number): Promise<RecallHit[]> {
    const datasetId = await this.ensureDataset()
    const res = await this.request(
      "/api/v1/recall",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          datasetIds: [datasetId],
          searchType: "CHUNKS",
          onlyContext: true,
          topK,
        }),
      },
      20_000,
    )
    const items = (await res.json()) as Array<Record<string, unknown>>
    const out: RecallHit[] = []
    for (const item of items) {
      const text = [item.text, item.answer, item.context].find(
        (v): v is string => typeof v === "string" && Boolean(v.trim()),
      )
      if (!text) continue
      out.push({
        text: text.trim(),
        dataset: typeof item.dataset_name === "string" ? item.dataset_name : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
      })
    }
    return out
  }
}

/** Render retrieved hits as an untrusted memory block. */
export function renderMemory(hits: RecallHit[], maxChars: number): string {
  const lines = ["长期记忆（该用户的私有记忆，可作为事实参考）："]
  let used = 0
  hits.forEach((hit, i) => {
    const text = hit.text.replace(/\s+/g, " ").trim()
    if (!text) return
    const remaining = maxChars - used
    if (remaining < 60) return
    const fact = text.split(/\s*##\s*/)[0].trim()
    const clipped = fact.length > 240 ? fact.slice(0, 240) + "…" : fact
    const line = `- (${i + 1}) ${clipped}`
    lines.push(line)
    used += line.length
  })
  return lines.join("\n")
}

type SessionMessage = {
  type?: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
}

/** Convert stored session messages to a compact transcript. */
export function buildTranscript(messages: readonly SessionMessage[], maxChars: number): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.type === "user" && typeof msg.text === "string" && msg.text.trim()) {
      lines.push(`[user] ${msg.text.trim()}`)
    } else if (msg.type === "assistant" && Array.isArray(msg.content)) {
      const text = msg.content
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n")
      if (text) lines.push(`[assistant] ${text}`)
    }
  }
  return truncate(lines.join("\n\n"), maxChars)
}

/** Extract text from one request message (`{role, content}`). */
function requestMessageText(message: unknown): string {
  const m = message as { role?: string; content?: unknown }
  if (m?.role !== "user") return ""
  if (typeof m.content === "string") return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p): p is { type: string; text: string } => Boolean(p) && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
  }
  return ""
}

const plugin: PluginNS.Plugin = {
  id: "cognee",
  async setup(ctx) {
    const cfg = loadConfig()
    const clients = new Map<string, CogneeClient>()
    const identityCache = new Map<string, { value: string | null; at: number }>()
    const recallCache = new Map<string, { sig: string; text: string }>()
    const seenUser = new Set<string>()
    const lastCapture = new Map<string, { hash: string; at: number }>()

    const clientFor = (identity: string) => {
      let client = clients.get(identity)
      if (!client) {
        client = new CogneeClient(cfg, identity)
        clients.set(identity, client)
      }
      return client
    }

    /**
     * Resolve the identity bound to this session. `auth.user_id` is set by the trusted
     * gateway through `session.instructions.entry`; model/prompt text is never used.
     */
    const resolveIdentity = async (sessionID: string): Promise<string | null> => {
      const cached = identityCache.get(sessionID)
      if (cached && Date.now() - cached.at < 5_000) return cached.value
      let value: string | null = null
      try {
        const entries = await ctx.session.instructions.entry.list({ sessionID })
        const entry = entries.find((e) => e.key === cfg.identityKey)
        if (entry) {
          value = typeof entry.value === "string" && entry.value.trim() ? entry.value.trim() : null
        } else if (cfg.allowDefaultIdentity) {
          value = cfg.defaultUser || null
        }
      } catch (error) {
        log(cfg, `identity lookup failed for ${sessionID}: ${String(error)}`)
        value = cfg.allowDefaultIdentity ? cfg.defaultUser || null : null
      }
      if (value && cfg.staticToken && value !== cfg.defaultUser) {
        warn(`static token mode cannot serve identity ${value}; memory disabled for this session`)
        value = null
      } else if (value && !cfg.staticToken && !cfg.users[value]) {
        warn(`identity ${value} has no Cognee credentials; memory disabled for this session`)
        value = null
      }
      identityCache.set(sessionID, { value, at: Date.now() })
      return value
    }

    const currentNodeSets = () => ["episode", `date:${new Date().toISOString().slice(0, 10)}`]

    if (cfg.capture) {
      await ctx.session.hook("experimental.idle", async ({ sessionID, background }) => {
        if (background.length > 0) return // let background work finish; idle fires again
        const identity = await resolveIdentity(sessionID)
        if (!identity) return
        const previous = lastCapture.get(sessionID)
        if (previous && Date.now() - previous.at < cfg.idleDebounceMs) return

        try {
          const messages = await ctx.session.context({ sessionID })
          const transcript = buildTranscript(messages as SessionMessage[], cfg.maxTranscriptChars)
          if (transcript.length < cfg.minTranscriptChars) return
          const transcriptHash = hash(transcript)
          if (previous?.hash === transcriptHash) return

          let summary = ""
          try {
            const info = await ctx.session.get({ sessionID })
            let model = info.model
            if (!model) {
              const dflt = await ctx.model.default()
              if (dflt.data) model = { providerID: dflt.data.providerID, id: dflt.data.id }
            }
            if (model) {
              const generated = await ctx.experimental.generate.text({
                model,
                prompt: `${EPISODE_PROMPT}\n\n<transcript>\n${transcript}\n</transcript>`,
              })
              summary = generated.text.trim()
            }
          } catch (error) {
            log(cfg, `distill failed for ${sessionID}: ${String(error)}`)
          }

          if (!summary) {
            // Deterministic fallback: keep a scrubbed, short trace without another LLM call.
            summary = `## Request\n${truncate(transcript, 1_800)}\n\n## Tags\ncapture-fallback`
          }
          if (/^SKIP$/i.test(summary)) {
            lastCapture.set(sessionID, { hash: transcriptHash, at: Date.now() })
            return
          }
          const cleaned = scrub(truncate(summary, 1_500))
          await clientFor(identity).remember(cleaned, currentNodeSets())
          lastCapture.set(sessionID, { hash: transcriptHash, at: Date.now() })
          log(cfg, `captured episode for ${identity} (${cleaned.length} chars)`)
        } catch (error) {
          warn(`capture failed for ${identity}: ${String(error)}`)
        }
      })
    }

    if (cfg.recall) {
      await ctx.session.hook("context", async (event) => {
        const identity = await resolveIdentity(event.sessionID)
        if (!identity) return

        const lastUser = [...event.messages].reverse().find((m) => (m as { role?: string }).role === "user")
        const query = requestMessageText(lastUser).trim()
        if (!query) return

        const signature = hash(query)
        const cached = recallCache.get(event.sessionID)
        if (cached?.sig === signature) {
          if (cached.text) {
            event.messages.unshift({ role: "user", content: [{ type: "text", text: cached.text }] } as any)
            event.system.push({ type: "text", text: cached.text } as any)
          }
          return
        }
        const first = !seenUser.has(event.sessionID)
        seenUser.add(event.sessionID)
        if (!first && !cfg.recallEveryTurn && !INTENT_RE.test(query)) return

        try {
          const hits = await clientFor(identity).recall(truncate(query, 2_000), cfg.recallTopK)
          const text = hits.length > 0 ? renderMemory(hits, cfg.maxInjectChars) : ""
          recallCache.set(event.sessionID, { sig: signature, text })
          if (!text) return
          event.messages.unshift({ role: "user", content: [{ type: "text", text }] } as any)
          event.system.push({ type: "text", text } as any)
          log(cfg, `recalled ${hits.length} hits for ${identity}`)
        } catch (error) {
          warn(`recall failed for ${identity}: ${String(error)}`)
        }
      })
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "cognee", description: "Long-term memory backed by Cognee" })
      editor.add({
        name: "memory_search",
        description:
          "Search the user's long-term memory for preferences, past decisions, or project facts. Use when the user refers to earlier sessions or asks why a choice was made.",
        input: {
          type: "object",
          properties: { query: { type: "string", description: "What to search for" } },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (raw: unknown, context) => {
          const input = (raw ?? {}) as { query?: unknown }
          const query = typeof input.query === "string" ? input.query.trim() : ""
          if (!query) return { content: "query is required" }
          const identity = await resolveIdentity(context.sessionID)
          if (!identity) return { content: "No memory identity is bound to this session." }
          const hits = await clientFor(identity).recall(truncate(query, 2_000), cfg.recallTopK)
          if (hits.length === 0) return { content: "No matching memories." }
          return { content: renderMemory(hits, cfg.maxInjectChars) }
        },
      })
      editor.add({
        name: "memory_remember",
        description: "Store a durable fact, preference, or decision in the user's long-term memory.",
        input: {
          type: "object",
          properties: { text: { type: "string", description: "The memory to store" } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async (raw: unknown, context) => {
          const input = (raw ?? {}) as { text?: unknown }
          const text = typeof input.text === "string" ? input.text.trim() : ""
          if (!text) return { content: "text is required" }
          const identity = await resolveIdentity(context.sessionID)
          if (!identity) return { content: "No memory identity is bound to this session." }
          await clientFor(identity).remember(scrub(truncate(text, 1_500)), currentNodeSets())
          return { content: "Stored." }
        },
      })
    })

    log(
      cfg,
      `ready: base=${cfg.baseUrl} users=${Object.keys(cfg.users).join(",") || "(none)"} capture=${cfg.capture} recall=${cfg.recall}`,
    )
  },
}

export default plugin
