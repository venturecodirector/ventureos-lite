/**
 * Per-workspace transactional sending identity (spec §4.11) — verified
 * domain/subdomain, from-name, reply-to — read from Workspace.mailgunConfig,
 * defaulting to MAILGUN_DOMAIN. No domain is ever hardcoded: an unconfigured
 * workspace fails loudly rather than sending from a guessed host.
 */
import { transactionalMailDomain } from "../../lib/env";
import { VENTURE_BRAND, type WorkspaceBrand } from "@/modules/workspaces/brand";

export interface SendingIdentity {
  domain: string;
  fromEmail: string;
  fromName: string;
  from: string; // "Name <email>"
  replyTo: string;
}

export function resolveSendingIdentity(
  mailgunConfig: unknown,
  /** The workspace's brand, when the caller knows it (audit-v2 item 6). */
  brand?: WorkspaceBrand,
): SendingIdentity {
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
  // The seed's name, read from the brand module rather than written here: a
  // workspace that set a sender identity uses it, and there is no literal in
  // this file for another workspace's mail to inherit (audit-v2 item 6).
  const fromName = String(cfg.fromName ?? brand?.senderName ?? VENTURE_BRAND.senderName);
  const fromEmail = String(cfg.fromEmail ?? brand?.senderEmail ?? `noreply@${domain}`);
  const replyTo = String(cfg.replyTo ?? "");
  return { domain, fromEmail, fromName, from: `${fromName} <${fromEmail}>`, replyTo };
}
