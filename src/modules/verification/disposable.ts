/**
 * Throwaway-mailbox domains (playbook-v3 P9/2: "maintained list in repo").
 *
 * In the repo on purpose rather than fetched: a blocklist that arrives over the
 * network is a dependency that can go down, change under us, or start returning
 * something we did not agree to — for a list that changes a few times a year.
 *
 * Kept deliberately SHORT and high-confidence. A false positive here silently
 * refuses to mail a real prospect, which is worse than letting a throwaway
 * address bounce once and be suppressed. Entries match the domain and any
 * subdomain of it.
 */
export const DISPOSABLE_DOMAINS = [
  // The big public ones
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
  "sharklasers.com", "grr.la", "spam4.me",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "throwawaymail.com", "trashmail.com", "trashmail.de", "wegwerfmail.de",
  "yopmail.com", "yopmail.fr", "yopmail.net",
  "getnada.com", "nada.email", "dispostable.com", "mailnesia.com",
  "maildrop.cc", "mintemail.com", "mytemp.email", "fakeinbox.com",
  "spamgourmet.com", "mailcatch.com", "tempinbox.com", "emailondeck.com",
  "moakt.com", "tempr.email", "discard.email", "mailsac.com",
  "inboxbear.com", "burnermail.io", "harakirimail.com",
  "temporary-mail.net", "minuteinbox.com", "mail-temp.com", "linshiyouxiang.net",
  // Hungarian-facing throwaways
  "eldobhato.hu", "kukamail.hu",
] as const;
