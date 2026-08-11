import { resolveSendingIdentity, type SendingIdentity } from "../mail/identity";
import { parseColdConfig } from "./logic";

/**
 * Cold-email sending identity (spec §4.16). Deliverability isolation: cold mail
 * goes out on a domain SEPARATE from transactional. The cold domain comes from
 * the workspace's cold-email config (featureFlags.coldEmail.coldDomain), falling
 * back to COLD_MAILGUN_DOMAIN — never the transactional domain.
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
  const domain =
    cold.coldDomain ??
    (typeof cfg.coldDomain === "string" ? cfg.coldDomain : null) ??
    process.env.COLD_MAILGUN_DOMAIN ??
    "cold.ventureco.group";
  // Reuse the transactional resolver for from-name/reply-to, then override domain.
  const base = resolveSendingIdentity(mailgunConfig);
  const fromEmail = `outreach@${domain}`;
  return { ...base, domain, fromEmail, from: `${base.fromName} <${fromEmail}>` };
}
