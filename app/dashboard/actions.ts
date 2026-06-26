"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Sets (or clears) a per-date override for one hour slot.
// Empty goal removes the override, so the slot falls back to the weekly template.
export async function setOverride(date: string, hour: number, goal: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const trimmed = goal.trim();
  if (trimmed === "") {
    await supabase
      .from("targets_override")
      .delete()
      .eq("user_id", user.id)
      .eq("date", date)
      .eq("hour", hour);
  } else {
    await supabase
      .from("targets_override")
      .upsert(
        { user_id: user.id, date, hour, goal: trimmed },
        { onConflict: "user_id,date,hour" },
      );
  }
  revalidatePath("/dashboard");
}
