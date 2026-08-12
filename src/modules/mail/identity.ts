/**
 * Per-workspace transactional sending identity (spec §4.11) — verified
 * domain/subdomain, from-name, reply-to — read from Workspace.mailgunConfig,
 * defaulting to MAILGUN_DOMAIN. No domain is ever hardcoded: an unconfigured
 * workspace fails loudly rather than sending from a guessed host.
 */
import { transactionalMailDomain } from "../../lib/env";

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
  const domain = String(cfg.domain ?? transactionalMailDomain() ?? "").trim().toLowerCase();
  if (!domain) {
    throw new Error(
      "No transactional sending domain: set MAILGUN_DOMAIN (mg.ventureco.group) " +
        "or the workspace's mailgunConfig.domain.",
    );
  }
  const fromName = String(cfg.fromName ?? "Venture CO Group");
  const fromEmail = String(cfg.fromEmail ?? `noreply@${domain}`);
  const replyTo = String(cfg.replyTo ?? "");
  return { domain, fromEmail, fromName, from: `${fromName} <${fromEmail}>`, replyTo };
}
