import Stripe from "stripe";
import type {
  CreatePaymentIntentParams,
  CreateCheckoutSessionParams,
  InitiatePayoutParams,
} from "./types";

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  return (_stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY!, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiVersion: "2026-04-22.dahlia" as any,
  }));
}

const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PCT || "0.20");

export async function createPaymentIntent({
  amount,
  buyerStripeId,
  auctionId,
  photographerAccountId,
}: CreatePaymentIntentParams): Promise<Stripe.PaymentIntent> {
  const amountCents = Math.round(amount * 100);
  const platformFeeCents = Math.round(amountCents * PLATFORM_FEE);
  return getStripe().paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    customer: buyerStripeId,
    payment_method_types: ["card"],
    application_fee_amount: platformFeeCents,
    transfer_data: { destination: photographerAccountId },
    metadata: { auction_id: auctionId },
  });
}

// Hosted Stripe Checkout for a won auction. Returns a Session whose `url` the
// frontend redirects to; Stripe hosts the card page. With a connected
// photographer account this is a destination charge (auto-pays their net and
// takes our fee), so no separate transfer is needed afterwards.
export async function createCheckoutSession({
  amount,
  buyerStripeId,
  auctionId,
  title,
  photographerAccountId,
  successUrl,
  cancelUrl,
}: CreateCheckoutSessionParams): Promise<Stripe.Checkout.Session> {
  const amountCents = Math.round(amount * 100);
  const platformFeeCents = Math.round(amountCents * PLATFORM_FEE);

  // auction_id on the PaymentIntent is what the webhook keys off to settle the
  // transaction and trigger content delivery. With a connected photographer
  // account this becomes a destination charge (fee + auto-transfer of the net).
  return getStripe().checkout.sessions.create({
    mode: "payment",
    customer: buyerStripeId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: { name: title },
        },
      },
    ],
    payment_intent_data: {
      metadata: { auction_id: auctionId },
      ...(photographerAccountId
        ? {
            application_fee_amount: platformFeeCents,
            transfer_data: { destination: photographerAccountId },
          }
        : {}),
    },
    metadata: { auction_id: auctionId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

export async function initiatePhotographerPayout({
  photographerAccountId,
  amount,
  auctionId,
}: InitiatePayoutParams): Promise<Stripe.Transfer> {
  const amountCents = Math.round(amount * 100);
  return getStripe().transfers.create({
    amount: amountCents,
    currency: "usd",
    destination: photographerAccountId,
    metadata: { auction_id: auctionId },
  });
}

export async function createConnectOnboardingLink(
  accountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<Stripe.AccountLink> {
  return getStripe().accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });
}

export async function getOrCreateCustomer(
  email: string,
  name?: string,
): Promise<Stripe.Customer> {
  const existing = await getStripe().customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];
  return getStripe().customers.create({ email, name });
}

export async function createConnectAccount(
  email: string,
  displayName?: string,
  handle?: string,
): Promise<Stripe.Account> {
  return getStripe().accounts.create({
    type: "express",
    country: "US",
    email,
    capabilities: { transfers: { requested: true } },
    business_profile: { name: displayName || handle },
  });
}
