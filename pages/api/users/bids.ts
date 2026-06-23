import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  supabaseAdmin,
  getUserFromRequest,
  supabaseQuery,
} from "../../../lib/supabase";
import { storage } from "../../../lib/storage";
import { formatAuction } from "../../../lib/format";
import type {
  DbUser,
  DbAuction,
  DbBid,
  DbTransaction,
} from "../../../lib/types";

// GET /api/users/bids — the signed-in buyer's auction activity:
//   won    — auctions they won (status 'sold'), with payment status and, once
//            paid, a short-lived signed download URL for the full-res file.
//   active — live auctions they have a bid on, flagged with whether they're the
//            current high bidder.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const u = user as DbUser;

  // ── Won auctions ───────────────────────────────────────────────────────────
  const { data: wonRows } = await supabaseQuery<DbAuction[]>(
    supabaseAdmin
      .from("auctions")
      .select("*, users!photographer_id(handle, display_name, avatar_url)")
      .eq("buyer_id", u.id)
      .eq("status", "sold")
      .order("updated_at", { ascending: false }),
  );
  const wonAuctions = wonRows ?? [];

  // Payment status per won auction comes from the transactions row.
  const wonIds = wonAuctions.map((a) => a.id);
  const txByAuction = new Map<string, DbTransaction>();
  if (wonIds.length) {
    const { data: txs } = await supabaseQuery<DbTransaction[]>(
      supabaseAdmin.from("transactions").select("*").in("auction_id", wonIds),
    );
    for (const tx of txs ?? []) txByAuction.set(tx.auction_id, tx);
  }

  const won = await Promise.all(
    wonAuctions.map(async (row) => {
      const tx = txByAuction.get(row.id);
      const paymentStatus = tx?.payment_status ?? "pending";
      const paid = paymentStatus === "succeeded";

      // Only hand back a download link after payment has settled.
      let downloadUrl: string | null = null;
      if (paid && row.full_url) {
        downloadUrl = await storage.createDownloadUrl(row.full_url);
      }

      const { full_url: _full, ...formatted } = formatAuction(row);
      return {
        ...formatted,
        salePrice: row.sale_price ?? formatted.currentBid,
        paymentStatus,
        paid,
        downloadUrl,
      };
    }),
  );

  // ── Active auctions the buyer is bidding on ─────────────────────────────────
  const { data: myBids } = await supabaseQuery<
    Pick<DbBid, "auction_id" | "amount" | "is_winning">[]
  >(
    supabaseAdmin
      .from("bids")
      .select("auction_id, amount, is_winning")
      .eq("bidder_id", u.id),
  );

  // Collapse to one entry per auction: my highest bid + whether I'm winning it.
  const myByAuction = new Map<string, { myBid: number; isWinning: boolean }>();
  for (const b of myBids ?? []) {
    const prev = myByAuction.get(b.auction_id);
    myByAuction.set(b.auction_id, {
      myBid: Math.max(prev?.myBid ?? 0, b.amount),
      isWinning: (prev?.isWinning ?? false) || b.is_winning,
    });
  }

  const activeIds = [...myByAuction.keys()];
  let active: Array<Record<string, unknown>> = [];
  if (activeIds.length) {
    const { data: activeRows } = await supabaseQuery<DbAuction[]>(
      supabaseAdmin
        .from("auctions")
        .select("*, users!photographer_id(handle, display_name, avatar_url)")
        .in("id", activeIds)
        .eq("status", "active")
        .order("ends_at", { ascending: true }),
    );
    active = (activeRows ?? []).map((row) => {
      const mine = myByAuction.get(row.id)!;
      const { full_url: _full, ...formatted } = formatAuction(row);
      return { ...formatted, myBid: mine.myBid, isWinning: mine.isWinning };
    });
  }

  return res.status(200).json({ won, active });
}

export default withErrorHandling(handler);
