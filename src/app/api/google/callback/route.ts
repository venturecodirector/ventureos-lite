import { prismaUnsafe } from "@/lib/db";
import { appLink } from "@/lib/public-links";
import { tryGetActiveContextOrThrow } from "@/lib/session";

/**
 * Google Calendar OAuth callback (spec §4.8). Exchanges the auth code for
 * tokens and stores them per-user (server-side only — never exposed to the
 * client) in GoogleCredential. Redirects back to /meetings.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function GET(req: Request) {
  let userId: string;
  try {
    ({ userId } = await tryGetActiveContextOrThrow());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) return Response.redirect(appLink("/meetings?google=denied"), 302);
  if (!code) return new Response("Missing code", { status: 400 });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return new Response("Google Calendar is not configured", { status: 503 });
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    return Response.redirect(appLink("/meetings?google=error"), 302);
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  const expiryDate = new Date(Date.now() + tok.expires_in * 1000);

  // Which Google account was just authorised. Identity matters now that a host
  // can connect several: without it, reconnecting a second account would
  // overwrite the first instead of adding to it.
  let accountEmail: string | null = null;
  try {
    const who = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (who.ok) accountEmail = ((await who.json()) as { email?: string }).email ?? null;
  } catch {
    // Non-fatal: the connection still works, it is just labelled "unknown".
  }

  // First account connected becomes the one meetings are written to; any
  // later one is busy-check only until the host says otherwise. That matches
  // the common case — business calendar first, personal added afterwards —
  // and never silently moves where meetings land.
  const existing = await prismaUnsafe.googleCredential.count({ where: { userId } });
  const purpose = existing === 0 ? "WRITE" : "BUSY_ONLY";

  // Not an upsert: accountEmail is nullable, and Prisma will not take a null
  // inside a compound-unique where. Look it up, then update or create.
  const prior = await prismaUnsafe.googleCredential.findFirst({
    where: { userId, accountEmail },
    select: { id: true },
  });
  if (prior) {
    await prismaUnsafe.googleCredential.update({
      where: { id: prior.id },
      data: {
        accessToken: tok.access_token,
        // Google only returns a refresh_token on first consent — keep the old one.
        ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}),
        expiryDate,
        scope: tok.scope ?? null,
        // Reconnecting must not move where meetings are written.
      },
    });
  } else {
    await prismaUnsafe.googleCredential.create({
      data: {
        userId,
        accountEmail,
        purpose,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        expiryDate,
        scope: tok.scope ?? null,
      },
    });
  }

  // A grant carrying the mail scopes gets a MailAccount, so the sync sweep has
  // something to pick up (playbook-v2 P2b). Keyed on the account email, so
  // reconnecting the same mailbox resumes rather than starting a second
  // backfill of the same 90 days.
  if (accountEmail && (tok.scope ?? "").includes("gmail.readonly")) {
    try {
      const { workspaceId } = await tryGetActiveContextOrThrow();
      const credential = await prismaUnsafe.googleCredential.findFirst({
        where: { userId, accountEmail },
        select: { id: true },
      });
      await prismaUnsafe.mailAccount.upsert({
        where: { userId_accountEmail: { userId, accountEmail } },
        create: {
          workspaceId,
          userId,
          accountEmail,
          credentialId: credential?.id ?? null,
          provider: "gmail",
          health: "ok",
        },
        update: {
          credentialId: credential?.id ?? null,
          // Reconnecting clears the reason it stopped; the sweep picks it up
          // again on the next pass.
          health: "ok",
          lastError: null,
          enabled: true,
        },
      });
    } catch {
      // The calendar connection still succeeded; mail sync simply is not set
      // up, and Settings → Email will say so.
    }
  }

  return Response.redirect(appLink("/meetings?google=connected"), 302);
}


