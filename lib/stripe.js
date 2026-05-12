import Stripe from "stripe";

let _stripe = null;
function getStripe() {
  return (_stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-04-22.dahlia",
  }));
}

const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PCT || "0.20");

export async function createPaymentIntent({
  amount,
  buyerStripeId,
  auctionId,
  photographerAccountId,
}) {
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

export async function initiatePhotographerPayout({
  photographerAccountId,
  amount,
  auctionId,
}) {
  const amountCents = Math.round(amount * 100);
  return getStripe().transfers.create({
    amount: amountCents,
    currency: "usd",
    destination: photographerAccountId,
    metadata: { auction_id: auctionId },
  });
}

export async function createConnectOnboardingLink(
  accountId,
  returnUrl,
  refreshUrl,
) {
  return getStripe().accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });
}

export async function getOrCreateCustomer(email, name) {
  const existing = await getStripe().customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];
  return getStripe().customers.create({ email, name });
}

export async function createConnectAccount(email, displayName, handle) {
  return getStripe().accounts.create({
    type: "express",
    country: "US",
    email,
    capabilities: { transfers: { requested: true } },
    business_profile: { name: displayName || handle },
  });
}
