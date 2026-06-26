import type { SupabaseClient } from "@supabase/supabase-js";
import { localParts, zonedHourToUtc, weekdayOfDate } from "@/lib/time";

// Foreground apps that the Chrome extension already describes in detail.
// When the browser is foreground, the agent's "Chrome, N min" block is just a
// container — drop it and let extension events win (the merge/dedupe rule).
const BROWSER_APPS = new Set([
  "chrome",
  "google chrome",
  "msedge",
  "microsoft edge",
  "edge",
  "brave",
  "brave browser",
  "opera",
  "firefox",
  "mozilla firefox",
  "arc",
  "vivaldi",
  "chromium",
]);

function isBrowserApp(app: string | null): boolean {
  if (!app) return false;
  return BROWSER_APPS.has(app.trim().toLowerCase());
}

export type EventRow = {
  id: number;
  user_id: string;
  source: string;
  app: string | null;
  repo: string | null;
  file: string | null;
  url: string | null;
  title: string | null;
  video_id: string | null;
  problem: string | null;
  is_idle: boolean;
  started_at: string;
  duration_seconds: number;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function labelFor(e: EventRow): string {
  if (e.source === "extension") {
    if (e.problem) return `LeetCode · ${e.problem}`;
    if (e.video_id) return `YouTube · ${e.title ?? e.video_id}`;
    if (e.url) return hostOf(e.url);
    return e.title ?? "Browser";
  }
  if (e.app === "Cursor" && e.repo) {
    return `Cursor · ${e.repo}${e.file ? ` / ${e.file}` : ""}`;
  }
  return e.app ?? e.title ?? "Unknown app";
}

// Sum durations per activity label → a compact text digest for the LLM.
function buildDigest(events: EventRow[]): string {
  const totals = new Map<string, number>();
  for (const e of events) {
    const k = labelFor(e);
    totals.set(k, (totals.get(k) ?? 0) + (e.duration_seconds || 0));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([label, secs]) => `- ${label}: ${Math.round(secs / 60)} min`)
    .join("\n");
}

export type GroqResult = {
  note: string;
  match: string;
  reason: string;
  tokens: number | null;
};

async function callGroq(
  target: string | null,
  digest: string,
): Promise<GroqResult> {
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const system =
    "You analyze one hour of a person's computer activity (window titles + browser data, text only). " +
    "Write a concise one or two sentence note describing what they did that hour. " +
    "If a target/goal is given, judge whether they matched it. " +
    'Respond ONLY as a JSON object with keys: note (string), match (one of "matched","partial","missed","no_activity"), reason (short string). ' +
    'Use "no_activity" only when no target was set.';
  const user =
    `Target for this hour: ${target && target.trim() ? target : "(no target set)"}\n\n` +
    `Activity (app/site: minutes):\n${digest || "(none)"}\n\n` +
    "Return the JSON object now.";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (res.status === 429) {
    const err = new Error("groq_rate_limited") as Error & {
      rateLimited?: boolean;
    };
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`groq_error_${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? "{}";
  let parsed: { note?: string; match?: string; reason?: string } = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { note: content, match: target ? "partial" : "no_activity" };
  }
  const allowed = ["matched", "partial", "missed", "no_activity"];
  const match =
    parsed.match && allowed.includes(parsed.match)
      ? parsed.match
      : target
        ? "partial"
        : "no_activity";

  return {
    note: String(parsed.note ?? "").slice(0, 1000),
    match,
    reason: String(parsed.reason ?? "").slice(0, 300),
    tokens: json?.usage?.total_tokens ?? null,
  };
}

type Slot = {
  userId: string;
  tz: string;
  date: string;
  hour: number;
  slotStart: Date;
  events: EventRow[];
};

// The centralized fan-out: find completed, unsummarized (user, hour) slots,
// dedupe/merge events, resolve the target, ask Groq, write hourly_notes.
export async function runSummarize(
  svc: SupabaseClient,
  opts?: { maxSlots?: number },
): Promise<{
  processed: number;
  skipped: number;
  dueSlots: number;
  users: number;
  rateLimited: boolean;
}> {
  const maxSlots = opts?.maxSlots ?? 20;
  const nowMs = Date.now();

  // 1. Distinct users with pending events.
  const { data: pendingUsers, error: e1 } = await svc
    .from("events")
    .select("user_id")
    .is("summarized_at", null)
    .limit(5000);
  if (e1) throw new Error(e1.message);
  const userIds = [...new Set((pendingUsers ?? []).map((r) => r.user_id))];
  if (userIds.length === 0)
    return { processed: 0, skipped: 0, dueSlots: 0, users: 0, rateLimited: false };

  // 2. Their timezones.
  const { data: profiles } = await svc
    .from("profiles")
    .select("id, timezone")
    .in("id", userIds);
  const tzOf = new Map<string, string>(
    (profiles ?? []).map((p) => [p.id as string, (p.timezone as string) || "UTC"]),
  );

  // 3. Build the list of *completed* slots (slot end already in the past).
  const dueSlots: Slot[] = [];
  for (const userId of userIds) {
    const tz = tzOf.get(userId) ?? "UTC";
    const { data: evs } = await svc
      .from("events")
      .select("*")
      .eq("user_id", userId)
      .is("summarized_at", null)
      .order("started_at", { ascending: true })
      .limit(5000);

    const groups = new Map<string, EventRow[]>();
    for (const e of (evs ?? []) as EventRow[]) {
      const { date, hour } = localParts(e.started_at, tz);
      const key = `${date}#${hour}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
    for (const [key, events] of groups) {
      const [date, hourStr] = key.split("#");
      const hour = Number(hourStr);
      const slotStart = zonedHourToUtc(date, hour, tz);
      if (slotStart.getTime() + 3_600_000 <= nowMs) {
        dueSlots.push({ userId, tz, date, hour, slotStart, events });
      }
    }
  }

  // 4. Process up to maxSlots, sequentially with gentle pacing.
  let processed = 0;
  let skipped = 0;
  let rateLimited = false;

  for (const slot of dueSlots.slice(0, maxSlots)) {
    const ids = slot.events.map((e) => e.id);

    // Merge/dedupe: extension events win for browser time; drop agent browser
    // containers; drop idle blocks.
    const ext = slot.events.filter((e) => e.source === "extension");
    const agentKept = slot.events.filter(
      (e) => e.source === "agent" && !isBrowserApp(e.app),
    );
    const merged = [...agentKept, ...ext].filter((e) => !e.is_idle);

    if (merged.length === 0) {
      // Nothing meaningful; consume so it doesn't re-trigger next run.
      await svc
        .from("events")
        .update({ summarized_at: new Date().toISOString() })
        .in("id", ids);
      skipped++;
      continue;
    }

    // Resolve target: override (may be a deliberate empty/cleared) ?? template.
    let target: string | null = null;
    const { data: ov } = await svc
      .from("targets_override")
      .select("goal")
      .eq("user_id", slot.userId)
      .eq("date", slot.date)
      .eq("hour", slot.hour)
      .maybeSingle();
    if (ov) {
      target = (ov.goal as string | null) ?? null;
    } else {
      const weekday = weekdayOfDate(slot.date);
      const { data: tpl } = await svc
        .from("targets_template")
        .select("goal")
        .eq("user_id", slot.userId)
        .eq("weekday", weekday)
        .eq("hour", slot.hour)
        .maybeSingle();
      target = (tpl?.goal as string | null) ?? null;
    }

    let result: GroqResult;
    try {
      result = await callGroq(target, buildDigest(merged));
    } catch (err) {
      if ((err as { rateLimited?: boolean })?.rateLimited) {
        rateLimited = true;
        break; // back off; next heartbeat picks up the rest
      }
      throw err;
    }

    await svc.from("hourly_notes").upsert(
      {
        user_id: slot.userId,
        slot_date: slot.date,
        slot_hour: slot.hour,
        slot_start: slot.slotStart.toISOString(),
        goal: target,
        note: result.note,
        match_status: result.match,
        reason: result.reason,
        model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
        tokens: result.tokens,
      },
      { onConflict: "user_id,slot_start", ignoreDuplicates: true },
    );

    await svc
      .from("events")
      .update({ summarized_at: new Date().toISOString() })
      .in("id", ids);

    processed++;
    await new Promise((r) => setTimeout(r, 250));
  }

  return { processed, skipped, dueSlots: dueSlots.length, users: userIds.length, rateLimited };
}
