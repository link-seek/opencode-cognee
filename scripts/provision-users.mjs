#!/usr/bin/env node
/**
 * Provision Cognee users and their private datasets.
 *
 * Usage:
 *   node scripts/provision-users.mjs \
 *     --base-url http://cognee.cognee-trial.svc.cluster.local:8001 \
 *     --users-file ./cognee-users.json \
 *     [--api-key-for xieyucheng --api-key-name mcp-service --api-key-out ./mcp.key]
 *
 * Registration is idempotent: an existing user is treated as success.
 * The API key is written to --api-key-out (0600) and never printed.
 */
import { writeFileSync } from "node:fs"
import { arg, required, readJsonMap, datasetName, cogneeLogin, apiAuthed } from "./lib.mjs"

const baseUrl = required("base-url").replace(/\/+$/, "")
const users = readJsonMap({
  file: arg("users-file"),
  inline: arg("users"),
  label: "COGNEE_USERS map",
  fileFlag: "--users-file <path> (JSON map, 0600)",
})
const apiKeyFor = arg("api-key-for")
const apiKeyName = arg("api-key-name", "service")
const apiKeyOut = arg("api-key-out")

async function call(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  return { res, body }
}

async function main() {
  for (const [identity, creds] of Object.entries(users)) {
    const register = await call("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: creds.email, password: creds.password, is_verified: true }),
    })
    if (register.res.ok) {
      console.log(`${identity}: registered`)
    } else {
      const detail = JSON.stringify(register.body)
      if (register.res.status === 400 && /REGISTER_USER_ALREADY_EXISTS|already exists/i.test(detail)) {
        console.log(`${identity}: already registered`)
      } else {
        throw new Error(`${identity}: register failed ${register.res.status} ${detail}`)
      }
    }

    const token = await cogneeLogin(baseUrl, creds.email, creds.password)
    const name = datasetName(identity, "u_")
    const listed = await call("/api/v1/datasets", { headers: { authorization: `Bearer ${token}` } })
    if (!listed.res.ok) throw new Error(`${identity}: list datasets ${listed.res.status}`)
    const found = listed.body.find((d) => d.name === name)
    if (found) {
      console.log(`${identity}: dataset ${name} (${found.id})`)
    } else {
      const created = await call("/api/v1/datasets", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      })
      if (!created.res.ok) throw new Error(`${identity}: create dataset ${created.res.status} ${JSON.stringify(created.body)}`)
      console.log(`${identity}: dataset ${name} (${created.body.id}) created`)
    }

    if (apiKeyFor === identity) {
      const key = await call("/api/v1/auth/api-keys", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: apiKeyName }),
      })
      if (!key.res.ok) throw new Error(`${identity}: api key ${key.res.status} ${JSON.stringify(key.body)}`)
      if (apiKeyOut) {
        writeFileSync(apiKeyOut, key.body.key, { mode: 0o600 })
        console.log(`${identity}: API key written to ${apiKeyOut}`)
      } else {
        console.log(`${identity}: API key created (use --api-key-out to save it)`)
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
