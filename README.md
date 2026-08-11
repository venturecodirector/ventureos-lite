# Venture OS Lite

Internal AI-assisted sales & delivery workspace for Venture CO Group. Self-hosted
via Docker Compose. See [`docs/spec.md`](docs/spec.md) (features),
[`docs/plan.md`](docs/plan.md) (phases) and [`CLAUDE.md`](CLAUDE.md) (rules).

**Stack:** Next.js 15 (App Router) + TypeScript strict + Tailwind · Prisma
(Postgres 16 default, MySQL 8 optional via `DB_FLAVOR`) · Auth.js · BullMQ +
Redis · Playwright worker (audits + PDF) · Mailgun EU · Caddy (automatic HTTPS).

## Local dev

Prerequisites: Node 20+, npm, Docker.

```bash
# 1. Config
cp .env.example .env            # then edit secrets as needed

# 2. Bring up the database + Redis (Postgres is the default flavor)
docker compose up db redis      # for MySQL: docker compose up db-mysql redis  (+ set DB_FLAVOR=mysql)

# 3. Install deps and generate the Prisma client
npm install
npm run prisma:generate

# 4. Run the app
npm run dev                     # http://localhost:3000
```

Common scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | `next lint` |
| `npm test` | vitest unit tests |
| `npm run test:e2e` | Playwright critical-flow tests |
| `npm run worker` | BullMQ background worker |

## Full stack in Docker

`docker-compose.yml` defines `app`, `db` / `db-mysql`, `redis`, `worker`
(Playwright-capable) and `caddy` (reverse proxy + automatic HTTPS), with a
`/data/files` volume for PDFs and screenshots.

```bash
# Postgres (default). COMPOSE_PROFILES must match DB_FLAVOR.
COMPOSE_PROFILES=postgres docker compose up --build
# MySQL:
COMPOSE_PROFILES=mysql   docker compose up --build   # + DB_FLAVOR=mysql, MySQL APP_DATABASE_URL
```

Caddy serves `APP_DOMAIN` (default `localhost`) and provisions its certificate
automatically — set `APP_DOMAIN` to a real hostname in production.

## Layout

```
src/app        — App Router routes (+ globals.css, layout, home shell)
src/components — UI (app shell, nav icons)
src/lib        — shared (Prisma client, scoring/gate helpers)
src/worker     — BullMQ worker entrypoint
prisma         — single schema (flavor-neutral)
test           — vitest units      e2e — Playwright critical flows
docs           — spec, plan, prototype (design reference)
```

Design tokens (canvas `#00051D`, purple gradient `#310B59 → #7427C6`, Bricolage
Grotesque + Inter) live in `tailwind.config.ts`, lifted from
`docs/prototype.html` — the visual source of truth.
