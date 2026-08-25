import { checkLocal } from "./local";
import { checkMx } from "./dns";
import { nullVerifier, type VerifierProvider } from "./provider";
import type { VerifyResult, VerifyStatus } from "./types";

/**
 * The layered verdict (playbook-v3 P9/2).
 *
 * Cheapest first, and each layer can only ever make the answer WORSE — a paid
 * provider saying "valid" does not rescue an address with no mail server, and
 * an MX record does not un-flag a role address. That ordering is what makes the
 * result explainable in one sentence to the person deciding whether to send.
 */
export async function verifyAddress(
  raw: string | null | undefined,
  opts: {
    provider?: VerifierProvider;
    now?: Date;
    /** Injected for tests; defaults to the real resolver. */
    mxCheck?: typeof checkMx;
  } = {},
): Promise<VerifyResult> {
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? nullVerifier;
  const mxCheck = opts.mxCheck ?? checkMx;

  // ---- layer 1: text ------------------------------------------------------
  const local = checkLocal(raw);
  if (local.reason) {
    return {
      status: "invalid",
      reason: local.reason,
      address: local.address,
      checkedAt: now,
    };
  }
  const address = local.address!;

  // ---- layer 2: DNS -------------------------------------------------------
  const mx = await mxCheck(local.domain!);
  if (mx.reason === "domain_not_found" || mx.reason === "no_mx") {
    return { status: "invalid", reason: mx.reason, address, checkedAt: now };
  }
  if (mx.reason === "dns_unavailable") {
    // Not the address's fault, and not an answer. Saying "invalid" here would
    // quietly drop good prospects every time a resolver hiccups.
    return { status: "unknown", reason: "dns_unavailable", address, checkedAt: now };
  }

  // ---- layer 3: the optional provider ------------------------------------
  let providerStatus: VerifyStatus = "unknown";
  let providerReason: VerifyResult["reason"] | null = null;
  if (provider.name !== "none") {
    try {
      const r = await provider.verify(address);
      providerStatus = r.status;
      if (r.status === "invalid") providerReason = "provider_invalid";
      else if (r.status === "risky") providerReason = "provider_risky";
      else if (r.status === "unknown") providerReason = "provider_unknown";
    } catch {
      providerStatus = "unknown";
      providerReason = "provider_unknown";
    }
    if (providerStatus === "invalid") {
      return { status: "invalid", reason: "provider_invalid", address, checkedAt: now };
    }
  }

  // ---- combine ------------------------------------------------------------
  // A role address is risky whatever the provider thinks: the question it
  // raises is "will a shared inbox welcome this", which no verifier answers.
  if (local.isRole) {
    return { status: "risky", reason: "role_address", address, checkedAt: now };
  }
  if (providerStatus === "risky") {
    return { status: "risky", reason: providerReason ?? "provider_risky", address, checkedAt: now };
  }
  if (provider.name !== "none" && providerStatus === "unknown") {
    return { status: "unknown", reason: "provider_unknown", address, checkedAt: now };
  }

  return { status: "valid", reason: "ok", address, checkedAt: now };
}
