const Redis = require('ioredis');

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

// Fallback anti-spam in-memory jika Redis tidak tersedia
const inMemoryCooldown = new Map();

/**
 * Kirim push notification via OneSignal dengan perlindungan anti-spam bawaan.
 * Setiap kombinasi (userId + title) diberi cooldown agar tidak bisa dikirim
 * berulang kali dalam jangka waktu tertentu.
 *
 * @param {string} userId       - ID user penerima (external_id OneSignal)
 * @param {string} title        - Judul notifikasi (juga dipakai sebagai kunci cooldown)
 * @param {string} message      - Isi pesan notifikasi
 * @param {number} [cooldownSec=300] - Cooldown dalam detik (default: 5 menit)
 */
const sendNotification = async (userId, title, message, cooldownSec = 300) => {
  const appId = process.env.ONESIGNAL_APP_ID;
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!appId || !restApiKey) {
    console.warn('[Notif] OneSignal credentials missing. Skipping.');
    return;
  }

  // ── Anti-Spam Guard ──────────────────────────────────────────────────────
  // Buat kunci unik berdasarkan siapa penerima dan judul notifikasinya.
  // Ini mencegah notif "Penyiraman Dimulai" atau "Perangkat Offline"
  // dikirim berkali-kali dalam waktu singkat.
  const cooldownKey = `notif_cd:${userId}:${title.replace(/\s+/g, '_').toLowerCase()}`;

  if (redis) {
    const isOnCooldown = await redis.get(cooldownKey);
    if (isOnCooldown) {
      console.log(`[Notif] Cooldown aktif, skip: "${title}" → ${userId}`);
      return;
    }
    // Set cooldown key di Redis
    await redis.set(cooldownKey, '1', 'EX', cooldownSec);
  } else {
    // Fallback: gunakan in-memory Map jika Redis tidak ada
    const expiresAt = inMemoryCooldown.get(cooldownKey);
    if (expiresAt && Date.now() < expiresAt) {
      console.log(`[Notif] Cooldown aktif (in-memory), skip: "${title}" → ${userId}`);
      return;
    }
    inMemoryCooldown.set(cooldownKey, Date.now() + cooldownSec * 1000);
  }
  // ────────────────────────────────────────────────────────────────────────

  const payload = {
    app_id: appId,
    include_aliases: {
      external_id: [userId]
    },
    target_channel: 'push',
    headings: { en: title },
    contents: { en: message }
  };

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${restApiKey}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (result.errors) {
      console.error('[Notif] OneSignal error:', result.errors);
    } else {
      console.log(`[Notif] Terkirim ke ${userId}: "${title}"`);
    }
  } catch (error) {
    console.error('[Notif] Gagal kirim via OneSignal:', error.message);
  }
};

module.exports = {
  sendNotification
};
