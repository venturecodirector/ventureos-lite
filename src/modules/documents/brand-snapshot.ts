/**
 * Pinning the branding a document was issued under (audit-v2 item 6).
 *
 * A sent quote or a signed contract is a RECORD of what was sent. Re-rendering
 * it after the workspace changed its letterhead would quietly reissue it with a
 * different identity on it — in the worst case a different company name on a
 * contract someone has already signed. So the first render captures the brand
 * and every render after that reads the capture, exactly as `templateVersionId`
 * pins the wording.
 */

import { BRAND_VERSION, brandFrom, type WorkspaceBrand } from "@/modules/workspaces/brand";

export interface PinnedBrand {
  brand: WorkspaceBrand;
  /** True when this render is the one that should write the snapshot back. */
  shouldPersist: boolean;
  version: number;
}

/**
 * Decide which brand a render should use.
 *
 * `snapshot` is whatever is on the document; `live` is the workspace's current
 * configuration. A document that already carries a snapshot uses it, whatever
 * the workspace looks like now.
 */
export function resolveDocumentBrand(
  snapshot: unknown,
  liveBrandJson: unknown,
): PinnedBrand {
  const hasSnapshot = !!snapshot && typeof snapshot === "object";
  if (hasSnapshot) {
    // Read through brandFrom so a snapshot written under an older shape still
    // resolves to a complete brand — missing fields fall back to the seed
    // rather than rendering as undefined.
    return { brand: brandFrom(snapshot), shouldPersist: false, version: BRAND_VERSION };
  }
  return { brand: brandFrom(liveBrandJson), shouldPersist: true, version: BRAND_VERSION };
}
