/* ============================================================================
 * Netheraxia — real-Postgres tests for supabase/schema.sql
 *
 * The DOM harness in run.mjs cannot catch database bugs: a trigger that
 * silently reverts a write, or an RLS policy that hides a row, both look
 * like success from JavaScript. Round 14 shipped exactly that bug, so the
 * schema now gets executed against a genuine PostgreSQL server.
 *
 *   pip install --break-system-packages pgserver
 *   node tests/db.mjs
 *
 * Skips (exit 0) when pgserver is unavailable, so it never blocks CI.
 * ==========================================================================*/
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass++; console.log('  \u001b[32m✅\u001b[0m ' + label); }
  else { fail++; console.log('  \u001b[31m❌\u001b[0m ' + label + (extra ? '\n     ' + extra : '')); }
};
const section = t => console.log('\n── ' + t + ' ──');

try {
  execFileSync('python3', ['-c', 'import pgserver'], { stdio: 'ignore' });
} catch {
  console.log('⏭️  pgserver not installed — skipping database tests.');
  console.log('   pip install --break-system-packages pgserver');
  process.exit(0);
}

// Minimal stand-in for the Supabase pieces the schema depends on.
const SHIM = `
create schema if not exists auth;
create schema if not exists extensions;
create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    encrypted_password text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create or replace function public.crypt(text,text) returns text
  language sql immutable as $$ select md5($1||$2) $$;
create or replace function extensions.crypt(text,text) returns text
  language sql immutable as $$ select md5($1||$2) $$;
do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
`;

const dir = mkdtempSync(join(tmpdir(), 'nxdb-'));
const runner = join(dir, 'run.py');
writeFileSync(runner, `
import sys, pathlib, pgserver
db = pgserver.get_server(pathlib.Path(sys.argv[1]))
sys.stdout.write(db.psql(sys.stdin.read()))
`);

// psql sends NOTICE output to stderr, and the raise-notice assertions below
// depend on it, so both streams are returned together.
const sql = (data, text) => {
  const r = spawnSync('python3', [runner, join(dir, data)],
    { input: text, encoding: 'utf8' });
  if (r.error) return 'PSQL_ERROR: ' + r.error.message;
  const out = (r.stdout || '') + (r.stderr || '');
  return r.status === 0 ? out : 'PSQL_ERROR: ' + out;
};

const schemaOf = ref => {
  const raw = ref === 'HEAD'
    ? readFileSync(join(ROOT, 'supabase/schema.sql'), 'utf8')
    : execFileSync('git', ['show', ref + ':supabase/schema.sql'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  return raw.replace('create extension if not exists pgcrypto;', '');
};

const NEW = schemaOf('HEAD');
const register = (name, mail) => `insert into auth.users (email, raw_user_meta_data)
  values ('${mail}', '{"mc_username":"${name}"}'::jsonb);`;
const asUser = name => `do $$ declare uid uuid; begin
  select id into uid from public.profiles where mc_username='${name}';
  perform set_config('request.jwt.claim.sub', uid::text, false);
end $$;`;

console.log('🐘 Netheraxia database tests (real PostgreSQL)');

/* ---------------------------------------------------------------- */
section('A. the schema runs end to end');
sql('a', SHIM);
const first = sql('a', NEW);
check('a fresh database accepts the whole file', !first.includes('PSQL_ERROR'),
  first.slice(0, 400));
const second = sql('a', NEW);
check('re-running it is safe (idempotent)', !second.includes('PSQL_ERROR'),
  second.slice(0, 400));
check('make_admin exists afterwards',
  sql('a', `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='make_admin';`).includes('1'));

/* ---------------------------------------------------------------- */
section('B. the admin bootstrap actually sticks');
sql('a', register('HyraxMC', 'h@mc.com'));
check('signing up creates a profile',
  sql('a', `select mc_username from public.profiles;`).includes('HyraxMC'));
check('the new player is not an admin yet',
  /HyraxMC\s*\|\s*f/.test(sql('a', `select mc_username, is_admin from public.profiles;`)));

const made = sql('a', `select public.make_admin('HyraxMC');`);
check('make_admin reports success', made.includes('انجام شد'));
check('and is_admin is really true afterwards',
  /HyraxMC\s*\|\s*t/.test(sql('a', `select mc_username, is_admin from public.profiles;`)),
  'this is the round-14 bug: the trigger reverted it silently');

const missing = sql('a', `do $$ begin perform public.make_admin('Ghost');
  exception when others then raise notice 'RAISED: %', sqlerrm; end $$;`);
check('an unregistered name raises a clear error, not silence',
  /RAISED:.*پیدا نشد/.test(missing));

/* ---------------------------------------------------------------- */
section('C. players still cannot promote themselves');
sql('a', register('Sneaky', 'e@mc.com'));
sql('a', `${asUser('Sneaky')} set role authenticated;
  update public.profiles set is_admin = true where mc_username='Sneaky'; reset role;`);
check('a logged-in player cannot set their own is_admin',
  /Sneaky\s*\|\s*f/.test(sql('a', `select mc_username, is_admin from public.profiles
                                   where mc_username='Sneaky';`)));
const direct = sql('a', `${asUser('Sneaky')} set role authenticated;
  do $$ begin perform public.make_admin('Sneaky');
    raise notice 'HOLE';
  exception when insufficient_privilege then raise notice 'BLOCKED'; end $$;
  reset role;`);
check('a player cannot call make_admin from the browser', direct.includes('BLOCKED'));
check('and they are still not an admin',
  /Sneaky\s*\|\s*f/.test(sql('a', `select mc_username, is_admin from public.profiles
                                   where mc_username='Sneaky';`)));
check('a player cannot unban themselves',
  (() => {
    sql('a', `update public.profiles set is_banned=true where mc_username='Sneaky';`);
    sql('a', `${asUser('Sneaky')} set role authenticated;
      update public.profiles set is_banned=false where mc_username='Sneaky'; reset role;`);
    const r = /Sneaky\s*\|\s*t/.test(sql('a', `select mc_username, is_banned from public.profiles
                                               where mc_username='Sneaky';`));
    sql('a', `update public.profiles set is_banned=false where mc_username='Sneaky';`);
    return r;
  })());

/* ---------------------------------------------------------------- */
section('D. only an admin may change the limits');
sql('a', `${asUser('HyraxMC')} set role authenticated;
  update public.app_settings set max_teams = 4 where id = 1; reset role;`);
check('an admin can lower max_teams',
  /\|\s*4/.test(sql('a', `select id, max_teams from public.app_settings;`)));

const blocked = sql('a', `${asUser('Sneaky')} set role authenticated;
  update public.app_settings set max_teams = 99 where id = 1; reset role;`);
check('a non-admin update affects zero rows', /UPDATE 0/.test(blocked),
  'PostgREST turns this into 200 + [] — the panel must not call it success');
check('the stored value is unchanged',
  /\|\s*4/.test(sql('a', `select id, max_teams from public.app_settings;`)));

/* ---------------------------------------------------------------- */
section('E. upgrading the user\u2019s existing database');
sql('b', SHIM);
let base = null;
try {
  execFileSync('git', ['cat-file', '-e', 'cc7288d:supabase/schema.sql'], { cwd: ROOT });
  base = 'cc7288d';
} catch {}
if (!base) {
  console.log('  ⏭️  the previous schema revision is not in this clone — skipped');
} else {
  sql('b', schemaOf(base));
  sql('b', register('HyraxMC', 'h@mc.com'));
  const oldWay = sql('b', `update public.profiles set is_admin = true
    where lower(mc_username) = lower('HyraxMC');`);
  check('the OLD schema reported UPDATE 1 …', /UPDATE 1/.test(oldWay));
  check('… while silently leaving is_admin false (the reported bug)',
    /HyraxMC\s*\|\s*f/.test(sql('b', `select mc_username, is_admin from public.profiles;`)));

  const up = sql('b', NEW);
  check('the new schema applies over the old one', !up.includes('PSQL_ERROR'),
    up.slice(0, 400));
  check('existing players are preserved',
    sql('b', `select mc_username from public.profiles;`).includes('HyraxMC'));
  check('make_admin now works on the upgraded database',
    sql('b', `select public.make_admin('HyraxMC');`).includes('انجام شد'));
  check('and the flag sticks',
    /HyraxMC\s*\|\s*t/.test(sql('b', `select mc_username, is_admin from public.profiles;`)));
}

/* ---------------------------------------------------------------- */
section('F. an admin may place a player into a team');
// fresh database so the member limits are predictable
sql('c', SHIM);
sql('c', NEW);
sql('c', register('Boss',  'b@mc.com'));
sql('c', register('Steve', 's@mc.com'));
sql('c', register('Alex',  'a@mc.com'));
sql('c', `select public.make_admin('Boss');`);
// Steve creates a team the normal way
sql('c', `${asUser('Steve')} set role authenticated;
  insert into public.teams (name, owner_id)
  select 'Alpha', id from public.profiles where mc_username='Steve';
  reset role;`);
check('a player can create their own team',
  sql('c', `select name from public.teams;`).includes('Alpha'));
check('the owner is auto-added as a member',
  /Steve/.test(sql('c', `select p.mc_username from public.team_members tm
    join public.profiles p on p.id=tm.user_id;`)));
check('Alex has no team yet',
  !/Alex/.test(sql('c', `select p.mc_username from public.team_members tm
    join public.profiles p on p.id=tm.user_id;`)));

// the feature: the admin inserts someone else's membership
const assigned = sql('c', `${asUser('Boss')} set role authenticated;
  insert into public.team_members (team_id, user_id, is_leader)
  select t.id, p.id, false from public.teams t, public.profiles p
   where t.name='Alpha' and p.mc_username='Alex'
  returning user_id;
  reset role;`);
check('an admin can add another player to a team', /INSERT 0 1/.test(assigned),
  assigned.slice(0, 300));
check('and the membership is really there',
  /Alex/.test(sql('c', `select p.mc_username from public.team_members tm
    join public.profiles p on p.id=tm.user_id;`)));

// a non-admin must not be able to do the same
sql('c', register('Nosy', 'n@mc.com'));
const nosy = sql('c', `${asUser('Nosy')} set role authenticated;
  insert into public.team_members (team_id, user_id, is_leader)
  select t.id, p.id, false from public.teams t, public.profiles p
   where t.name='Alpha' and p.mc_username='Nosy2';
  reset role;`);
check('a normal player cannot add a different user', /INSERT 0 0|PSQL_ERROR/.test(nosy));

// the one-team rule still applies to admin inserts.
// Steve already owns Alpha and cannot own a second team, so Bravo needs a
// fresh owner -- otherwise the insert below would match zero rows and the
// assertion would pass for the wrong reason.
sql('c', register('Owner2', 'o2@mc.com'));
sql('c', `${asUser('Owner2')} set role authenticated;
  insert into public.teams (name, owner_id)
  select 'Bravo', id from public.profiles where mc_username='Owner2';
  reset role;`);
check('a second team exists to test against',
  sql('c', `select name from public.teams order by name;`).includes('Bravo'));
const dup = sql('c', `${asUser('Boss')} set role authenticated;
  do $$ begin
    insert into public.team_members (team_id, user_id, is_leader)
    select t.id, p.id, false from public.teams t, public.profiles p
     where t.name='Bravo' and p.mc_username='Alex';
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('an admin still cannot put someone in two teams at once',
  /REFUSED: ALREADY_IN_TEAM/.test(dup), dup.slice(0, 300));

// a banned player is refused
sql('c', `update public.profiles set is_banned=true where mc_username='Nosy';`);
const ban = sql('c', `${asUser('Boss')} set role authenticated;
  do $$ begin
    insert into public.team_members (team_id, user_id, is_leader)
    select t.id, p.id, false from public.teams t, public.profiles p
     where t.name='Alpha' and p.mc_username='Nosy';
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('a banned player cannot be assigned', /REFUSED: BANNED/.test(ban), ban.slice(0, 300));

// the per-team cap is enforced even for an admin
sql('c', `update public.app_settings set max_members = 2 where id = 1;`);
sql('c', register('Extra', 'e@mc.com'));
const full = sql('c', `${asUser('Boss')} set role authenticated;
  do $$ begin
    insert into public.team_members (team_id, user_id, is_leader)
    select t.id, p.id, false from public.teams t, public.profiles p
     where t.name='Alpha' and p.mc_username='Extra';
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('the team-size cap still applies to an admin',
  /REFUSED: TEAM_FULL/.test(full), full.slice(0, 300));

// and the admin can pull a player back out
const removed = sql('c', `${asUser('Boss')} set role authenticated;
  delete from public.team_members tm using public.profiles p
   where tm.user_id = p.id and p.mc_username='Alex';
  reset role;`);
check('an admin can remove a player from a team', /DELETE 1/.test(removed));
check('the player is teamless afterwards',
  !/Alex/.test(sql('c', `select p.mc_username from public.team_members tm
    join public.profiles p on p.id=tm.user_id;`)));

/* ----------------------------------------------------------------
 * G. the Telegram gate cannot be walked around
 *
 * The browser check is only a convenience. What actually protects
 * registration is the trigger, so these run straight against the
 * database the way an attacker calling the REST API would.
 * ---------------------------------------------------------------- */
section('G. registration is gated on Telegram membership');

sql('g', SHIM);
sql('g', NEW);

check('the ticket table exists',
  sql('g', `select to_regclass('public.telegram_tickets');`).includes('telegram_tickets'));

// While the gate is off, nothing changes for existing servers.
const offSignup = sql('g', `do $$ begin ${register('NoGate', 'ng@mc.com').replace(/^insert/, 'insert')}
  raise notice 'ALLOWED'; exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('with the gate off, registration works as before',
  /ALLOWED/.test(offSignup), offSignup.slice(0, 300));

// Turn the gate on.
sql('g', `update public.app_settings set telegram_required = true where id = 1;`);

const noTicket = sql('g', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('sneaky@mc.com', '{"mc_username":"Sneaky"}'::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('a direct API signup with no ticket is refused',
  /REFUSED: TELEGRAM_REQUIRED/.test(noTicket), noTicket.slice(0, 300));

const madeUp = sql('g', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('fake@mc.com', ('{"mc_username":"Faker","telegram_ticket":"'
            || gen_random_uuid() || '"}')::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('an invented ticket id is refused',
  /REFUSED: TELEGRAM_TICKET_INVALID/.test(madeUp), madeUp.slice(0, 300));

const garbage = sql('g', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('junk@mc.com', '{"mc_username":"Junk","telegram_ticket":"not-a-uuid"}'::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('a malformed ticket does not crash the trigger',
  /REFUSED: TELEGRAM_TICKET_INVALID/.test(garbage), garbage.slice(0, 300));

// A real ticket — the sort the Edge Function issues after getChatMember.
sql('g', `insert into public.telegram_tickets (token, telegram_id, telegram_username)
          values ('11111111-1111-1111-1111-111111111111', 555001, 'realguy');`);
const good = sql('g', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('real@mc.com',
            '{"mc_username":"RealGuy","telegram_ticket":"11111111-1111-1111-1111-111111111111"}'::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('a genuine ticket lets the player register',
  /ALLOWED/.test(good), good.slice(0, 300));
check('the telegram id is stored on the profile',
  /555001/.test(sql('g', `select telegram_id from public.profiles where mc_username='RealGuy';`)));
check('the ticket is marked used',
  /t/.test(sql('g', `select used_at is not null from public.telegram_tickets
                     where token='11111111-1111-1111-1111-111111111111';`)));

// Replay: the same ticket a second time.
const replay = sql('g', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('replay@mc.com',
            '{"mc_username":"Replay","telegram_ticket":"11111111-1111-1111-1111-111111111111"}'::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('the same ticket cannot be reused',
  /REFUSED: TELEGRAM_TICKET_USED/.test(replay), replay.slice(0, 300));

// An expired ticket.
sql('g', `insert into public.telegram_tickets (token, telegram_id, created_at)
          values ('22222222-2222-2222-2222-222222222222', 555002, now() - interval '2 hours');`);
const stale = sql('g', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('stale@mc.com',
            '{"mc_username":"Stale","telegram_ticket":"22222222-2222-2222-2222-222222222222"}'::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('an expired ticket is refused',
  /REFUSED: TELEGRAM_TICKET_EXPIRED/.test(stale), stale.slice(0, 300));

// One Telegram account may not register twice.
sql('g', `insert into public.telegram_tickets (token, telegram_id)
          values ('33333333-3333-3333-3333-333333333333', 555001);`);
const twice = sql('g', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('alt@mc.com',
            '{"mc_username":"AltAccount","telegram_ticket":"33333333-3333-3333-3333-333333333333"}'::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('one telegram account cannot make a second player',
  /REFUSED: TELEGRAM_ALREADY_USED/.test(twice), twice.slice(0, 300));

// The browser must never be able to mint its own ticket.
const forge = sql('g', `set role authenticated;
  do $$ begin
    insert into public.telegram_tickets (telegram_id) values (999999);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('a logged-in user cannot mint their own ticket',
  /REFUSED/.test(forge), forge.slice(0, 300));

const peek = sql('g', `set role anon;
  do $$ begin
    perform * from public.telegram_tickets;
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('an anonymous visitor cannot read tickets',
  /REFUSED/.test(peek), peek.slice(0, 300));

check('public_config exposes the telegram settings to the site',
  /telegram_required/.test(sql('g', `select public.public_config();`)));
check('public_config does not leak anything token-shaped',
  !/bot_token|TELEGRAM_BOT_TOKEN/i.test(sql('g', `select public.public_config();`)));

/* ----------------------------------------------------------------
 * H. the 6-digit code path (for users who cannot open telegram.org)
 * ---------------------------------------------------------------- */
section('H. verifying by code instead of the login button');

sql('h', SHIM);
sql('h', NEW);
sql('h', `update public.app_settings set telegram_required = true where id = 1;`);

const redeem = (code) => sql('h', `do $$ declare r json; begin
    r := public.redeem_telegram_code('${code}');
    raise notice 'TICKET %', r->>'ticket';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);

check('an unknown code is refused',
  /REFUSED: TELEGRAM_CODE_INVALID/.test(redeem('123456')));

sql('h', `insert into public.telegram_codes (code, telegram_id, telegram_username)
          values ('654321', 777001, 'coder');`);
const ok = redeem('654321');
check('a real code returns a ticket', /TICKET [0-9a-f-]{36}/.test(ok), ok.slice(0, 300));
check('the code is burned after use',
  /REFUSED: TELEGRAM_CODE_USED/.test(redeem('654321')));

sql('h', `insert into public.telegram_codes (code, telegram_id, created_at)
          values ('111111', 777002, now() - interval '30 minutes');`);
check('an expired code is refused',
  /REFUSED: TELEGRAM_CODE_EXPIRED/.test(redeem('111111')));

// The ticket that came out of the code must actually work for signing up.
const viaCode = sql('h', `do $$ declare t uuid; begin
    select token into t from public.telegram_tickets
     where telegram_id = 777001 and used_at is null;
    insert into auth.users (email, raw_user_meta_data)
    values ('coder@mc.com', ('{"mc_username":"Coder","telegram_ticket":"' || t || '"}')::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('a ticket earned by code can register',
  /ALLOWED/.test(viaCode), viaCode.slice(0, 300));
check('and the telegram id is recorded',
  /777001/.test(sql('h', `select telegram_id from public.profiles where mc_username='Coder';`)));

// Same anti-abuse rules as the button path.
sql('h', `insert into public.telegram_codes (code, telegram_id) values ('222222', 777001);`);
check('one telegram account still cannot register twice',
  /REFUSED: TELEGRAM_ALREADY_USED/.test(redeem('222222')));

const readCodes = sql('h', `set role anon;
  do $$ begin perform * from public.telegram_codes; raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('a visitor cannot read the codes table',
  /REFUSED/.test(readCodes), 'otherwise anyone could just read a valid code');

const writeCodes = sql('h', `set role anon;
  do $$ begin insert into public.telegram_codes (code, telegram_id) values ('999999', 1);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('a visitor cannot mint their own code', /REFUSED/.test(writeCodes));

console.log(`\n${fail ? '❌' : '🎉'} database tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
