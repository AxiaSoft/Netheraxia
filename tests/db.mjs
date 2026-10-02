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
 * G. closing registration really closes it
 *
 * The user reported signups still going through after switching
 * registration off in the panel. The site not checking the flag was
 * one half; a stale handle_new_user() in an older database is the
 * other. check-registration.sql diagnoses and repairs the latter.
 * ---------------------------------------------------------------- */
section('G. closing registration is enforced by the database');

const DIAG = readFileSync(join(ROOT, 'supabase/check-registration.sql'), 'utf8');
const signup = (dbKey, name, mail) => sql(dbKey, `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('${mail}', '{"mc_username":"${name}"}'::jsonb);
    raise notice 'SIGNUP WENT THROUGH';
  exception when others then raise notice 'BLOCKED: %', sqlerrm; end $$;`);

sql('g', SHIM);
sql('g', NEW);

sql('g', `update public.app_settings set registration_open = false where id = 1;`);
check('a closed registration refuses a new signup',
  /BLOCKED: REGISTRATION_CLOSED/.test(signup('g', 'Nope', 'nope@mc.com')));
sql('g', `update public.app_settings set registration_open = true where id = 1;`);
check('re-opening lets players in again',
  /SIGNUP WENT THROUGH/.test(signup('g', 'Yep', 'yep@mc.com')));

// Reproduce the stale-trigger database, then prove the repair script fixes it.
sql('h', SHIM);
sql('h', NEW);
sql('h', `create or replace function public.handle_new_user()
  returns trigger language plpgsql security definer set search_path = public as $$
  begin
    insert into public.profiles (id, mc_username, email)
    values (new.id, btrim(coalesce(new.raw_user_meta_data->>'mc_username','')), new.email);
    return new;
  end $$;`);
sql('h', `update public.app_settings set registration_open = false where id = 1;`);
check('an out-of-date trigger reproduces the reported bug',
  /SIGNUP WENT THROUGH/.test(signup('h', 'Stale', 'stale@mc.com')),
  'this is what the user is most likely hitting');

const repair = sql('h', DIAG);
check('the diagnostic spots the out-of-date function',
  /تابع قدیمی است/.test(repair), repair.slice(0, 500));
check('the diagnostic runs without error', !repair.includes('PSQL_ERROR'),
  repair.slice(0, 400));
check('its built-in self-test passes', /تست موفق/.test(repair), repair.slice(-400));
check('after repair a closed signup is refused',
  /BLOCKED: REGISTRATION_CLOSED/.test(signup('h', 'Fixed', 'fixed@mc.com')));
check('the repair preserves the closed setting',
  /\n\s*f\s*\n/.test(sql('h', `select registration_open from public.app_settings where id = 1;`)));
check('the self-test leaves no test user behind',
  !/NxSelfTest/.test(sql('h', `select mc_username from public.profiles;`)));

// A missing trigger is the other way this breaks.
sql('i', SHIM);
sql('i', NEW);
sql('i', `drop trigger if exists on_auth_user_created on auth.users;`);
const recreate = sql('i', DIAG);
check('a missing trigger is detected',
  /تریگر ثبت‌نام وجود ندارد/.test(recreate), recreate.slice(0, 500));
check('and is put back', /تست موفق/.test(recreate), recreate.slice(-400));

/* ----------------------------------------------------------------
 * H. deleting a player for good
 *
 * Deleting only the profiles row is not enough: the auth.users row
 * would survive, the person could still log in and their email would
 * stay taken. These checks run against the real cascade chain
 *   auth.users -> profiles -> teams(owner) -> team_members
 * because that chain is what makes this operation dangerous.
 * ---------------------------------------------------------------- */
section('H. an admin can remove a player completely');

sql('j', SHIM);
sql('j', NEW);
sql('j', register('Boss', 'boss@mc.com'));
sql('j', `select public.make_admin('Boss');`);
sql('j', register('Plain', 'plain@mc.com'));

// a visitor must never reach this function
const anonTry = sql('j', `set role anon;
  do $$ begin perform public.admin_delete_player(gen_random_uuid());
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('an anonymous visitor cannot call it', /REFUSED/.test(anonTry), anonTry.slice(0, 200));

// a logged-in non-admin must be refused
const plainTry = sql('j', `${asUser('Plain')} set role authenticated;
  do $$ declare u uuid; begin
    select id into u from public.profiles where mc_username='Boss';
    perform public.admin_delete_player(u);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('a normal player cannot delete anyone',
  /REFUSED: NOT_ALLOWED/.test(plainTry), plainTry.slice(0, 300));
check('and the target is still there',
  /Boss/.test(sql('j', `select mc_username from public.profiles;`)));

// the happy path: a plain player with no team
const asBoss = `${asUser('Boss')} set role authenticated;`;
const gone = sql('j', `${asBoss}
  do $$ declare r json; u uuid; begin
    select id into u from public.profiles where mc_username='Plain';
    r := public.admin_delete_player(u);
    raise notice 'DELETED %', r->>'username';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('an admin can delete a plain player', /DELETED Plain/.test(gone), gone.slice(0, 300));
check('the profile row is gone',
  !/Plain/.test(sql('j', `select mc_username from public.profiles;`)));
check('the auth account is gone too',
  !/plain@mc\.com/.test(sql('j', `select email from auth.users;`)),
  'otherwise they could still log in and the email would stay taken');
check('their email can be used to register again',
  /ALLOWED/.test(sql('j', `do $$ begin
    insert into auth.users (email, raw_user_meta_data)
    values ('plain@mc.com', '{"mc_username":"PlainAgain"}'::jsonb);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`)));

// guards
const self = sql('j', `${asBoss}
  do $$ declare u uuid; begin
    select id into u from public.profiles where mc_username='Boss';
    perform public.admin_delete_player(u);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('an admin cannot delete their own account',
  /REFUSED: CANNOT_DELETE_SELF/.test(self), self.slice(0, 300));

sql('j', register('Other', 'other@mc.com'));
sql('j', `select public.make_admin('Other');`);
const otherAdmin = sql('j', `${asBoss}
  do $$ declare u uuid; begin
    select id into u from public.profiles where mc_username='Other';
    perform public.admin_delete_player(u);
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('one admin cannot delete another admin',
  /REFUSED: CANNOT_DELETE_ADMIN/.test(otherAdmin), otherAdmin.slice(0, 300));

const ghost = sql('j', `${asBoss}
  do $$ begin
    perform public.admin_delete_player('00000000-0000-0000-0000-000000000000');
    raise notice 'ALLOWED';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('deleting an unknown player says so',
  /REFUSED: PLAYER_NOT_FOUND/.test(ghost), ghost.slice(0, 300));

/* --- what happens to their team --------------------------------- */
sql('k', SHIM);
sql('k', NEW);
sql('k', register('Adm', 'adm@mc.com'));
sql('k', `select public.make_admin('Adm');`);
sql('k', register('Cap', 'cap@mc.com'));
sql('k', register('Mate', 'mate@mc.com'));
sql('k', register('Solo', 'solo@mc.com'));
const asAdm = `${asUser('Adm')} set role authenticated;`;

// Cap owns a team that Mate also belongs to
sql('k', `${asUser('Cap')} set role authenticated;
  insert into public.teams (name, owner_id)
  select 'Alpha', id from public.profiles where mc_username='Cap';
  reset role;`);
sql('k', `${asAdm}
  insert into public.team_members (team_id, user_id, is_leader)
  select t.id, p.id, false from public.teams t, public.profiles p
   where t.name='Alpha' and p.mc_username='Mate';
  reset role;`);
// Solo owns a team alone
sql('k', `${asUser('Solo')} set role authenticated;
  insert into public.teams (name, owner_id)
  select 'Lonely', id from public.profiles where mc_username='Solo';
  reset role;`);

const capGone = sql('k', `${asAdm}
  do $$ declare r json; u uuid; begin
    select id into u from public.profiles where mc_username='Cap';
    r := public.admin_delete_player(u);
    raise notice 'MOVED % NAMES %', r->>'teams_transferred', r->>'transferred_team_names';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('deleting a captain who has team-mates reports a transfer',
  /MOVED 1/.test(capGone), capGone.slice(0, 300));
check('the team survives',
  /Alpha/.test(sql('k', `select name from public.teams;`)),
  'the owner_id cascade would otherwise wipe the whole team');
check('the remaining member becomes the owner',
  /Mate/.test(sql('k', `select p.mc_username from public.teams t
    join public.profiles p on p.id = t.owner_id where t.name='Alpha';`)));
check('and is marked as leader',
  /t/.test(sql('k', `select tm.is_leader from public.team_members tm
    join public.profiles p on p.id = tm.user_id
    join public.teams t on t.id = tm.team_id
    where t.name='Alpha' and p.mc_username='Mate';`)));
check('the deleted captain is no longer a member',
  !/Cap/.test(sql('k', `select p.mc_username from public.team_members tm
    join public.profiles p on p.id=tm.user_id;`)));

const soloGone = sql('k', `${asAdm}
  do $$ declare r json; u uuid; begin
    select id into u from public.profiles where mc_username='Solo';
    r := public.admin_delete_player(u);
    raise notice 'DROPPED % NAMES %', r->>'teams_deleted', r->>'deleted_team_names';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;
  reset role;`);
check('deleting the only member of a team removes the team',
  /DROPPED 1/.test(soloGone), soloGone.slice(0, 300));
check('that team is really gone',
  !/Lonely/.test(sql('k', `select name from public.teams;`)));

// a plain member leaving must not disturb the team
const mateCount = sql('k', `select count(*) from public.team_members tm
  join public.teams t on t.id=tm.team_id where t.name='Alpha';`);
check('the surviving team still has its member', /1/.test(mateCount));

/* ---------------------------------------------------------------- */
section('I. the stand-alone add-delete-player.sql script');

// Someone who installed the schema before this round has a database with no
// admin_delete_player in it. That is exactly the database this script has to
// upgrade, so the test starts from one.
sql('m', SHIM);
sql('m', NEW);
sql('m', 'drop function if exists public.admin_delete_player(uuid);');
sql('m', register('Chief', 'chief@mc.com'));
sql('m', register('Doomed', 'doomed@mc.com'));
sql('m', `select public.make_admin('Chief');`);
// registration closed, to prove the script puts the setting back as it found it
sql('m', `update public.app_settings set registration_open = false where id = 1;`);

check('the function really is missing to begin with',
  sql('m', `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='admin_delete_player';`).includes('0'));

const APPLY = readFileSync(join(ROOT, 'supabase/add-delete-player.sql'), 'utf8');
const applied = sql('m', APPLY);
check('the script runs without errors', !applied.includes('PSQL_ERROR'),
  applied.slice(0, 500));
check('its built-in self-test passes', /تست موفق/.test(applied),
  applied.slice(-500));
check('the function exists afterwards',
  sql('m', `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='admin_delete_player';`).includes('1'));
check('the self-test leaves no rubbish behind',
  !sql('m', `select count(*) from public.profiles where mc_username='NxDelTest';`)
    .match(/\n\s*1\s*\n/));
check('and puts the registration setting back how it found it',
  /\n\s*f\s*\n/.test(sql('m', `select registration_open from public.app_settings where id=1;`)),
  'the script opens registration briefly to make its test account');

check('running it a second time is safe',
  !sql('m', APPLY).includes('PSQL_ERROR'));

// and the thing it installed actually works
const asChief = `do $$ declare uid uuid; begin
  select id into uid from public.profiles where mc_username='Chief';
  perform set_config('request.jwt.claim.sub', uid::text, false);
end $$; set role authenticated;`;
const used = sql('m', `${asChief}
  do $$ declare u uuid; r json; begin
    select id into u from public.profiles where mc_username='Doomed';
    r := public.admin_delete_player(u);
    raise notice 'GONE %', r->>'username';
  exception when others then raise notice 'REFUSED: %', sqlerrm; end $$;`);
check('an admin can then delete a player with it', /GONE Doomed/.test(used),
  used.slice(0, 300));
check('the player is gone for good',
  !sql('m', `select mc_username from public.profiles;`).includes('Doomed'));

console.log(`\n${fail ? '❌' : '🎉'} database tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
