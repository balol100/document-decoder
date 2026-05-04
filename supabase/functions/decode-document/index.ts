// Supabase Edge Function: decode-document
//
// Receives an image (JPEG/PNG/WebP) or PDF as base64, sends it to Claude Haiku 4.5
// (vision), and returns a structured analysis explaining the document in simple
// Hebrew — what it says, what to do, deadlines, warnings, and urgency.
//
// PRIVACY GUARANTEES:
//   - Document contents are NEVER logged. The base64 payload is sent to Anthropic
//     and immediately discarded after the response is returned to the user.
//   - No persistence: nothing is stored to disk, KV, or DB.
//   - Logs contain only the request method, response status, and error category —
//     never the document image, never the AI's response text.
//
// Setup:
//   supabase functions deploy decode-document --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// Request:  POST /functions/v1/decode-document
//   headers: apikey + authorization (anon key), content-type: application/json
//   body:    { "image": "<base64>", "mediaType": "image/jpeg" | "image/png" | "image/webp" | "application/pdf" }
//
// Response (200):
//   {
//     "documentType": "bank" | "insurance" | "government" | "legal" | "municipal" | "medical" | "tax" | "utility" | "other",
//     "sender": "<who sent the document, in Hebrew>",
//     "summary": "<2-3 sentence plain-Hebrew summary>",
//     "actionItems": ["<step 1>", "<step 2>", ...],
//     "deadlines": [{ "what": "<what>", "date": "YYYY-MM-DD" | "<free-text>" }, ...],
//     "warnings": ["<warning 1>", ...],
//     "urgency": "low" | "medium" | "high"
//   }
//
// Response (4xx/5xx): { "error": "<code>", "message": "<hebrew message for end user>" }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://decoder.lior-ai.com,https://decoder-lior-ai.netlify.app,https://document-decoder.netlify.app,https://document-decoder.lior-ai.com,http://localhost,http://localhost:3000,http://localhost:5173,http://localhost:8000")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Daily rate limit per IP. Documents use more tokens than license-plate OCR.
const DAILY_LIMIT = parseInt(Deno.env.get("DAILY_LIMIT") || "5", 10);

// In-memory rate limiter, keyed by IP+UTC-day.
// (Edge Functions are short-lived, so this is best-effort. Combined with the
// client-side limit it gives a reasonable cap. For strict enforcement use KV.)
type Bucket = { count: number; expiresAt: number };
const rateLimits = new Map<string, Bucket>();

function todayBucketKey(ip: string): string {
  const d = new Date();
  const day = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  return `${ip}:${day}`;
}

function checkAndIncrementRate(ip: string): { allowed: boolean; remaining: number } {
  const key = todayBucketKey(ip);
  const now = Date.now();
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  const expiresAt = tomorrow.getTime();

  // GC expired buckets
  if (rateLimits.size > 1000) {
    for (const [k, b] of rateLimits) {
      if (b.expiresAt <= now) rateLimits.delete(k);
    }
  }

  const existing = rateLimits.get(key);
  if (!existing || existing.expiresAt <= now) {
    rateLimits.set(key, { count: 1, expiresAt });
    return { allowed: true, remaining: DAILY_LIMIT - 1 };
  }
  if (existing.count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  existing.count += 1;
  return { allowed: true, remaining: DAILY_LIMIT - existing.count };
}

function corsHeaders(origin: string): Record<string, string> {
  const allowed = ALLOWED_ORIGINS.some((o) => origin === o || (o && origin.startsWith(o)));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0] || "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json; charset=utf-8" },
  });
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

const SYSTEM_PROMPT = `אתה מפענח מסמכים רשמיים בעברית. המטרה שלך: לעזור לאזרח רגיל בישראל להבין מה כתוב במסמך — בלי בלגן ובלי משפטית.

קהל היעד: כל אדם בישראל, כולל מבוגרים שלא מבינים בז'רגון בנקאי, ביטוחי, משפטי או ממשלתי.

קווים מנחים:
- כתוב בעברית פשוטה, חמה, ברורה. כמו שמסבירים לבן משפחה.
- אל תשתמש במונחים מקצועיים בלי להסביר אותם.
- אל תהיה דרמטי. אל תבהיל. אבל גם אל תפספס סכנות אמיתיות.
- אם משהו לא ברור או לא קריא — תכתוב את זה בכנות.
- היה ספציפי: סכומים, תאריכים, מספרים — תזכיר אותם אם הם במסמך.
- אם המסמך לא במצב טוב או חסרים פרטים — תיתן הסבר חלקי בכנות.

החזר *רק* JSON תקין במבנה הזה (בלי markdown, בלי הסברים מסביב):

{
  "documentType": "bank" | "insurance" | "government" | "legal" | "municipal" | "medical" | "tax" | "utility" | "other",
  "sender": "מי שלח את המסמך — שם הבנק/המוסד/המשרד/החברה. אם לא ברור: 'מסמך לא מזוהה'",
  "summary": "סיכום של 2-3 משפטים בעברית פשוטה — מה המסמך אומר ומה הקטע. בלי ז'רגון.",
  "actionItems": [
    "פעולה 1 שצריך לעשות, ניסוח ברור (למשל 'לשלם את החוב באתר הבנק' או 'לחתום ולהחזיר את הטופס בדואר')",
    "פעולה 2"
  ],
  "deadlines": [
    {
      "what": "מה צריך לעשות עד התאריך",
      "date": "YYYY-MM-DD אם יש תאריך מדויק במסמך, אחרת תיאור חופשי כמו 'עד סוף החודש'"
    }
  ],
  "warnings": [
    "אזהרה או דבר חשוב שצריך לשים לב אליו (למשל 'אם לא תשלם עד התאריך — יחויב ריבית פיגורים' או 'הקנס יכול לגדול אם לא מטפלים מהר')"
  ],
  "urgency": "low" | "medium" | "high"
}

כללי דחיפות:
- "high" — דרוש פעולה מיידית (תוך כמה ימים), או שיש סנקציות חמורות (עיקול, הליכים משפטיים, ניתוק שירות, חיוב גדול)
- "medium" — צריך לטפל בקרוב (תוך שבוע-שבועיים), או שיש דד-ליין
- "low" — מסמך מידע בלבד, או שאין דד-ליין דחוף

חשוב:
- "actionItems" יכול להיות ריק אם אין מה לעשות (מסמך מידע בלבד)
- "deadlines" יכול להיות ריק אם אין תאריכים
- "warnings" יכול להיות ריק אם אין סכנות
- "summary" חייב להיות תמיד מלא
- אם המסמך לא קריא בכלל או לא נראה כמו מסמך — החזר documentType="other", sender="לא הצלחתי לזהות", summary שמסביר את הבעיה, ו-urgency="low"`;

// Walk the text and return the substring of the first balanced {...} block,
// honoring string literals so braces inside strings don't unbalance the count.
// Greedy `.*` regex breaks when the model wraps JSON in prose that contains
// stray braces; this scanner stops at the first true closing brace.
function extractBalancedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeParseJson(text: string): unknown | null {
  if (!text) return null;
  // Strip markdown code fences if Claude added them despite the system prompt.
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(stripped);
  } catch {
    // Intentionally fall through.
  }
  const balanced = extractBalancedJson(stripped);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      // Intentionally fall through.
    }
  }
  return null;
}

type Analysis = {
  documentType: string;
  sender: string;
  summary: string;
  actionItems: string[];
  deadlines: Array<{ what: string; date: string }>;
  warnings: string[];
  urgency: "low" | "medium" | "high";
};

function normalizeAnalysis(raw: Record<string, unknown>): Analysis {
  const allowedTypes = new Set([
    "bank", "insurance", "government", "legal",
    "municipal", "medical", "tax", "utility", "other",
  ]);
  const allowedUrgency = new Set(["low", "medium", "high"]);

  const documentType = typeof raw.documentType === "string" && allowedTypes.has(raw.documentType)
    ? raw.documentType
    : "other";

  const sender = typeof raw.sender === "string" && raw.sender.trim()
    ? raw.sender.trim().slice(0, 200)
    : "מסמך לא מזוהה";

  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 1500) : "";

  const actionItems = Array.isArray(raw.actionItems)
    ? raw.actionItems
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().slice(0, 400))
        .slice(0, 10)
    : [];

  const deadlines = Array.isArray(raw.deadlines)
    ? raw.deadlines
        .map((d) => {
          if (!d || typeof d !== "object") return null;
          const obj = d as Record<string, unknown>;
          const what = typeof obj.what === "string" ? obj.what.trim().slice(0, 300) : "";
          const date = typeof obj.date === "string" ? obj.date.trim().slice(0, 100) : "";
          if (!what && !date) return null;
          return { what, date };
        })
        .filter((d): d is { what: string; date: string } => d !== null)
        .slice(0, 10)
    : [];

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().slice(0, 400))
        .slice(0, 10)
    : [];

  const urgency = (typeof raw.urgency === "string" && allowedUrgency.has(raw.urgency))
    ? (raw.urgency as "low" | "medium" | "high")
    : "low";

  return { documentType, sender, summary, actionItems, deadlines, warnings, urgency };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", message: "שיטה לא נתמכת" }, 405, origin);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("[decode-document] missing ANTHROPIC_API_KEY");
    return jsonResponse(
      { error: "server_misconfigured", message: "תקלה בהגדרות השרת. נסה שוב מאוחר יותר." },
      500, origin,
    );
  }

  // Rate limit before parsing the (potentially large) body.
  const ip = getClientIp(req);
  const limit = checkAndIncrementRate(ip);
  if (!limit.allowed) {
    return jsonResponse(
      { error: "rate_limited", message: "הגעת למכסה היומית של 5 מסמכים. נסה שוב מחר." },
      429, origin,
    );
  }

  let body: { image?: unknown; mediaType?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { error: "invalid_json", message: "בעיה בקריאת הבקשה. נסה שוב." },
      400, origin,
    );
  }

  const image = body?.image;
  const mediaType = body?.mediaType;

  if (typeof image !== "string" || !image) {
    return jsonResponse(
      { error: "missing_image", message: "לא נשלחה תמונה. בחר/י תמונה או מסמך PDF." },
      400, origin,
    );
  }

  // Allow ~10MB of base64 (~7.5MB binary). Anthropic limit is 5MB binary per image.
  if (image.length > 10 * 1024 * 1024) {
    return jsonResponse(
      { error: "image_too_large", message: "הקובץ גדול מדי. הקובץ חייב להיות עד 10MB." },
      413, origin,
    );
  }

  const validImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  let mt: string;
  let sourceType: "image" | "document";
  if (mediaType === "application/pdf") {
    mt = "application/pdf";
    sourceType = "document";
  } else if (typeof mediaType === "string" && validImageTypes.has(mediaType)) {
    mt = mediaType;
    sourceType = "image";
  } else {
    mt = "image/jpeg";
    sourceType = "image";
  }

  // Build Anthropic vision request.
  const contentBlock: Record<string, unknown> = sourceType === "document"
    ? {
      type: "document",
      source: { type: "base64", media_type: mt, data: image },
    }
    : {
      type: "image",
      source: { type: "base64", media_type: mt, data: image },
    };

  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            contentBlock,
            { type: "text", text: "פענח את המסמך. החזר רק JSON תקין לפי המבנה שביקשתי." },
          ],
        }],
      }),
    });
  } catch (e) {
    console.error("[decode-document] anthropic fetch failed:", (e as Error)?.message);
    return jsonResponse(
      { error: "anthropic_unreachable", message: "תקלה זמנית בחיבור לשרת ה-AI. נסה שוב בעוד רגע." },
      502, origin,
    );
  }

  if (!r.ok) {
    // Log only the status code, not the request or response body (no PII leak).
    const status = r.status;
    let detailCategory = "anthropic_error";
    try {
      const errBody = await r.text();
      // Only log the first 200 chars and only the error type, never the user content.
      const first = errBody.slice(0, 200);
      if (first.includes("rate_limit")) detailCategory = "anthropic_rate_limit";
      else if (first.includes("invalid_request")) detailCategory = "anthropic_invalid_request";
      console.error(`[decode-document] anthropic ${status}: ${detailCategory}`);
    } catch {
      console.error(`[decode-document] anthropic ${status}: <no body>`);
    }
    const userMsg = status === 429
      ? "השרת עמוס כרגע. נסה שוב בעוד דקה."
      : status >= 500
        ? "תקלה זמנית בשרת ה-AI. נסה שוב בעוד רגע."
        : "לא הצלחתי לפענח את המסמך. נסה תמונה ברורה יותר.";
    return jsonResponse({ error: detailCategory, message: userMsg }, 502, origin);
  }

  let data: Record<string, unknown>;
  try {
    data = await r.json();
  } catch {
    return jsonResponse(
      { error: "anthropic_bad_response", message: "תשובה לא ברורה מהשרת. נסה שוב." },
      502, origin,
    );
  }

  const content = (data as { content?: Array<{ type?: string; text?: string }> })?.content;
  const textBlock = Array.isArray(content) ? content.find((c) => c?.type === "text") : null;
  const text = (textBlock?.text || "").trim();

  if (!text) {
    const message = sourceType === "document"
      ? "לא הצלחתי לקרוא את ה-PDF. נסה/י לצלם את המסמך במצלמה — לרוב זה עובד יותר טוב."
      : "לא קיבלתי תשובה מה-AI. נסה/י תמונה ברורה יותר.";
    return jsonResponse({ error: "empty_response", message }, 502, origin);
  }

  const parsed = safeParseJson(text);
  if (!parsed || typeof parsed !== "object") {
    // Log structural diagnostics only — never the text itself, which may contain
    // extracted document content (PII).
    console.error("[decode-document] parse_failed " + JSON.stringify({
      source_type: sourceType,
      media_type: mt,
      text_length: text.length,
      open_braces: (text.match(/\{/g) || []).length,
      close_braces: (text.match(/\}/g) || []).length,
      starts_with_brace: text.startsWith("{"),
      ends_with_brace: text.endsWith("}"),
      has_code_fence: text.includes("```"),
    }));

    // Plain-text fallback: rather than show an error, hand the user the model's
    // raw Hebrew so they at least see *something* useful. Frontend keys off
    // `fallback: true` to render this without the structured cards.
    return jsonResponse({
      fallback: true,
      documentType: "other",
      sender: sourceType === "document" ? "מסמך PDF" : "מסמך",
      summary: text.slice(0, 5000),
      actionItems: [],
      deadlines: [],
      warnings: [],
      urgency: "low",
    }, 200, origin);
  }

  const analysis = normalizeAnalysis(parsed as Record<string, unknown>);

  if (!analysis.summary) {
    const message = sourceType === "document"
      ? "לא הצלחתי לקרוא את ה-PDF. נסה/י לצלם את המסמך במצלמה במקום."
      : "לא הצלחתי לקרוא את המסמך. נסה תמונה ברורה יותר של המסמך כולו.";
    return jsonResponse({ error: "no_summary", message }, 502, origin);
  }

  return jsonResponse(analysis, 200, origin);
});
