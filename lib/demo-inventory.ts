type DemoAuctionLike = {
  title?: string | null;
  preview_url?: string | null;
  photographer?: string | null;
  users?: {
    handle?: string | null;
    display_name?: string | null;
    photographer_handle?: string | null;
  } | null;
};

const DEMO_TITLES = new Set(["test", "seam marketplace item"]);
const DEMO_PHOTOGRAPHERS = new Set(["test", "seam_photog"]);
const DEMO_PREVIEW_HOSTS = ["placehold.co", "example.com"];

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeHandle(value: string | null | undefined): string {
  return normalizeText(value).replace(/^@+/, "");
}

export function isDemoTitle(value: string | null | undefined): boolean {
  return DEMO_TITLES.has(normalizeText(value));
}

export function isDemoPhotographer(value: string | null | undefined): boolean {
  return DEMO_PHOTOGRAPHERS.has(normalizeHandle(value));
}

export function isDemoPreviewUrl(value: string | null | undefined): boolean {
  if (!value) return false;

  try {
    const host = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    return DEMO_PREVIEW_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    const normalized = normalizeText(value);
    return DEMO_PREVIEW_HOSTS.some((blocked) =>
      normalized.includes(`://${blocked}/`) ||
      normalized.includes(`://www.${blocked}/`) ||
      normalized.includes(`.${blocked}/`) ||
      normalized.startsWith(`${blocked}/`) ||
      normalized.startsWith(`www.${blocked}/`),
    );
  }
}

export function isDemoAuction(row: DemoAuctionLike): boolean {
  return (
    isDemoTitle(row.title) ||
    isDemoPreviewUrl(row.preview_url) ||
    [row.photographer, row.users?.handle, row.users?.display_name, row.users?.photographer_handle]
      .some((value) => isDemoPhotographer(value))
  );
}
