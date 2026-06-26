"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { hashToken } from "@/lib/auth/resolveUser";

// Issues a device token. The raw token is returned ONCE to the caller and never
// stored — only its SHA-256 hash is persisted. Runs under the user's session, so
// the RLS insert policy (user_id = auth.uid()) is what authorizes the write.
export async function createDevice(
  name: string,
): Promise<{ token?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not signed in" };

  const token = randomBytes(24).toString("base64url"); // ~32 url-safe chars
  const { error } = await supabase.from("devices").insert({
    user_id: user.id,
    name: name?.trim() || "My PC",
    token_hash: hashToken(token),
  });
  if (error) return { error: error.message };

  revalidatePath("/devices");
  return { token };
}

export async function revokeDevice(formData: FormData) {
  const id = String(formData.get("id"));
  const supabase = await createClient();
  await supabase
    .from("devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id); // RLS already scopes this to the signed-in user's rows
  revalidatePath("/devices");
}
