# @link-seek/opencode-cognee

OpenCode **v2** native plugin for [Cognee](https://cognee.ai) persistent memory:
auto-recall on every prompt, auto-capture of completed tool traces, compaction
support, plus manual `cognee_remember` / `cognee_search` tools.

The upstream [`@cognee/cognee-opencode`](https://github.com/topoteretes/cognee-integrations/tree/main/integrations/opencode)
is V1-API only and does not load on OpenCode v2. This is a minimal V2 port
following the [official migration table](https://opencode.ai/docs/build/plugins/migrate-v1).

## Install

```sh
opencode plugin add @linkseek/opencode-cognee
```

Needs a reachable Cognee backend (self-hosted `cognee-mcp` or equivalent):

```sh
export COGNEE_BASE_URL="http://localhost:8000"
export COGNEE_API_KEY="..."        # optional, Bearer
export COGNEE_DATASET="agent_sessions"
```

In-cluster example: `http://cognee.cognee-trial.svc.cluster.local:8000`.

## Behavior

- auto-recall + auto-capture (v0.1; implementation is being reworked per the design below)
- backend down = memory degrades to no-op (warns, never breaks the session)
- credential-shaped content is scrubbed before upload, payloads truncated

## Design

Long-term memory architecture (Claude Code / Codex-aligned):

- [docs/memory-architecture.md](docs/memory-architecture.md)

Two authorships (human policy vs agent memory), file-first vault + cognee retrieval,
full lifecycle (capture → distill → review → supersede → delete/export).
