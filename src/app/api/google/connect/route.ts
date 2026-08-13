import { tryGetActiveContextOrThrow } from "@/lib/session";

/**
 * Start the Google Calendar OAuth flow (spec §4.8). Redirects the host to
 * Google's consent screen; tokens are exchanged and stored server-side by the
 * callback. access_type=offline + prompt=consent so we receive a refresh token.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  // Write bookings into the calendar.
  "https://www.googleapis.com/auth/calendar.events",
  // Read busy periods. calendar.events alone is NOT enough for freeBusy —
  // Google rejects it with insufficientPermissions, which made every slot
  // look free and let prospects book over existing meetings. readonly is the
  // least-privilege scope that satisfies the freeBusy endpoint.
  "https://www.googleapis.com/auth/calendar.readonly",
  // Email sync (playbook-v2 P2). Restricted scopes, which need Google
  // verification on an EXTERNAL consent screen — ours is Internal on the
  // Workspace domain, so they are granted without review and refresh tokens do
  // not expire. readonly + send rather than modify: we never need to change
  // anything in the user's mailbox, and asking for less is the difference
  // between a scope review and none.
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
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
