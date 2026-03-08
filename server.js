import express from "express";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const PORT = process.env.PORT || 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));

/* ==============================
   CLIENT CONFIG (env-var driven)
   Set these per Railway service
============================== */
const CLIENT_NAME    = process.env.CLIENT_NAME    || "HopePal Ministry";
const CLIENT_SLUG    = process.env.CLIENT_SLUG    || "default";
const MESSAGE_SOURCE = process.env.MESSAGE_SOURCE || `${CLIENT_NAME} Chat`;
const CLIENT_DIR     = process.env.CLIENT_DIR     || CLIENT_SLUG; // subfolder name in repo

/* ==============================
   SERVE STATIC FILES
   Serves client subfolder first,
   then falls back to root
============================== */
const clientPath = join(__dirname, CLIENT_DIR);
app.use(express.static(clientPath));   // e.g. /otr/app.html, /otr/reader.html
app.use(express.static(__dirname));    // root fallback (index.html, shared assets)

/* ==============================
   SUPABASE CLIENT (lazy init)
============================== */
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/* ==============================
   LIVE STATE (in-memory)
============================== */
let LIVE_STATE = {
  isLive:    false,
  updatedAt: null,
  source:    "control-url"
};

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
   MINISTRY MESSAGE ENDPOINT
============================== */
app.post("/ministry-message", async (req, res) => {
  const { name, message, source } = req.body || {};

  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("ministry_messages")
      .insert([{
        name:    name?.trim() || "Anonymous",
        message: message.trim(),
        source:  source || MESSAGE_SOURCE
      }]);

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: "Failed to save message" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Ministry message error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ==============================
   READER MESSAGES ENDPOINT
   (password protected)
============================== */
app.get("/messages", async (req, res) => {
  const readerPassword = process.env.READER_PASSWORD;
  const provided       = req.headers["x-reader-password"];

  if (!readerPassword || provided !== readerPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("ministry_messages")
      .select("id, name, message, source, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("Supabase fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch messages" });
    }

    return res.json({ messages: data });
  } catch (err) {
    console.error("Reader fetch error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ==============================
   LIVE CONTROL — URL TRIGGERS
============================== */
app.get("/live/on", (req, res) => {
  LIVE_STATE.isLive    = true;
  LIVE_STATE.updatedAt = new Date().toISOString();
  LIVE_STATE.source    = "control-url";
  console.log(`[${CLIENT_NAME}] LIVE STATE: ON`);
  return res.json({ ok: true, ...LIVE_STATE });
});

app.get("/live/off", (req, res) => {
  LIVE_STATE.isLive    = false;
  LIVE_STATE.updatedAt = new Date().toISOString();
  LIVE_STATE.source    = "control-url";
  console.log(`[${CLIENT_NAME}] LIVE STATE: OFF`);
  return res.json({ ok: true, ...LIVE_STATE });
});

/* ==============================
   LIVE STATUS (FRONTEND POLLING)
============================== */
app.get("/live-status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(LIVE_STATE);
});

/* ==============================
   HEALTH / INFO
============================== */
app.get("/__whoami", (req, res) => {
  res.json({
    service:  `hopepal-${CLIENT_SLUG}`,
    client:   CLIENT_NAME,
    status:   "running",
    version:  "2026-03-08",
    routes:   ["/ministry-message", "/messages", "/live/on", "/live/off", "/live-status"],
    live:     LIVE_STATE
  });
});

/* ==============================
   START SERVER
============================== */
app.listen(PORT, () => {
  console.log(`[HopePal] ${CLIENT_NAME} service running on port ${PORT}`);
});
