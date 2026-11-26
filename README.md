# opencode-cognee

OpenCode v2 long-term memory backed by [Cognee](https://github.com/topoteretes/cognee).
Auto-recall on session start / memory intent, capture on session idle, per-user dataset
isolation through Cognee's EBAC (not application-side filtering).

## What it does

| Hook | Behavior |
|---|---|
| `session.context` | Retrieves up to `COGNEE_RECALL_TOP_K` chunks (`CHUNKS`, no LLM) from the identity's private dataset and injects them as an untrusted `<memory>` system block. First user message always recalls; later turns only on memory intent unless `COGNEE_RECALL_EVERY_TURN=1`. |
| `experimental.idle` | Distills the session into one episode with a transient model call, scrubs secrets, and writes it to `u_<identity>`. Debounced by `COGNEE_IDLE_DEBOUNCE_MS`; identical transcripts are skipped. |
| tools | `cognee_memory_search` and `cognee_memory_remember`; neither accepts a user/dataset argument. |

Identity is resolved from the session instruction entry `auth.user_id` (written by the
trusted gateway through `PUT /api/experimental/session/{id}/instructions/entries/auth.user_id`).
If no identity is bound, the plugin does **no** recall and **no** capture. It never reads a
user id from prompt text or tool input.

## Requirements

- OpenCode `2.3.0+` (v2 plugin API: `Plugin.define` + `ctx.session.hook`).
- Cognee `1.6.x` REST API with `REQUIRE_AUTHENTICATION=true` and
  `ENABLE_BACKEND_ACCESS_CONTROL=true`.
- One Cognee user per identity. The plugin logs in with that user's email/password and
  writes only to `u_<identity>`; cross-user reads are rejected by Cognee with 403.

## Install

```bash
opencode plugin add @linkseek/opencode-cognee@0.2.0
```

Then set the environment (Kubernetes Secret, never baked into the image):

```bash
COGNEE_BASE_URL=http://cognee.cognee-trial.svc.cluster.local:8001
COGNEE_USERS='{"xieyucheng":{"email":"xieyucheng@link-seek.dev","password":"..."},"yingxin":{"email":"yingxin@link-seek.dev","password":"..."}}'
# Optional single-user fallback. Only for local/single-user pods. In a shared instance
# leave this unset so a session without an identity entry fails closed.
# COGNEE_DEFAULT_USER=xieyucheng
# COGNEE_TOKEN=...            # static bearer token instead of login (single user only)
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `COGNEE_BASE_URL` | `http://cognee.cognee-trial.svc.cluster.local:8001` | Cognee REST base URL (no `/api` suffix). |
| `COGNEE_USERS` | `{}` | JSON map `identity -> {email,password}` authorized on this OpenCode instance. |
| `COGNEE_DEFAULT_USER` | empty | Fallback identity when a session has no `auth.user_id` entry. Leave empty for multi-user. |
| `COGNEE_ALLOW_DEFAULT_IDENTITY` | `true` iff default user is set | Explicitly allow the fallback; set `0` in shared instances. |
| `COGNEE_IDENTITY_KEY` | `auth.user_id` | Instruction entry key carrying the SSO subject. |
| `COGNEE_DATASET_PREFIX` | `u_` | Private dataset prefix. |
| `COGNEE_CAPTURE` / `COGNEE_RECALL` | `true` | Enable capture / recall. |
| `COGNEE_RECALL_TOP_K` | `8` | Chunks per recall. |
| `COGNEE_RECALL_EVERY_TURN` | `false` | Recall on every user turn (cost trade-off). |
| `COGNEE_IDLE_DEBOUNCE_MS` | `120000` | Minimum gap between captures in one session. |
| `COGNEE_MIN_TRANSCRIPT_CHARS` | `240` | Skip trivial sessions. |
| `COGNEE_TIMEOUT_MS` | `15000` | Per-request timeout (remember uses a longer timeout). |
| `COGNEE_MAX_INJECT_CHARS` | `4000` | Recall injection budget. |
| `COGNEE_MAX_TRANSCRIPT_CHARS` | `24000` | Transcript budget for distillation. |
| `COGNEE_DEBUG` | `false` | Verbose logs (never logs secrets). |

## Dataset / identity model

```
identity "xieyucheng" -> Cognee user xieyucheng@... -> dataset u_xieyucheng
identity "yingxin"    -> Cognee user yingxin@...    -> dataset u_yingxin
```

- A session's identity is read from `auth.user_id`; unknown identities fail closed.
- Dataset names are sanitized (`^[a-z0-9_-]`, max 64 chars) so an identity cannot escape its prefix.
- The plugin caches the dataset UUID per identity and always passes `datasetId` to
  remember/recall. Shared datasets (team/org) are intentionally not read in this version.
- `COGNEE_USERS` is an MVP credential map. For a shared multi-user instance, replace it with
  a token broker that maps the SSO subject to a short-lived Cognee JWT; do not distribute all
  users' passwords to every pod.

## Migration from opencode-mem

The migration script reads `projects/*.db` (table `memories`), filters soft-deleted rows,
preserves ids as HTML comments, scrubs credentials, batches documents, and records imported
ids in a state file so re-runs are idempotent.

```bash
node scripts/migrate-mem.mjs \
  --dir /path/to/opencode-mem \
  --identity xieyucheng \
  --base-url http://cognee.cognee-trial.svc.cluster.local:8001 \
  --email xieyucheng@link-seek.dev --password '...' \
  --batch 40 --delay-ms 500 \
  --state ./migration-xieyucheng.json \
  --jsonl ./legacy-xieyucheng.jsonl
```

Use `--dry-run` first. `--profile-user <email|name>` selects which learned profile to
import; by default placeholder profiles (`unknown`/`anonymous`) are skipped. `--limit N`
imports only the first N memories for a smoke test.

Provision users and datasets before migrating:

```bash
node scripts/provision-users.mjs \
  --base-url http://cognee.cognee-trial.svc.cluster.local:8001 \
  --users '{"xieyucheng":{"email":"xieyucheng@link-seek.dev","password":"..."}}'
```

## Development

```bash
npm install
npm test          # 15 unit tests, fake Cognee REST server, no cluster required
npm run typecheck
```

The tests cover: secret redaction, dataset sanitization, login/dataset/remember/recall,
cross-identity 403, identity fail-closed, idle capture targeting, and absence of identity
parameters in tools.

## Notes / limits

- Recall is `CHUNKS` only (0 LLM). Graph/completion search is a future option.
- Capture costs one model call per debounced idle; the deterministic fallback stores a
  scrubbed trace if the model call fails.
- Cognee must be the only writer to its data directory. Run the REST API as the sole
  writer and put the MCP server in API-proxy mode (`--api-url`) if both are needed.


## Kubernetes / image integration (link-seek)

The `opencode-tools` image bakes the plugin as a project-location file plugin:

```
/.opencode/plugins/cognee/index.ts
```

OpenCode scans the project `.opencode/plugins/` directory automatically; no `plugins`
package spec is written to `opencode.json`. This avoids the npm registry and OpenCode's
own npm cache (`~/.cache/opencode/npm`), which is required for package plugins.

Environment (from the pod Secret):

```
COGNEE_BASE_URL=http://cognee.cognee-trial.svc.cluster.local:8001
COGNEE_USERS={"xieyucheng":{...},"yingxin":{...}}
COGNEE_ALLOW_DEFAULT_IDENTITY=0
COGNEE_IDLE_DEBOUNCE_MS=60000
```

Recall is injected **twice** for reliability: appended to `event.system` and inserted
as a transient user message in `event.messages`. This deployment's provider/model ignored
either channel alone but used the fact when both carried it.
The same query reuses the cached block across tool continuations (one recall API call
per turn). Each hit is reduced to its first fact sentence (text before the first `##`)
and clipped to 240 characters; otherwise legacy batch text makes the memory ambiguous.

Cognee side: `cognee-api` (REST, sole DB writer, port 8001) + `cognee-mcp` (API proxy,
port 8000, existing `/mcp` contract), one `cognee-data` PVC, EBAC/JWT/hashed API keys.
