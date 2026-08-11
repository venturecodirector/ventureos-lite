/**
 * Per-workspace sending identity (spec §4.11) — verified domain/subdomain,
 * from-name, reply-to — read from Workspace.mailgunConfig, with env defaults.
 */
export interface SendingIdentity {
  domain: string;
  fromEmail: string;
  fromName: string;
  from: string; // "Name <email>"
  replyTo: string;
}

export function resolveSendingIdentity(mailgunConfig: unknown): SendingIdentity {
  const cfg =
    mailgunConfig && typeof mailgunConfig === "object" && !Array.isArray(mailgunConfig)
      ? (mailgunConfig as Record<string, unknown>)
      : {};
  const domain = String(cfg.domain ?? process.env.MAILGUN_DOMAIN ?? "mail.ventureco.group");
  const fromName = String(cfg.fromName ?? "Venture CO Group");
  const fromEmail = String(cfg.fromEmail ?? `noreply@${domain}`);
  const replyTo = String(cfg.replyTo ?? "");
  return { domain, fromEmail, fromName, from: `${fromName} <${fromEmail}>`, replyTo };
}
