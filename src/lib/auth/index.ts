import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { SESSION_TTL_MS, resolveSession } from "./sessions";

/**
 * Auth.js (NextAuth v5) wiring — CLAUDE.md → Auth.
 *
 * Division of responsibility, which is the thing to understand here:
 *
 *   Auth.js owns  the signed cookie, CSRF, and the /api/auth routes.
 *   WE own        what the cookie means. The cookie carries nothing but an
 *                 opaque session token; `src/lib/auth/sessions.ts` resolves it
 *                 against the `sessions` table on every request.
 *
 * Why not the database session strategy? Auth.js forces JWT for the credentials
 * provider. Rather than accept a stateless, unrevocable session — which would
 * miss CLAUDE.md's "server sessions in DB" — the JWT is reduced to a pointer
 * and the DB row stays authoritative. Revoking the row logs the user out on
 * their next request, which is the property that actually matters.
 *
 * Consequence: nothing downstream should read identity from the JWT claims.
 * `getActiveContext()` is the only sanctioned reader, and it goes to the DB.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  // Auth.js v5 looks for AUTH_SECRET; this deployment has always called it
  // NEXTAUTH_SECRET (CLAUDE.md → Environment). Accept either rather than
  // silently falling back to an unsigned cookie.
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  // Behind Caddy the origin arrives via X-Forwarded-*; Caddy is the only proxy
  // hop and it sets them, so the forwarded host is trustworthy here.
  trustHost: true,
  session: {
    strategy: "jwt",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        sessionToken: { type: "text" },
      },
      /**
       * Deliberately NOT where passwords are checked.
       *
       * `signInWithPassword` (src/modules/auth/actions.ts) runs the real
       * authentication — throttle, bcrypt, TOTP — and mints the session row. It
       * then hands the resulting opaque token here purely so Auth.js will set
       * its cookie. This step only confirms the token maps to a live session.
       *
       * Splitting it this way is not ceremony: routing the password through
       * `authorize` would run the whole login twice per submit — two bcrypt
       * comparisons, two rows in the attempt ledger, and a TOTP code burned by
       * the first pass that the second would then reject as a replay. One
       * authentication, one session.
       */
      async authorize(raw) {
        const token = typeof raw?.sessionToken === "string" ? raw.sessionToken : "";
        if (!token) return null;
        const session = await resolveSession(token);
        if (!session) return null;
        return { id: session.userId, sessionToken: token };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user && "sessionToken" in user) {
        token.sessionToken = (user as { sessionToken?: string }).sessionToken;
      }
      return token;
    },
    async session({ session, token }) {
      // Deliberately minimal. The DB row — not this object — is the identity.
      (session as { sessionToken?: string }).sessionToken =
        typeof token.sessionToken === "string" ? token.sessionToken : undefined;
      return session;
    },
  },
});

/** The opaque session token from the current request's cookie, if any. */
export async function currentSessionToken(): Promise<string | null> {
  // `auth` is overloaded (it doubles as a middleware wrapper), so its return
  // type has to be narrowed by hand rather than inferred.
  let session: { sessionToken?: string } | null;
  try {
    session = (await auth()) as { sessionToken?: string } | null;
  } catch {
    // An undecryptable cookie (rotated AUTH_SECRET, truncated value, a stale
    // cookie from another deployment) means "not signed in" — not a 500. The
    // browser is handed the login page and gets a fresh cookie there.
    return null;
  }
  const token = session?.sessionToken;
  return typeof token === "string" && token ? token : null;
}
