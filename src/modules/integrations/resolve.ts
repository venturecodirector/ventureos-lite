import { getWorkspaceClient } from "@/lib/db";
import { decryptSecret, CredentialCryptoError } from "@/lib/crypto";
import { ALL_FIELDS, fieldByKey, validateResolved } from "./registry";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";

/**
 * Where every integration credential is resolved.
 *
 * Order: the workspace's own value if it has one, otherwise the env fallback.
 * That ordering is what lets a single deployment serve several workspaces with
 * different Mailgun domains while still booting from env alone.
 *
 * THE MAILGUN INVARIANT. `src/lib/env.ts` refuses to boot when the cold and
 * transactional domains are equal — but it only sees env. Now that a workspace
 * can override either from the database, that check alone is no longer
 * sufficient: a saved row could reintroduce the collision at runtime. So the
 * same rule is applied HERE, to the resolved pair, and a violation collapses
 * the cold credentials to null rather than handing back a usable pair. Cold
 * sending then fails closed (see modules/campaigns/identity.ts), which is the
 * safe direction.
 *
 * Not a server action: this is a library used by server actions and jobs.
 */

export interface ResolvedIntegrations {
  values: Record<string, string | null>;
  /** Which keys came from the database rather than env. */
  fromDb: Set<string>;
  /** Invariant violations found while resolving; cold creds are dropped. */
  problems: Array<{ key: string; message: string }>;
}

function envValue(envVar: string): string | null {
  if (!envVar) return null;
  const v = process.env[envVar];
  return v && v.trim() ? v.trim() : null;
}

export async function resolveIntegrations(workspaceId: string): Promise<ResolvedIntegrations> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.integration.findMany();

  const values: Record<string, string | null> = {};
  const fromDb = new Set<string>();

  for (const field of ALL_FIELDS) {
    const row = rows.find((r) => r.key === field.key);
    let dbValue: string | null = null;

    if (row) {
      if (field.kind === "secret" && row.valueEnc) {
        try {
          dbValue = decryptSecret(row.valueEnc);
        } catch (e) {
          // A key rotation or a tampered row: treat as absent and fall back to
          // env rather than crashing every screen that touches integrations.
          if (!(e instanceof CredentialCryptoError)) throw e;
          dbValue = null;
        }
      } else if (field.kind === "plain") {
        dbValue = row.valuePlain?.trim() || null;
      }
    }

    if (dbValue) {
      values[field.key] = dbValue;
      fromDb.add(field.key);
    } else {
      values[field.key] = envValue(field.envVar);
    }
  }

  const problems = validateResolved(values);

  // Fail closed on the domain collision: if cold and transactional would end up
  // the same, cold has no usable credentials at all.
  if (problems.some((p) => p.key === "mailgun.cold.domain")) {
    values["mailgun.cold.domain"] = null;
    values["mailgun.cold.apiKey"] = null;
  }
  if (problems.some((p) => p.key === "mailgun.cold.apiKey")) {
    values["mailgun.cold.apiKey"] = null;
  }

  return { values, fromDb, problems };
}

/** Convenience for a single credential. */
export async function resolveIntegration(
  workspaceId: string,
  key: string,
): Promise<string | null> {
  if (!fieldByKey(key)) throw new Error(`Unknown integration key: ${key}`);
  const { values } = await resolveIntegrations(workspaceId);
  return values[key] ?? null;
}

/** The mail credentials, shaped for the send path. */
export interface MailCredentials {
  transactional: { domain: string | null; apiKey: string | null };
  cold: { domain: string | null; apiKey: string | null };
  webhookSigningKey: string | null;
}

export async function resolveMailCredentials(workspaceId: string): Promise<MailCredentials> {
  const { values } = await resolveIntegrations(workspaceId);
  return {
    transactional: {
      domain: values["mailgun.tx.domain"] ?? null,
      apiKey: values["mailgun.tx.apiKey"] ?? null,
    },
    cold: {
      domain: values["mailgun.cold.domain"] ?? null,
      apiKey: values["mailgun.cold.apiKey"] ?? null,
    },
    webhookSigningKey: values["mailgun.webhookSigningKey"] ?? null,
  };
}

/**
 * The NAV credentials, shaped for the taxpayer lookup.
 *
 * Returns null unless everything the lookup actually needs is present, so a
 * half-configured integration reads as "not configured" rather than failing at
 * NAV with a signature error nobody can interpret. exchangeKey is deliberately
 * NOT required: the taxpayer query does not use it.
 *
 * The software identity comes from the workspace brand, because those fields
 * tell NAV who wrote the software making the call — on a white-labelled
 * deployment that is the operator, not us.
 */
export interface NavCredentialSet {
  login: string;
  password: string;
  signKey: string;
  taxNumber: string;
  environment: "test" | "production";
  softwareId: string;
  softwareName: string;
  softwareDevName: string;
  softwareDevContact: string;
}

export async function resolveNavCredentials(
  workspaceId: string,
  brand: Pick<WorkspaceBrand, "name" | "legalName" | "senderName" | "senderEmail">,
): Promise<NavCredentialSet | null> {
  const { values } = await resolveIntegrations(workspaceId);
  const login = values["nav.login"];
  const password = values["nav.password"];
  const signKey = values["nav.signKey"];
  const taxNumber = values["nav.taxNumber"];
  const softwareId = values["nav.softwareId"];
  if (!login || !password || !signKey || !taxNumber || !softwareId) return null;

  const env = values["nav.environment"] === "test" ? "test" : "production";
  return {
    login,
    password,
    signKey,
    taxNumber,
    environment: env,
    softwareId,
    softwareName: brand.name,
    // Who WROTE the software, legally. On a white-labelled deployment that is
    // the operator's own legal entity.
    softwareDevName: brand.legalName || brand.name,
    // NAV requires a contact; the workspace's sender address is the one the
    // operator already publishes, so there is nothing new to configure.
    softwareDevContact: brand.senderEmail || `${brand.senderName}`,
  };
}
