# מפענח מסמכים — Document Decoder

> כלי חינמי שמסביר מסמכים רשמיים בעברית פשוטה — מכתבים מהבנק, מהביטוח, מהמדינה, מהעירייה ומקומות נוספים.

A free tool that helps people in Israel understand official documents. Photograph or upload any official document → get a plain-Hebrew explanation of what it says, what to do, deadlines, and warnings.

**Live:** https://decoder.lior-ai.com

## Privacy by design

- Documents are **never stored** — not in a database, not on disk, not in logs.
- The image is sent to Anthropic for one-shot analysis and discarded immediately.
- No accounts, no cookies, no tracking.
- Edge function logs contain only error categories — never document content.

## Stack

- Single `index.html` (inline CSS + JS), Hebrew RTL, Heebo font
- Supabase Edge Function (`decode-document`) → Claude Haiku 4.5 (vision)
- Netlify hosting
- 5 documents/day per IP (server-side + client-side limit)

## Edge function

`supabase/functions/decode-document/index.ts` accepts an image or PDF (base64),
returns a structured JSON analysis: `documentType`, `sender`, `summary`,
`actionItems[]`, `deadlines[]`, `warnings[]`, `urgency`.

Deploy:

```bash
supabase functions deploy decode-document --no-verify-jwt
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

## Credits

נבנה על ידי Claude ו-[lior_Ai](https://lior-ai.com) — כי כל אדם צריך להבין מה כתוב לו ❤️
