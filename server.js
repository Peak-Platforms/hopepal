import express from "express";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));

/* ==============================
   PLATFORM CONFIG
============================== */
const PLATFORM_NAME = "HopePal";

/* ==============================
   CORS + BODY PARSERS
============================== */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-reader-password");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ==============================
   SUPABASE — PER CLIENT
   Env var convention:
   OTR_SUPABASE_URL
   OTR_SUPABASE_SERVICE_ROLE_KEY
   OTR_READER_PASSWORD
   Falls back to generic if not set.
============================== */
function getSupabase(clientSlug) {
  const slug = clientSlug.toUpperCase();
  const url  = process.env[`${slug}_SUPABASE_URL`]              || process.env.SUPABASE_URL;
  const key  = process.env[`${slug}_SUPABASE_SERVICE_ROLE_KEY`] || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(url, key);
}

function getReaderPassword(clientSlug) {
  const slug = clientSlug.toUpperCase();
  return process.env[`${slug}_READER_PASSWORD`] || process.env.READER_PASSWORD;
}

/* ==============================
   LIVE STATE (per client, in-memory)
============================== */
const LIVE_STATES = {};

function getLiveState(clientSlug) {
  if (!LIVE_STATES[clientSlug]) {
    LIVE_STATES[clientSlug] = { isLive: false, updatedAt: null, source: "control-url" };
  }
  return LIVE_STATES[clientSlug];
}

/* ==============================
   ROOT STATIC ASSETS
============================== */
app.use(express.static(__dirname, { index: false }));

/* ==============================
   PLATFORM ROUTES
   /         → index.html  (HopePal landing page)
   /app      → app.html    (HopePal generic demo)
   /reader   → reader.html (HopePal demo reader)
============================== */
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

app.get("/app", (req, res) => {
  res.sendFile(join(__dirname, "app.html"));
});

app.get("/reader", (req, res) => {
  res.sendFile(join(__dirname, "reader.html"));
});

/* ==============================
   CLIENT PAGE ROUTES
   /otr         → otr/app.html
   /otr/reader  → otr/reader.html
============================== */
app.get("/:client", (req, res, next) => {
  const clientSlug = req.params.client.toLowerCase();
  const clientDir  = join(__dirname, clientSlug);
  const appFile    = join(clientDir, "app.html");

  if (!fs.existsSync(clientDir) || !fs.statSync(clientDir).isDirectory()) return next();
  if (!fs.existsSync(appFile)) return res.status(404).send(`No app found for: ${clientSlug}`);

  console.log(`[${PLATFORM_NAME}] /${clientSlug} → ${clientSlug}/app.html`);
  res.sendFile(appFile);
});

app.get("/:client/reader", (req, res, next) => {
  const clientSlug = req.params.client.toLowerCase();
  const clientDir  = join(__dirname, clientSlug);
  const readerFile = join(clientDir, "reader.html");

  if (!fs.existsSync(clientDir) || !fs.statSync(clientDir).isDirectory()) return next();
  if (!fs.existsSync(readerFile)) return res.status(404).send(`No reader found for: ${clientSlug}`);

  console.log(`[${PLATFORM_NAME}] /${clientSlug}/reader → ${clientSlug}/reader.html`);
  res.sendFile(readerFile);
});

/* ==============================
   MINISTRY MESSAGE ENDPOINT
   POST /otr/ministry-message
============================== */
app.post("/:client/ministry-message", async (req, res) => {
  const clientSlug = req.params.client.toLowerCase();
  const { name, message, source } = req.body || {};

  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    const supabase = getSupabase(clientSlug);
    const { error } = await supabase
      .from("ministry_messages")
      .insert([{
        name:    name?.trim() || "Anonymous",
        message: message.trim(),
        source:  source || `${clientSlug} ministry chat`
      }]);

    if (error) {
      console.error(`[${clientSlug}] Supabase insert error:`, error);
      return res.status(500).json({ error: "Failed to save message" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(`[${clientSlug}] Message error:`, err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ==============================
   READER MESSAGES ENDPOINT
   GET /otr/messages
============================== */
app.get("/:client/messages", async (req, res) => {
  const clientSlug     = req.params.client.toLowerCase();
  const readerPassword = getReaderPassword(clientSlug);
  const provided       = req.headers["x-reader-password"];

  if (!readerPassword || provided !== readerPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = getSupabase(clientSlug);
    const { data, error } = await supabase
      .from("ministry_messages")
      .select("id, name, message, source, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error(`[${clientSlug}] Supabase fetch error:`, error);
      return res.status(500).json({ error: "Failed to fetch messages" });
    }

    return res.json({ messages: data });
  } catch (err) {
    console.error(`[${clientSlug}] Reader fetch error:`, err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ==============================
   LIVE CONTROL
   GET /otr/live/on
   GET /otr/live/off
   GET /otr/live-status
============================== */
app.get("/:client/live/on", (req, res) => {
  const clientSlug    = req.params.client.toLowerCase();
  const state         = getLiveState(clientSlug);
  state.isLive        = true;
  state.updatedAt     = new Date().toISOString();
  console.log(`[${clientSlug}] LIVE: ON`);
  return res.json({ ok: true, ...state });
});

app.get("/:client/live/off", (req, res) => {
  const clientSlug    = req.params.client.toLowerCase();
  const state         = getLiveState(clientSlug);
  state.isLive        = false;
  state.updatedAt     = new Date().toISOString();
  console.log(`[${clientSlug}] LIVE: OFF`);
  return res.json({ ok: true, ...state });
});

app.get("/:client/live-status", (req, res) => {
  const clientSlug = req.params.client.toLowerCase();
  res.setHeader("Cache-Control", "no-store");
  return res.json(getLiveState(clientSlug));
});

/* ==============================
   HEALTH / INFO
============================== */
app.get("/__whoami", (req, res) => {
  const clients = fs.readdirSync(__dirname).filter(f => {
    const fullPath = join(__dirname, f);
    return fs.statSync(fullPath).isDirectory()
      && !f.startsWith('.')
      && f !== 'node_modules';
  });

  res.json({
    platform:   PLATFORM_NAME,
    status:     "running",
    version:    "2026-03-08",
    clients,
    routes: {
      platform:  ["GET /", "GET /app", "GET /reader"],
      perClient: [
        "GET  /:client",
        "GET  /:client/reader",
        "POST /:client/ministry-message",
        "GET  /:client/messages",
        "GET  /:client/live/on",
        "GET  /:client/live/off",
        "GET  /:client/live-status",
      ]
    },
    liveStates: LIVE_STATES
  });
});

/* ==============================
   START SERVER
============================== */
app.listen(PORT, () => {
  console.log(`[${PLATFORM_NAME}] Platform running on port ${PORT}`);
  console.log(`[${PLATFORM_NAME}] /__whoami to see all active clients`);
});
