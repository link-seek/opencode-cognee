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

import type { Plugin as PluginNS } from "@opencode/plugin"
import {
  DEFAULT_DATASET_PREFIX,
  DEFAULT_IDENTITY_KEY,
  buildTranscript,
  hash,
  parseUsers,
  renderMemory,
  safeDatasetName,
  scrub,
  truncate,
  type RecallHit,
  type SessionMessage,
  type UserCredential,
} from "./lib.ts"

// Named budgets (ms unless noted). Recall runs on the prompt path: keep the
// recall budget short and fail-open so a slow Cognee never stalls the user.
const BROKER_LOGIN_CAP_MS = 20_000
const DIRECT_LOGIN_CAP_MS = 20_000
const REMEMBER_TIMEOUT_MS = 150_000
const RECALL_TIMEOUT_MS = 20_000
const BREAKER_OPEN_MS = 60_000
const BREAKER_THRESHOLD = 3
const LOGIN_COOLDOWN_MS = 45_000
const CAPTURE_FAIL_BACKOFF_MS = 300_000

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

export {
  buildTranscript,
  hash,
  parseUsers,
  renderMemory,
  safeDatasetName,
  scrub,
  truncate,
  type RecallHit,
  type SessionMessage,
  type UserCredential,
} from "./lib.ts"

export interface Cfg {
  baseUrl: string
  users: Record<string, UserCredential>
  staticToken: string
  brokerUrl: string
  brokerToken: string
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

export { DEFAULT_DATASET_PREFIX, DEFAULT_IDENTITY_KEY } from "./lib.ts"

function envFlag(value: string | undefined, dflt: boolean) {
  if (value === undefined || value === "") return dflt
  return !["0", "false", "no", "off"].includes(value.toLowerCase())
}

function envInt(value: string | undefined, dflt: number) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
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
    brokerUrl: (env.COGNEE_BROKER_URL ?? "").replace(/\/+$/, ""),
    brokerToken: env.COGNEE_BROKER_TOKEN ?? "",
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

/** Minimal Cognee REST client bound to one identity. */
export class CogneeClient {
  private token = ""
  private tokenExpiresAt = 0
  private readonly datasets = new Map<string, string>()
  private failures = 0
  private openUntil = 0
  private loginInflight: Promise<void> | null = null
  private datasetInflight: Promise<string> | null = null
  private loginCooldownUntil = 0
  private lastLoginError: unknown = null
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
    if (this.cfg.brokerUrl) {
      const res = await fetch(`${this.cfg.brokerUrl}/token`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.brokerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ identity: this.identity }),
        signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs, BROKER_LOGIN_CAP_MS)),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new CogneeError(`token broker rejected ${this.identity}: ${res.status}`, res.status, text.slice(0, 300))
      }
      const data = (await res.json()) as { token?: string; expiresAt?: number }
      if (!data.token) throw new CogneeError("token broker returned no token", 500, "")
      this.token = data.token
      // NOTE: `||`, not `??` — tokenExpiry() returns 0 (not nullish) for opaque tokens.
      this.tokenExpiresAt = data.expiresAt || tokenExpiry(this.token) || Date.now() + 50 * 60_000
      log(this.cfg, `broker token for ${this.identity}`)
      return
    }
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
      signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs, DIRECT_LOGIN_CAP_MS)),
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
    if (!force && this.loginInflight) {
      await this.loginInflight
      return
    }
    if (!force && Date.now() < this.loginCooldownUntil) throw this.lastLoginError
    const attempt = (async () => {
      try {
        await this.login()
      } catch (error) {
        // Negative result: back off so bad credentials don't hammer Cognee per query.
        this.loginCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS
        this.lastLoginError = error
        throw error
      }
    })()
    if (!force) this.loginInflight = attempt
    try {
      await attempt
    } finally {
      if (!force && this.loginInflight === attempt) this.loginInflight = null
    }
  }

  private breakerOpen(): boolean {
    return Date.now() < this.openUntil
  }

  private tripBreaker() {
    this.failures++
    if (this.failures >= BREAKER_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_OPEN_MS
      this.failures = 0
      warn(`Cognee circuit open for ${this.identity} (60s)`)
    }
  }

  /**
   * `rebuildBody` rebuilds a one-shot request body (e.g. FormData) for the 401
   * retry; without it a consumed multipart body would be re-sent empty.
   */
  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
    retry = true,
    rebuildBody?: () => BodyInit,
  ): Promise<Response> {
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
      return this.request(
        path,
        rebuildBody ? { ...init, body: rebuildBody() } : init,
        timeoutMs,
        false,
      )
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      // Deterministic client errors (ACL, bad request) must not open the circuit:
      // retrying them is pointless and would DoS this identity's memory for 60s.
      if (res.status >= 400 && res.status < 500) {
        throw new CogneeError(`Cognee ${init.method ?? "GET"} ${path} -> ${res.status}`, res.status, text.slice(0, 500))
      }
      this.tripBreaker()
      throw new CogneeError(`Cognee ${init.method ?? "GET"} ${path} -> ${res.status}`, res.status, text.slice(0, 500))
    }
    this.failures = 0
    return res
  }

  /** Forget a cached dataset id (e.g. after a 403/404 using it). */
  dropDataset(): void {
    this.datasets.delete(safeDatasetName(this.identity, this.cfg.datasetPrefix))
  }

  async ensureDataset(): Promise<string> {
    const name = safeDatasetName(this.identity, this.cfg.datasetPrefix)
    const cached = this.datasets.get(name)
    if (cached) return cached
    if (this.datasetInflight) return this.datasetInflight
    const run = (async () => {
      const listed = (await (await this.request("/api/v1/datasets")).json()) as Array<{ id: string; name: string }>
      const found = listed.find((d) => d.name === name)
      if (found) {
        this.datasets.set(name, found.id)
        return found.id
      }
      try {
        const res = await this.request("/api/v1/datasets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        })
        const created = (await res.json()) as { id: string; name: string }
        // Cache under the requested name: server-side normalization must not
        // defeat the cache on the next call.
        this.datasets.set(name, created.id)
        log(this.cfg, `created dataset ${created.name}`)
        return created.id
      } catch (error) {
        if (error instanceof CogneeError && error.status === 409) {
          // Lost a create race: re-list and use the winner's id.
          const relisted = (await (await this.request("/api/v1/datasets")).json()) as Array<{
            id: string
            name: string
          }>
          const winner = relisted.find((d) => d.name === name)
          if (winner) {
            this.datasets.set(name, winner.id)
            return winner.id
          }
        }
        throw error
      }
    })()
    this.datasetInflight = run
    try {
      return await run
    } finally {
      if (this.datasetInflight === run) this.datasetInflight = null
    }
  }

  /** Run `fn` with the dataset id; on 403/404 evict the cached id and retry once. */
  private async withFreshDataset<T>(fn: (datasetId: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.ensureDataset())
    } catch (error) {
      if (error instanceof CogneeError && (error.status === 403 || error.status === 404)) {
        this.dropDataset()
        return fn(await this.ensureDataset())
      }
      throw error
    }
  }

  async remember(text: string, nodeSets: string[]): Promise<void> {
    const buildForm = (datasetId: string) => {
      const form = new FormData()
      form.append("raw_data", text)
      form.append("datasetId", datasetId)
      for (const tag of nodeSets) form.append("node_set", tag)
      form.append("self_improvement", "false")
      form.append("run_in_background", "true")
      return form
    }
    await this.withFreshDataset(async (datasetId) => {
      await this.request(
        "/api/v1/remember",
        { method: "POST", body: buildForm(datasetId) },
        REMEMBER_TIMEOUT_MS,
        true,
        () => buildForm(datasetId),
      )
    })
  }

  async recall(query: string, topK: number): Promise<RecallHit[]> {
    return this.withFreshDataset(async (datasetId) => {
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
        RECALL_TIMEOUT_MS,
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
    })
  }
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
    if (cfg.brokerUrl && Object.keys(cfg.users).length > 0) {
      // Defense in depth: in broker mode the pods must hold only the broker token.
      // Plaintext Cognee passwords in pod env defeat the isolation model.
      warn(`COGNEE_USERS is set but ignored in broker mode for ${Object.keys(cfg.users).join(",")}; keep passwords only in the broker Secret`)
    }
    const clients = new Map<string, CogneeClient>()
    const identityCache = new Map<string, { value: string | null; at: number }>()
    const recallCache = new Map<string, { sig: string; text: string; identity: string }>()
    const seenUser = new Set<string>()
    const lastCapture = new Map<string, { hash: string; at: number }>()
    const captureInflight = new Set<string>()
    const captureFailAt = new Map<string, number>()

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
        // Fail closed: a lookup error must never bind the session to the shared
        // default identity (that would mix tenants' recall/capture). The default
        // applies only when the lookup succeeded and found no entry.
        log(cfg, `identity lookup failed for ${sessionID}: ${String(error)}`)
        value = null
      }
      if (value && cfg.brokerUrl) {
        // No local credential check: the broker is the authority and rejects
        // unknown identities at token time (fail-closed there too).
      } else if (value && cfg.staticToken && value !== cfg.defaultUser) {
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

    /**
     * Inject recalled memory into both channels. Dual injection is deliberate:
     * the `event.system` block is the canonical channel, while the transient
     * user message is a workaround for providers that under-weight appended
     * system content (verified: recall broke when the user-channel copy was
     * removed). Do not "dedupe" this without re-running the two-instance E2E.
     * See README "Recall injection" for the full rationale.
     */
    const injectMemory = (event: { messages: unknown[]; system: unknown[] }, text: string) => {
      event.messages.unshift({ role: "user", content: [{ type: "text", text }] } as never)
      event.system.push({ type: "text", text } as never)
    }

    if (cfg.capture) {
      await ctx.session.hook("experimental.idle", async ({ sessionID, background }) => {
        if (background.length > 0) return // let background work finish; idle fires again
        const identity = await resolveIdentity(sessionID)
        if (!identity) return
        const previous = lastCapture.get(sessionID)
        if (previous && Date.now() - previous.at < cfg.idleDebounceMs) return
        const failAt = captureFailAt.get(sessionID) ?? 0
        if (Date.now() - failAt < CAPTURE_FAIL_BACKOFF_MS) return
        if (captureInflight.has(sessionID)) return // concurrent idle: one capture at a time
        captureInflight.add(sessionID)

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
            // Skip: persisting raw transcript when the distiller (the safety
            // layer) failed would store the most secret-rich text verbatim.
            lastCapture.set(sessionID, { hash: transcriptHash, at: Date.now() })
            return
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
          captureFailAt.set(sessionID, Date.now())
        } finally {
          captureInflight.delete(sessionID)
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
        // The cache entry carries its identity: a session rebound to another
        // identity must never receive the previous identity's memory block.
        if (cached && cached.identity === identity && cached.sig === signature) {
          if (cached.text) injectMemory(event as unknown as { messages: unknown[]; system: unknown[] }, cached.text)
          return
        }
        const first = !seenUser.has(event.sessionID)
        seenUser.add(event.sessionID)
        if (!first && !cfg.recallEveryTurn && !INTENT_RE.test(query)) return

        try {
          const hits = await clientFor(identity).recall(truncate(query, 2_000), cfg.recallTopK)
          const text = hits.length > 0 ? renderMemory(hits, cfg.maxInjectChars) : ""
          recallCache.set(event.sessionID, { sig: signature, text, identity })
          if (!text) return
          injectMemory(event as unknown as { messages: unknown[]; system: unknown[] }, text)
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
