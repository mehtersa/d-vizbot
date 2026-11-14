// Döviz / Altın / BIST uyarı botu - Cloudflare Worker
// Komutlar Telegram'dan verilir, fiyatlar her 5 dakikada kontrol edilir.
//
// Gerekli gizli değişkenler (Settings > Variables and Secrets):
//   TELEGRAM_TOKEN  : BotFather'dan aldığın token
//   WEBHOOK_SECRET  : kendi uydurduğun rastgele harf/rakam dizisi (A-Z a-z 0-9 _ -)
//   OWNER_CHAT_ID   : senin Telegram chat ID'n (bot ilk mesajda söyler)

import { DurableObject } from "cloudflare:workers";

const MAX_ALERTS = 20;
const OUNCE_GRAMS = 31.1035;

// ---------- Semboller ----------
const KNOWN = {
  USD: { y: "USDTRY=X", label: "Dolar/TL", d: 4 },
  EUR: { y: "EURTRY=X", label: "Euro/TL", d: 4 },
  GBP: { y: "GBPTRY=X", label: "Sterlin/TL", d: 4 },
  ONS: { y: "GC=F", label: "Ons altın ($)", d: 2 },
  GRAM: { derived: true, label: "Gram altın (TL)", d: 2 },
  BIST100: { y: "XU100.IS", label: "BIST 100", d: 2 },
};
const ALIASES = {
  DOLAR: "USD", USDTRY: "USD", EURO: "EUR", EURTRY: "EUR", STERLIN: "GBP",
  ALTIN: "GRAM", GRAMALTIN: "GRAM", XAU: "ONS", BIST: "BIST100", XU100: "BIST100",
};

function resolveSymbol(input) {
  let s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (ALIASES[s]) s = ALIASES[s];
  if (KNOWN[s]) return { key: s, ...KNOWN[s] };
  if (/^[A-Z0-9]{2,8}$/.test(s)) return { key: s, y: `${s}.IS`, label: `${s} (BIST)`, d: 2 };
  return null;
}

// ---------- Fiyat çekme (Yahoo Finance, resmi olmayan uç) ----------
function yahooPrice(sym, cache) {
  if (!cache.has(sym)) {
    cache.set(
      sym,
      (async () => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) throw new Error(`${sym}: HTTP ${r.status}`);
        const j = await r.json();
        const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (typeof p !== "number" || !isFinite(p)) throw new Error(`${sym}: fiyat yok`);
        return p;
      })()
    );
  }
  return cache.get(sym);
}

async function priceOf(info, cache) {
  if (info.derived) {
    // Gram altın = ons fiyatı / 31,1035 x dolar kuru (yaklaşık, serbest piyasadan farklı olabilir)
    const [oz, usd] = await Promise.all([yahooPrice("GC=F", cache), yahooPrice("USDTRY=X", cache)]);
    return (oz / OUNCE_GRAMS) * usd;
  }
  return yahooPrice(info.y, cache);
}

function fmt(n, d) {
  try {
    return n.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
  } catch (_) {
    return n.toFixed(d);
  }
}

// ---------- Uyarıların saklandığı Durable Object ----------
export class Store extends DurableObject {
  async list() {
    return (await this.ctx.storage.get("alerts")) || [];
  }
  async add(a) {
    const alerts = await this.list();
    if (alerts.length >= MAX_ALERTS) return { error: "limit" };
    const id = ((await this.ctx.storage.get("seq")) || 0) + 1;
    const alert = { ...a, id };
    alerts.push(alert);
    await this.ctx.storage.put({ alerts, seq: id });
    return { alert };
  }
  async removeAt(index) {
    const alerts = await this.list();
    if (index < 0 || index >= alerts.length) return null;
    const [removed] = alerts.splice(index, 1);
    await this.ctx.storage.put("alerts", alerts);
    return removed;
  }
  async removeIds(ids) {
    const set = new Set(ids);
    const alerts = (await this.list()).filter((a) => !set.has(a.id));
    await this.ctx.storage.put("alerts", alerts);
  }
}

const getStore = (env) => env.STORE.get(env.STORE.idFromName("main"));

// ---------- Telegram ----------
async function say(env, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return r.ok;
}

const HELP = `Döviz / Altın / BIST uyarı botu

/ekle SEMBOL üstünde|altında DEĞER
  /ekle USD üstünde 45
  /ekle GRAM altında 4500
  /ekle THYAO üstünde 320
/liste : kurulu uyarılar
/sil NO : uyarıyı sil
/fiyat [SEMBOL ...] : anlık fiyatlar

Hazır semboller: USD, EUR, GBP, GRAM, ONS, BIST100
Başka kodlar BIST hissesi sayılır (THYAO, ASELS, ...).
Uyarı tetiklenince bir kez haber verir ve silinir.
BIST verisi gecikmeli olabilir.`;

const norm = (t) =>
  t.toLowerCase().replace(/ü/g, "u").replace(/ı/g, "i").replace(/ş/g, "s")
    .replace(/ö/g, "o").replace(/ç/g, "c").replace(/ğ/g, "g");

function parseDir(tok) {
  const t = norm(tok || "");
  if ([">", "ustunde", "ustu", "ustune", "yukari", "up", "above"].includes(t)) return "up";
  if (["<", "altinda", "alti", "altina", "asagi", "down", "below"].includes(t)) return "down";
  return null;
}

async function handleMessage(env, msg) {
  const chatId = String(msg.chat.id);
  if (!env.OWNER_CHAT_ID || chatId !== String(env.OWNER_CHAT_ID)) {
    await say(env, chatId, `Bu bot özeldir. Chat ID'n: ${chatId}\n(Sahibiysen bunu OWNER_CHAT_ID olarak kaydet.)`);
    return;
  }

  const parts = (msg.text || "").trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase().replace(/@.*$/, "");
  const store = getStore(env);

  if (cmd === "/start" || cmd === "/yardim" || cmd === "/help") {
    return void (await say(env, chatId, HELP));
  }

  if (cmd === "/fiyat") {
    const names = parts.length > 1 ? parts.slice(1) : ["USD", "EUR", "GRAM", "ONS", "BIST100"];
    const cache = new Map();
    const lines = await Promise.all(
      names.slice(0, 10).map(async (n) => {
        const info = resolveSymbol(n);
        if (!info) return `${n}: geçersiz sembol`;
        try {
          return `${info.label}: ${fmt(await priceOf(info, cache), info.d)}`;
        } catch (_) {
          return `${info.label}: fiyat alınamadı`;
        }
      })
    );
    return void (await say(env, chatId, lines.join("\n")));
  }

  if (cmd === "/liste") {
    const alerts = await store.list();
    if (!alerts.length) return void (await say(env, chatId, "Kurulu uyarı yok. /ekle ile ekleyebilirsin."));
    const lines = alerts.map((a, i) => {
      const info = resolveSymbol(a.key);
      return `${i + 1}. ${info ? info.label : a.key} ${a.dir === "up" ? "≥" : "≤"} ${fmt(a.value, info ? info.d : 2)}`;
    });
    return void (await say(env, chatId, lines.join("\n") + "\n\nSilmek için: /sil NO"));
  }

  if (cmd === "/sil") {
    const n = parseInt(parts[1], 10);
    if (!n) return void (await say(env, chatId, "Kullanım: /sil NO (numarayı /liste'den bak)"));
    const removed = await store.removeAt(n - 1);
    return void (await say(env, chatId, removed ? "Uyarı silindi." : "Böyle bir numara yok."));
  }

  if (cmd === "/ekle") {
    const info = resolveSymbol(parts[1]);
    const dir = parseDir(parts[2]);
    const value = parseFloat(String(parts[3] || "").replace(",", "."));
    if (!info || !dir || !isFinite(value) || value <= 0) {
      return void (await say(env, chatId, "Kullanım: /ekle SEMBOL üstünde|altında DEĞER\nÖrnek: /ekle USD üstünde 45"));
    }
    let current;
    try {
      current = await priceOf(info, new Map());
    } catch (_) {
      return void (await say(env, chatId, `${info.label} için fiyat alınamadı. Sembolü kontrol et ya da biraz sonra dene.`));
    }
    const already = dir === "up" ? current >= value : current <= value;
    if (already) {
      return void (await say(env, chatId,
        `${info.label} şu an ${fmt(current, info.d)}, bu koşul zaten sağlanıyor. Uyarı eklenmedi.`));
    }
    const res = await store.add({ key: info.key, dir, value });
    if (res.error) return void (await say(env, chatId, `En fazla ${MAX_ALERTS} uyarı olabilir. Önce /sil ile birini kaldır.`));
    return void (await say(env, chatId,
      `✅ Eklendi: ${info.label} ${dir === "up" ? "≥" : "≤"} ${fmt(value, info.d)}\nŞu an: ${fmt(current, info.d)}`));
  }

  await say(env, chatId, "Anlamadım. Komutlar için /yardim yaz.");
}

// ---------- Zamanlanmış kontrol ----------
async function checkAlerts(env) {
  if (!env.OWNER_CHAT_ID || !env.TELEGRAM_TOKEN) return;
  const store = getStore(env);
  const alerts = await store.list();
  if (!alerts.length) return;

  const cache = new Map();
  const results = await Promise.all(
    alerts.map(async (a) => {
      const info = resolveSymbol(a.key);
      if (!info) return null;
      try {
        return { a, info, price: await priceOf(info, cache) };
      } catch (e) {
        console.log("fiyat hatası:", String(e));
        return null;
      }
    })
  );

  const fired = results.filter(
    (r) => r && (r.a.dir === "up" ? r.price >= r.a.value : r.price <= r.a.value)
  );
  if (!fired.length) return;

  const text = fired
    .map(
      (f) =>
        `🔔 ${f.info.label} ${f.a.dir === "up" ? "hedefin üstüne çıktı" : "hedefin altına indi"}\n` +
        `Hedef: ${fmt(f.a.value, f.info.d)} · Şu an: ${fmt(f.price, f.info.d)}`
    )
    .join("\n\n");

  // Mesaj gittiyse uyarıları sil; gitmediyse bir sonraki kontrolde tekrar denenir.
  if (await say(env, env.OWNER_CHAT_ID, text)) {
    await store.removeIds(fired.map((f) => f.a.id));
  }
}

// ---------- Giriş noktaları ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
        return new Response("Yetkisiz", { status: 401 });
      }
      let update;
      try {
        update = await request.json();
      } catch (_) {
        return new Response("ok");
      }
      const msg = update && update.message;
      if (msg && typeof msg.text === "string" && msg.chat) {
        ctx.waitUntil(handleMessage(env, msg).catch((e) => console.log("hata:", String(e))));
      }
      return new Response("ok");
    }

    return new Response("Döviz botu çalışıyor.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAlerts(env).catch((e) => console.log("kontrol hatası:", String(e))));
  },
};
