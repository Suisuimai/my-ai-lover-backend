# V2 review and deployment order

Do not deploy the frontend before the database and backend are ready.

1. Back up `sessions`, `messages`, `session_memories`, `user_settings`, and
   `model_credentials` in Supabase.
2. Run `migrations/001_character_foundation.sql` in the Supabase SQL Editor.
   Confirm both verification counts at the bottom are zero.
3. Run `migrations/002_long_term_memories.sql`. Confirm
   `invalid_character_ownership` is zero.
4. Deploy the backend branch and verify `GET /health`.
5. Deploy the frontend branch.

## Manual review

1. Sign in and open Settings.
2. Expand **Companion & you**, change the companion name and communication
   style, then save.
3. Add a preferred user name and "listen before offering advice" as a
   communication preference.
4. Start a new conversation and confirm the companion uses the saved identity.
5. In conversation A, make a clear promise with a distinctive phrase, such as
   "Sunday interview practice". Wait several seconds for background extraction.
6. Open Settings > Long-term memories. Correct the extracted text or triggers if
   necessary.
7. Start conversation B and mention the distinctive phrase. The companion
   should use the memory naturally without reciting a database list.
8. Pause the memory and repeat the test in conversation C; it should no longer
   influence the reply.
9. Delete the memory and confirm it disappears.

## Local verification

Backend:

```powershell
npm.cmd test
node --check index.js
npm.cmd start
```

Frontend:

```powershell
npm.cmd run lint
npm.cmd run dev
```

The frontend defaults to `http://localhost:3000` for the backend in development.
