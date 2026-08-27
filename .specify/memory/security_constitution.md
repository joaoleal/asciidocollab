# AsciiDoCollab Security Constitution

## Trust Boundaries

```
Internet → Load Balancer (TLS) → Fastify API → Domain Use Cases → Infrastructure
                                                    ↓
                                              PostgreSQL / Docker (git sandbox)
```

- TLS MUST be terminated at the load balancer / reverse proxy.
- Internal service-to-service communication (Fastify ↔ Hocuspocus) MAY use plain HTTP
  within the Docker network.
- The domain layer is the trust boundary — all external input MUST be validated before
  reaching domain logic.

---

## Authentication & Authorization Standards

- **RBAC in the domain:** Permission checks MUST live in use cases, not in route
  handlers. Routes call use cases; use cases enforce authorization. No route MAY
  duplicate a permission check that the domain already performs.
- Session-based authentication with PostgreSQL-backed sessions (Prisma store).
- In-memory or filesystem session stores are not permitted.

---

## Data Isolation & Privacy Rules

- Each project's data is isolated by `projectId` foreign keys on all domain tables.
- Multi-tenant isolation enforced at the repository layer — queries MUST filter by
  project context.
- File uploads stored with project-scoped paths. No cross-project file access.

---

## Secrets Management Policy

- **Credential handling:** Secrets (API tokens, SSH keys, TOTP secrets) MUST be
  encrypted at rest with AES-256. They MUST never be logged, committed, or written to
  disk unencrypted.
- Environment variables via `.env` files, never hardcoded.
- No secrets in version control — `.gitignore` MUST exclude all credential files.

---

## Secure-by-Design Patterns

- **Input validation:** All external input MUST be validated at the boundary (Fastify
  schema validation for API, Zod for frontend forms). The domain layer MUST NOT trust
  its inputs.
- **Typed errors prevent information leaks:** Domain error types MUST NOT expose
  internal state (stack traces, DB IDs, file paths) to the client. Fastify's error
  handler maps domain errors to safe HTTP responses.
- **Dependency scanning:** All runtime dependencies MUST be scanned for known
  vulnerabilities as part of the CI pipeline (`pnpm audit` + OSV-Scanner, gated at
  High+ / CVSS ≥ 7.0).
- **Static analysis (SAST):** Application code MUST be scanned by a SAST tool in CI
  (Semgrep — `p/security-audit` + `p/owasp-top-ten` packs plus first-party
  `.semgrep.yml` rules) to catch injection, path traversal, weak crypto, and missing
  sanitization. Regexes MUST be linear-time (no catastrophic backtracking), enforced by
  `eslint-plugin-redos`.
- **Secret & workflow scanning:** The repository MUST be scanned for committed secrets
  across full git history (gitleaks) and CI workflow definitions MUST be hardened
  (zizmor). These run in the CI `security` job (mirrored locally by
  `scripts/ci/security.sh`).

---

## API & Integration Security

- **Rate limiting — a deliberate, configurable decision per route (not blanket).** The global limiter is
  registered with `global: false`, so rate limiting is opt-in per route; it is NOT required on every
  endpoint. The rule is that the decision MUST NOT be forgotten:
  - **MUST rate-limit:** unauthenticated endpoints, authentication / credential / account-recovery flows,
    and any endpoint that is expensive, abuse-prone, or **amplifies load** (e.g. search, downloads,
    fan-out/bulk reads).
  - **MAY skip:** cheap, authenticated, low-amplification routes where another control already bounds abuse
    — but the reason MUST be recorded at the route or in its contract (as the collab-auth routes already do).
    Silently omitting a limit is the only violation; an explicit, justified "no limit" is compliant.
  - **When limited, the limit MUST be configurable, never a hardcoded literal:** a `rateLimitMax` +
    `rateLimitWindow` pair defined in `apps/api/src/config/schema.ts`, bound to environment variables with a
    documented default. The route's contract MUST note the limit and its `429` response.
- CORS configured for allowed origins only.
- Request size limits enforced at the Fastify level.
- No direct database access from the frontend — all data flows through the API layer.

---

## Git Sandbox Security

- Git operations MUST run inside sandboxed git-worker containers — **never on the API host or
  any application host process**. They MAY be served by a **bounded, warm pool of git-worker
  containers sized to load** (not necessarily one container per operation, and not one per
  project); a short-lived container-per-operation is permitted but no longer required.
- Each **job** MUST be scoped to a single project: it operates only on that project's storage
  directory, in a **freshly cleaned workspace**, and MUST NOT retain or share filesystem or
  process state (working tree, index, credentials, environment) with any other project's job on
  the same worker. A worker MUST scrub per-job state between jobs.
- Network egress from git-worker containers MUST be **deny-by-default with an allowlist**: only
  the host(s) of the connection's configured remote (and the provider's known git endpoints) are
  reachable. Unrestricted egress is prohibited (SSRF / exfiltration control). This is the sole,
  narrow exception to a fully network-isolated sandbox and exists only because remote
  synchronization inherently requires reaching the remote.
- Credentials used at execution time MUST be supplied out-of-band (ephemeral credential helper /
  askpass or environment — never process argv) and MUST NOT be written into the remote URL,
  `.git/config`, the working tree, logs, or any persisted artifact. They are decrypted only in
  worker memory for the duration of the job and scrubbed afterward.
- Workers run with minimal privileges and a filesystem writable only within the mounted project
  directory.

---

## Audit, Logging & Monitoring Requirements

- All authentication events (login, logout, failed attempts) MUST be logged.
- All authorization denials MUST be logged with actor, resource, and reason.
- Sensitive fields (passwords, tokens, secrets) MUST be redacted from all logs.
- Error monitoring captures unhandled exceptions without exposing internals to clients.

---

## Security Incident Response Triggers

- Multiple failed login attempts from the same IP → temporary lockout + alert.
- Dependency vulnerability detected → CI fails, blocks merge.
- Secrets detected in git history → immediate rotation + audit.
- Unauthorized cross-project access attempt → alert + session termination.

---

**Version**: 1.3.0 | **Ratified**: 2026-05-27 | **Last Amended**: 2026-08-24

<!--
AMENDMENT 1.2.0 → 1.3.0 (2026-08-24, MINOR): "Git Sandbox Security" reconciled with the real git
synchronization design (feature 048). The prior wording predated an actual sync feature (it derived from
the dormant FR-011 scaffold) and mandated one short-lived container per operation with "no network
access" — both impossible for interactive, remote-synchronizing git. Reframed to: git MUST still run in
sandboxed worker containers and NEVER on a host process; a bounded warm worker pool is now permitted
PROVIDED each job is single-project-scoped, runs in a freshly cleaned workspace, and shares no
filesystem/process/credential state across projects; network egress is deny-by-default with an allowlist
restricted to the configured remote (the sole narrow exception, since sync requires the remote); and
execution-time credentials MUST be supplied out-of-band and never persisted to URL/.git config/argv/logs/
working tree. Isolation intent (no host git, minimal blast radius, project isolation) is preserved and
strengthened (explicit per-job scrub + egress allowlist + credential-handling rule); nothing removed.
No conflict with the governance or architecture constitutions (aligned in the same cycle: architecture
2.6.0). Governance Principle X is unchanged; git-sync egress is handled as a user-consented, allowlisted
publish documented at feature scope (see specs/048-git-repository-sync/plan.md), not by amending a
non-negotiable principle.

AMENDMENT 1.0.0 → 1.1.0 (2026-06-13, MINOR): "API & Integration Security" rate-limiting rule expanded.
The prior "Rate limiting on all public endpoints" was literally inaccurate (the limiter runs `global: false`
and some authenticated/internal routes are intentionally unlimited). Reframed as a deliberate, documented,
*configurable* per-route decision: abuse-prone/unauthenticated/amplifying routes MUST be limited; cheap
authenticated routes MAY skip with a recorded reason; limits MUST be config/env-driven, never hardcoded.
No principle removed; guidance strengthened so the decision (and its config options) cannot be silently
forgotten.
-->

