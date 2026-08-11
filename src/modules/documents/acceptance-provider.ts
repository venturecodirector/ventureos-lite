/**
 * The Accept step is an INTERFACE, its implementation swappable (spec §4.9): the
 * default records contractual assent (name + company + checkbox + timestamp/IP/
 * UA) — this is assent evidence, NOT a qualified e-signature. The planned
 * in-house e-signature module plugs into this exact slot.
 */
export interface AcceptanceInput {
  name: string;
  company: string;
  agreed: boolean;
}

export interface AcceptanceOutcome {
  ok: boolean;
  method: "assent" | "esignature";
  error?: string;
}

export interface AcceptanceProvider {
  readonly name: string;
  accept(input: AcceptanceInput): AcceptanceOutcome;
}

export class AssentProvider implements AcceptanceProvider {
  readonly name = "assent";

  accept(input: AcceptanceInput): AcceptanceOutcome {
    if (!input.name?.trim()) return { ok: false, method: "assent", error: "Name is required." };
    if (!input.company?.trim()) return { ok: false, method: "assent", error: "Company is required." };
    if (!input.agreed) {
      return { ok: false, method: "assent", error: "You must accept the quote to proceed." };
    }
    return { ok: true, method: "assent" };
  }
}

export function getAcceptanceProvider(): AcceptanceProvider {
  // A future ESignatureProvider (ACCEPTANCE_PROVIDER=esignature) plugs in here.
  return new AssentProvider();
}
