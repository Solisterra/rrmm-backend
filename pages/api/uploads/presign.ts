import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { getUserFromRequest } from "../../../lib/supabase";
import {
  storage,
  StorageError,
  PREVIEW_BUCKET,
  FULLRES_BUCKET,
} from "../../../lib/storage";
import { v4 as uuidv4 } from "uuid";
import type { DbUser } from "../../../lib/types";

const MAX_PHOTO_MB = 50;
const MAX_VIDEO_MB = 500;
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "video/mp4",
  "video/quicktime",
  "video/mov",
];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  // Uploads are for verified sellers (and admins).
  const u = user as DbUser;
  if (u.role !== "admin" && u.sell_status !== "verified")
    return res
      .status(403)
      .json({ error: "Seller verification required to upload" });
  const { fileType, fileSizeMb } = req.body as {
    fileType?: string;
    fileSizeMb?: number;
    contentType?: string;
  };

  if (!fileType || !ALLOWED_TYPES.includes(fileType)) {
    return res.status(400).json({ error: `File type ${fileType} not allowed` });
  }

  const isVideo = fileType.startsWith("video/");
  const maxMb = isVideo ? MAX_VIDEO_MB : MAX_PHOTO_MB;
  if ((fileSizeMb ?? 0) > maxMb) {
    return res.status(400).json({
      error: `File too large. Max ${maxMb}MB for ${isVideo ? "video" : "photos"}`,
    });
  }

  const ext = fileType.split("/")[1].replace("quicktime", "mov");
  const fileId = uuidv4();
  const filePath = `${u.id}/${fileId}.${ext}`;

  let previewTarget, fullTarget;
  try {
    [previewTarget, fullTarget] = await Promise.all([
      storage.createUploadUrl(PREVIEW_BUCKET, filePath),
      storage.createUploadUrl(FULLRES_BUCKET, filePath),
    ]);
  } catch (e) {
    const err = e as StorageError;
    return res.status(500).json({
      error: `Failed to generate upload URLs: ${err.message}`,
      bucket: err.bucket,
    });
  }

  const publicUrl = storage.getPublicUrl(PREVIEW_BUCKET, filePath);

  return res.status(200).json({
    fileId,
    filePath,
    preview: {
      signedUrl: previewTarget.signedUrl,
      path: previewTarget.path,
      token: previewTarget.token,
      publicUrl,
    },
    fullres: {
      signedUrl: fullTarget.signedUrl,
      path: fullTarget.path,
      token: fullTarget.token,
    },
    instructions:
      "Either (a) supabase.storage.from(bucket).uploadToSignedUrl(path, token, file), " +
      "or (b) PUT the raw file body to signedUrl with header 'content-type: <fileType>'. " +
      "Then POST to /api/auctions with preview.publicUrl as preview_url and filePath as full_url.",
  });
}

export default withErrorHandling(handler);
