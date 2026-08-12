import { tryGetActiveContextOrThrow } from "@/lib/session";

/**
 * Start the Google Calendar OAuth flow (spec §4.8). Redirects the host to
 * Google's consent screen; tokens are exchanged and stored server-side by the
 * callback. access_type=offline + prompt=consent so we receive a refresh token.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
].join(" ");

export async function GET() {
  try {
    await tryGetActiveContextOrThrow();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return new Response("Google Calendar is not configured", { status: 503 });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return Response.redirect(`${AUTH_URL}?${params.toString()}`, 302);
}
