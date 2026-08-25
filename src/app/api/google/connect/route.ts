import { tryGetActiveContextOrThrow } from "@/lib/session";
import { googleConsentUrl } from "@/modules/meetings/google-oauth";

/**
 * Start the Google Calendar OAuth flow (spec §4.8). Redirects the host to
 * Google's consent screen; tokens are exchanged and stored server-side by the
 * callback.
 *
 * The URL itself is built in `@/modules/meetings/google-oauth`, where a test can
 * reach it — this file cannot be imported by one, because the session pulls in
 * Auth.js. That is exactly how the parameter deciding whether a second calendar
 * could be connected at all went unasserted.
 */
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

  return Response.redirect(googleConsentUrl({ clientId, redirectUri }), 302);
}
