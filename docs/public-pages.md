# Public pages — how they route, and how to test them locally

Three prospect-facing surfaces are served by the same Next app as the
authenticated product, on their own hostnames (CLAUDE.md → Domain layout):

| Surface | Public URL | App route | Built by |
|---|---|---|---|
| Website audit report | `audit.ventureco.agency/<slug>` | `/share/<slug>` | Site Audit → publish |
| Quote acceptance | `quote.ventureco.agency/<slug>` | `/accept/<slug>` | Documents → send a quote |
| Booking page | `meet.ventureco.agency/<slug>` | `/book/<slug>` | Settings → booking page |

None of them require a sign-in — the slug is the credential. It is generated
from 9 random bytes (~72 bits), which is unguessable but **not** secret-grade:
treat these links as "anyone with the URL can read this".

The **Public Pages** screen in the app lists every link the workspace has handed
out, whether it has been opened, when it expires, and lets an Owner revoke a
share or take the booking page offline.

## How a request reaches the right route

Two independent mechanisms, so neither is a single point of failure:

1. **Caddy** (production) knows the real hostnames from `PUBLIC_*_HOST` and
   rewrites `/<slug>` → `/share/<slug>` etc., stamping `X-Public-Surface`.
2. **`src/middleware.ts`** honours that header, and falls back to matching the
   `audit.` / `quote.` / `meet.` subdomain prefix. The prefix fallback is what
   makes local testing work with no proxy at all.

Middleware runs in the edge runtime, where `process.env` is inlined at *build*
time — which is exactly why it must not read hostnames from env, and why the
header/prefix approach is used instead.

The direct in-app paths (`/share/<slug>`, `/accept/<slug>`, `/book/<slug>`)
always work too. That is deliberate: it keeps local development and the e2e
suite free of hostname setup.

## Testing locally

### Option A — direct paths (simplest)

```bash
npm run dev
open http://localhost:3000/share/<slug>
open http://localhost:3000/accept/<slug>
open http://localhost:3000/book/tamas
```

This exercises the pages themselves but not the host routing.

### Option B — `*.localhost` subdomains (no setup needed)

Chrome, Safari and Firefox all resolve `*.localhost` to 127.0.0.1 without any
hosts-file entry, and the middleware's prefix match does the rest:

```bash
open http://audit.localhost:3000/<slug>
open http://quote.localhost:3000/<slug>
open http://meet.localhost:3000/tamas
```

Or from the terminal, forcing the Host header:

```bash
curl -H "Host: audit.localhost" http://127.0.0.1:3000/<slug>
curl -H "Host: quote.localhost" http://127.0.0.1:3000/<slug>
curl -H "Host: meet.localhost"  http://127.0.0.1:3000/tamas
```

### Option C — real hostnames via /etc/hosts

Closest to production if you want the actual domain names in the address bar:

```
127.0.0.1  ventureco.local audit.ventureco.local quote.ventureco.local meet.ventureco.local
```

Then set `APP_URL=http://ventureco.local:3000` and the three `PUBLIC_*_URL`
variables to match, so generated links point at those hosts.

### Option D — simulate Caddy's header

To test the production path specifically, without Caddy:

```bash
curl -H "X-Public-Surface: audit" http://127.0.0.1:3000/<slug>
```

> A client cannot use this against production: the Caddyfile strips
> `X-Public-Surface` on the app hostname before proxying, so only Caddy can set
> it. Worth knowing when reading the middleware.

## Getting test data

```bash
# an audit share
npx tsx -e 'import {PrismaClient} from "@prisma/client"; const p=new PrismaClient();
p.auditShare.findFirst({orderBy:{createdAt:"desc"}}).then(s=>console.log(s?.slug)).finally(()=>p.$disconnect())'

# a quote acceptance link
npx tsx -e 'import {PrismaClient} from "@prisma/client"; const p=new PrismaClient();
p.document.findFirst({where:{acceptSlug:{not:null}}}).then(d=>console.log(d?.acceptSlug)).finally(()=>p.$disconnect())'
```

The booking page is seeded as `tamas` by `npm run db:seed`.

## What each page does when opened

- **Audit report** — records the first open and increments `open_count`, and
  writes an `audit_share_opened` activity to the lead's timeline. Returns 410
  once `expires_at` passes (60 days by default, or immediately after an Owner
  revokes it).
- **Quote acceptance** — records name, company, IP, user agent and timestamp as
  immutable assent evidence, flips the quote to `ACCEPTED`, emails the Owner and
  unlocks contract generation. Accepting twice is a no-op, not a second record.
- **Booking page** — creates the lead (if new), the meeting, and queues the
  Claude meeting brief; sends confirmations to guest and host. A submission
  faster than a human could type is rejected as a bot.

## e2e coverage

`e2e/booking.spec.ts` covers a real booking and the bot rejection.
`e2e/workspace-isolation.spec.ts` asserts the public slugs are reachable
unauthenticated **by design** while remaining outside any tenant scope.
