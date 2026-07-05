// Canonical non-exclusive marketplace license terms — the single source of truth
// for the click-through text shown to a buyer and its version. When a buyer accepts
// at purchase (B7), the exact wording is frozen into
// `license_acceptances.legal_text_snapshot` so the agreement is unambiguous even if
// the terms change later. To revise the license, bump BOTH the version and the text
// together. Must stay byte-identical to the copy the frontend renders in the
// license modal (rrmm-frontend/src/prototype/data.ts) and in sync with the column
// default in `supabase/buyer_tier_sync_migration.sql` — the snapshot's whole point
// is recording what the buyer actually saw.
export const LICENSE_VERSION = "v1.0";

export const LICENSE_LEGAL_TEXT = `RRMM NON-EXCLUSIVE CONTENT LICENSE (${LICENSE_VERSION})

This Non-Exclusive Content License ("License") is granted by the photographer ("Licensor") to the licensing buyer ("Licensee") through the Rocket Ranch Media Marketplace ("RRMM") upon completion of payment.

1. GRANT. Licensor grants Licensee a worldwide, perpetual, non-exclusive, non-transferable license to use, reproduce, and display the licensed content across Licensee's own media and marketing channels.

2. NON-EXCLUSIVITY. This License is non-exclusive. Licensor may license the same content to any number of other parties. Licensee acquires no ownership of, or exclusive rights in, the content or its copyright.

3. RESTRICTIONS. Licensee may not resell, redistribute, sublicense, or otherwise make the raw content file available to third parties as stock, templates, or for further licensing. Licensee may not represent the content as its own original work for purposes of further licensing.

4. OWNERSHIP. Licensor retains all copyright and ownership of the content and may continue to sell, license, or exploit it without restriction.

5. FEES. The license fee is the marketplace price shown at checkout. RRMM retains a 20% platform commission; the remaining 80% is paid to Licensor. All sales are final.

6. WARRANTY & LIABILITY. Licensor warrants it holds the rights to license the content. RRMM provides the marketplace "as is" and is not liable for misuse of licensed content by either party.

By accepting, Licensee agrees to be bound by the terms of this License as of the acceptance date.`;
