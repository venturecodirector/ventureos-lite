import { resolveIntegration } from "@/modules/integrations/resolve";
import type { VerifyStatus } from "./types";

/**
 * The optional third layer (playbook-v3 P9/2, layer 3).
 *
 * ── NULL BY DEFAULT, DELIBERATELY ───────────────────────────────────────────
 *
 * The system must work, and work WELL, without a paid verifier: syntax +
 * disposable + role + MX already catches the failures that actually hurt a
 * sending domain. A provider adds mailbox-level certainty for a per-address
 * fee, and whether that is worth paying is the owner's call — so the default
 * answers "I have no opinion" and changes nothing.
 *
 * The adapter shape is the same family as RegistryProvider and MailProvider:
 * one interface, a null implementation, and the choice made by configuration
 * rather than by code.
 */
export interface VerifierResult {
  status: VerifyStatus;
  /** What the provider called it, kept for the audit trail. */
  raw?: string;
}

export interface VerifierProvider {
  readonly name: string;
  /** Per-address cost in USD, for the batch preview. Zero for the null one. */
  readonly costPerCheckUsd: number;
  verify(address: string): Promise<VerifierResult>;
}

/** The default: no opinion, no cost, no network. */
export const nullVerifier: VerifierProvider = {
  name: "none",
  costPerCheckUsd: 0,
  async verify() {
    return { status: "unknown" };
  },
};

/**
 * ZeroBounce, as the one concrete implementation.
 *
 * Chosen because its response is a single unambiguous `status` string rather
 * than a score to threshold, which keeps the mapping below honest. Any other
 * vendor is a new object in this file, not a change anywhere else.
 */
function zeroBounce(apiKey: string): VerifierProvider {
  return {
    name: "zerobounce",
    costPerCheckUsd: 0.008,
    async verify(address) {
      const url = new URL("https://api.zerobounce.net/v2/validate");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("email", address);
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { status: "unknown", raw: `http_${res.status}` };
      const data = (await res.json()) as { status?: string; sub_status?: string };
      const raw = data.status ?? "unknown";
      // Only "invalid" is treated as a refusal. "catch-all" and "unknown" mean
      // the provider could not tell, which is not the same as a bad address.
      const status: VerifyStatus =
        raw === "valid"
          ? "valid"
          : raw === "invalid"
            ? "invalid"
            : raw === "catch-all" || raw === "do_not_mail" || raw === "spamtrap"
              ? "risky"
              : "unknown";
      return { status, raw: data.sub_status ? `${raw}/${data.sub_status}` : raw };
    },
  };
}

/** Resolve the workspace's verifier, or the null one. */
export async function getVerifier(workspaceId: string): Promise<VerifierProvider> {
  const key = await resolveIntegration(workspaceId, "verifier.apiKey").catch(() => null);
  if (!key?.trim()) return nullVerifier;
  return zeroBounce(key.trim());
}
