/**
 * Public audit report at audit.<domain>/r/<slug>.
 *
 * Moved here in P12 when the root of the audit domain became the self-serve
 * landing page. The report itself is unchanged — this re-exports the existing
 * page so there is one implementation, and /share/<slug> keeps working for any
 * link that predates the move.
 */
export { default, dynamic } from "../../share/[slug]/page";
