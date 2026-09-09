-- ============================================================================
--  Netheraxia — حساب بازیکنان و سیستم تیم‌ها
--  این فایل را در Supabase → SQL Editor اجرا کنید (یک‌بار، کامل).
--  اجرای دوباره‌اش هم بی‌خطر است (idempotent).
-- ============================================================================

create extension if not exists pgcrypto;

-- نسخه‌ی قدیمی این تابع (تک‌آرگومانی) ایمیل را لو می‌داد؛ حذفش می‌کنیم
drop function if exists public.email_for_login(text);

-- ============================================================================
-- ۱) تنظیمات کلی — از پنل مدیریت قابل تغییر است
-- ============================================================================
create table if not exists public.app_settings (
    id                 int primary key default 1,
    max_teams          int     not null default 10,
    max_members        int     not null default 10,
    registration_open  boolean not null default true,   -- ثبت‌نام بازیکن جدید
    team_creation_open boolean not null default true,   -- ساخت تیم جدید
    join_open          boolean not null default true,   -- عضو شدن در تیم
    one_team_per_user  boolean not null default true,   -- هر بازیکن فقط یک تیم
    updated_at         timestamptz not null default now(),
    constraint app_settings_singleton check (id = 1),
    constraint app_settings_sane check (max_teams between 1 and 500
                                    and max_members between 1 and 500)
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- تنظیمات گروه تلگرام (اگر قبلاً اسکیما را اجرا کرده‌اید، این ستون‌ها اضافه می‌شوند)
alter table public.app_settings
    add column if not exists telegram_required      boolean not null default false,
    add column if not exists telegram_group_url     text    not null default '',
    add column if not exists telegram_bot_username  text    not null default '',
    add column if not exists telegram_verify_url    text    not null default '';

-- ============================================================================
-- ۲) پروفایل بازیکن — به auth.users وصل است
-- ============================================================================
create table if not exists public.profiles (
    id          uuid primary key references auth.users(id) on delete cascade,
    mc_username text not null,
    email       text,
    is_admin    boolean not null default false,
    is_banned   boolean not null default false,
    created_at  timestamptz not null default now()
);

do $$ begin
    alter table public.profiles add constraint profiles_username_format
        check (mc_username ~ '^[A-Za-z0-9_]{3,16}$');
exception when duplicate_object then null; end $$;

-- حساب تلگرامی که موقع ثبت‌نام تأیید شده است
alter table public.profiles
    add column if not exists telegram_id       bigint,
    add column if not exists telegram_username text;

-- هر حساب تلگرام فقط یک بازیکن (جلوگیری از چند حسابه)
create unique index if not exists profiles_telegram_uniq
    on public.profiles (telegram_id) where telegram_id is not null;

-- نام ماینکرفتی بدون توجه به بزرگی/کوچکی حروف یکتاست
create unique index if not exists profiles_username_uniq
    on public.profiles (lower(mc_username));

-- ============================================================================
-- ۲.۵) بلیت عضویت تلگرام
--     Edge Function بعد از اینکه با getChatMember مطمئن شد طرف واقعاً عضو
--     گروه است، اینجا یک بلیت یک‌بارمصرف می‌سازد. موقع ثبت‌نام همین بلیت
--     مصرف می‌شود.
--
--     چرا بلیت؟ چون اگر فقط مرورگر بگوید «تأیید شد»، کاربر می‌تواند مستقیم
--     به REST API درخواست بدهد و مرحله را رد کند. بلیت را فقط سرور می‌سازد.
-- ============================================================================
create table if not exists public.telegram_tickets (
    token             uuid primary key default gen_random_uuid(),
    telegram_id       bigint      not null,
    telegram_username text,
    telegram_name     text,
    created_at        timestamptz not null default now(),
    used_at           timestamptz,
    used_by           uuid references auth.users(id) on delete set null
);

create index if not exists telegram_tickets_tg_id on public.telegram_tickets (telegram_id);

-- بلیت ۳۰ دقیقه اعتبار دارد
create or replace function public.telegram_ticket_valid(p_token uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.telegram_tickets t
        where t.token = p_token
          and t.used_at is null
          and t.created_at > now() - interval '30 minutes');
$$;

-- ============================================================================
-- ۳) تیم‌ها
-- ============================================================================
create table if not exists public.teams (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    description text,
    emoji       text default '🛡️',
    flag        text,                      -- تصویر پرچم به صورت data URL (base64)
    color       text default '#2f86ff',
    owner_id    uuid not null references public.profiles(id) on delete cascade,
    created_at  timestamptz not null default now()
);

-- برای پروژه‌هایی که جدول را قبلاً ساخته‌اند
alter table public.teams add column if not exists flag text;

do $$ begin
    alter table public.teams add constraint teams_flag_size
        check (flag is null or char_length(flag) <= 400000);   -- ~۳۰۰ کیلوبایت
exception when duplicate_object then null; end $$;

do $$ begin
    alter table public.teams add constraint teams_name_len
        check (char_length(btrim(name)) between 2 and 24);
exception when duplicate_object then null; end $$;

create unique index if not exists teams_name_uniq on public.teams (lower(btrim(name)));

create table if not exists public.team_members (
    team_id   uuid not null references public.teams(id) on delete cascade,
    user_id   uuid not null references public.profiles(id) on delete cascade,
    is_leader boolean not null default false,
    joined_at timestamptz not null default now(),
    primary key (team_id, user_id)
);
create index if not exists team_members_user_idx on public.team_members (user_id);

-- ============================================================================
-- ۴) توابع کمکی
-- ============================================================================
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- ساخت خودکار پروفایل هنگام ثبت‌نام
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    s public.app_settings;
    uname text;
    tkt   text;
    trow  public.telegram_tickets;
begin
    select * into s from public.app_settings where id = 1;
    if not s.registration_open then
        raise exception 'REGISTRATION_CLOSED';
    end if;

    -- ── دروازه‌ی تلگرام ──────────────────────────────────────────────────
    -- اگر مدیر «عضویت در گروه تلگرام الزامی است» را روشن کرده باشد، ثبت‌نام
    -- فقط با بلیتی انجام می‌شود که Edge Function بعد از getChatMember ساخته.
    -- این چک اینجاست (نه در مرورگر) تا حتی درخواست مستقیم به API هم رد شود.
    if s.telegram_required then
        tkt := btrim(coalesce(new.raw_user_meta_data->>'telegram_ticket', ''));
        if tkt = '' then
            raise exception 'TELEGRAM_REQUIRED';
        end if;

        begin
            select * into trow from public.telegram_tickets
            where token = tkt::uuid for update;
        exception when invalid_text_representation then
            raise exception 'TELEGRAM_TICKET_INVALID';
        end;

        if trow.token is null then
            raise exception 'TELEGRAM_TICKET_INVALID';
        end if;
        if trow.used_at is not null then
            raise exception 'TELEGRAM_TICKET_USED';
        end if;
        if trow.created_at < now() - interval '30 minutes' then
            raise exception 'TELEGRAM_TICKET_EXPIRED';
        end if;
        if exists (select 1 from public.profiles p
                   where p.telegram_id = trow.telegram_id) then
            raise exception 'TELEGRAM_ALREADY_USED';
        end if;

        -- بلیت مصرف شد؛ دیگر قابل استفاده‌ی دوباره نیست
        update public.telegram_tickets
           set used_at = now(), used_by = new.id
         where token = trow.token;
    end if;

    uname := btrim(coalesce(new.raw_user_meta_data->>'mc_username', ''));
    if uname = '' then
        raise exception 'USERNAME_REQUIRED';
    end if;
    if uname !~ '^[A-Za-z0-9_]{3,16}$' then
        raise exception 'USERNAME_INVALID';
    end if;
    if exists (select 1 from public.profiles p where lower(p.mc_username) = lower(uname)) then
        raise exception 'USERNAME_TAKEN';
    end if;

    insert into public.profiles (id, mc_username, email, telegram_id, telegram_username)
    values (new.id, uname, new.email, trow.telegram_id, trow.telegram_username);
    return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ============================================================================
-- ۵) محدودیت‌ها — سمت دیتابیس، غیرقابل دور زدن از مرورگر
-- ============================================================================
create or replace function public.enforce_team_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.app_settings; n int;
begin
    select * into s from public.app_settings where id = 1;

    if not s.team_creation_open and not public.is_admin() then
        raise exception 'TEAM_CREATION_CLOSED';
    end if;

    select count(*) into n from public.teams;
    if n >= s.max_teams then
        raise exception 'MAX_TEAMS_REACHED';
    end if;

    if exists (select 1 from public.profiles p where p.id = new.owner_id and p.is_banned) then
        raise exception 'BANNED';
    end if;

    if s.one_team_per_user then
        select count(*) into n from public.team_members tm where tm.user_id = new.owner_id;
        if n > 0 then
            raise exception 'ALREADY_IN_TEAM';
        end if;
    end if;

    new.name := btrim(new.name);
    return new;
end $$;

drop trigger if exists trg_teams_limits on public.teams;
create trigger trg_teams_limits
    before insert on public.teams
    for each row execute function public.enforce_team_limits();

-- سازنده‌ی تیم خودکار کاپیتان می‌شود
create or replace function public.add_owner_as_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.team_members (team_id, user_id, is_leader)
    values (new.id, new.owner_id, true)
    on conflict do nothing;
    return new;
end $$;

drop trigger if exists trg_teams_owner_member on public.teams;
create trigger trg_teams_owner_member
    after insert on public.teams
    for each row execute function public.add_owner_as_member();

create or replace function public.enforce_member_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.app_settings; n int; team_owner uuid;
begin
    select * into s from public.app_settings where id = 1;
    select t.owner_id into team_owner from public.teams t where t.id = new.team_id;

    -- افزوده‌شدن خودِ سازنده هنگام ساخت تیم، مشمول سوییچ «عضویت» نیست
    if new.user_id <> team_owner and not s.join_open and not public.is_admin() then
        raise exception 'JOIN_CLOSED';
    end if;

    if exists (select 1 from public.profiles p where p.id = new.user_id and p.is_banned) then
        raise exception 'BANNED';
    end if;

    select count(*) into n from public.team_members tm where tm.team_id = new.team_id;
    if n >= s.max_members then
        raise exception 'TEAM_FULL';
    end if;

    if s.one_team_per_user then
        select count(*) into n from public.team_members tm where tm.user_id = new.user_id;
        if n > 0 then
            raise exception 'ALREADY_IN_TEAM';
        end if;
    end if;

    return new;
end $$;

drop trigger if exists trg_members_limits on public.team_members;
create trigger trg_members_limits
    before insert on public.team_members
    for each row execute function public.enforce_member_limits();

-- کاپیتان نمی‌تواند تیم را ترک کند؛ باید تیم را حذف کند یا کاپیتانی را واگذار کند
create or replace function public.protect_owner_membership()
returns trigger language plpgsql security definer set search_path = public as $$
declare team_owner uuid;
begin
    select t.owner_id into team_owner from public.teams t where t.id = old.team_id;
    -- تیم قبلاً حذف شده (حذف آبشاری) → جلوی حذف عضو را نگیر
    if team_owner is null then return old; end if;
    if old.user_id = team_owner and not public.is_admin() then
        raise exception 'OWNER_CANNOT_LEAVE';
    end if;
    return old;
end $$;

drop trigger if exists trg_members_protect_owner on public.team_members;
create trigger trg_members_protect_owner
    before delete on public.team_members
    for each row execute function public.protect_owner_membership();

-- ============================================================================
-- ۶) نمای عمومی تیم‌ها — بدون افشای ایمیل بازیکنان
-- ============================================================================
drop view if exists public.teams_public;
create view public.teams_public
with (security_invoker = false) as
select
    t.id,
    t.name,
    t.description,
    t.emoji,
    t.flag,
    t.color,
    t.created_at,
    t.owner_id,
    (select p.mc_username from public.profiles p where p.id = t.owner_id) as owner_name,
    coalesce((
        select json_agg(json_build_object(
                   'user_id',   tm.user_id,
                   'name',      p.mc_username,
                   'is_leader', tm.is_leader,
                   'joined_at', tm.joined_at)
               order by tm.is_leader desc, tm.joined_at)
        from public.team_members tm
        join public.profiles p on p.id = tm.user_id
        where tm.team_id = t.id
    ), '[]'::json) as members,
    (select count(*) from public.team_members tm where tm.team_id = t.id) as member_count
from public.teams t;

grant select on public.teams_public to anon, authenticated;

-- ============================================================================
-- ۷) RPCها
-- ============================================================================

-- آیا این نام ماینکرفتی آزاد است؟
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = public as $$
    select btrim(coalesce(p_username, '')) ~ '^[A-Za-z0-9_]{3,16}$'
       and not exists (
           select 1 from public.profiles p
           where lower(p.mc_username) = lower(btrim(p_username)));
$$;

-- ورود با نام ماینکرفتی.
-- ایمیل فقط وقتی برگردانده می‌شود که رمز عبور هم درست باشد؛ در غیر این صورت
-- null. این کار جلوی جمع‌آوری ایمیل بازیکنان از روی نام کاربری را می‌گیرد.
create or replace function public.email_for_login(p_login text, p_password text default null)
returns text language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare v text; res text; uid uuid;
begin
    v := btrim(coalesce(p_login, ''));
    if v = '' then return null; end if;
    if position('@' in v) > 0 then return v; end if;   -- خودش ایمیل است

    select p.id into uid from public.profiles p
      where lower(p.mc_username) = lower(v) and not p.is_banned;
    if uid is null then return null; end if;
    if p_password is null or p_password = '' then return null; end if;

    -- تأیید رمز عبور داخل دیتابیس؛ رمز هرگز جایی ذخیره یا لاگ نمی‌شود
    select u.email into res from auth.users u
      where u.id = uid
        and u.encrypted_password = crypt(p_password, u.encrypted_password);
    return res;
end $$;

-- تنظیمات + آمار، در یک درخواست
create or replace function public.public_config()
returns json language sql stable security definer set search_path = public as $$
    select json_build_object(
        'max_teams',          s.max_teams,
        'max_members',        s.max_members,
        'registration_open',  s.registration_open,
        'team_creation_open', s.team_creation_open,
        'join_open',          s.join_open,
        'one_team_per_user',  s.one_team_per_user,
        'telegram_required',     s.telegram_required,
        'telegram_group_url',    s.telegram_group_url,
        'telegram_bot_username', s.telegram_bot_username,
        'telegram_verify_url',   s.telegram_verify_url,
        'team_count',         (select count(*) from public.teams),
        'player_count',       (select count(*) from public.profiles),
        'member_count',       (select count(*) from public.team_members))
    from public.app_settings s where s.id = 1;
$$;

-- تیم من (اگر عضو تیمی باشم)
create or replace function public.my_membership()
returns json language sql stable security definer set search_path = public as $$
    select coalesce((
        select json_build_object('team_id', tm.team_id, 'is_leader', tm.is_leader,
                                 'team_name', t.name)
        from public.team_members tm join public.teams t on t.id = tm.team_id
        where tm.user_id = auth.uid() limit 1), 'null'::json);
$$;

-- واگذاری کاپیتانی به یکی از اعضا
create or replace function public.transfer_leadership(p_team_id uuid, p_new_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare team_owner uuid;
begin
    select t.owner_id into team_owner from public.teams t where t.id = p_team_id;
    if team_owner is null then raise exception 'TEAM_NOT_FOUND'; end if;
    if team_owner <> auth.uid() and not public.is_admin() then
        raise exception 'NOT_ALLOWED';
    end if;
    if not exists (select 1 from public.team_members tm
                   where tm.team_id = p_team_id and tm.user_id = p_new_owner) then
        raise exception 'NOT_A_MEMBER';
    end if;
    update public.teams set owner_id = p_new_owner where id = p_team_id;
    update public.team_members set is_leader = (user_id = p_new_owner) where team_id = p_team_id;
end $$;

grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.email_for_login(text, text) to anon, authenticated;
grant execute on function public.public_config()          to anon, authenticated;
grant execute on function public.my_membership()          to authenticated;
grant execute on function public.transfer_leadership(uuid, uuid) to authenticated;

-- ============================================================================
-- ۸) RLS — چه کسی اجازه‌ی چه کاری دارد
-- ============================================================================
alter table public.profiles          enable row level security;
alter table public.teams             enable row level security;
alter table public.team_members      enable row level security;
alter table public.app_settings      enable row level security;
alter table public.telegram_tickets  enable row level security;
-- هیچ policyای برای telegram_tickets تعریف نمی‌شود ⇒ هیچ کاربر عادی‌ای
-- (نه anon نه authenticated) نمی‌تواند بخواند یا بنویسد. کلید سرویس RLS را
-- دور می‌زند، پس Edge Function کار می‌کند.

drop policy if exists profiles_select   on public.profiles;
drop policy if exists profiles_update   on public.profiles;
drop policy if exists profiles_admin_all on public.profiles;
-- نام بازیکنان عمومی است (برای نمایش اعضای تیم لازم است)؛
-- ایمیل از طریق نمای teams_public افشا نمی‌شود.
create policy profiles_select on public.profiles
    for select using (true);
create policy profiles_update on public.profiles
    for update using (id = auth.uid() or public.is_admin())
    with check (id = auth.uid() or public.is_admin());
create policy profiles_admin_all on public.profiles
    for delete using (public.is_admin());

-- کاربر عادی نمی‌تواند خودش را ادمین یا آنبن کند.
--
-- نکته‌ی مهم: تریگرها برای «همه» اجرا می‌شوند — حتی برای کاربر postgres در
-- SQL Editor. در نسخه‌ی قبلی همین تریگر باعث می‌شد دستور «خودم را ادمین کن»
-- بی‌سروصدا بی‌اثر بماند: پستگرس آن را اجرا می‌کرد، تریگر مقدار را به false
-- برمی‌گرداند و هیچ خطایی هم نمی‌داد. برای همین اولین ادمین هرگز ساخته نمی‌شد.
--
-- حالا فقط درخواست‌هایی که از طرف یک «کاربرِ وارد شده» می‌آیند محدود می‌شوند.
-- auth.uid() فقط وقتی مقدار دارد که درخواست از مرورگر با توکن کاربر بیاید؛
-- در SQL Editor و با service_role مقدارش null است، پس راه‌اندازی اولیه باز است.
-- (کاربر anon هم auth.uid() ندارد، ولی RLS اصلاً اجازه‌ی UPDATE به او نمی‌دهد.)
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null or public.is_admin() then
        return new;             -- SQL Editor / service_role / ادمین
    end if;
    new.is_admin  := old.is_admin;
    new.is_banned := old.is_banned;
    new.id        := old.id;
    return new;
end $$;
drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard
    before update on public.profiles
    for each row execute function public.guard_profile_update();

drop policy if exists teams_select on public.teams;
drop policy if exists teams_insert on public.teams;
drop policy if exists teams_update on public.teams;
drop policy if exists teams_delete on public.teams;
create policy teams_select on public.teams for select using (true);
create policy teams_insert on public.teams for insert to authenticated
    with check (owner_id = auth.uid());
create policy teams_update on public.teams for update
    using (owner_id = auth.uid() or public.is_admin())
    with check (owner_id = auth.uid() or public.is_admin());
create policy teams_delete on public.teams for delete
    using (owner_id = auth.uid() or public.is_admin());

drop policy if exists members_select on public.team_members;
drop policy if exists members_insert on public.team_members;
drop policy if exists members_delete on public.team_members;
drop policy if exists members_update on public.team_members;
create policy members_select on public.team_members for select using (true);
-- عضویت آزاد: هرکس خودش را اضافه می‌کند (ادمین هم می‌تواند)
create policy members_insert on public.team_members for insert to authenticated
    with check (user_id = auth.uid() or public.is_admin());
-- خروج خود بازیکن، اخراج توسط کاپیتان، یا حذف توسط ادمین
create policy members_delete on public.team_members for delete
    using (user_id = auth.uid()
        or public.is_admin()
        or exists (select 1 from public.teams t
                   where t.id = team_id and t.owner_id = auth.uid()));
create policy members_update on public.team_members for update
    using (public.is_admin()
        or exists (select 1 from public.teams t
                   where t.id = team_id and t.owner_id = auth.uid()));

drop policy if exists settings_select on public.app_settings;
drop policy if exists settings_update on public.app_settings;
create policy settings_select on public.app_settings for select using (true);
create policy settings_update on public.app_settings for update
    using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- ۹) دسترسی جدول‌ها (GRANT)
--     پستگرس اول GRANT را چک می‌کند و بعد RLS. بدون این بخش، حتی با وجود
--     policyها، خواندن جدول‌ها رد می‌شود و پروفایل خالی می‌ماند.
-- ============================================================================
grant usage on schema public to anon, authenticated;

grant select                         on public.profiles     to anon, authenticated;
grant update                         on public.profiles     to authenticated;
grant select                         on public.teams        to anon, authenticated;
grant insert, update, delete         on public.teams        to authenticated;
grant select                         on public.team_members to anon, authenticated;
grant insert, update, delete         on public.team_members to authenticated;
grant select                         on public.app_settings to anon, authenticated;
grant update                         on public.app_settings to authenticated;

-- جدول بلیت‌ها عمداً به anon/authenticated داده نمی‌شود: فقط Edge Function
-- (با کلید سرویس) می‌نویسد و فقط تریگر ثبت‌نام (security definer) می‌خواند.
-- اگر مرورگر می‌توانست بلیت بسازد، کل دروازه بی‌معنی می‌شد.
revoke all on public.telegram_tickets from anon, authenticated;
grant execute on function public.telegram_ticket_valid(uuid) to anon, authenticated;

-- ============================================================================
-- ۱۰) تازه‌سازی کش اسکیمای PostgREST
--     بدون این، ستون‌های تازه‌اضافه‌شده (مثل teams.flag) با خطای
--     «Could not find the 'flag' column ... in the schema cache» رد می‌شوند.
-- ============================================================================
notify pgrst, 'reload schema';

-- ============================================================================
-- ۱۱) ادمین کردن خودتان
-- ============================================================================
-- تابع زیر برخلاف UPDATE ساده، اگر بازیکن پیدا نشود خطای واضح می‌دهد؛
-- پس دیگر «اجرا شد ولی هیچ اتفاقی نیفتاد» پیش نمی‌آید.
create or replace function public.make_admin(p_username text)
returns text language plpgsql security definer set search_path = public as $$
declare n int;
begin
    update public.profiles
       set is_admin = true
     where lower(mc_username) = lower(btrim(p_username));
    get diagnostics n = row_count;
    if n = 0 then
        raise exception
            'بازیکنی با نام «%» پیدا نشد. اول در خود سایت ثبت‌نام کنید، بعد این را اجرا کنید. برای دیدن نام‌های ثبت‌شده: select mc_username from public.profiles;', p_username;
    end if;
    return 'انجام شد — «' || btrim(p_username) || '» حالا ادمین است.';
end $$;

-- پستگرس به‌صورت پیش‌فرض اجرای توابع را به همه می‌دهد؛ این یکی نباید از
-- مرورگر قابل صدا زدن باشد، وگرنه هر بازیکنی می‌تواند خودش را ادمین کند.
revoke execute on function public.make_admin(text) from public;
revoke execute on function public.make_admin(text) from anon, authenticated;

-- ============================================================================
-- طرز استفاده (در SQL Editor):
--   ۱) ببینید چه کسانی ثبت‌نام کرده‌اند:
--        select mc_username, email, is_admin from public.profiles order by created_at;
--   ۲) خودتان را ادمین کنید — نام را دقیقاً از خروجی بالا بردارید:
--        select public.make_admin('YourMinecraftName');
--   ۳) بررسی کنید:
--        select mc_username, is_admin from public.profiles where is_admin;
--   بعد در پنل مدیریت یک‌بار خروج و دوباره ورود بزنید.
-- ============================================================================

-- ============================================================================
-- ۱۲) تأیید نهایی — این پیام یعنی فایل تا آخر اجرا شد
--     اگر این خروجی را نمی‌بینید، یعنی فایل کامل اجرا نشده و
--     make_admin هم ساخته نشده است.
-- ============================================================================
do $$
declare missing text := '';
begin
    if to_regprocedure('public.make_admin(text)') is null then
        missing := missing || ' make_admin';
    end if;
    if to_regclass('public.teams') is null then
        missing := missing || ' teams';
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='teams'
                     and column_name='flag') then
        missing := missing || ' teams.flag';
    end if;
    if to_regclass('public.telegram_tickets') is null then
        missing := missing || ' telegram_tickets';
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='app_settings'
                     and column_name='telegram_required') then
        missing := missing || ' app_settings.telegram_required';
    end if;
    if missing <> '' then
        raise exception 'اسکیما ناقص اجرا شد. این موارد ساخته نشدند:%', missing;
    end if;
    raise notice '✅ اسکیما کامل اجرا شد. حالا این را اجرا کنید: select public.make_admin(''نام_ماینکرفت_شما'');';
end $$;

select '✅ اسکیما کامل نصب شد' as وضعیت,
       (select count(*) from public.profiles) as تعداد_بازیکن,
       (select count(*) from public.profiles where is_admin) as تعداد_ادمین,
       coalesce((select string_agg(mc_username, '، ')
                 from public.profiles where is_admin), '— هیچ ادمینی نیست —') as ادمین‌ها;
