import express from "express";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_NAME = "HopePal";

/* ==============================
   CORS + BODY PARSERS
============================== */
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

/* ==============================
   SUPABASE — PER CLIENT
   OTR_SUPABASE_URL
   OTR_SUPABASE_SERVICE_ROLE_KEY
============================== */
function getSupabase(clientSlug) {
  const slug = clientSlug.toUpperCase();
  const url  = process.env[`${slug}_SUPABASE_URL`]              || process.env.SUPABASE_URL;
  const key  = process.env[`${slug}_SUPABASE_SERVICE_ROLE_KEY`] || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(url, key);
}

/* ==============================
   READERS — PER CLIENT
   OTR_READERS=[
     {"name":"Sidney","password":"pw1","phone":"+14055551234","email":"sidney@otr.com"},
     {"name":"Chaplain Bob","password":"pw2","phone":"+14055555678","email":"bob@otr.com"}
   ]
============================== */
function getReaders(clientSlug) {
  const slug = clientSlug.toUpperCase();
  const raw  = process.env[`${slug}_READERS`];
  if (!raw) return [];
  try { return JSON.parse(raw); }
  catch (e) { console.error(`[${clientSlug}] Invalid READERS JSON:`, e.message); return []; }
}

function authenticateReader(clientSlug, providedPassword) {
  return getReaders(clientSlug).find(r => r.password === providedPassword) || null;
}

/* ==============================
   NOTIFICATIONS
   TWILIO_ACCOUNT_SID
   TWILIO_AUTH_TOKEN
   TWILIO_FROM_NUMBER
   RESEND_API_KEY
   RESEND_FROM_EMAIL
============================== */
async function notifyReaders(clientSlug, senderName, readerUrl) {
  const readers = getReaders(clientSlug);
  if (!readers.length) return;

  const smsBody   = `[HopePal] New message from ${senderName} → ${readerUrl}`;
  const emailHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#841617;">New Ministry Message</h2>
      <p>A new encrypted message arrived from <strong>${senderName}</strong>.</p>
      <a href="${readerUrl}" style="display:inline-block;background:#841617;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;">Open Reader →</a>
      <p style="color:#999;font-size:12px;margin-top:24px;">HopePal · Peak Platforms</p>
    </div>
  `;

  for (const reader of readers) {
    if (reader.phone && process.env.TWILIO_ACCOUNT_SID) {
      try {
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
        const r = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
          {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ To: reader.phone, From: process.env.TWILIO_FROM_NUMBER, Body: smsBody })
          }
        );
        if (r.ok) console.log(`[${clientSlug}] SMS → ${reader.name}`);
        else console.error(`[${clientSlug}] SMS failed → ${reader.name}`);
      } catch (e) { console.error(`[${clientSlug}] SMS error:`, e.message); }
    }

    if (reader.email && process.env.RESEND_API_KEY) {
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from:    process.env.RESEND_FROM_EMAIL || "noreply@hopepal.life",
            to:      reader.email,
            subject: `New message from ${senderName}`,
            html:    emailHtml
          })
        });
        if (r.ok) console.log(`[${clientSlug}] Email → ${reader.name}`);
        else console.error(`[${clientSlug}] Email failed → ${reader.name}`);
      } catch (e) { console.error(`[${clientSlug}] Email error:`, e.message); }
    }
  }
}

/* ==============================
   FOLLOW-UP ALERTS
   Re-notify all readers if a message
   sits unread for 30 minutes
============================== */
async function checkStaleMessages() {
  // Get all active client folders
  const clients = fs.readdirSync(__dirname).filter(f => {
    const p = join(__dirname, f);
    return fs.statSync(p).isDirectory() && !f.startsWith('.') && f !== 'node_modules';
  });

  for (const slug of clients) {
    try {
      const supabase  = getSupabase(slug);
      const cutoff    = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
      const { data }  = await supabase
        .from("ministry_messages")
        .select("id, name")
        .eq("status", "unread")
        .lt("created_at", cutoff)
        .limit(5);

      if (data && data.length > 0) {
        console.log(`[${slug}] ⚠️  ${data.length} unread message(s) older than 30 min — re-notifying`);
        const readerUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || "hopepal.life"}/${slug}/reader`;
        for (const msg of data) {
          await notifyReaders(slug, `${msg.name} (FOLLOW-UP — still unread)`, readerUrl);
        }
      }
    } catch (e) {
      // Skip clients with no Supabase configured
    }
  }
}

// Run stale check every 15 minutes
setInterval(checkStaleMessages, 15 * 60 * 1000);

/* ==============================
   LIVE STATE (per client)
============================== */
const LIVE_STATES = {};
function getLiveState(slug) {
  if (!LIVE_STATES[slug]) LIVE_STATES[slug] = { isLive: false, updatedAt: null };
  return LIVE_STATES[slug];
}

/* ==============================
   STATIC FILE ROUTING
============================== */
app.use(express.static(__dirname, { index: false }));

app.get("/",       (req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/app",    (req, res) => res.sendFile(join(__dirname, "app.html")));
app.get("/reader", (req, res) => res.sendFile(join(__dirname, "reader.html")));

app.get("/:client", (req, res, next) => {
  const slug = req.params.client.toLowerCase();
  const dir  = join(__dirname, slug);
  const file = join(dir, "app.html");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return next();
  if (!fs.existsSync(file)) return res.status(404).send(`No app: ${slug}`);
  res.sendFile(file);
});

app.get("/:client/reader", (req, res, next) => {
  const slug = req.params.client.toLowerCase();
  const dir  = join(__dirname, slug);
  const file = join(dir, "reader.html");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return next();
  if (!fs.existsSync(file)) return res.status(404).send(`No reader: ${slug}`);
  res.sendFile(file);
});

/* ==============================
   MINISTRY MESSAGE ENDPOINT
   POST /:client/ministry-message
============================== */
app.post("/:client/ministry-message", async (req, res) => {
  const slug = req.params.client.toLowerCase();
  const { name, message, source } = req.body || {};
  if (!message || message.trim().length < 2) return res.status(400).json({ error: "Message required" });

  const senderName = name?.trim() || "Anonymous";
  try {
    const supabase = getSupabase(slug);
    const { error } = await supabase
      .from("ministry_messages")
      .insert([{ name: senderName, message: message.trim(), source: source || `${slug} chat`, status: "unread", read_by: [] }]);

    if (error) { console.error(`[${slug}] Insert error:`, error); return res.status(500).json({ error: "Failed to save" }); }

    const readerUrl = `${req.protocol}://${req.get("host")}/${slug}/reader`;
    notifyReaders(slug, senderName, readerUrl).catch(e => console.error(`[${slug}] Notify error:`, e.message));

    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "Server error" }); }
});

/* ==============================
   READER MESSAGES ENDPOINT
   GET /:client/messages
   Marks messages as read by this reader
============================== */
app.get("/:client/messages", async (req, res) => {
  const slug     = req.params.client.toLowerCase();
  const provided = req.headers["x-reader-password"];
  const reader   = authenticateReader(slug, provided);
  if (!reader) return res.status(401).json({ error: "Unauthorized" });

  try {
    const supabase = getSupabase(slug);
    const { data, error } = await supabase
      .from("ministry_messages")
      .select("id, name, message, source, status, claimed_by, claimed_at, resolved_by, resolved_at, read_by, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) { console.error(`[${slug}] Fetch error:`, error); return res.status(500).json({ error: "Failed to fetch" }); }

    // Mark unread messages as read by this reader (background, don't block)
    const unreadIds = data
      .filter(m => m.status === "unread" && !Array.isArray(m.read_by)?.includes(reader.name))
      .map(m => m.id);

    if (unreadIds.length > 0) {
      supabase
        .from("ministry_messages")
        .update({ status: "read" })
        .in("id", unreadIds)
        .eq("status", "unread")
        .then(() => console.log(`[${slug}] Marked ${unreadIds.length} messages read by ${reader.name}`))
        .catch(e => console.error(`[${slug}] Mark read error:`, e.message));
    }

    return res.json({ messages: data, reader: reader.name });
  } catch (err) { return res.status(500).json({ error: "Server error" }); }
});

/* ==============================
   MESSAGE STATUS ENDPOINT
   PATCH /:client/messages/:id
   Body: { action: "claim" | "resolve" | "reopen" }
============================== */
app.patch("/:client/messages/:id", async (req, res) => {
  const slug     = req.params.client.toLowerCase();
  const msgId    = req.params.id;
  const provided = req.headers["x-reader-password"];
  const reader   = authenticateReader(slug, provided);
  if (!reader) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.body;
  if (!["claim", "resolve", "reopen"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  const updates = {
    claim:   { status: "claimed",  claimed_by: reader.name,  claimed_at: new Date().toISOString() },
    resolve: { status: "resolved", resolved_by: reader.name, resolved_at: new Date().toISOString() },
    reopen:  { status: "read",     claimed_by: null,          claimed_at: null, resolved_by: null, resolved_at: null }
  }[action];

  try {
    const supabase = getSupabase(slug);
    const { error } = await supabase
      .from("ministry_messages")
      .update(updates)
      .eq("id", msgId);

    if (error) { console.error(`[${slug}] Status update error:`, error); return res.status(500).json({ error: "Update failed" }); }

    console.log(`[${slug}] Message ${msgId} → ${action} by ${reader.name}`);
    return res.json({ success: true, action, reader: reader.name });
  } catch (err) { return res.status(500).json({ error: "Server error" }); }
});

/* ==============================
   LIVE CONTROL
============================== */
app.get("/:client/live/on", (req, res) => {
  const state = getLiveState(req.params.client.toLowerCase());
  state.isLive = true; state.updatedAt = new Date().toISOString();
  return res.json({ ok: true, ...state });
});
app.get("/:client/live/off", (req, res) => {
  const state = getLiveState(req.params.client.toLowerCase());
  state.isLive = false; state.updatedAt = new Date().toISOString();
  return res.json({ ok: true, ...state });
});
app.get("/:client/live-status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(getLiveState(req.params.client.toLowerCase()));
});

/* ==============================
   HEALTH
============================== */
app.get("/__whoami", (req, res) => {
  const clients = fs.readdirSync(__dirname).filter(f => {
    const p = join(__dirname, f);
    return fs.statSync(p).isDirectory() && !f.startsWith('.') && f !== 'node_modules';
  });
  res.json({
    platform: PLATFORM_NAME, status: "running", version: "2026-03-08", clients,
    notifications: { sms: !!process.env.TWILIO_ACCOUNT_SID, email: !!process.env.RESEND_API_KEY },
    liveStates: LIVE_STATES
  });
});

/* ==============================
   START
============================== */
app.listen(PORT, () => {
  console.log(`[${PLATFORM_NAME}] Running on port ${PORT}`);
  console.log(`[${PLATFORM_NAME}] SMS:   ${process.env.TWILIO_ACCOUNT_SID ? "✅" : "⚠️  not configured"}`);
  console.log(`[${PLATFORM_NAME}] Email: ${process.env.RESEND_API_KEY    ? "✅" : "⚠️  not configured"}`);
  console.log(`[${PLATFORM_NAME}] Stale message check: every 15 min`);
});
