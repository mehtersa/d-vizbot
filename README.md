# Döviz / Altın / BIST uyarı botu

Telegram'dan komut verirsin, bot her 5 dakikada fiyatlara bakar, hedefe gelince sana yazar.

## Kurulum

1. **Telegram botu aç:** Telegram'da @BotFather'a `/newbot` yaz, ad ve kullanıcı adı ver, sana bir **token** verir.
2. **GitHub:** Yeni (private) repo aç, `worker.js` ve `wrangler.toml` dosyalarını repo ana dizinine yükle (klasör yok).
3. **Cloudflare:** Workers & Pages > Create > GitHub reposunu içe aktar. Proje adı `doviz-bot` olsun (wrangler.toml'daki adla aynı).
4. **Gizli değişkenler:** Projenin Settings > Variables and Secrets bölümünde **Secret** olarak ekle:
   - `TELEGRAM_TOKEN` = BotFather'ın verdiği token
   - `WEBHOOK_SECRET` = kendi uydurduğun uzun rastgele harf/rakam dizisi (örn. 30 karakter, boşluk ve özel karakter yok)
5. **Webhook'u bağla:** Tarayıcıda şu adresi aç (köşeli parantezli yerleri doldur):
   `https://api.telegram.org/bot[TOKEN]/setWebhook?url=https://doviz-bot.[HESAP].workers.dev/telegram&secret_token=[WEBHOOK_SECRET]`
   `{"ok":true,...}` görmelisin.
6. **Chat ID'ni al:** Botuna Telegram'dan `/start` yaz. Sana Chat ID'ni söyler. Bunu `OWNER_CHAT_ID` adıyla üçüncü bir **Secret** olarak ekle.
7. Botuna tekrar `/start` yaz, yardım menüsü gelirse hazırsın.

## Komutlar

- `/ekle USD üstünde 45`
- `/ekle GRAM altında 4500`
- `/ekle THYAO üstünde 320`
- `/liste`, `/sil 2`, `/fiyat`, `/fiyat USD THYAO`

Hazır semboller: USD, EUR, GBP, GRAM, ONS, BIST100. Başka kodlar BIST hissesi sayılır.

## Notlar

- Fiyatlar Yahoo Finance'ın resmi olmayan ucundan gelir. BIST verisi gecikmeli olabilir, bu bir yatırım tavsiyesi aracı değildir.
- Gram altın, ons fiyatı / 31,1035 x dolar kuru ile hesaplanır. Kuyumcu/serbest piyasa fiyatından biraz farklı olabilir.
- Uyarı tetiklenince bir kez haber verir ve silinir.
- Token ve secret değerlerini asla GitHub'a yükleme, sadece Cloudflare'de Secret olarak tut.
