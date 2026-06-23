// ── Storage seam ──────────────────────────────────────────────────────────────
// The single module every file-storage operation routes through. Today it's
// backed by Supabase Storage; the `StorageBackend` interface is the swap point so
// a different backend (e.g. cheaper cold storage for ARCHIVED content) can be
// dropped in later without touching call sites. No tiering/selection logic yet —
// just keep this seam clean: callers must never import the Supabase storage client
// or hardcode bucket strings directly.

import { supabaseAdmin } from "./supabase";

// Logical bucket names. Implementation detail of the current backend, but exposed
// here so callers reference these constants instead of raw strings.
export const PREVIEW_BUCKET = "previews"; // public, watermarked previews
export const FULLRES_BUCKET = "fullres"; // private, delivered via signed URLs

// Default lifetime for a delivered full-res download link (7 days).
export const DOWNLOAD_URL_TTL = 60 * 60 * 24 * 7;

export interface UploadTarget {
  signedUrl: string;
  path: string;
  token: string;
}

// Thrown by createUploadUrl so callers can report which bucket failed.
export class StorageError extends Error {
  constructor(
    message: string,
    readonly bucket: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StorageBackend {
  /** A short-lived URL the client PUTs the file to. Throws StorageError on failure. */
  createUploadUrl(bucket: string, path: string): Promise<UploadTarget>;
  /** Stable public URL for a public-bucket object (e.g. previews). */
  getPublicUrl(bucket: string, path: string): string;
  /**
   * Short-lived signed URL to download a private object. Returns null if it can't
   * be signed. Defaults to the full-res bucket + DOWNLOAD_URL_TTL — the dominant
   * "deliver purchased content" case.
   */
  createDownloadUrl(
    path: string,
    ttlSeconds?: number,
    bucket?: string,
  ): Promise<string | null>;
  /** Delete objects. Used for archive/cleanup. */
  remove(bucket: string, paths: string[]): Promise<void>;
}

// ── Supabase implementation ───────────────────────────────────────────────────
const supabaseStorage: StorageBackend = {
  async createUploadUrl(bucket, path) {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUploadUrl(path, { upsert: true });
    if (error || !data) {
      throw new StorageError(
        error?.message ?? "Failed to create upload URL",
        bucket,
      );
    }
    return { signedUrl: data.signedUrl, path: data.path, token: data.token };
  },

  getPublicUrl(bucket, path) {
    return supabaseAdmin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  },

  async createDownloadUrl(
    path,
    ttlSeconds = DOWNLOAD_URL_TTL,
    bucket = FULLRES_BUCKET,
  ) {
    const { data } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(path, ttlSeconds);
    return data?.signedUrl ?? null;
  },

  async remove(bucket, paths) {
    const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
    if (error) throw new StorageError(error.message, bucket);
  },
};

// The single storage handle the rest of the app imports.
export const storage: StorageBackend = supabaseStorage;
