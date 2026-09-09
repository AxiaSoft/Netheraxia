-- ============================================================================
-- حذف کامل «بررسی عضویت تلگرام» از دیتابیس
-- ----------------------------------------------------------------------------
-- این فایل را فقط در صورتی اجرا کنید که قبلاً نسخه‌ی تلگرام‌دار اسکیما را
-- اجرا کرده باشید.
--
-- ⚠️ چرا لازم است؟
--    فایل‌های سایت به حالت قبل برگشتند، ولی چیزی که قبلاً در دیتابیس ساخته
--    شده خودبه‌خود پاک نمی‌شود. اگر تیک «عضویت تلگرام الزامی» روشن مانده
--    باشد، تریگر ثبت‌نام همچنان دنبال بلیت می‌گردد و هیچ‌کس نمی‌تواند
--    ثبت‌نام کند.
--
-- 📌 طرز استفاده:
--    ۱) داشبورد سوپابیس → SQL Editor
--    ۲) کل همین فایل را کپی و Run کنید
--    ۳) بعد از آن، یک‌بار هم فایل supabase/schema.sql را اجرا کنید
--
--    اطلاعات بازیکنان، تیم‌ها و تنظیمات دست‌نخورده می‌ماند.
-- ============================================================================

-- ۱) اول از همه: دروازه را خاموش کن تا ثبت‌نام همین حالا باز شود.
--    (اگر ستون وجود نداشته باشد یعنی از اول نصب نشده و کاری لازم نیست)
do $$ begin
    update public.app_settings set telegram_required = false where id = 1;
exception when undefined_column then
    raise notice 'ستون telegram_required وجود ندارد — چیزی برای خاموش کردن نبود.';
end $$;

-- ۲) تریگر ثبت‌نام را به نسخه‌ی ساده و بدون تلگرام برگردان.
--    این همان چیزی است که در schema.sql هم هست؛ اینجا تکرار می‌شود تا
--    ثبت‌نام بلافاصله درست شود، حتی قبل از اجرای دوباره‌ی schema.sql.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    s public.app_settings;
    uname text;
begin
    select * into s from public.app_settings where id = 1;
    if not s.registration_open then
        raise exception 'REGISTRATION_CLOSED';
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

    insert into public.profiles (id, mc_username, email)
    values (new.id, uname, new.email);
    return new;
end $$;

-- ۳) توابع و جدول‌های تلگرام را حذف کن
drop function if exists public.redeem_telegram_code(text);
drop function if exists public.telegram_ticket_valid(uuid);
drop table    if exists public.telegram_codes;
drop table    if exists public.telegram_tickets;

-- ۴) ستون‌های اضافه‌شده به تنظیمات را حذف کن
alter table public.app_settings
    drop column if exists telegram_required,
    drop column if exists telegram_group_url,
    drop column if exists telegram_bot_username,
    drop column if exists telegram_verify_url;

-- ۵) ستون‌های تلگرام روی پروفایل بازیکنان
drop index if exists public.profiles_telegram_uniq;
alter table public.profiles
    drop column if exists telegram_id,
    drop column if exists telegram_username;

-- ۶) public_config را به نسخه‌ی بدون تلگرام برگردان
create or replace function public.public_config()
returns json language sql stable security definer set search_path = public as $$
    select json_build_object(
        'max_teams',          s.max_teams,
        'max_members',        s.max_members,
        'registration_open',  s.registration_open,
        'team_creation_open', s.team_creation_open,
        'join_open',          s.join_open,
        'one_team_per_user',  s.one_team_per_user,
        'team_count',         (select count(*) from public.teams),
        'player_count',       (select count(*) from public.profiles),
        'member_count',       (select count(*) from public.team_members))
    from public.app_settings s where s.id = 1;
$$;

grant execute on function public.public_config() to anon, authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
-- ۷) تأیید نهایی — اگر این پیام را دیدید یعنی همه‌چیز پاک شد
-- ============================================================================
do $$
declare leftover text := '';
begin
    if to_regclass('public.telegram_tickets') is not null then
        leftover := leftover || ' telegram_tickets';
    end if;
    if to_regclass('public.telegram_codes') is not null then
        leftover := leftover || ' telegram_codes';
    end if;
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='app_settings'
                 and column_name='telegram_required') then
        leftover := leftover || ' app_settings.telegram_required';
    end if;
    if leftover <> '' then
        raise exception 'این موارد پاک نشدند:%', leftover;
    end if;
    raise notice '✅ بررسی تلگرام کاملاً حذف شد. ثبت‌نام دوباره عادی است.';
end $$;

select '✅ تلگرام حذف شد' as وضعیت,
       (select count(*) from public.profiles) as تعداد_بازیکن,
       (select registration_open from public.app_settings where id = 1) as ثبت‌نام_باز_است;
