import docusignPkg from "docusign-esign";
import type { RightsTransferParams } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ApiClient, EnvelopesApi, EnvelopeDefinition } = docusignPkg as any;

async function getApiClient() {
  const apiClient = new ApiClient();
  apiClient.setBasePath(process.env.DOCUSIGN_BASE_URL);

  const privateKey = process.env.DOCUSIGN_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const tokenResp = await apiClient.requestJWTUserToken(
    process.env.DOCUSIGN_INTEGRATION_KEY,
    process.env.DOCUSIGN_USER_ID,
    ["signature", "impersonation"],
    Buffer.from(privateKey),
    3600,
  );
  apiClient.addDefaultHeader("Authorization", `Bearer ${tokenResp.body.access_token}`);
  return apiClient;
}

async function executeRightsTransfer({
  transactionId,
  buyerEmail,
  buyerName,
  photographerEmail,
  photographerName,
  listingTitle,
  salePrice,
  exclusiveTier,
}: RightsTransferParams): Promise<{ envelopeId: string; status: string }> {
  const apiClient = await getApiClient();
  const envelopesApi = new EnvelopesApi(apiClient);

  const exclusivityText: Record<string, string> = {
    full_exclusive:
      "FULL EXCLUSIVE — Buyer holds all reproduction, distribution, and sublicensing rights. Photographer may not post, license, or distribute the content in any form.",
    platform_exclusive:
      "PLATFORM EXCLUSIVE — Buyer holds exclusive rights for digital platform distribution. Photographer may not post to any social media or digital channel.",
    non_exclusive:
      "NON-EXCLUSIVE — Buyer holds rights to publish and distribute. Photographer retains the right to post organically on their own channels.",
  };

  const envelopeDefinition = new EnvelopeDefinition();
  envelopeDefinition.templateId = process.env.DOCUSIGN_TEMPLATE_ID;
  envelopeDefinition.status = "sent";

  envelopeDefinition.templateRoles = [
    {
      roleName: "Buyer",
      name: buyerName,
      email: buyerEmail,
      tabs: {
        textTabs: [
          { tabLabel: "listing_title", value: listingTitle },
          { tabLabel: "sale_price", value: `$${salePrice.toLocaleString()}` },
          { tabLabel: "exclusivity_terms", value: exclusivityText[exclusiveTier] ?? exclusiveTier },
          { tabLabel: "transaction_id", value: transactionId },
          {
            tabLabel: "execution_date",
            value: new Date().toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
          },
        ],
      },
    },
    {
      roleName: "Photographer",
      name: photographerName ?? "Photographer",
      email: photographerEmail,
    },
  ];

  envelopeDefinition.emailSubject = `Rights Transfer Agreement: "${listingTitle}"`;
  envelopeDefinition.emailBlurb = `Your Rocket Ranch Media Marketplace rights transfer for "${listingTitle}" is ready to sign.`;

  const result = await envelopesApi.createEnvelope(
    process.env.DOCUSIGN_ACCOUNT_ID,
    { envelopeDefinition },
  );

  return { envelopeId: result.envelopeId, status: result.status };
}

async function checkEnvelopeStatus(envelopeId: string): Promise<{ status: string; completedAt: string }> {
  const apiClient = await getApiClient();
  const envelopesApi = new EnvelopesApi(apiClient);
  const envelope = await envelopesApi.getEnvelope(
    process.env.DOCUSIGN_ACCOUNT_ID,
    envelopeId,
  );
  return { status: envelope.status, completedAt: envelope.completedDateTime };
}

export default { executeRightsTransfer, checkEnvelopeStatus };
