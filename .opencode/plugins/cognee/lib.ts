/**
 * Shared pure helpers for the opencode-cognee plugin and its node scripts.
 *
 * Importable from both the TypeScript plugin (`./lib.ts`) and plain node
 * scripts (`../.opencode/plugins/cognee/lib.ts`, via node type-stripping).
 * Keep this file free of imports and erasable-syntax-only TypeScript so both
 * loaders accept it: no enums, namespaces, or parameter properties.
 */

export const DEFAULT_IDENTITY_KEY = "auth.user_id"
export const DEFAULT_DATASET_PREFIX = "u_"

export interface UserCredential {
  email: string
  password: string
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

/**
 * Canonical dataset name for an identity. All scripts and the plugin must use
 * this (never hand-rolled variants) so one identity maps to one dataset.
 */
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

import { createHash } from "node:crypto"

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export interface RecallHit {
  text: string
  dataset?: string
  source?: string
}

/**
 * Render retrieved hits as an untrusted memory block, bounded by maxChars
 * (header included). Uses a `for` loop so the budget actually stops output.
 */
export function renderMemory(hits: RecallHit[], maxChars: number): string {
  // Header is user-visible prompt text: keep it stable. Hits are untrusted.
  const header = "长期记忆（该用户的私有记忆，可作为事实参考）："
  const lines = [header]
  let used = header.length
  for (let i = 0; i < hits.length; i++) {
    const text = hits[i].text.replace(/\s+/g, " ").trim()
    if (!text) continue
    const remaining = maxChars - used - 1 // -1 for the joining newline
    if (remaining < 60) break
    const clipped = text.length > 240 ? text.slice(0, 240) + "…" : text
    let line = `- (${i + 1}) ${clipped}`
    if (line.length > remaining) line = line.slice(0, remaining)
    lines.push(line)
    used += line.length + 1 // +1 for the joining newline
  }
  return lines.join("\n")
}

export type SessionMessage = {
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
