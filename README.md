# cinikimi-wa-service

WhatsApp worker service for Cinikimi. Run and deploy separately from the web app.

Quick run (local):

```bash
cd wa-service
npm ci
# fill .env or set env vars
npm run start
```

Environment variables

- `SUPABASE_URL`, `SUPABASE_KEY` (or service role key)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` (if using S3)
- Any WhatsApp credential files under `wa_auth_info/` — do NOT commit these
- `PORT` (optional)

Notes
- Do not commit `wa_auth_info/` or `.env`. Use Railway/GitHub Secrets for production.
