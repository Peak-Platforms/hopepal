import express from "express";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const app  = express();
const PORT = process.env.PORT || 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── CORS + PARSERS ─────────────────────────────────── */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-reader-password");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ── SUPABASE ────────────────────────────────────────── */
function getSupabase(clientSlug) {
  const slug = clientSlug.toUpperCase();
  const url  = process.env[`${slug}_SUPABASE_URL`]              || process.env.SUPABASE_URL;
  const key  = process.env[`${slug}_SUPABASE_SERVICE_ROLE_KEY`] || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error(`No Supabase config for ${slug}`);
  return createClient(url, key);
}

/* ── READERS ─────────────────────────────────────────── */
function getReaders(clientSlug) {
  const slug = clientSlug.toUpperCase();
  const raw  = process.env[`${slug}_READERS`];
  if (!raw) return [];
  try { return JSON.parse(raw); }
  catch (e) { console.error(`[${clientSlug}] Invalid READERS JSON:`, e.message); return []; }
}

function authenticateReader(clientSlug, password) {
  return getReaders(clientSlug).find(r => r.password === password) || null;
}

/* ── LIVE STATE ──────────────────────────────────────── */
const LIVE_STATES = {};
function getLiveState(slug) {
  if (!LIVE_STATES[slug]) LIVE_STATES[slug] = { isLive: false, updatedAt: null };
  return LIVE_STATES[slug];
}

/* ── CLIENT FOLDERS ──────────────────────────────────── */
function getClients() {
  try {
    return fs.readdirSync(__dirname).filter(f => {
      try {
        const p = join(__dirname, f);
        return fs.statSync(p).isDirectory() && !f.startsWith('.') && !['node_modules'].includes(f);
      } catch { return false; }
    });
  } catch { return []; }
}

/* ── EMAIL NOTIFICATION ──────────────────────────────── */
async function notifyReaders(clientSlug, senderName, readerUrl) {
  if (!process.env.RESEND_API_KEY) return;
  const readers = getReaders(clientSlug).filter(r => r.email);
  for (const reader of readers) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from:    process.env.RESEND_FROM_EMAIL || "noreply@hopepal.life",
          to:      reader.email,
          subject: `New message from ${senderName}`,
          html:    `<p>New message from <strong>${senderName}</strong>.</p><a href="${readerUrl}">Open Reader</a>`
        })
      });
      console.log(`[${clientSlug}] Email sent to ${reader.name}`);
    } catch (e) { console.error(`[${clientSlug}] Email error:`, e.message); }
  }
}

/* ── STATIC FILES ────────────────────────────────────── */
app.use(express.static(__dirname, { index: false }));

app.get("/",       (req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/app",    (req, res) => res.sendFile(join(__dirname, "app.html")));
app.get("/reader", (req, res) => res.sendFile(join(__dirname, "reader.html")));

app.get("/:client", (req, res, next) => {
  const file = join(__dirname, req.params.client.toLowerCase(), "app.html");
  if (!fs.existsSync(file)) return next();
  res.sendFile(file);
});

app.get("/:client/reader", (req, res, next) => {
  const file = join(__dirname, req.params.client.toLowerCase(), "reader.html");
  if (!fs.existsSync(file)) return next();
  res.sendFile(file);
});

/* ── SEND MESSAGE ────────────────────────────────────── */
app.post("/:client/ministry-message", async (req, res) => {
  const slug = req.params.client.toLowerCase();
  const { name, message, source } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: "Message required" });

  try {
    const supabase = getSupabase(slug);
    const { error } = await supabase
      .from("ministry_messages")
      .insert([{ name: name?.trim() || "Anonymous", message: message.trim(), source: source || `${slug} chat`, status: "unread" }]);

    if (error) { console.error(`[${slug}] Insert error:`, error.message); return res.status(500).json({ error: "Failed to save" }); }

    const readerUrl = `${req.protocol}://${req.get("host")}/${slug}/reader`;
    notifyReaders(slug, name?.trim() || "Anonymous", readerUrl).catch(() => {});

    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

/* ── GET MESSAGES ────────────────────────────────────── */
app.get("/:client/messages", async (req, res) => {
  const slug   = req.params.client.toLowerCase();
  const reader = authenticateReader(slug, req.headers["x-reader-password"]);
  if (!reader) return res.status(401).json({ error: "Unauthorized" });

  try {
    const supabase = getSupabase(slug);
    const { data, error } = await supabase
      .from("ministry_messages")
      .select("id, name, message, source, status, claimed_by, claimed_at, resolved_by, resolved_at, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) { console.error(`[${slug}] Fetch error:`, error.message); return res.status(500).json({ error: "Failed to fetch" }); }

    const unreadIds = (data || []).filter(m => m.status === "unread").map(m => m.id);
    if (unreadIds.length > 0) {
      supabase.from("ministry_messages").update({ status: "read" }).in("id", unreadIds)
        .then(() => console.log(`[${slug}] Marked ${unreadIds.length} read`))
        .catch(() => {});
    }

    return res.json({ messages: data || [], reader: reader.name });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

/* ── UPDATE MESSAGE STATUS ───────────────────────────── */
app.patch("/:client/messages/:id", async (req, res) => {
  const slug   = req.params.client.toLowerCase();
  const reader = authenticateReader(slug, req.headers["x-reader-password"]);
  if (!reader) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.body;
  const updates = {
    claim:   { status: "claimed",  claimed_by: reader.name, claimed_at: new Date().toISOString() },
    resolve: { status: "resolved", resolved_by: reader.name, resolved_at: new Date().toISOString() },
    reopen:  { status: "read",     claimed_by: null, claimed_at: null, resolved_by: null, resolved_at: null }
  }[action];

  if (!updates) return res.status(400).json({ error: "Invalid action" });

  try {
    const supabase = getSupabase(slug);
    const { error } = await supabase.from("ministry_messages").update(updates).eq("id", req.params.id);
    if (error) return res.status(500).json({ error: "Update failed" });
    return res.json({ success: true, action, reader: reader.name });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

/* ── LIVE STATE ──────────────────────────────────────── */
app.get("/:client/live/on",     (req, res) => { const s = getLiveState(req.params.client); s.isLive = true;  s.updatedAt = new Date().toISOString(); res.json({ ok: true, ...s }); });
app.get("/:client/live/off",    (req, res) => { const s = getLiveState(req.params.client); s.isLive = false; s.updatedAt = new Date().toISOString(); res.json({ ok: true, ...s }); });
app.get("/:client/live-status", (req, res) => { res.setHeader("Cache-Control","no-store"); res.json(getLiveState(req.params.client)); });

/* ── DELETE MESSAGE(S) ───────────────────────────────── */
app.delete("/:client/messages/:id", async (req, res) => {
  const slug   = req.params.client.toLowerCase();
  const reader = authenticateReader(slug, req.headers["x-reader-password"]);
  if (!reader) return res.status(401).json({ error: "Unauthorized" });

  try {
    const supabase = getSupabase(slug);
    const { error } = await supabase
      .from("ministry_messages")
      .delete()
      .eq("id", req.params.id);
    if (error) return res.status(500).json({ error: "Delete failed" });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete("/:client/messages", async (req, res) => {
  const slug   = req.params.client.toLowerCase();
  const reader = authenticateReader(slug, req.headers["x-reader-password"]);
  if (!reader) return res.status(401).json({ error: "Unauthorized" });

  const { ids } = req.body || {};
  if (!ids || !ids.length) return res.status(400).json({ error: "No ids provided" });

  try {
    const supabase = getSupabase(slug);
    const { error } = await supabase
      .from("ministry_messages")
      .delete()
      .in("id", ids);
    if (error) return res.status(500).json({ error: "Delete failed" });
    return res.json({ success: true, deleted: ids.length });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

/* ── LIVE STATE ──────────────────────────────────────── */
app.post("/:client/lessons/search", async (req, res) => {
  const slug  = req.params.client.toLowerCase();
  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: "Query required" });

  try {
    const supabase = getSupabase(slug);
    const terms    = query.toLowerCase().trim().split(/\s+/).filter(t => t.length > 2);

    // 1. Try keyword array overlap
    let { data, error } = await supabase
      .from("lessons")
      .select("week, title, scripture, summary, audio_url, duration_seconds")
      .eq("published", true)
      .overlaps("keywords", terms)
      .order("week")
      .limit(3);

    if (error) throw error;

    // 2. Fallback — theme overlap
    if (!data || data.length === 0) {
      ({ data, error } = await supabase
        .from("lessons")
        .select("week, title, scripture, summary, audio_url, duration_seconds")
        .eq("published", true)
        .overlaps("themes", terms)
        .order("week")
        .limit(3));
      if (error) throw error;
    }

    // 3. Fallback — full text search on summary
    if (!data || data.length === 0) {
      ({ data, error } = await supabase
        .from("lessons")
        .select("week, title, scripture, summary, audio_url, duration_seconds")
        .eq("published", true)
        .textSearch("summary", query.trim(), { type: "websearch" })
        .order("week")
        .limit(3));
      if (error) throw error;
    }

    console.log(`[${slug}] Lesson search: "${query}" → ${(data||[]).length} results`);
    return res.json({ results: data || [] });

  } catch (err) {
    console.error(`[${slug}] Lesson search error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ── HEALTH ──────────────────────────────────────────── */
app.get("/__whoami", (req, res) => {
  res.json({
    platform: "HopePal", status: "running", version: "2026-04-21",
    clients: getClients(),
    notifications: { email: !!process.env.RESEND_API_KEY, sms: !!process.env.TWILIO_ACCOUNT_SID }
  });
});

/* ── START ───────────────────────────────────────────── */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HopePal] Running on port ${PORT}`);
  console.log(`[HopePal] SMS:   ${process.env.TWILIO_ACCOUNT_SID ? "✅" : "⚠️  not configured"}`);
  console.log(`[HopePal] Email: ${process.env.RESEND_API_KEY    ? "✅" : "⚠️  not configured"}`);
});


