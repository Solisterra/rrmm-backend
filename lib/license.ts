// Canonical non-exclusive marketplace license terms — the single source of truth
// for the click-through text shown to a buyer and its version. When a buyer accepts
// at purchase (B7), the exact wording is frozen into
// `license_acceptances.legal_text_snapshot` so the agreement is unambiguous even if
// the terms change later. To revise the license, bump BOTH the version and the text
// together. Must stay in sync with the column defaults in
// `supabase/content_lifecycle_migration.sql`.
export const LICENSE_VERSION = "v1.0";

export const LICENSE_LEGAL_TEXT =
  "v1.0: Non-exclusive license. The buyer is granted a non-exclusive, non-transferable license to use this content. The photographer retains ownership and may license the same content to other buyers. Resale or sublicensing of the underlying content is prohibited.";
