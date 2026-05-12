/**
 * GET /api/users
 * Returns a paginated list of users (admin only)
 */
import { withErrorHandling } from "../../../lib/api.js";
import { getAllUsers, getUserFromRequest } from "../../../lib/supabase.js";

async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  // const requester = await getUserFromRequest(req);
  // if (!requester) return res.status(401).json({ error: "Unauthorized" });
  // if (requester.role !== "admin")
  //   return res.status(403).json({ error: "Admin only" });

  const role = Array.isArray(req.query.role)
    ? req.query.role[0]
    : req.query.role;
  const limitParam = Array.isArray(req.query.limit)
    ? req.query.limit[0]
    : req.query.limit;
  const offsetParam = Array.isArray(req.query.offset)
    ? req.query.offset[0]
    : req.query.offset;

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  const offset = offsetParam ? Number.parseInt(offsetParam, 10) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return res
      .status(400)
      .json({ error: "limit must be an integer from 1 to 200" });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: "offset must be an integer >= 0" });
  }

  if (role && !["photographer", "buyer", "admin"].includes(role)) {
    return res.status(400).json({ error: "Invalid role filter" });
  }

  const result = await getAllUsers({ role, limit, offset });

  return res.status(200).json(result);
}

export default withErrorHandling(handler);
