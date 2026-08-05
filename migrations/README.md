# Database migrations

This directory is the ordered, append-only migration history for the V2 work.

Rules:

1. Never edit a migration after it has been applied to a shared database.
2. Never delete production rows as part of a feature migration.
3. Add nullable columns or safe defaults before backfilling existing rows.
4. Back up the affected tables before applying a migration.
5. Include verification queries and a rollback note with every migration.
6. Apply migrations in filename order and record the applied filename and time.

The existing `supabase-schema.sql` and `supabase-security-migration.sql` predate
this convention. They describe the current baseline but must not be rerun
blindly: the security migration intentionally deletes legacy demo sessions.

The first V2 migration will bind existing sessions to a default character
without deleting messages or `session_memories`.
