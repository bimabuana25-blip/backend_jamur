const supabase = require('../supabase/client');
const { sendNotification } = require('../utils/notification');
const Redis = require('ioredis');

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

// Jalankan pengecekan setiap 5 menit
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function startOfflineDetector() {
    setInterval(async () => {
        try {
            // console.log('[OfflineDetector] Mengecek perangkat offline...');

            // Waktu 5 menit yang lalu (di Supabase pakai UTC)
            const fiveMinsAgo = new Date(Date.now() - CHECK_INTERVAL_MS).toISOString();

            // Cari perangkat yang is_online = true TAPI last_seen < 5 menit yang lalu
            const { data: devices, error } = await supabase
                .from('devices')
                .select('device_id, claimed_by, last_seen')
                .eq('is_online', true)
                .lt('last_seen', fiveMinsAgo);

            if (error) throw error;

            for (const device of devices) {
                console.log(`[OfflineDetector] Perangkat ${device.device_id} terdeteksi OFFLINE!`);

                // 1. Update status di DB jadi offline
                await supabase
                    .from('devices')
                    .update({ is_online: false })
                    .eq('device_id', device.device_id);

                // 2. Kirim Notifikasi OneSignal
                if (device.claimed_by) {
                    const notifKey = `offline_notif_${device.device_id}`;
                    const isNotified = redis ? await redis.get(notifKey) : false;

                    if (!isNotified) {
                        sendNotification(
                            device.claimed_by,
                            'Peringatan Kritis! 🚨',
                            `Perangkat IoT Kumbung (${device.device_id}) terputus dari jaringan atau mati listrik.`
                        );
                        if (redis) await redis.set(notifKey, '1', 'EX', 3600); // 1 jam cooldown
                    }
                }
            }
        } catch (error) {
            console.error('[OfflineDetector] Error:', error.message);
        }
    }, CHECK_INTERVAL_MS);

    console.log('[OfflineDetector] Aktif. Pengecekan perangkat offline berjalan setiap 5 menit.');
}

module.exports = { startOfflineDetector };
