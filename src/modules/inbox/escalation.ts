/**
 * Money-talk escalation (spec §4.7). Price/proposal/contract mentions auto-flag
 * the thread, notify the Owner, and lock money-talk drafting.
 */
const PRICE_TERMS = [/\bár\b/i, /árat/i, /mennyibe/i, /\bprice\b/i, /\bcost\b/i, /\bdíj/i, /\bfizet/i, /\bbudget\b/i, /\bkeret/i];
const PROPOSAL_TERMS = [/árajánlat/i, /ajánlat/i, /\bproposal\b/i, /\bquote\b/i];
const CONTRACT_TERMS = [/szerződés/i, /\bcontract\b/i, /\bagreement\b/i];

export function detectMoneyTalk(text: string): boolean {
  return escalationReason(text) !== null;
}

export function escalationReason(text: string): "price" | "proposal" | "contract" | null {
  if (CONTRACT_TERMS.some((re) => re.test(text))) return "contract";
  if (PROPOSAL_TERMS.some((re) => re.test(text))) return "proposal";
  if (PRICE_TERMS.some((re) => re.test(text))) return "price";
  return null;
}
