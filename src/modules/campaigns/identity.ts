import { coldMailDomain, transactionalMailDomain } from "../../lib/env";
import { resolveSendingIdentity, type SendingIdentity } from "../mail/identity";
import { parseColdConfig } from "./logic";

/**
 * Cold-email sending identity (spec §4.16). Deliverability isolation: cold mail
 * goes out on a domain SEPARATE from transactional. The cold domain comes from
 * the workspace's cold-email config (featureFlags.coldEmail.coldDomain), falling
 * back to MAILGUN_COLD_DOMAIN — never the transactional domain, and never a
 * hardcoded default. If no cold domain is configured, cold sending is refused
 * outright rather than degraded onto mg.ventureco.group.
 */
export function resolveColdIdentity(
  mailgunConfig: unknown,
  featureFlags: unknown,
): SendingIdentity {
  const cold = parseColdConfig(featureFlags);
  const cfg =
    mailgunConfig && typeof mailgunConfig === "object" && !Array.isArray(mailgunConfig)
      ? (mailgunConfig as Record<string, unknown>)
      : {};
  const domain = (
    cold.coldDomain ??
    (typeof cfg.coldDomain === "string" ? cfg.coldDomain : null) ??
    coldMailDomain() ??
    ""
  )
    .trim()
    .toLowerCase();

  if (!domain) {
    throw new Error(
      "No cold sending domain: set MAILGUN_COLD_DOMAIN (cold.ventureco.agency) or the " +
        "workspace's coldEmail.coldDomain. Cold outreach never uses the transactional domain.",
    );
  }

  const transactional = transactionalMailDomain();
  if (transactional && domain === transactional) {
    throw new Error(
      `Cold sending domain "${domain}" is the transactional domain. Cold outreach must run ` +
        "on its own domain so a complaint can never burn the transactional reputation.",
    );
  }

  // Reuse the transactional resolver for from-name/reply-to, then override domain.
  const base = resolveSendingIdentity(mailgunConfig);
  if (domain === base.domain) {
    throw new Error(
      `Cold sending domain "${domain}" matches the workspace's transactional domain.`,
    );
  }
  const fromEmail = `outreach@${domain}`;
  return { ...base, domain, fromEmail, from: `${base.fromName} <${fromEmail}>` };
}
