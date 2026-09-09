/* ============================================================================
 * Netheraxia — بررسی عضویت در گروه تلگرام
 * ----------------------------------------------------------------------------
 * چرا این فایل لازم است؟
 *
 * بررسی عضویت تلگرام «حتماً» باید سمت سرور انجام شود:
 *
 *   ۱) توکن ربات یک کلید مخفی است. اگر داخل سایت بگذاریم، هر بازدیدکننده‌ای
 *      با View Source آن را برمی‌دارد و می‌تواند ربات را کامل تصاحب کند.
 *   ۲) هر چیزی که مرورگر بگوید قابل جعل است. اگر خود صفحه تصمیم بگیرد
 *      «این نفر عضو است»، کاربر می‌تواند همان درخواست را دستی بسازد.
 *
 * پس این تابع روی سرورهای سوپابیس اجرا می‌شود (نه در مرورگر) و:
 *   ۱) امضای دیتای ورود تلگرام را با توکن ربات چک می‌کند (جعل‌ناپذیر)
 *   ۲) تازه بودن آن را چک می‌کند (جلوگیری از replay)
 *   ۳) با getChatMember می‌پرسد این کاربر واقعاً عضو گروه هست یا نه
 *   ۴) اگر عضو بود، یک «بلیت» یک‌بارمصرف در دیتابیس می‌سازد
 *
 * بعد موقع ثبت‌نام، تریگر دیتابیس همان بلیت را طلب می‌کند. یعنی حتی اگر کسی
 * مستقیم با REST API ثبت‌نام کند، بدون بلیتِ معتبر رد می‌شود.
 *
 * راهنمای راه‌اندازی: SETUP-TELEGRAM.md
 * ==========================================================================*/

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// چند دقیقه بعد از ورود تلگرام، دیتا هنوز قابل قبول است
const MAX_AUTH_AGE_SECONDS = 15 * 60;

// وضعیت‌هایی که یعنی «عضو گروه است»
const MEMBER_STATUSES = ["creator", "administrator", "member", "restricted"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** مقایسه‌ی امن (زمان‌ثابت) تا از حمله‌ی زمان‌سنجی جلوگیری شود */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * الگوریتم رسمی تلگرام:
 *   secret_key      = SHA256(bot_token)                 ← بایتِ خام، نه hex
 *   data_check_str  = مرتب‌شده‌ی "key=value" با \n
 *   hash            = HMAC_SHA256(data_check_str, secret_key)
 */
async function checkTelegramSignature(
  data: Record<string, string>,
  hash: string,
): Promise<boolean> {
  const pairs = Object.keys(data)
    .filter((k) => k !== "hash" && data[k] !== "" && data[k] != null)
    .sort()
    .map((k) => `${k}=${data[k]}`);
  const dataCheckString = pairs.join("\n");

  const secretKey = await crypto.subtle.digest("SHA-256", enc.encode(BOT_TOKEN));
  const key = await crypto.subtle.importKey(
    "raw",
    secretKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(dataCheckString));
  return safeEqual(toHex(sig), String(hash).toLowerCase());
}

/** آیا این کاربر عضو گروه است؟ ربات باید در گروه ادمین باشد. */
async function isGroupMember(
  telegramId: number,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember` +
    `?chat_id=${encodeURIComponent(CHAT_ID)}&user_id=${telegramId}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (_e) {
    return { ok: false, error: "telegram_unreachable" };
  }

  const body = await res.json().catch(() => null);
  if (!body || body.ok !== true) {
    const desc = String(body?.description ?? "");
    // «کاربر پیدا نشد» یعنی هرگز عضو نبوده — این خطا نیست، جواب منفی است.
    if (/user not found|PARTICIPANT_ID_INVALID/i.test(desc)) {
      return { ok: false, status: "left" };
    }
    return { ok: false, error: desc || "telegram_error" };
  }

  const status = String(body.result?.status ?? "");
  // restricted فقط وقتی عضو است که is_member صریحاً true باشد
  if (status === "restricted" && body.result?.is_member === false) {
    return { ok: false, status: "left" };
  }
  return { ok: MEMBER_STATUSES.includes(status), status };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!BOT_TOKEN || !CHAT_ID) {
    return json({
      ok: false,
      code: "not_configured",
      message:
        "بررسی تلگرام روی سرور پیکربندی نشده است. مقدارهای TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID را در Edge Function Secrets بگذارید.",
    }, 200);
  }

  let payload: Record<string, string>;
  try {
    payload = await req.json();
  } catch (_e) {
    return json({ ok: false, code: "bad_request", message: "دیتای نامعتبر." }, 400);
  }

  const hash = String(payload?.hash ?? "");
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    return json({
      ok: false,
      code: "bad_signature",
      message: "دیتای ورود تلگرام معتبر نیست.",
    }, 200);
  }

  // ۱) امضا — ثابت می‌کند دیتا واقعاً از تلگرام آمده
  if (!(await checkTelegramSignature(payload, hash))) {
    return json({
      ok: false,
      code: "bad_signature",
      message: "امضای تلگرام معتبر نیست. دوباره از دکمه‌ی تلگرام وارد شوید.",
    }, 200);
  }

  // ۲) تازگی — جلوی استفاده‌ی دوباره از یک لینک قدیمی را می‌گیرد
  const authDate = Number(payload.auth_date ?? 0);
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || age > MAX_AUTH_AGE_SECONDS || age < -300) {
    return json({
      ok: false,
      code: "expired",
      message: "زمان تأیید تلگرام گذشته است. دوباره تلاش کنید.",
    }, 200);
  }

  const telegramId = Number(payload.id ?? 0);
  if (!telegramId) {
    return json({ ok: false, code: "bad_request", message: "شناسه‌ی تلگرام نامعتبر است." }, 200);
  }

  // ۳) عضویت واقعی در گروه
  const member = await isGroupMember(telegramId);
  if (member.error) {
    return json({
      ok: false,
      code: "telegram_error",
      message:
        "ارتباط با تلگرام برقرار نشد یا ربات در گروه ادمین نیست. به مدیر سرور اطلاع دهید.",
      detail: member.error,
    }, 200);
  }
  if (!member.ok) {
    return json({
      ok: false,
      code: "not_member",
      message: "شما هنوز عضو گروه تلگرام نیستید. اول در گروه عضو شوید، بعد دوباره تلاش کنید.",
    }, 200);
  }

  // ۴) بلیت یک‌بارمصرف؛ فقط این تابع (با کلید سرویس) می‌تواند بسازدش
  const displayName = [payload.first_name, payload.last_name]
    .filter(Boolean).join(" ").slice(0, 80);

  const insert = await fetch(`${SUPABASE_URL}/rest/v1/telegram_tickets`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify({
      telegram_id: telegramId,
      telegram_username: payload.username ?? null,
      telegram_name: displayName || null,
    }),
  });

  if (!insert.ok) {
    const text = await insert.text();
    return json({
      ok: false,
      code: "db_error",
      message:
        "جدول بلیت‌ها پیدا نشد. فایل supabase/schema.sql را دوباره در SQL Editor اجرا کنید.",
      detail: text.slice(0, 300),
    }, 200);
  }

  const rows = await insert.json();
  const ticket = Array.isArray(rows) ? rows[0] : rows;

  return json({
    ok: true,
    ticket: ticket?.token,
    telegram: {
      id: telegramId,
      username: payload.username ?? null,
      name: displayName || null,
    },
  });
});
