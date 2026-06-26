import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";

export type ResolvedUser = { userId: string; via: "jwt" | "device" };

// Resolves the caller of an ingest request to a user_id via either:
//   - a Supabase access token (JWT)  → web app / Chrome extension
//   - an opaque device token (hashed) → desktop agent
// Returns null if neither resolves.
export async function resolveUser(req: Request): Promise<ResolvedUser | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const svc = createServiceClient();

  // JWT path: Supabase access tokens have three dot-separated segments.
  if (token.split(".").length === 3) {
    const { data, error } = await svc.auth.getUser(token);
    if (!error && data.user) return { userId: data.user.id, via: "jwt" };
  }

  // Device-token path: look up the SHA-256 hash, must not be revoked.
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: device } = await svc
    .from("devices")
    .select("id, user_id")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (device) {
    // Best-effort last-seen bump; don't block ingest on it.
    await svc
      .from("devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", device.id);
    return { userId: device.user_id, via: "device" };
  }

  return null;
}

// SHA-256 hex of a token (used when issuing device tokens).
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
