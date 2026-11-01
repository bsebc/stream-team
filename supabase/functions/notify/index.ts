import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------
// Stream Team — notifier + the ONLY writer to the database.
//
//   POST {}                         -> send due reminders (called by cron)
//   POST { action: "<member act>" } -> a team member's action, validated here
//   POST { action: "admin_*" }      -> privileged write, guarded by the PIN
//
// The browser can read the schedule but cannot write to any table: row-level
// security allows SELECT only. Every change goes through this function, which
// checks that the change is legal (your own turn, still open, not cancelled,
// inside the confirm window, ...) before making it, and sends the Telegram
// message itself. That is what stops someone with the public key from
// rewriting the schedule or spamming the group directly.
//
// Identity is still "who you picked on this device" — there are no accounts —
// so the checks are about what a move is allowed to do, not who is asking.
// ---------------------------------------------------------------

const TG    = Deno.env.get("TELEGRAM_TOKEN")!;
const GROUP = Deno.env.get("TELEGRAM_GROUP")!;
const APP   = "https://stream.bsebc.com";

// Old copies of the page (open on someone's phone during a deploy) send the
// pre-2026-11 {event: ...} calls after writing to the tables themselves.
// Once the database stops accepting those writes, the events are only a way
// to post fake messages, so they stay off.
const LEGACY_EVENTS = false;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "stream" } }
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const ok   = (body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: true, ...body }), { headers: CORS });
// `error` is a stable code the app translates; `message` is for logs/humans.
const fail = (code: string, status = 400, message?: string) =>
  new Response(JSON.stringify({ error: code, message: message ?? code }), { status, headers: CORS });

// Everything interpolated into a Telegram message goes through esc():
// parse_mode is HTML, and a bare "&" or "<" in a name or a special-service
// label ("Q&A night") makes Telegram reject the whole message.
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Error text from fetch() can contain the request URL, and Telegram URLs
// carry the bot token. Nothing that might hold it is ever logged or returned
// without going through this.
const redact = (s: unknown) => String(s).split(TG || "\u0000").join("<token>");

// Returns { ok, permanent }. "permanent" means Telegram will never accept
// this message — the member blocked the bot, deleted the chat, or was never
// reachable — so retrying it forever is pointless.
async function send(chat: string | number, text: string): Promise<{ ok: boolean; permanent: boolean }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true
      })
    });
    if (res.ok) return { ok: true, permanent: false };
    const body = await res.text();
    console.error("telegram:", res.status, redact(body));
    const permanent =
      res.status === 403 ||
      /chat not found|blocked|deactivated|kicked|can't initiate|user is deactivated/i.test(body);
    return { ok: false, permanent };
  } catch (e) {
    console.error("telegram fetch failed:", redact(e));
    return { ok: false, permanent: false };   // network blip — worth retrying
  }
}

// ---------------------------------------------------------------------
// Time zone handling.
//
// This function runs in UTC. Service times are wall-clock times in the
// church's own zone, so everything converts the stored wall clock into a
// real instant first. Intl handles daylight saving.
// ---------------------------------------------------------------------

let TZ = "America/New_York";      // replaced by the settings value each run
const HOUR = 3_600_000;
const LIVE_MS = 2 * HOUR;          // a service counts as "on" for two hours

function zoneOffsetMs(at: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(at);
  const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - at.getTime();
}

// "2026-09-06" + "18:00:00" in America/New_York -> the true UTC instant.
function instantOf(date: string, time: string, tz: string): Date {
  const naive = new Date(`${date}T${String(time).slice(0, 8).padEnd(8, ":00")}Z`);
  const guess = new Date(naive.getTime() - zoneOffsetMs(naive, tz));
  // One correction pass: on a DST changeover the offset at the guessed
  // instant can differ from the offset at the naive one.
  const settled = zoneOffsetMs(guess, tz);
  return new Date(naive.getTime() - settled);
}

// "2026-12-24" + "19:00:00" -> { text: "Thu, Dec 24 · Christmas Eve 7 PM" }
// what/text are already HTML-escaped.
function label(s: any) {
  const when = instantOf(s.date, s.time, TZ);
  const day = when.toLocaleDateString("en-US",
    { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  const mins = Number(String(s.time).slice(3, 5));
  const clock = when.toLocaleTimeString("en-US",
    { hour: "numeric", minute: mins ? "2-digit" : undefined, hour12: true, timeZone: TZ });
  const what = esc(s.special || (s.part === "M" ? "Morning" : "Evening"));
  return { day, clock, what, when, text: `${day} · ${what} ${clock}` };
}

const appBase = () => APP.replace(/[#?].*$/, "").replace(/\/$/, "");

// A link straight to this service inside the app: the member lands on
// My turns with the sheet for that turn already open.
function deepLink(s: any) {
  // & MUST be written &amp; — this goes inside an <a href> with parse_mode
  // HTML, which rejects a bare &. The browser reads &amp; as a plain &.
  return `${appBase()}/#t=${encodeURIComponent(s.id)}&amp;me=${encodeURIComponent(s.member_id ?? "")}`;
}

async function settings() {
  const { data, error } = await db.from("settings").select("*").eq("id", 1).single();
  if (error || !data) throw new Error("cannot read settings: " + (error?.message ?? "no row"));
  TZ = data.timezone || TZ;
  return data;
}

async function member(id: string) {
  if (!id) return null;
  const { data } = await db.from("members").select("id, name, chat_id, active").eq("id", id).maybeSingle();
  return data ?? null;
}
const nameOf = async (id: string | null | undefined) => {
  if (!id) return "";
  const m = await member(id);
  return esc(m?.name ?? "someone");
};

async function service(id: string) {
  if (!id || typeof id !== "string") return null;
  const { data } = await db.from("services").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

async function pendingFor(serviceId: string) {
  const { data } = await db.from("requests").select("*")
    .eq("service_id", serviceId).eq("status", "pending").limit(1);
  return (data && data[0]) || null;
}

// ---------------------------------------------------------------------
// Rate limits, kept in stream.rate_limits by the rate_hit() SQL function.
// add = 0 reads the current count without adding to it. If the table or
// function is missing the limiter fails open, so the app keeps working.
// ---------------------------------------------------------------------
async function rateHit(key: string, windowSecs: number, add = 1): Promise<number> {
  const { data, error } = await db.rpc("rate_hit", { p_key: key, p_window_secs: windowSecs, p_add: add });
  if (error) { console.error("rate_hit:", error.message); return 0; }
  return Number(data) || 0;
}

function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Constant-time string compare, so response timing says nothing about how
// many leading characters of a guessed PIN were right.
function sameText(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const PIN_IP_LIMIT = 5, PIN_IP_WINDOW = 15 * 60;      // per address
const PIN_ALL_LIMIT = 30, PIN_ALL_WINDOW = 60 * 60;   // everyone together

// Returns the settings row when the PIN is right, or a Response to send back.
async function checkPin(pin: unknown, ip: string): Promise<any> {
  const [mine, all] = await Promise.all([
    rateHit("pin:" + ip, PIN_IP_WINDOW, 0),
    rateHit("pin:*", PIN_ALL_WINDOW, 0)
  ]);
  if (mine >= PIN_IP_LIMIT || all >= PIN_ALL_LIMIT) {
    return fail("locked", 429, "Too many wrong PINs. Try again later.");
  }
  let cfg;
  try { cfg = await settings(); }
  catch (e) {
    // A failing settings read must NOT look like a wrong PIN.
    console.error(redact(e));
    return fail("server", 500, "Cannot read settings.");
  }
  if (typeof pin !== "string" || !pin || !sameText(pin, String(cfg.admin_pin))) {
    await Promise.all([rateHit("pin:" + ip, PIN_IP_WINDOW), rateHit("pin:*", PIN_ALL_WINDOW)]);
    return fail("bad pin", 401);
  }
  return cfg;
}

// ---------------------------------------------------------------------
// Linking Telegram accounts to members.
//
// A DM can only be sent to a chat_id, and Telegram only reveals a person's
// chat_id once they have written to the bot. So we read recent updates and
// match the sender's @username against members.telegram. Runs on every cron
// tick. offset=-100 asks for the NEWEST 100 updates: without it Telegram
// returns the oldest 100, and once more than 100 pile up (a chatty group)
// a new member's first message would not be seen for up to a day.
// ---------------------------------------------------------------------
async function linkChats() {
  let body: any;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG}/getUpdates?offset=-100&limit=100`);
    if (!res.ok) {
      console.error("getUpdates failed:", res.status, redact(await res.text()));
      return { linked: 0, seen: 0, unmatched: [] as string[] };
    }
    body = await res.json();
  } catch (e) {
    console.error("getUpdates failed:", redact(e));
    return { linked: 0, seen: 0, unmatched: [] as string[] };
  }
  const updates: any[] = body?.result ?? [];

  const byUser = new Map<string, number>();
  for (const u of updates) {
    const msg = u.message ?? u.edited_message ?? u.my_chat_member;
    const from = msg?.from, chat = msg?.chat;
    if (!from?.username || !chat?.id) continue;
    if (chat.type !== "private") continue;      // group messages are not DMs
    byUser.set(String(from.username).toLowerCase(), chat.id);
  }
  if (!byUser.size) return { linked: 0, seen: 0, unmatched: [] };

  const { data: members } = await db.from("members").select("id, telegram, chat_id");
  let linked = 0;
  const matched = new Set<string>();

  for (const m of members ?? []) {
    if (!m.telegram) continue;
    const handle = String(m.telegram).replace(/^@/, "").toLowerCase();
    const id = byUser.get(handle);
    if (!id) continue;
    matched.add(handle);
    if (m.chat_id === id) continue;             // already linked
    const { error } = await db.from("members").update({ chat_id: id }).eq("id", m.id);
    if (error) console.error("link failed for", m.id, error.message);
    else { linked++; console.log("linked", m.id, "->", id); }
  }

  const unmatched = [...byUser.keys()].filter(h => !matched.has(h));
  if (unmatched.length) console.log("unmatched senders:", unmatched.join(", "));
  return { linked, seen: byUser.size, unmatched };
}

// ==================== reminders (cron) ====================

async function runReminders() {
  await linkChats();

  const cfg = await settings();
  const hours = cfg?.rem_hours ?? 24;
  const now   = new Date();
  const until = new Date(now.getTime() + hours * HOUR);

  // The date columns are plain dates, so the coarse filter runs a day wide
  // on each side; the exact instant check below is what actually decides.
  const dayBefore = (d: Date) => new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
  const dayAfter  = (d: Date) => new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);

  const { data: due } = await db
    .from("services")
    .select("*, members(name, chat_id, active)")
    .eq("notified", false)
    .eq("cancelled", false)
    .gte("date", dayBefore(now))
    .lte("date", dayAfter(until));

  // Each service is CLAIMED (flag flipped with a WHERE on the old value)
  // before anything is sent, so two runs overlapping — the cron plus someone
  // poking the endpoint — can never post the same reminder twice. If the
  // group post then fails, the claim is released and the next run retries.
  const claim = async (id: string, flag: "notified" | "warned") => {
    const { data } = await db.from("services").update({ [flag]: true })
      .eq("id", id).eq(flag, false).select("id");
    return !!data?.length;
  };
  const release = (id: string, flag: "notified" | "warned") =>
    db.from("services").update({ [flag]: false }).eq("id", id);

  let sent = 0;
  for (const s of due ?? []) {
    const L = label(s);
    if (L.when < now || L.when > until) continue;
    // A member switched to inactive will not turn up, so a turn they still
    // hold is announced as having no operator, and they get no DM.
    const op = s.member_id && s.members && s.members.active !== false ? s.members : null;
    if (!await claim(s.id, "notified")) continue;

    if (cfg?.notify_reminder_group !== false) {
      const text = op && s.open
        ? `🔴 <b>${esc(op.name)}</b> still needs a replacement — ${L.what} ${L.clock}, ${L.day}.\n` +
          `Open the app — first to accept takes it. ${APP}`
        : op
        ? `⏰ <b>Coming up</b> — ${L.what} ${L.clock}, ${L.day}\n` +
          `Operator: <b>${esc(op.name)}</b>\nConfirm in the app 👍 ${APP}`
        : `🔴 <b>No operator</b> for ${L.what} ${L.clock}, ${L.day}.\n` +
          `Open the app — first to accept takes it. ${APP}`;
      const r = await send(GROUP, text);
      if (!r.ok) {
        console.error("group reminder failed, will retry:", s.id);
        await release(s.id, "notified");
        continue;
      }
    }

    if (op && !s.open && cfg?.dm_duty && op.chat_id) {
      const r = await send(op.chat_id,
        `You are on the livestream — ${L.what} ${L.clock}, ${L.day}.\n` +
        `<a href="${deepLink(s)}">Confirm or ask for a replacement</a>`);
      if (!r.ok) {
        console.error(r.permanent
          ? `DM unreachable (member ${s.member_id}) — check their Telegram setup`
          : `DM failed for ${s.id}, group post already sent`);
      }
    }
    sent++;
  }

  // ---- second pass: the last-call warning ----------------------------
  // Unconfirmed close to the start — including turns nobody holds or that
  // are still waiting for a replacement, which need the nudge the most.
  const warnH = cfg?.warn_hours ?? 2;
  const warnBy = new Date(now.getTime() + warnH * HOUR);
  const { data: risky } = await db
    .from("services")
    .select("*, members(name, chat_id, active)")
    .eq("confirmed", false)
    .eq("warned", false)
    .eq("cancelled", false)
    .gte("date", dayBefore(now))
    .lte("date", dayAfter(warnBy));

  for (const s of risky ?? []) {
    const L = label(s);
    if (L.when < now || L.when > warnBy) continue;
    const mins = Math.round((L.when.getTime() - now.getTime()) / 60000);
    const left = mins >= 60
      ? `${Math.floor(mins / 60)}h ${mins % 60 ? (mins % 60) + "m" : ""}`.trim()
      : `${mins} min`;
    const op = s.member_id && s.members && s.members.active !== false ? s.members : null;
    if (!await claim(s.id, "warned")) continue;
    if (cfg?.notify_unconfirmed !== false) {
      const r = await send(GROUP, op && !s.open
        ? `⚠️ <b>Not confirmed yet</b> — ${L.what} ${L.clock} starts in ${left}.\n` +
          `<b>${esc(op.name)}</b> has not confirmed. ${APP}`
        : `⚠️ <b>Still no operator</b> — ${L.what} ${L.clock} starts in ${left}.\n` +
          `Open the app — first to accept takes it. ${APP}`);
      if (!r.ok) {
        console.error("group warning failed, will retry:", s.id);
        await release(s.id, "warned");
        continue;
      }
    }
    if (op && !s.open && cfg?.dm_duty && op.chat_id) {
      const r = await send(op.chat_id,
        `⚠️ ${L.what} ${L.clock} starts in ${left} and you have not confirmed.\n` +
        `<a href="${deepLink(s)}">Confirm now</a>`);
      if (!r.ok) console.error("warning DM failed for", s.id, r.permanent ? "(unreachable)" : "(transient)");
    }
  }
  return sent;
}

// ==================== member actions ====================
//
// Each one re-reads the row and applies its change with a WHERE clause that
// repeats the precondition, so two people tapping at once cannot both win:
// the second update matches no row and gets a clear error code back.

const MEMBER_ACTIONS = new Set(["confirm", "request_cover", "withdraw", "cover", "ask", "accept", "decline"]);

// Times relative to now for a service: when the confirm window opens, and
// whether it has started / finished.
function timing(s: any, cfg: any) {
  const start = instantOf(s.date, s.time, TZ);
  const now = Date.now();
  const opensAt = start.getTime() - (cfg.rem_hours ?? 24) * HOUR;
  return {
    start,
    windowOpen: now >= opensAt - 5 * 60_000,       // a little slack for phone clocks
    over: now >= start.getTime() + LIVE_MS          // finished — nothing to do
  };
}

// Taking a turn inside the confirm window IS the confirmation; outside it the
// flags reset so the new operator gets their own reminder at the normal time.
function handoffFlags(s: any, cfg: any) {
  return timing(s, cfg).windowOpen
    ? { confirmed: true, notified: true, warned: true }
    : { confirmed: false, notified: false, warned: false };
}

async function runMember(b: any, ip: string) {
  if (await rateHit("act:" + ip, 600) > 60) return fail("busy", 429, "Too many actions. Wait a few minutes.");
  const cfg = await settings();
  const L0 = async (s: any) => label(s);

  // An admin may withdraw any request; they send the PIN instead of a name.
  if (b.action === "withdraw" && b.pin) {
    const c = await checkPin(b.pin, ip);
    if (c instanceof Response) return c;
    return withdraw(b, cfg, null);
  }

  const me = await member(String(b.member || ""));
  if (!me) return fail("who", 400, "Pick your name first.");
  if (me.active === false) return fail("inactive", 403);

  switch (b.action) {
    case "confirm": {
      const s = await service(b.service_id);
      if (!s) return fail("gone", 404);
      if (s.member_id !== me.id) return fail("not_yours", 403);
      if (s.cancelled) return fail("cancelled", 409);
      if (s.open) return fail("open", 409);
      const t = timing(s, cfg);
      if (t.over) return fail("past", 409);
      if (!t.windowOpen) return fail("too_early", 409);
      if (s.confirmed) return ok({ already: true });
      const { data, error } = await db.from("services")
        .update({ confirmed: true })
        .eq("id", s.id).eq("member_id", me.id).eq("cancelled", false).eq("open", false)
        .select("id");
      if (error) return fail("server", 500, error.message);
      if (!data?.length) return fail("changed", 409);
      if (cfg.notify_confirm === true) {
        const L = await L0(s);
        await send(GROUP, `👍 <b>${esc(me.name)}</b> confirmed — ${L.text}`);
      }
      return ok();
    }

    case "request_cover": {
      const s = await service(b.service_id);
      if (!s) return fail("gone", 404);
      if (s.member_id !== me.id) return fail("not_yours", 403);
      if (s.cancelled) return fail("cancelled", 409);
      if (timing(s, cfg).over) return fail("past", 409);
      if (s.open || await pendingFor(s.id)) return fail("pending", 409);
      const { data, error } = await db.from("services")
        .update({ open: true })
        .eq("id", s.id).eq("member_id", me.id).eq("open", false).eq("cancelled", false)
        .select("id");
      if (error) return fail("server", 500, error.message);
      if (!data?.length) return fail("changed", 409);
      const ins = await db.from("requests")
        .insert({ service_id: s.id, from_id: me.id, to_id: null, status: "pending" });
      if (ins.error) {
        // Most likely a request appeared in between (one pending per service).
        await db.from("services").update({ open: false }).eq("id", s.id).eq("member_id", me.id);
        return fail("pending", 409, ins.error.message);
      }
      let told = true;
      if (cfg.alert_swap) {
        const L = await L0(s);
        told = (await send(GROUP,
          `🔴 <b>${esc(me.name)}</b> needs a replacement\n${L.text}\n` +
          `Open the app — first to accept takes it. ${APP}`)).ok;
      }
      return ok({ told });
    }

    case "withdraw":
      return withdraw(b, cfg, me);

    case "cover": {
      const s = await service(b.service_id);
      if (!s) return fail("gone", 404);
      if (s.cancelled) return fail("cancelled", 409);
      if (timing(s, cfg).over) return fail("past", 409);
      if (s.member_id === me.id) return fail("already_yours", 409);
      if (!s.open && s.member_id) return fail("taken", 409);
      const was = s.member_id || null;
      let q = db.from("services")
        .update({ member_id: me.id, open: false, replaced_from: was, ...handoffFlags(s, cfg) })
        .eq("id", s.id).eq("cancelled", false)
        .or("open.eq.true,member_id.is.null");
      q = was ? q.eq("member_id", was) : q.is("member_id", null);
      const { data, error } = await q.select("id");
      if (error) return fail("server", 500, error.message);
      if (!data?.length) return fail("taken", 409);
      await db.from("requests").update({ status: "done" })
        .eq("service_id", s.id).eq("status", "pending").is("to_id", null);
      const flags = handoffFlags(s, cfg);
      if (cfg.notify_pickup !== false) {
        const L = await L0(s);
        await send(GROUP,
          `✅ <b>${esc(me.name)}</b> takes ${L.text}` + (was ? ` — covering for ${await nameOf(was)}` : ""));
      }
      return ok({ confirmed: flags.confirmed });
    }

    case "ask": {
      const s = await service(b.service_id);
      if (!s) return fail("gone", 404);
      if (s.member_id !== me.id) return fail("not_yours", 403);
      if (s.cancelled) return fail("cancelled", 409);
      if (timing(s, cfg).over) return fail("past", 409);
      if (s.open || await pendingFor(s.id)) return fail("pending", 409);
      const to = await member(String(b.to || ""));
      if (!to || to.active === false || to.id === me.id) return fail("bad_target", 400);
      const ins = await db.from("requests")
        .insert({ service_id: s.id, from_id: me.id, to_id: to.id, status: "pending" });
      if (ins.error) return fail("pending", 409, ins.error.message);
      let dm = false;
      if (to.chat_id) {
        const L = await L0(s);
        dm = (await send(to.chat_id,
          `🔄 <b>${esc(me.name)}</b> asks you to take ${L.text}\n` +
          `<a href="${appBase()}/#me=${encodeURIComponent(to.id)}">Accept or decline</a>`)).ok;
      }
      return ok({ dm });
    }

    case "accept": {
      const { data: r } = await db.from("requests").select("*").eq("id", String(b.request_id || "")).maybeSingle();
      if (!r || r.status !== "pending") return fail("answered", 409);
      if (r.to_id !== me.id) return fail("not_yours", 403);
      const s = await service(r.service_id);
      if (!s) return fail("gone", 404);
      if (s.cancelled) return fail("cancelled", 409);
      if (timing(s, cfg).over) return fail("past", 409);
      // Claim the request first: whoever flips it out of "pending" wins, so
      // an accept and a withdraw racing each other cannot both succeed.
      const claim = await db.from("requests").update({ status: "done" })
        .eq("id", r.id).eq("status", "pending").select("id");
      if (claim.error) return fail("server", 500, claim.error.message);
      if (!claim.data?.length) return fail("answered", 409);
      const { data, error } = await db.from("services")
        .update({ member_id: me.id, open: false, replaced_from: r.from_id || null, ...handoffFlags(s, cfg) })
        .eq("id", s.id).eq("member_id", r.from_id).eq("cancelled", false)
        .select("id");
      if (error || !data?.length) {
        // The turn changed hands meanwhile — the ask no longer means anything.
        await db.from("requests").update({ status: "cancelled" }).eq("id", r.id);
        return fail(error ? "server" : "changed", error ? 500 : 409, error?.message);
      }
      if (cfg.notify_pickup !== false) {
        const L = await L0(s);
        const from = await nameOf(r.from_id);
        await send(GROUP,
          `✅ <b>${esc(me.name)}</b> takes ${L.text}` + (from ? ` — covering for ${from}` : ""));
      }
      return ok({ confirmed: handoffFlags(s, cfg).confirmed });
    }

    case "decline": {
      const { data: r } = await db.from("requests").select("*").eq("id", String(b.request_id || "")).maybeSingle();
      if (!r || r.status !== "pending") return fail("answered", 409);
      if (r.to_id !== me.id) return fail("not_yours", 403);
      const upd = await db.from("requests").update({ status: "declined" })
        .eq("id", r.id).eq("status", "pending").select("id");
      if (upd.error) return fail("server", 500, upd.error.message);
      if (!upd.data?.length) return fail("answered", 409);
      const s = await service(r.service_id);
      const asker = await member(r.from_id);
      if (s && asker?.chat_id) {
        const L = await L0(s);
        await send(asker.chat_id, `🚫 <b>${esc(me.name)}</b> can't take ${L.text}`);
      }
      return ok();
    }
  }
  return fail("unknown action");
}

// Withdraws whatever is pending on a service: an open call for cover, or a
// direct ask nobody has answered. `me` is null when an admin does it.
async function withdraw(b: any, cfg: any, me: any) {
  const s = await service(b.service_id);
  if (!s) return fail("gone", 404);
  const r = await pendingFor(s.id);
  if (me) {
    const mine = r ? r.from_id === me.id : (s.open && s.member_id === me.id);
    if (!mine) return fail("not_yours", 403);
  }
  if (!r && !s.open) return fail("answered", 409);
  // Whoever changes the row first wins. For an open call that is the
  // services.open flag, which "I'll cover it" also requires; for a direct ask
  // it is the request's status, which "Accept" also requires. Either way the
  // loser gets "answered" and nothing contradictory is posted.
  if (s.open) {
    let q = db.from("services").update({ open: false }).eq("id", s.id).eq("open", true);
    q = s.member_id ? q.eq("member_id", s.member_id) : q.is("member_id", null);
    const upd = await q.select("id");
    if (upd.error) return fail("server", 500, upd.error.message);
    if (!upd.data?.length) return fail("answered", 409);
  }
  if (r) {
    const upd = await db.from("requests").update({ status: "cancelled" })
      .eq("id", r.id).eq("status", "pending").select("id");
    if (upd.error) return fail("server", 500, upd.error.message);
    if (!upd.data?.length && !s.open) return fail("answered", 409);
  }
  const L = label(s);
  const who = await nameOf(r?.from_id ?? s.member_id);
  if (r?.to_id) {
    // A withdrawn PRIVATE ask concerns one person, so tell only them.
    const target = await member(r.to_id);
    if (target?.chat_id) {
      await send(target.chat_id,
        `↩️ <b>${who || "Someone"}</b> withdrew the request to take ${L.text}. Nothing needed from you.`);
    }
  } else if (who) {
    await send(GROUP, `↩️ <b>${who}</b> no longer needs cover — ${L.text}`);
  } else {
    await send(GROUP, `↩️ No longer looking for an operator — ${L.text}`);
  }
  return ok();
}

// ==================== admin actions ====================

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
const isTime = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
const hhmmss = (t: string) => (t.length === 5 ? t + ":00" : t);
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

async function runAdmin(b: any, ip: string) {
  const cfg = await checkPin(b.pin, ip);
  if (cfg instanceof Response) return cfg;

  switch (b.action) {
    case "admin_login":
      return ok({ settings: {
        group_name: cfg.group_name, rem_hours: cfg.rem_hours,
        dm_duty: cfg.dm_duty, alert_swap: cfg.alert_swap,
        notify_reminder_group: cfg.notify_reminder_group,
        notify_pickup: cfg.notify_pickup,
        notify_confirm: cfg.notify_confirm,
        notify_schedule: cfg.notify_schedule,
        notify_unconfirmed: cfg.notify_unconfirmed,
        warn_hours: cfg.warn_hours,
        timezone: cfg.timezone
      }});

    case "admin_test": {
      // Linking here too: pressing Send test message is the natural moment to
      // pick up anyone who has just written to the bot.
      const link = await linkChats();
      const r = await send(GROUP, "🔧 Test message from the app. If you can see this, the bot is wired up.");
      if (!r.ok) return fail("telegram", 502, "Telegram did not accept the message.");
      return ok({ linked: link.linked, seen: link.seen });
    }

    case "admin_save_member": {
      const m = b.member || {};
      const name = clean(m.name, 40);
      let id = clean(m.id, 40);
      if (m.create) {
        // Adding someone new must never overwrite an existing member that
        // happens to share a name, so the id is made here and checked.
        const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "member";
        id = base;
        for (let n = 2; await member(id); n++) id = base + n;
      }
      if (!/^[a-z0-9_-]+$/i.test(id) || !name) return fail("missing name");
      const tgHandle = clean(m.telegram, 33).replace(/\s/g, "");
      if (tgHandle && !/^@?[A-Za-z0-9_]{3,32}$/.test(tgHandle)) return fail("bad telegram");
      const share = Math.max(0, Math.min(100, Math.round(Number(m.share_pct) || 0)));
      const { error: e1 } = await db.from("members").upsert({
        id, name, name_ru: clean(m.name_ru, 40) || null,
        telegram: tgHandle ? "@" + tgHandle.replace(/^@/, "") : null,
        share_pct: share, active: m.active !== false
      });
      if (e1) return fail("server", 500, e1.message);
      return ok({ id });
    }

    case "admin_delete_member": {
      const id = String(b.id || "");
      if (!/^[a-z0-9_-]+$/i.test(id)) return fail("bad id");
      const today = new Date().toISOString().slice(0, 10);
      // Their upcoming turns open up for the group; requests that mention
      // them are closed and detached so the foreign keys let the row go.
      const steps = [
        db.from("services").update({ member_id: null, open: true, confirmed: false })
          .eq("member_id", id).gte("date", today),
        db.from("requests").update({ status: "cancelled" }).eq("status", "pending").or(`from_id.eq.${id},to_id.eq.${id}`),
      ];
      for (const st of steps) { const { error } = await st; if (error) return fail("server", 500, error.message); }
      for (const col of ["from_id", "to_id"]) {
        const { error } = await db.from("requests").update({ [col]: null }).eq(col, id);
        if (error) return fail("server", 500, error.message);
      }
      const { error: e2b } = await db.from("members").delete().eq("id", id);
      if (e2b) return fail("server", 500, e2b.message);
      return ok();
    }

    case "admin_set_service": {
      const s = b.service || {};
      if (!s.id || !isDate(s.date) || !isTime(String(s.time).slice(0, 5)) || !["M", "E", "S"].includes(s.part)) {
        return fail("bad service");
      }
      if (s.member_id) {
        const m = await member(String(s.member_id));
        if (!m) return fail("bad_target");
      }
      const { error: e3 } = await db.from("services").upsert({
        id: String(s.id), date: s.date, part: s.part, time: hhmmss(String(s.time).slice(0, 8)),
        member_id: s.member_id || null, special: clean(s.special, 60),
        open: !s.member_id, confirmed: false, notified: false, warned: false,
        // Assigning an operator implies the service is happening.
        cancelled: false,
        // An admin assigning someone directly is not a hand-off.
        replaced_from: null
      });
      if (e3) return fail("server", 500, e3.message);
      await db.from("requests")
        .update({ status: "cancelled" })
        .eq("service_id", s.id).eq("status", "pending");
      return ok();
    }

    // "Leave open — ask the group": nobody holds it, the group is asked, and
    // the first member to accept takes it.
    case "admin_open_service": {
      const s = await service(b.id);
      if (!s) return fail("gone", 404);
      await db.from("requests").update({ status: "cancelled" }).eq("service_id", s.id).eq("status", "pending");
      const { error } = await db.from("services").update({
        member_id: null, open: true, confirmed: false, notified: false, warned: false,
        cancelled: false, replaced_from: null
      }).eq("id", s.id);
      if (error) return fail("server", 500, error.message);
      const ins = await db.from("requests").insert({ service_id: s.id, from_id: null, to_id: null, status: "pending" });
      if (ins.error) return fail("server", 500, ins.error.message);
      const L = label(s);
      if (s.special || cfg.alert_swap) {
        await send(GROUP, `🔴 <b>No operator</b> for ${L.text}\nOpen the app — first to accept takes it. ${APP}`);
      }
      return ok();
    }

    case "admin_add_special": {
      const date = b.date, time = String(b.time || "");
      if (!isDate(date) || !isTime(time.slice(0, 5))) return fail("bad service");
      const special = clean(b.label, 60) || "Special service";
      const id = "S" + date + time.slice(0, 5).replace(":", "");
      if (await service(id)) return fail("exists", 409, "There is already a special service at that date and time.");
      let who = null;
      if (b.member_id) {
        who = await member(String(b.member_id));
        if (!who || who.active === false) return fail("bad_target");
      }
      const row = {
        id, date, part: "S", time: hhmmss(time.slice(0, 5)), member_id: who?.id ?? null, special,
        open: !who, confirmed: false, notified: false, warned: false, cancelled: false, replaced_from: null
      };
      const { error } = await db.from("services").upsert(row);
      if (error) return fail("server", 500, error.message);
      await db.from("requests").update({ status: "cancelled" }).eq("service_id", id).eq("status", "pending");
      if (!who) {
        const ins = await db.from("requests").insert({ service_id: id, from_id: null, to_id: null, status: "pending" });
        if (ins.error) return fail("server", 500, ins.error.message);
      }
      const L = label(row);
      await send(GROUP, who
        ? `⭐ <b>New service</b> — ${esc(special)}\n${L.text}\nOperator: <b>${esc(who.name)}</b>`
        : `⭐ <b>New service</b> — ${esc(special)}\n${L.text}\nWho can take it? First to accept in the app gets it. ${APP}`);
      return ok({ id });
    }

    // Call a service off, or put it back on. The row is kept so the record
    // survives and nobody's history silently changes.
    case "admin_cancel_service": {
      const s = await service(b.id);
      if (!s) return fail("gone", 404);
      const on = !!b.on;
      const { error } = await db.from("services")
        .update(on
          ? { cancelled: true, open: false, confirmed: false, warned: true }
          : { cancelled: false, notified: false, warned: false })
        .eq("id", s.id);
      if (error) return fail("server", 500, error.message);
      if (on) {
        await db.from("requests").update({ status: "cancelled" })
          .eq("service_id", s.id).eq("status", "pending");
      }
      if (cfg.notify_schedule !== false) {
        const L = label(s);
        await send(GROUP, on
          ? `🚫 <b>Service cancelled</b> — ${L.text}\nNobody is needed. ${APP}`
          : `↩️ <b>Back on</b> — ${L.text}\n` +
            (s.member_id ? `Operator: <b>${await nameOf(s.member_id)}</b>. ` : "") +
            `Confirm in the app 👍 ${APP}`);
      }
      return ok();
    }

    case "admin_delete_service": {
      const s = await service(b.id);
      if (!s) return fail("gone", 404);
      // Regular Sunday services are cancelled, not deleted, so history and
      // stats stay intact. Only one-off specials can be removed outright.
      if (s.part !== "S") return fail("not_special", 400);
      const { error: e4 } = await db.from("services").delete().eq("id", s.id);
      if (e4) return fail("server", 500, e4.message);
      return ok();
    }

    case "admin_apply_plan": {
      const plan: any[] = Array.isArray(b.plan) ? b.plan.slice(0, 200) : [];
      const rows = [];
      for (const p of plan) {
        if (!isDate(p.date) || !["M", "E"].includes(p.part) || p.id !== p.date + p.part || !isTime(String(p.time).slice(0, 5))) {
          return fail("bad plan", 400, `row ${p?.id}: not a Sunday morning/evening slot`);
        }
        rows.push({
          id: p.id, date: p.date, part: p.part, time: hhmmss(String(p.time).slice(0, 5)),
          member_id: p.member_id, special: "", open: false,
          confirmed: false, notified: false, warned: false, replaced_from: null
        });
      }
      if (!rows.length) return fail("empty plan");
      // Never write over a cancelled service: auto-fill must not quietly put
      // a called-off service back on by assigning someone to it.
      const { data: off } = await db.from("services").select("id").in("id", rows.map(r => r.id)).eq("cancelled", true);
      const skip = new Set((off ?? []).map((x: any) => x.id));
      const live = rows.filter(r => !skip.has(r.id));

      for (let i = 0; i < live.length; i += 40) {
        const slice = live.slice(i, i + 40);
        const { error } = await db.from("services").upsert(slice);
        if (error) return fail("server", 500, `row ${slice[0].id}: ${error.message}`);
        // A request on a slot that now has a fresh operator means nothing
        // any more (e.g. an inactive member's open call for cover).
        await db.from("requests").update({ status: "cancelled" })
          .in("service_id", slice.map(r => r.id)).eq("status", "pending");
      }
      // b.silent is set on every batch but the last, so the group hears once.
      if (cfg.notify_schedule !== false && !b.silent) {
        const n = Number(b.total) || live.length;
        await send(GROUP,
          `📅 <b>Schedule updated</b> — ${n} services assigned.\n` +
          `Check your turns: ${APP}`);
      }
      return ok({ count: live.length, skipped: skip.size });
    }

    case "admin_save_settings": {
      const num = (v: unknown, lo: number, hi: number, d: number) =>
        v === undefined ? d : Math.max(lo, Math.min(hi, Math.round(Number(v)) || d));
      const bool = (v: unknown, d: boolean) => (v === undefined ? d : !!v);
      let tz = cfg.timezone;
      if (b.timezone !== undefined) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: String(b.timezone) }); tz = String(b.timezone); }
        catch { return fail("bad timezone"); }
      }
      const rem = num(b.rem_hours, 1, 72, cfg.rem_hours);
      const warn = num(b.warn_hours, 1, 24, cfg.warn_hours);
      // Confirm opens when the reminder goes out; a warning at or before that
      // moment would nag people who could not have confirmed yet.
      if (warn >= rem) return fail("warn_order", 400, "The last-call warning must come after the reminder.");
      const { error: e6 } = await db.from("settings").update({
        rem_hours:             rem,
        warn_hours:            warn,
        dm_duty:               bool(b.dm_duty, cfg.dm_duty),
        alert_swap:            bool(b.alert_swap, cfg.alert_swap),
        notify_reminder_group: bool(b.notify_reminder_group, cfg.notify_reminder_group),
        notify_pickup:         bool(b.notify_pickup, cfg.notify_pickup),
        notify_confirm:        bool(b.notify_confirm, cfg.notify_confirm),
        notify_schedule:       bool(b.notify_schedule, cfg.notify_schedule),
        notify_unconfirmed:    bool(b.notify_unconfirmed, cfg.notify_unconfirmed),
        timezone:              tz
      }).eq("id", 1);
      if (e6) return fail("server", 500, e6.message);
      return ok();
    }

    case "admin_change_pin": {
      const np = String(b.new_pin ?? "");
      if (np.length < 6 || np.length > 32) return fail("pin too short");
      const { error: e7 } = await db.from("settings").update({ admin_pin: np }).eq("id", 1);
      // Never report success on a PIN change that did not land — the admin
      // would believe the new PIN works and be locked out next login.
      if (e7) return fail("server", 500, e7.message);
      return ok();
    }

    default:
      return fail("unknown action");
  }
}

// ==================== legacy events (off) ====================
// Kept only so a deploy can briefly accept calls from pages that were open
// before the update. See LEGACY_EVENTS.

async function runLegacyEvent(b: any) {
  if (b.event === "test") {
    const link = await linkChats();
    await send(GROUP, "🔧 Test message from the app. If you can see this, the bot is wired up.");
    return ok({ linked: link.linked, seen: link.seen });
  }
  if (b.event === "link_chats") return ok(await linkChats());
  const s = await service(b.service_id);
  if (!s) return fail("unknown service");
  const cfg = await settings();
  const L = label(s);
  switch (b.event) {
    case "cover_requested":
      if (!cfg.alert_swap) return ok({ muted: true });
      await send(GROUP, b.from
        ? `🔴 <b>${await nameOf(b.from)}</b> needs a replacement\n${L.text}\nOpen the app — first to accept takes it. ${APP}`
        : `🔴 <b>No operator</b> for ${L.text}\nOpen the app — first to accept takes it. ${APP}`);
      break;
    case "covered": {
      if (cfg.notify_pickup === false) return ok({ muted: true });
      const from = await nameOf(b.from);
      await send(GROUP, `✅ <b>${await nameOf(b.by)}</b> takes ${L.text}` + (from ? ` — covering for ${from}` : ""));
      break;
    }
    case "asked": {
      const m = await member(String(b.to || ""));
      if (m?.chat_id) await send(m.chat_id, `🔄 <b>${await nameOf(b.from)}</b> asks you to take ${L.text}\n<a href="${appBase()}/#me=${encodeURIComponent(m.id)}">Accept or decline</a>`);
      break;
    }
    case "declined": {
      const m = await member(String(b.to || ""));
      if (m?.chat_id) await send(m.chat_id, `🚫 <b>${await nameOf(b.by)}</b> can't take ${L.text}`);
      break;
    }
    case "cancelled":
      if (b.to) {
        const m = await member(String(b.to));
        if (m?.chat_id) await send(m.chat_id, `↩️ <b>${await nameOf(b.from)}</b> withdrew the request to take ${L.text}. Nothing needed from you.`);
        break;
      }
      await send(GROUP, `↩️ <b>${await nameOf(b.from)}</b> no longer needs cover — ${L.text}`);
      break;
    case "confirmed":
      if (cfg.notify_confirm !== true) return ok({ muted: true });
      await send(GROUP, `👍 <b>${await nameOf(b.by)}</b> confirmed — ${L.text}`);
      break;
    case "service_cancelled":
      if (cfg.notify_schedule === false) return ok({ muted: true });
      await send(GROUP, `🚫 <b>Service cancelled</b> — ${L.text}\nNobody is needed. ${APP}`);
      break;
    case "service_restored":
      if (cfg.notify_schedule === false) return ok({ muted: true });
      await send(GROUP, `↩️ <b>Back on</b> — ${L.text}\n` + (b.member ? `Operator: <b>${await nameOf(b.member)}</b>. ` : "") + `Confirm in the app 👍 ${APP}`);
      break;
    case "special_open":
      await send(GROUP, `⭐ <b>New service</b> — ${esc(s.special)}\n${L.text}\nWho can take it? First to accept in the app gets it. ${APP}`);
      break;
    case "special_assigned":
      await send(GROUP, `⭐ <b>New service</b> — ${esc(s.special)}\n${L.text}\nOperator: <b>${await nameOf(s.member_id)}</b>`);
      break;
    default:
      return fail("unknown event");
  }
  return ok();
}

// ==================== entry point ====================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const ip = clientIp(req);
      if (typeof b?.action === "string") {
        if (b.action.startsWith("admin_")) return await runAdmin(b, ip);
        if (MEMBER_ACTIONS.has(b.action)) return await runMember(b, ip);
        return fail("unknown action");
      }
      if (b?.event) {
        if (!LEGACY_EVENTS) return fail("gone", 410, "Update the app: reload the page.");
        if (await rateHit("evt:" + ip, 600) > 30) return fail("busy", 429);
        return await runLegacyEvent(b);
      }
    }
    // The hourly cron job calls with the project's secret key. Anyone else
    // can only nudge the reminder run a few times an hour (it is harmless —
    // it only sends what is due — but it should not be a free loop).
    const fromCron = (req.headers.get("apikey") || "").startsWith("sb_secret_");
    if (!fromCron && await rateHit("tick:" + clientIp(req), 3600) > 6) return fail("busy", 429);
    const sent = await runReminders();
    return ok({ reminders_sent: sent });
  } catch (err) {
    console.error(redact((err as any)?.stack ?? err));
    return fail("server", 500, "Something went wrong on the server.");
  }
});
