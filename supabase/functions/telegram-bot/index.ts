/* ============================================================================
 * Netheraxia — ربات کد تأیید
 * ----------------------------------------------------------------------------
 * این تابع «راه دوم» تأیید عضویت است و برای وقتی ساخته شده که دکمه‌ی ورود
 * تلگرام در مرورگر کار نکند (که در ایران خیلی پیش می‌آید، چون سایت
 * telegram.org معمولاً باز نمی‌شود).
 *
 * منطقش ساده است: بازیکن داخل خود تلگرام — که برایش باز است — به ربات
 * /start می‌دهد. ربات چک می‌کند عضو گروه هست یا نه، و اگر بود یک کد ۶ رقمی
 * در همان چت خصوصی می‌فرستد. بازیکن کد را در سایت وارد می‌کند.
 *
 * چرا امن است؟ چون کد فقط و فقط در چت خصوصیِ همان حساب تلگرام فرستاده
 * می‌شود. اگر کسی کد را داشته باشد، یعنی واقعاً به آن حساب دسترسی دارد و
 * getChatMember هم قبلش تأیید کرده که عضو گروه است.
 *
 * راهنمای نصب: SETUP-TELEGRAM.md
 * ==========================================================================*/

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// رشته‌ی دلخواه برای اینکه فقط تلگرام بتواند این آدرس را صدا بزند
const HOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

const MEMBER_STATUSES = ["creator", "administrator", "member", "restricted"];

async function tg(method: string, body: unknown) {
  return await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null);
}

async function say(chatId: number, text: string) {
  await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

async function isMember(userId: number): Promise<boolean> {
  const r = await tg("getChatMember", { chat_id: CHAT_ID, user_id: userId });
  if (!r || r.ok !== true) return false;
  const st = String(r.result?.status ?? "");
  if (st === "restricted" && r.result?.is_member === false) return false;
  return MEMBER_STATUSES.includes(st);
}

/** کد ۶ رقمی با تصادفِ رمزنگاری‌شده (نه Math.random) */
function makeCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(b[0] % 900000 + 100000);
}

Deno.serve(async (req: Request) => {
  // تلگرام این هدر را با همان مقداری که موقع ثبت وبهوک داده‌ایم می‌فرستد
  if (HOOK_SECRET &&
      req.headers.get("x-telegram-bot-api-secret-token") !== HOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok");

  let update: any;
  try { update = await req.json(); } catch { return new Response("ok"); }

  const msg = update?.message;
  const text = String(msg?.text ?? "");
  const from = msg?.from;
  // فقط چت خصوصی؛ در گروه جواب نمی‌دهیم تا اسپم نشود
  if (!msg || !from || msg.chat?.type !== "private") return new Response("ok");

  if (!/^\/(start|code|کد)/i.test(text.trim())) {
    await say(msg.chat.id,
      "برای گرفتن کد تأیید، دستور /start را بفرست.");
    return new Response("ok");
  }

  if (!(await isMember(from.id))) {
    await say(msg.chat.id,
      "❌ تو هنوز عضو گروه نیستی.\n\n" +
      "اول در گروه عضو شو، بعد دوباره /start را بزن.");
    return new Response("ok");
  }

  const code = makeCode();
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 80);

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/telegram_codes`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      telegram_id: from.id,
      telegram_username: from.username ?? null,
      telegram_name: name || null,
    }),
  });

  if (!ins.ok) {
    await say(msg.chat.id, "⚠️ مشکلی پیش آمد. کمی بعد دوباره تلاش کن.");
    return new Response("ok");
  }

  await say(msg.chat.id,
    "✅ عضویتت تأیید شد.\n\n" +
    `کد تو: <code>${code}</code>\n\n` +
    "این کد را در سایت، در مرحله‌ی ۲ ثبت‌نام وارد کن.\n" +
    "⏱ تا ۱۰ دقیقه معتبر است.");

  return new Response("ok");
});
