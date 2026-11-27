# opencode-cognee review synthesis (0.4.0 -> 0.5.0)
5 tracks: arch(2 critical/5 warn/2 sugg), correctness(5/8/6), security(1/4/2), perf(1/4/2), maintain(5/7/4).

## Fixed in 0.5.0 (all high/critical + cheap mediums, 28/28 tests)
P1 broker per-identity tokens (BROKER_TOKENS map; legacy global deprecated): arch-critical + sec-high impersonation.
P2 recall cache carries identity, validated on hit: arch-critical + corr-high cross-tenant leak.
P3 identity lookup error fails closed (default only on successful empty lookup): corr-high.
P4 breaker only on 5xx/429/network; 4xx returned directly: corr-high + arch-warn.
P5 broker expiry `??`->`||` + opaque-token cache test: corr-high.
P6 shared lib.ts (scrub/safeDatasetName/hash/truncate/parseUsers/renderMemory/buildTranscript) + scripts/lib.mjs (args/num/login/ensureDataset/rememberForm); migrate/provision/e2e use it: maint-high + arch-warn.
P7 explicit no-op broker branch comment: maint-high.
P8 migrate: profile idempotency, state shape validation, numeric validation, password-env only, dirname fix: corr-high/med.
M9 timingSafeEqual, 8KB body cap, health without count, refuse COGNEE_USERS in broker mode, manifest securityContext + NetworkPolicy.
M10 login/dataset in-flight dedup, login cooldown, capture in-flight guard + 5min fail backoff, skip-on-distill-failure.
M11 renderMemory budget counts header + newlines, for-loop break.
M12 401 retry rebuilds FormData via factory.
M13 e2e null-checks, non-OK throws, tolerant recall parse, no secret print.
M16 ensureDataset caches requested name, 409 re-list, evict+retry on 403/404.
M17 tests: opaque cache, FormData rebuild, 403-no-trip, identity rebound, double-idle, budget, broker 404/502/413/qs.

## Deferred (documented, not in 0.5.0)
- Dual-channel recall injection kept (load-bearing provider workaround; now named + commented + E2E-guarded).
- TokenProvider extraction / 4-module split: done as 2-file split (lib.ts + index.ts); deeper split deferred.
- Migration streaming/concurrency, transcript tail-iteration, /token rate limit, checkJs: deferred, low ROI now.
