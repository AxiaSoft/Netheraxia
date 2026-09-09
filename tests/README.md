# Netheraxia tests

Two suites. Both are offline; neither needs a browser.

## 1. Page/UI tests — `node tests/run.mjs`

Stub a minimal DOM plus a fake GitHub/Supabase API and load the real
`index.html` / `admin.html` inline scripts. 290 checks.

Covers:

- both 3D backgrounds (voxel tunnel + wire terrain) across themes and viewports
- the server-status presets and how they drive the home page
- the connect-button switch (hidden button must also block the modal)
- server addresses staying inside the modal, version staying on the page
- the GitHub sync: auth, create, skip-unchanged, single-file publish,
  UTF-8 round-trip, 409 retry, pull, no push loops and offline behaviour
- the account layer: login/register, teams, profile, password recovery,
  flag upload, and the account button in every state
- admin writes that a database can refuse *silently* (sections Z, AA)
- finding players with no team, and the admin-bootstrap card (BB)
- the retired teams tab staying removed without collateral damage (CC)
- the admin assigning / moving / removing a player's team, including the
  rollback when the destination team is full (DD, EE)

## 2. Database tests — `node tests/db.mjs`

The DOM suite cannot catch schema bugs: a trigger that reverts a write and an
RLS policy that hides a row both look like success from JavaScript. Round 14
shipped exactly that — `update ... set is_admin = true` reported `UPDATE 1`
and changed nothing — so `supabase/schema.sql` is now executed against a real
PostgreSQL server.

```bash
pip install --break-system-packages pgserver
node tests/db.mjs
```

It skips with exit 0 when `pgserver` is missing, so it never blocks anything.
A small shim supplies the Supabase pieces (`auth.users`, `auth.uid()`, the
`anon`/`authenticated` roles); everything else is the real schema file.

Covers:

- the whole file applies to a fresh database, and re-applying is idempotent
- `make_admin()` really flips `is_admin`, and raises a clear error for an
  unregistered name instead of matching zero rows
- a logged-in player still cannot promote or unban themselves, nor call
  `make_admin` from the browser
- only an admin can change the limits; a non-admin `UPDATE` affects 0 rows
  (which PostgREST reports as `200 []` — the trap behind the "value bounces
  back" bug)
- the upgrade path on the user's existing database: the old schema's silent
  failure is reproduced, then the new file is applied over it, players are
  preserved and the bootstrap works
- an admin can add and remove other players' memberships, while a normal
  player cannot -- and the one-team, team-full and banned rules still hold
  for the admin too
- the Telegram gate holds at the database level: a signup with no ticket, an
  invented ticket, a malformed one, a replayed one and an expired one are all
  refused, a genuine ticket is accepted exactly once, one Telegram account
  cannot make two players, and neither `anon` nor `authenticated` can read or
  mint tickets

`run.mjs` additionally verifies the Telegram login signature (section FF) by
lifting `checkTelegramSignature` out of the Edge Function and running it
against a vector computed independently from Telegram's published algorithm —
a tampered user id, a wrong hash and a wrong bot token must all be rejected.
It also asserts we use the Login Widget algorithm (`SHA256(bot_token)`) and
not the Mini App one (`HMAC(bot_token,'WebAppData')`), which is a common and
silent mix-up.
