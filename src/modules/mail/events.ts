import type { EmailStatus } from "@prisma/client";

/**
 * Map a Mailgun event to an EmailLog status + whether the recipient should be
 * suppressed (spec §4.11). Delivery/open update the lead timeline; bounces,
 * complaints and unsubscribes add to the suppression list.
 */
export function mapMailgunEvent(event: string): {
  status: EmailStatus | null;
  suppress: boolean;
} {
  switch (event) {
    case "delivered":
      return { status: "DELIVERED", suppress: false };
    case "opened":
      return { status: "OPENED", suppress: false };
    case "failed":
      return { status: "BOUNCED", suppress: true };
    case "complained":
    case "unsubscribed":
      return { status: null, suppress: true };
    default:
      return { status: null, suppress: false };
  }
}
