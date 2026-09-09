-- ============================================================================
-- عیب‌یابی: «ثبت‌نام را بستم ولی هنوز کار می‌کند»
-- ----------------------------------------------------------------------------
-- این فایل را در SQL Editor سوپابیس اجرا کنید. چیزی را خراب نمی‌کند؛
-- فقط وضعیت را نشان می‌دهد و اگر ایرادی باشد، خودش درستش می‌کند.
-- ============================================================================

-- ۱) الان تنظیم روی چه چیزی است؟
select
    case when registration_open then '🔓 ثبت‌نام باز است'
         else '🔒 ثبت‌نام بسته است' end as وضعیت_ثبت‌نام,
    registration_open,
    updated_at as آخرین_تغییر
from public.app_settings where id = 1;

-- ۲) آیا تریگر ثبت‌نام اصلاً وجود دارد؟
--    اگر اینجا چیزی برنگردد، یعنی تریگر نصب نشده و هیچ‌چیز جلوی ثبت‌نام را
--    نمی‌گیرد — همان حالتی که «بستم ولی باز است» دیده می‌شود.
select
    case when count(*) = 0 then '❌ تریگر ثبت‌نام وجود ندارد!'
         else '✅ تریگر ثبت‌نام نصب است' end as وضعیت_تریگر
from pg_trigger
where tgname = 'on_auth_user_created' and not tgisinternal;

-- ۳) آیا خود تابع، تنظیم را چک می‌کند؟
select
    case when prosrc like '%REGISTRATION_CLOSED%'
         then '✅ تابع تنظیم را چک می‌کند'
         else '❌ تابع قدیمی است و تنظیم را نادیده می‌گیرد!' end as وضعیت_تابع
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'handle_new_user';

-- ============================================================================
-- ۴) تعمیر خودکار — تابع را به نسخه‌ی درست برمی‌گرداند
--    اگر از قبل درست بوده، هیچ ضرری ندارد.
-- ============================================================================
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

-- تریگر را هم دوباره وصل کن (اگر نبود، ساخته می‌شود)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

notify pgrst, 'reload schema';

-- ============================================================================
-- ۵) تست واقعی — با ثبت‌نام قلابی امتحان می‌کند که واقعاً بسته شده یا نه
--    کاربر آزمایشی بلافاصله پاک می‌شود.
-- ============================================================================
do $$
declare
    was_open boolean;
    blocked  boolean := false;
begin
    select registration_open into was_open from public.app_settings where id = 1;

    -- موقتاً ببند
    update public.app_settings set registration_open = false where id = 1;

    begin
        insert into auth.users (id, email, raw_user_meta_data)
        values (gen_random_uuid(), 'nx_selftest@example.invalid',
                '{"mc_username":"NxSelfTest"}'::jsonb);
    exception when others then
        if sqlerrm like '%REGISTRATION_CLOSED%' then blocked := true; end if;
    end;

    -- تمیزکاری
    delete from public.profiles where mc_username = 'NxSelfTest';
    delete from auth.users where email = 'nx_selftest@example.invalid';

    -- تنظیم را به حالت اولش برگردان
    update public.app_settings set registration_open = was_open where id = 1;

    if blocked then
        raise notice '✅ تست موفق: وقتی ثبت‌نام بسته باشد، دیتابیس جلوی آن را می‌گیرد.';
    else
        raise exception 'تست شکست خورد: با وجود بسته بودن، ثبت‌نام انجام شد.';
    end if;
end $$;

-- ============================================================================
-- نتیجه‌ی نهایی
-- ============================================================================
select '✅ همه‌چیز درست شد' as نتیجه,
       case when registration_open then '🔓 باز' else '🔒 بسته' end as ثبت‌نام_الان,
       'اگر می‌خواهید ببندید، از پنل مدیریت تیک را بردارید.' as توضیح
from public.app_settings where id = 1;
