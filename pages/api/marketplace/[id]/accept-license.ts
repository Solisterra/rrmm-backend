import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../../lib/api";
import { getUserFromRequest, supabaseAdmin } from "../../../../lib/supabase";
import { LICENSE_VERSION, LICENSE_LEGAL_TEXT } from "../../../../lib/license";
import type {
  DbUser,
  DbAuction,
  DbTransaction,
  DbLicenseAcceptance,
} from "../../../../lib/types";

// POST /api/marketplace/:id/accept-license  (B7)
// Records a buyer's click-through acceptance of the non-exclusive marketplace
// license as an immutable, audited row — the license analog of a listing
// attestation (same IP / user-agent / session / version capture, plus a frozen
// legal-text snapshot). The buyer posts back the `transactionId` returned by
// POST .../purchase; that transaction is the security anchor — it must exist,
// belong to this buyer, and point at THIS listing. Rows are INSERT-only and
// immutable (block_license_mutation trigger), so the endpoint is idempotent: a
// repeat accept for the same transaction returns the first record instead of
// writing a duplicate.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const { id } = req.query as { id: string };

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const u = user as DbUser;
  if (u.role !== "buyer")
    return res.status(403).json({ error: "Buyer account required" });

  const { transaction_id, agreement_accepted } = req.body as {
    transaction_id?: string;
    agreement_accepted?: boolean;
  };

  if (!transaction_id)
    return res.status(400).json({ error: "transaction_id is required" });
  // The DB CHECK requires agreement_accepted = TRUE; reject early with a clean
  // message rather than letting the insert throw a constraint error.
  if (agreement_accepted !== true)
    return res.status(400).json({
      error: "You must accept the non-exclusive license terms to continue.",
    });

  // Anchor on the transaction: it must exist, belong to this buyer, and reference
  // the listing in the path. This stops a buyer recording an acceptance against
  // someone else's purchase or a mismatched listing.
  const { data: txRow } = await supabaseAdmin
    .from("transactions")
    .select("id, buyer_id, auction_id")
    .eq("id", transaction_id)
    .single();

  const tx = txRow as Pick<
    DbTransaction,
    "id" | "buyer_id" | "auction_id"
  > | null;
  if (!tx) return res.status(404).json({ error: "Transaction not found" });
  if (tx.buyer_id !== u.id)
    return res
      .status(403)
      .json({ error: "This purchase belongs to another buyer" });
  if (tx.auction_id !== id)
    return res
      .status(400)
      .json({ error: "Transaction does not match this listing" });

  // The click-through license is non-exclusive and only applies to marketplace
  // listings; exclusive auction wins transfer rights via DocuSign, not this path.
  const { data: listingRow } = await supabaseAdmin
    .from("auctions")
    .select("id, status")
    .eq("id", id)
    .single();
  const listing = listingRow as Pick<DbAuction, "id" | "status"> | null;
  if (!listing || listing.status !== "marketplace")
    return res
      .status(400)
      .json({ error: "Listing is not available for licensing" });

  // Idempotent: one immutable acceptance per purchase. If this transaction was
  // already accepted, return that record rather than writing a duplicate (rows
  // can't be de-duped after the fact — UPDATE/DELETE are blocked by trigger).
  const { data: existingRow } = await supabaseAdmin
    .from("license_acceptances")
    .select("id, accepted_at, license_version")
    .eq("transaction_id", transaction_id)
    .maybeSingle();
  const existing = existingRow as Pick<
    DbLicenseAcceptance,
    "id" | "accepted_at" | "license_version"
  > | null;
  if (existing)
    return res.status(200).json({
      acceptance: {
        id: existing.id,
        accepted_at: existing.accepted_at,
        version: existing.license_version,
      },
      message: "License already accepted for this purchase.",
    });

  // Capture the audit fingerprint server-side (same pattern as the listing
  // attestation). x-forwarded-for is set by Vercel's proxy; fall back to the socket.
  const ipAddress =
    (req.headers["x-forwarded-for"] as string) ||
    req.socket?.remoteAddress ||
    "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  const sessionId = req.headers["x-session-id"] as string | undefined;

  const { data: acceptanceRow, error: insertErr } = await supabaseAdmin
    .from("license_acceptances")
    .insert({
      buyer_id: u.id,
      content_id: id,
      transaction_id,
      agreement_accepted: true,
      accepted_at: new Date().toISOString(),
      ip_address: ipAddress,
      user_agent: userAgent,
      session_id: sessionId ?? null,
      // Freeze the exact terms and version at acceptance time (server-controlled).
      license_version: LICENSE_VERSION,
      legal_text_snapshot: LICENSE_LEGAL_TEXT,
    })
    .select("id, accepted_at, license_version")
    .single();

  if (insertErr || !acceptanceRow)
    return res.status(500).json({
      error: insertErr?.message ?? "Could not record license acceptance",
    });

  const ac = acceptanceRow as Pick<
    DbLicenseAcceptance,
    "id" | "accepted_at" | "license_version"
  >;
  return res.status(201).json({
    acceptance: {
      id: ac.id,
      accepted_at: ac.accepted_at,
      version: ac.license_version,
    },
    message: "Non-exclusive license accepted and recorded.",
  });
}

export default withErrorHandling(handler);
