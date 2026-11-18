# Comma server

Accounts for the Comma desktop app: register with email verification, sign in per device, refresh and sign out,
profile and synced settings, device list. NestJS 12 on Bun (no build step), Postgres through Drizzle. The contract is
`docs/spec.md` section 5; request and response schemas live in `packages/shared/src/api/` and the server validates
with exactly those.

## Run locally

Requires Bun 1.4+ and Docker.

```sh
bun install                                  # at the repository root
docker compose up -d db                      # Postgres 17 on 127.0.0.1:55432
cd apps/server
cp .env.example .env                         # then set JWT__SECRET (openssl rand -base64 48)
bun run db:migrate
MAILER__DEV_PRINT_CODES=1 bun run start:dev  # http://127.0.0.1:8787, verification codes appear in the log
```

The whole stack in Docker (Postgres, a one-shot `migrate` service, then the server on `127.0.0.1:8787`):

```sh
docker compose up -d --build                 # from the repository root
curl http://127.0.0.1:8787/v1/health
```

Compose reads `apps/server/.env.example`, which holds placeholders only. For a real deployment, copy it, set
`NODE_ENV=production`, a random `JWT__SECRET` and SMTP settings, and point `env_file` at the copy. The image runs as the
non-root `bun` user and is built from the repository root: `docker build -f apps/server/Dockerfile .`.

## Configuration

Environment variables, `SECTION__KEY`, validated at startup by zod (`src/app.config.ts`). A `.env` file in
`apps/server` is read too.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` requires `MAILER__DRIVER=smtp` and refuses `MAILER__DEV_PRINT_CODES` |
| `SERVER__PORT` | `8787` | |
| `SERVER__TRUST_PROXY` | `loopback` | Express `trust proxy`; set it so rate limits see client IPs behind a proxy |
| `DATABASE__URL` | required | `postgres://user:pass@host:5432/db` |
| `JWT__SECRET` | required | At least 32 characters. Signs access tokens (HS256) and keys the email-code hashes |
| `AUTH__REFRESH_TTL_DAYS` | `30` | A refresh token expires this long after it was issued; each refresh issues a new one |
| `MAILER__DRIVER` | `console` | `console` logs that a code was sent; `smtp` sends it |
| `MAILER__DEV_PRINT_CODES` | `0` | `1` makes the console mailer print the code |
| `MAILER__FROM` | `Comma <no-reply@localhost>` | Sender address |
| `MAILER__SMTP_URL` | | Required with `smtp`: `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465` |

## Database and migrations

Tables are in `src/entity/<domain>/*.entity.ts`; migrations are SQL in `drizzle/`.

```sh
bun run db:generate    # after changing an entity; commit the new SQL in drizzle/
bun run db:migrate     # applies pending migrations to DATABASE__URL (compose runs this as the migrate service)
```

## Tests

```sh
docker compose -p comma-server-test up -d db                # Postgres on 127.0.0.1:55432
bun run typecheck
bun test                                                    # each test file gets its own fresh database
docker compose -p comma-server-test down -v
```

`TEST_DATABASE_URL` (default `postgres://comma:comma@localhost:55432/comma`) must be a role that can create databases.

## API

All routes are under `/v1` and speak JSON. Errors are `{ code, message }` with `code` from `ErrorCode` in
`packages/shared/src/api/errors.ts`. Authenticated routes take `Authorization: Bearer <access_token>`.

| Route | Auth | Body | Success |
| --- | --- | --- | --- |
| `GET /v1/health` | public | | 200 terminus report; 503 when Postgres is down |
| `POST /v1/auth/register` | public | `email`, `password` (8+), `name` | 201 `{ user }`, unverified; a 6-digit code is emailed. 409 `email_taken` |
| `POST /v1/auth/verify-email` | public | `email`, `code` | 200 `{ ok: true }`. 400 `invalid_code`, `code_expired`, `too_many_attempts` |
| `POST /v1/auth/verify-email/resend` | public | `email` | 200 `{ ok: true }`, also for unknown or verified addresses. 429 `resend_cooldown` |
| `POST /v1/auth/login` | public | `email`, `password`, optional `device_name`, `platform` | 200 `{ access_token, refresh_token, expires_in, user }`. 401 `invalid_credentials`, 403 `email_not_verified` |
| `POST /v1/auth/refresh` | public | `refresh_token` | 200, same shape as login. 401 `invalid_refresh_token`, `refresh_token_reused` |
| `POST /v1/auth/logout` | public | `refresh_token` | 200 `{ ok: true }`; signs that device out |
| `GET /v1/me` | bearer | | 200 `{ user }` |
| `PATCH /v1/me` | bearer | `name` and/or `settings` (`languages`, `translate_targets`, `context_level`) | 200 `{ user }`; settings keys are merged |
| `DELETE /v1/me` | bearer | `password` | 204; the user, devices, tokens and codes are deleted. 403 `invalid_credentials` |
| `GET /v1/devices` | bearer | | 200 `{ devices }`, `current` marks the caller's |
| `DELETE /v1/devices/:id` | bearer | | 204; that device is signed out at once. 404 `not_found` |

How sessions work:

- Passwords are hashed with argon2id (`Bun.password`). Login answers wrong email and wrong password the same way.
- Email codes are 6 digits, stored as an HMAC, valid 10 minutes, 5 attempts; a new one can be sent 60 s after the last.
- Each login creates a device. The access token is an HS256 JWT valid 15 minutes with `sub` (user id) and `did`
  (device id). The refresh token is 32 random bytes; only its SHA-256 is stored, on the device.
- Every refresh spends the presented refresh token and returns a new pair. Presenting a spent one again signs that
  device out (its newest refresh token and its access tokens stop working). Clients must not refresh concurrently.
- Signing out, revoking a device, or deleting the account takes effect on the next request, because every
  authenticated request checks that the device still exists.
- Register, verify, resend, login and refresh are rate limited per client IP (`AUTH_THROTTLE` in
  `src/modules/auth/auth.controller.ts`).
