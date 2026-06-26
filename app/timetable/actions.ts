"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Saves all 24 hour goals for one weekday of the recurring template.
// Non-empty hours are upserted; cleared hours are deleted.
export async function saveTemplate(formData: FormData) {
  const weekday = Number(formData.get("weekday"));
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const upserts: {
    user_id: string;
    weekday: number;
    hour: number;
    goal: string;
  }[] = [];
  const emptyHours: number[] = [];

  for (let hour = 0; hour < 24; hour++) {
    const goal = String(formData.get(`hour_${hour}`) ?? "").trim();
    if (goal) upserts.push({ user_id: user.id, weekday, hour, goal });
    else emptyHours.push(hour);
  }

  if (upserts.length) {
    await supabase
      .from("targets_template")
      .upsert(upserts, { onConflict: "user_id,weekday,hour" });
  }
  if (emptyHours.length) {
    await supabase
      .from("targets_template")
      .delete()
      .eq("user_id", user.id)
      .eq("weekday", weekday)
      .in("hour", emptyHours);
  }

  revalidatePath("/timetable");
  redirect(`/timetable?weekday=${weekday}&saved=1`);
}
