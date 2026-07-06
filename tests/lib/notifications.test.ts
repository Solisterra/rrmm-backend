import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseHarness, type ResolveCtx } from "../helpers/supabase-mock";

// ── Mocks ─────────────────────────────────────────────────────────────────────
const db = makeSupabaseHarness();

const { twilioCreate, twilioFactory, sgSend, sgSetApiKey } = vi.hoisted(() => {
  const twilioCreate = vi.fn(async () => ({ sid: "SM1" }));
  return {
    twilioCreate,
    twilioFactory: vi.fn(() => ({ messages: { create: twilioCreate } })),
    sgSend: vi.fn(async () => [{ statusCode: 202 }]),
    sgSetApiKey: vi.fn(),
  };
});

vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: db.supabaseAdmin,
  getUserFromRequest: db.getUserFromRequest,
  supabaseQuery: db.supabaseQuery,
  supabase: db.supabase,
}));
vi.mock("twilio", () => ({ default: twilioFactory }));
vi.mock("@sendgrid/mail", () => ({
  default: { setApiKey: sgSetApiKey, send: sgSend },
}));

let notifications: typeof import("../../lib/notifications");

// Archived-listing notice is the one notification the spec requires over BOTH
// email and SMS; these tests pin the whole delivery pipeline.
function archiveResolver(phone: string | null) {
  return ({ table, terminal }: ResolveCtx) => {
    if (table === "auctions" && terminal === "single")
      return { data: { title: "Starship Launch" }, error: null };
    if (table === "users" && terminal === "single")
      return {
        data: {
          email: "shooter@example.com",
          display_name: "Shooter",
          phone,
        },
        error: null,
      };
    return { data: null, error: null };
  };
}

beforeEach(async () => {
  db.reset();
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
  vi.stubEnv("SENDGRID_API_KEY", "SG.test");
  vi.stubEnv("SENDGRID_FROM_EMAIL", "no-reply@rrmm.example");
  vi.stubEnv("SENDGRID_FROM_NAME", "RRMM");
  notifications = await import("../../lib/notifications");
});

describe("notifyContentArchived — email + SMS per spec", () => {
  it("persists the in-app notification", async () => {
    db.setResolver(archiveResolver("+15551234567"));
    await notifications.notifyContentArchived({
      photographerId: "photographer-1",
      auctionId: "auction-1",
    });
    expect(db.inserts("notifications")[0]).toMatchObject({
      user_id: "photographer-1",
      type: "content_archived",
      auction_id: "auction-1",
    });
  });

  it("sends BOTH an email and an SMS when the photographer has a phone", async () => {
    db.setResolver(archiveResolver("+15551234567"));
    await notifications.notifyContentArchived({
      photographerId: "photographer-1",
      auctionId: "auction-1",
    });

    expect(sgSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "shooter@example.com" }),
    );
    expect(twilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551234567",
        from: "+15550001111",
        body: expect.stringContaining("archived"),
      }),
    );
  });

  it("skips SMS (but still emails) when no phone is on file", async () => {
    db.setResolver(archiveResolver(null));
    await notifications.notifyContentArchived({
      photographerId: "photographer-1",
      auctionId: "auction-1",
    });
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(sgSend).toHaveBeenCalled();
  });

  it("never lets an SMS failure break the notification", async () => {
    db.setResolver(archiveResolver("+15551234567"));
    twilioCreate.mockRejectedValueOnce(new Error("twilio down"));
    await expect(
      notifications.notifyContentArchived({
        photographerId: "photographer-1",
        auctionId: "auction-1",
      }),
    ).resolves.toBeUndefined();
    // Email delivery still proceeds after the SMS failure.
    expect(sgSend).toHaveBeenCalled();
  });
});
