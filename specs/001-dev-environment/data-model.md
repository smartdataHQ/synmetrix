# Data Model: Proper Development Environment

This feature does not introduce database entities. The "data model"
consists of runtime state tracked via files and process metadata.

## Runtime State

### PID File (`.dev-client-v2.pid`)

- **Location**: `{repo_root}/.dev-client-v2.pid`
- **Content**: Single line containing the PID (integer) of the
  client-v2 Vite dev server process
- **Lifecycle**:
  - Created by `dev:start` / `dev:setup` when spawning client-v2
  - Read by `dev:status` to check process liveness
  - Read + deleted by `dev:stop` when terminating client-v2
  - If PID file exists but process is dead: stale — `dev:start`
    removes it and spawns a new process
- **Gitignored**: Yes

### Log File (`.dev-client-v2.log`)

- **Location**: `{repo_root}/.dev-client-v2.log`
- **Content**: stdout and stderr output from the client-v2 Vite
  dev server process (appended on each start)
- **Lifecycle**:
  - Created/appended by `startClientV2()` when spawning the
    detached process (stdout/stderr redirected here)
  - Read by `dev logs client-v2` via `tail -f`
  - Not deleted by `dev:stop` (preserved for post-mortem debugging)
  - Grows unboundedly; developer may delete manually
- **Gitignored**: Yes

### Environment Templates

#### `.env.example`

Derived from current `.env`. All non-secret values preserved as-is.
Secret values replaced with descriptive placeholders:

| Variable | Template Value |
|----------|---------------|
| `JWT_KEY` | `<generate-a-random-32-char-key>` |
| All others | Current values (ports, URLs, flags) |

#### `.dev.env.example`

Derived from current `.dev.env`. Secret/host-specific values replaced:

| Variable | Template Value |
|----------|---------------|
| `HASURA_GRAPHQL_ADMIN_SECRET` | `<choose-an-admin-secret>` |
| `POSTGRES_HOST` | `<your-postgres-host>` |
| `POSTGRES_USER` | `<your-postgres-user>` |
| `POSTGRES_PASSWORD` | `<your-postgres-password>` |
| `POSTGRES_DB` | `synmetrix` (default, not secret) |
| `POSTGRES_ADDR` | `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}/${POSTGRES_DB}?sslmode=require` |
| `DATABASE_URL` | `${POSTGRES_ADDR}` |
| `HASURA_GRAPHQL_DATABASE_URL` | `${POSTGRES_ADDR}` |
| Minio defaults | Preserved (local-only, not sensitive) |
| SMTP/mailhog | Preserved (local-only, not sensitive) |

## Health Check Model

The `dev:status` command produces a table with these fields per
service:

| Field | Type | Source |
|-------|------|--------|
| Service Name | string | Compose service name or "client-v2" |
| Type | enum | "docker" or "host" |
| Port | integer | From compose file or Vite config |
| Status | enum | "running", "stopped", "unhealthy", "not started" |
| Uptime | string | From `docker inspect` or PID creation time |

### Status Resolution

- **Docker services**: `docker compose ps --format json` → parse
  State field
- **client-v2**: Check PID file exists → check process alive via
  `kill -0 {pid}` → HTTP probe `http://localhost:8000`
