#!/usr/bin/env python3
"""Live probe for the deployed cognee-trial backend (runs INSIDE the cluster).

Intended to be copied into the cognee pod and executed there
(`kubectl cp` + `kubectl exec`), so no port-forward / extra RBAC is needed.
Uses only the standard library. Exit 0 = remember -> recall round-trip OK.

Env:
  COGNEE_BASE_URL default http://127.0.0.1:8000 (pod-local)
  COGNEE_API_KEY  optional Bearer
  PROBE_DATASET   default live_probe (caller should pass a per-run name)
  PROBE_TIMEOUT_S recall poll budget, default 720
"""
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("COGNEE_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
API_KEY = os.environ.get("COGNEE_API_KEY", "")
DATASET = os.environ.get("PROBE_DATASET", "live_probe")
TIMEOUT = int(os.environ.get("PROBE_TIMEOUT_S", "720"))
# MODE=remember: write only. MODE=recall: read only (needs PROBE_STAMP).
# MODE unset/roundtrip: both (separate MCP sessions, same process).
MODE = os.environ.get("PROBE_MODE", "roundtrip")
STAMP = os.environ.get("PROBE_STAMP", f"live-probe {os.environ.get('GITHUB_RUN_ID', 'manual')} {int(time.time())}")


def rpc(method, params, timeout=30, session=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        BASE + "/mcp",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **({"Mcp-Session-Id": session} if session else {}),
            **({"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            sid = res.headers.get("mcp-session-id", session)
            payload = res.read().decode()
    except Exception as e:
        raise RuntimeError(f"mcp {method} transport: {e}")
    for line in payload.splitlines():
        if line.startswith("data:"):
            msg = json.loads(line[5:])
            if msg.get("id") == 1:
                if "error" in msg:
                    raise RuntimeError(f"mcp {method}: {msg['error']}")
                return msg["result"], sid
    raise RuntimeError(f"mcp {method}: no matching response")


def main():
    # health
    with urllib.request.urlopen(BASE + "/health", timeout=15) as res:
        assert res.status == 200, "health check failed"
    print("health OK", flush=True)

    # session
    _, session = rpc("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "opencode-cognee-live", "version": "0.1.0"},
    })
    assert session, "no session id"
    print("session OK", flush=True)

    def call(name, args, timeout=60):
        result, _ = rpc("tools/call",
                        {"name": name, "arguments": args}, timeout, session)
        return result

    if MODE in ("remember", "roundtrip"):
        # remember (background: ingestion outlives any single request deadline)
        r = call("remember", {"data": STAMP, "dataset_name": DATASET, "background": True}, 60)
        print("remember accepted", flush=True)
        if MODE == "remember":
            print(f"STAMP={STAMP}", flush=True)
            print("REMEMBER-OK", flush=True)
            return 0

    # recall (retrieval-only: no LLM needed server-side)
    deadline = time.time() + TIMEOUT
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        try:
            result = call("recall", {"query": STAMP, "top_k": 3, "search_type": "CHUNKS"}, 60)
            texts = [c.get("text", "") for c in result.get("content", []) if isinstance(c, dict)]
            blob = "\n".join(texts)
            if len(blob) > 50 and "live-probe" in blob and "no matching" not in blob and "warming up" not in blob:
                print(f"recall HIT after {attempt} polls", flush=True)
                break
            print(f"poll {attempt}: not yet", flush=True)
        except Exception as e:
            print(f"poll {attempt} err: {e}", flush=True)
        time.sleep(20)
    else:
        print("FAIL: recall never returned the probe entry", flush=True)
        return 1

    # cleanup (best-effort)
    try:
        call("forget", {"dataset": DATASET}, 60)
        print("cleanup OK", flush=True)
    except Exception as e:
        print(f"cleanup warn: {e}", flush=True)
    print("LIVE-OK", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
