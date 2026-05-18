import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { supabaseAdmin, getUserFromRequest } from "../../../lib/supabase";
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
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if ((user as DbUser).role !== "photographer")
    return res.status(403).json({ error: "Photographers only" });

  const u = user as DbUser;
  const { fileType, fileSizeMb } = req.body as { fileType?: string; fileSizeMb?: number; contentType?: string };

  if (!fileType || !ALLOWED_TYPES.includes(fileType)) {
    return res.status(400).json({ error: `File type ${fileType} not allowed` });
  }

  const isVideo = fileType.startsWith("video/");
  const maxMb = isVideo ? MAX_VIDEO_MB : MAX_PHOTO_MB;
  if ((fileSizeMb ?? 0) > maxMb) {
    return res.status(400).json({ error: `File too large. Max ${maxMb}MB for ${isVideo ? "video" : "photos"}` });
  }

  const ext = fileType.split("/")[1].replace("quicktime", "mov");
  const fileId = uuidv4();

  const [previewSigned, fullSigned] = await Promise.all([
    supabaseAdmin.storage.from("previews").createSignedUploadUrl(`${u.id}/${fileId}.${ext}`),
    supabaseAdmin.storage.from("fullres").createSignedUploadUrl(`${u.id}/${fileId}.${ext}`),
  ]);

  if (previewSigned.error || fullSigned.error) {
    return res.status(500).json({ error: "Failed to generate upload URLs" });
  }

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  return res.status(200).json({
    fileId,
    preview: {
      signedUrl: previewSigned.data.signedUrl,
      token: previewSigned.data.token,
      publicUrl: `${baseUrl}/storage/v1/object/public/previews/${u.id}/${fileId}.${ext}`,
    },
    fullres: {
      signedUrl: fullSigned.data.signedUrl,
      token: fullSigned.data.token,
    },
    instructions:
      "Upload preview to preview.signedUrl, full-res to fullres.signedUrl, then POST to /api/auctions with the returned publicUrl as preview_url",
  });
}

export default withErrorHandling(handler);
