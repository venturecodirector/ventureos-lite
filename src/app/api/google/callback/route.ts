import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

/**
 * Google Calendar OAuth callback (spec §4.8). Exchanges the auth code for
 * tokens and stores them per-user (server-side only — never exposed to the
 * client) in GoogleCredential. Redirects back to /meetings.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function GET(req: Request) {
  let userId: string;
  try {
    ({ userId } = await getActiveContext());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) return Response.redirect(`${appUrl()}/meetings?google=denied`, 302);
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
    return Response.redirect(`${appUrl()}/meetings?google=error`, 302);
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  const expiryDate = new Date(Date.now() + tok.expires_in * 1000);

  await prismaUnsafe.googleCredential.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiryDate,
      scope: tok.scope ?? null,
    },
    update: {
      accessToken: tok.access_token,
      // Google only returns a refresh_token on first consent — keep the old one.
      ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}),
      expiryDate,
      scope: tok.scope ?? null,
    },
  });

  return Response.redirect(`${appUrl()}/meetings?google=connected`, 302);
}

function appUrl(): string {
  return process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? "";
}
