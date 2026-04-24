/**
 * =============================================================================
 * MQTT CLIENT — Jembatan Komunikasi ke ESP32
 * =============================================================================
 * File ini mengurus semua komunikasi antara server Node.js dan perangkat ESP32
 * menggunakan protokol MQTT melalui HiveMQ Cloud.
 *
 * MQTT itu apa?
 * MQTT adalah protokol pesan ringan yang populer di dunia IoT. Cara kerjanya
 * seperti sistem "publish-subscribe": ada yang kirim pesan (publish) ke sebuah
 * "topik", dan ada yang langganan (subscribe) topik itu untuk menerimanya.
 *
 * Di sistem ini:
 * - ESP32 → PUBLISH data sensor ke topik 'sensor/dht22'
 * - Server → SUBSCRIBE ke 'sensor/dht22' untuk menerima data tersebut
 * - Server → PUBLISH perintah ke 'cmd/relay/{deviceId}' untuk nyala/matiin pompa
 * - Server → PUBLISH config ke 'config/threshold' saat threshold diubah
 *
 * Fitur penting di file ini: IN-MEMORY CACHE untuk threshold.
 * Tanpa cache: setiap data sensor masuk (bisa 1x/detik!) → query ke Supabase.
 * Dengan cache: data threshold disimpan di memori, query DB hanya tiap 30 detik.
 * Ini menghemat kuota database secara signifikan.
 * =============================================================================
 */

const mqtt = require('mqtt')
const supabase = require('../supabase/client')
const Redis = require('ioredis')
const { sendNotification } = require('../utils/notification')

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null

// Daftar topik MQTT yang digunakan dalam sistem ini
const TOPIC_SENSOR = 'sensor/dht22'      // Topik untuk menerima data dari ESP32
const TOPIC_THRESHOLD_BASE = 'config/threshold' // Topik dasar untuk kirim setting threshold ke ESP32
const TOPIC_RELAY = 'cmd/relay'           // Topik dasar untuk kontrol relay

// =============================================================================
// IN-MEMORY CACHE — Penyimpanan Sementara di Memori Server
// =============================================================================
// Map ini menyimpan data threshold tiap device agar tidak perlu query DB terus-menerus.
// Format isi Map: { deviceId → { temp_max, hum_max, cachedAt } }
// Cache akan kadaluarsa setelah CACHE_TTL_MS milidetik (default 30 detik)
const thresholdCache = new Map()
const CACHE_TTL_MS = 30 * 1000  // 30 detik dalam milidetik

/**
 * Ambil data threshold dari cache. Kalau cache kosong atau sudah kadaluarsa,
 * baru query ke database Supabase, lalu simpan hasilnya ke cache.
 *
 * @param {string} deviceId - ID perangkat ESP32
 * @returns {Object|null} Objek { temp_max, hum_max } atau null jika gagal
 */
async function getCachedThreshold(deviceId) {
    const cached = thresholdCache.get(deviceId)

    // Cek apakah cache masih valid (belum kadaluarsa)
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached  // cache hit — tidak perlu query DB
    }

    // Cache miss atau sudah expired — ambil data segar dari Supabase
    const { data, error } = await supabase
        .from('thresholds')
        .select('temp_max, hum_max')
        .eq('device_id', deviceId)
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('[Cache] Gagal baca threshold:', error.message)
        return null
    }

    if (!data) {
        console.warn(`[Cache] Threshold belum disetel untuk ${deviceId}`)
        return null
    }

    // Simpan hasil query ke cache beserta timestamp saat ini
    thresholdCache.set(deviceId, { ...data, cachedAt: Date.now() })
    console.log(`[Cache] Threshold ${deviceId} diperbarui dari DB`)
    return data
}
// =============================================================================

// =============================================================================
// IN-MEMORY CACHE UNTUK SMART FILTER (DEADBAND) & STATUS
// =============================================================================
// Map ini mencatat status terakhir agar tidak spam ke Supabase
const sensorLogCache = new Map() // { temp, hum, relay_state, lastSavedAt }
const lastSeenCache = new Map()  // timestamp terakhir kali device laporan online

const TEMP_DELTA = 0.5;         // Perubahan suhu minimal untuk disimpan
const HUM_DELTA = 1.0;          // Perubahan kelembapan minimal untuk disimpan
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 menit (jaga grafik tidak putus)
const LAST_SEEN_INTERVAL_MS = 1 * 60 * 1000; // 1 menit (throttle status online)
// =============================================================================

// Variabel untuk menyimpan instance koneksi MQTT (digunakan di seluruh file ini)
let client

/**
 * Memulai koneksi ke MQTT broker (HiveMQ Cloud).
 * Fungsi ini dipanggil PERTAMA KALI saat server start di index.js,
 * sebelum Worker dijalankan, agar MQTT siap saat Worker butuh publishRelay.
 */
function connect() {
    // Buat koneksi ke HiveMQ menggunakan kredensial dari .env
    client = mqtt.connect(process.env.MQTT_BROKER_URL, {
        port: parseInt(process.env.MQTT_PORT) || 8883,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        protocol: 'mqtts',       // wajib TLS untuk HiveMQ Cloud (koneksi terenkripsi)
        clientId: `nodejs-backend-${Date.now()}`, // ID unik agar tidak bentrok
        clean: true,
        reconnectPeriod: 5000,   // Coba reconnect tiap 5 detik jika koneksi putus
    })

    // Event: Berhasil terhubung ke broker
    client.on('connect', () => {
        console.log('[MQTT] Terhubung ke HiveMQ Cloud')
        // Mulai "dengarkan" data sensor dari ESP32
        client.subscribe(TOPIC_SENSOR, { qos: 1 })
    })

    /**
     * Event: Ada pesan masuk dari topik yang di-subscribe.
     * Ini adalah inti dari pemrosesan data sensor.
     * Alur: Terima data → Simpan ke DB → Cek threshold → Kontrol relay
     */
    client.on('message', async (topic, payload) => {
        try {
            // Hanya proses pesan dari topik sensor, abaikan topik lain
            if (topic !== TOPIC_SENSOR) return

        // Parsing payload dari format JSON ke objek JavaScript
        let data
        try {
            data = JSON.parse(payload.toString())
        } catch {
            return console.error('[MQTT] Payload tidak valid JSON')
        }

        // Destructure data sensor. Jika ESP32 tidak kirim device_id, pakai default 'esp32-01'
        // relay_state dikirim ESP32 sebagai boolean (true = ON, false = OFF)
        const { temp, hum, relay_state, device_id = 'esp32-01' } = data
        console.log(`[MQTT] [${device_id}] Sensor: ${temp}°C | ${hum}% | Relay: ${relay_state}`)

        const now = Date.now();

        // Langkah 1A: Update status online (last_seen) dengan throttle 1 menit
        const lastSeen = lastSeenCache.get(device_id) || 0;
        if (now - lastSeen > LAST_SEEN_INTERVAL_MS) {
            // Kita tidak perlu await di sini agar tidak memblokir proses peringatan (Push Notif)
            supabase.from('devices')
                .update({ is_online: true, last_seen: new Date().toISOString() })
                .eq('device_id', device_id)
                .then(({ error }) => {
                    if (error) console.error('[MQTT] Gagal update last_seen:', error.message);
                    else lastSeenCache.set(device_id, now);
                });
        }

        // Langkah 1B: Smart Filter untuk menyimpan data ke tabel sensor_logs
        let shouldSaveData = false;
        const lastData = sensorLogCache.get(device_id);

        if (!lastData) {
            shouldSaveData = true; // Simpan jika belum ada riwayat di memori server
        } else {
            const tempDiff = Math.abs(temp - lastData.temp);
            const humDiff = Math.abs(hum - lastData.hum);
            const timeDiff = now - lastData.lastSavedAt;
            const relayChanged = relay_state !== lastData.relay_state;

            // Logika Smart Filter (Deadband)
            if (tempDiff > TEMP_DELTA || humDiff > HUM_DELTA || relayChanged || timeDiff > HEARTBEAT_INTERVAL_MS) {
                shouldSaveData = true;
            }
        }

        if (shouldSaveData) {
            const { error: insertErr } = await supabase.from('sensor_logs').insert({
                device_id,
                temperature: temp,
                humidity: hum,
                relay_state: relay_state ?? false,
            })
            if (insertErr) {
                console.error('[MQTT] Gagal simpan sensor log:', insertErr.message)
            } else {
                // Catat ke memori setelah berhasil insert
                sensorLogCache.set(device_id, {
                    temp,
                    hum,
                    relay_state: relay_state ?? false,
                    lastSavedAt: now
                });
            }
        }

        // Langkah 2: Baca threshold dari cache (hanya untuk memastikan cache tersimpan, logika auto diurus ESP32)
        const threshold = await getCachedThreshold(device_id)

        // Langkah 3: Pengecekan Suhu & Kelembapan untuk Push Notification (Anti-Spam 30 menit)
        if (threshold) {
            let alertMsg = null
            let notifKey = null

            if (temp > threshold.temp_max) {
                alertMsg = `Peringatan Panas! Suhu saat ini ${temp}°C (Batas: ${threshold.temp_max}°C)`
                notifKey = `notified_temp_${device_id}`
            } else if (hum > threshold.hum_max) {
                // Sesuai kebutuhan jika hum > hum_max atau hum < hum_min (karena ini jamur, kadang hum_min yang dicari)
                // Tapi kita ikuti plan awal: Kelembapan melebihi batas.
                alertMsg = `Peringatan Lembap! Kelembapan saat ini ${hum}% (Batas: ${threshold.hum_max}%)`
                notifKey = `notified_hum_${device_id}`
            }

            if (alertMsg && notifKey) {
                // Cek apakah sudah dinotifikasi dalam 30 menit terakhir
                const isNotified = redis ? await redis.get(notifKey) : false
                if (!isNotified) {
                    // Cari user yang memiliki alat ini
                    const { data: device } = await supabase
                        .from('devices')
                        .select('claimed_by')
                        .eq('device_id', device_id)
                        .single()

                    if (device && device.claimed_by) {
                        sendNotification(device.claimed_by, 'Peringatan Sensor Kumbung ⚠️', alertMsg)
                        // Set cooldown 30 menit (1800 detik)
                        if (redis) await redis.set(notifKey, '1', 'EX', 1800)
                    }
                }
            }
        }
        } catch (globalErr) {
            console.error('[MQTT] Kesalahan tidak terduga saat memproses pesan:', globalErr.message)
        }
    })

    // Event: Terjadi error pada koneksi MQTT
    client.on('error', err => console.error('[MQTT] Error:', err.message))

    // Event: Koneksi terputus — otomatis akan mencoba reconnect sesuai reconnectPeriod
    client.on('offline', () => console.warn('[MQTT] Koneksi terputus, mencoba reconnect...'))
}

/**
 * Kirim nilai threshold terbaru ke ESP32 via MQTT.
 * Dipanggil otomatis saat user update threshold melalui API.
 * Sekaligus memperbarui cache agar nilai baru langsung efektif.
 *
 * @param {string} deviceId - ID perangkat target
 * @param {number} tempMax - Batas maksimum suhu (°C)
 * @param {number} humMax - Batas maksimum kelembapan (%)
 */
function publishThreshold(deviceId, tempMax, humMax) {
    const payload = JSON.stringify({ temp: tempMax, hum: humMax })
    // retain: true → ESP32 yang baru connect akan langsung dapat nilai threshold terkini
    client.publish(`${TOPIC_THRESHOLD_BASE}/${deviceId}`, payload, { qos: 1, retain: true })

    // Perbarui cache langsung agar nilai baru efektif tanpa harus tunggu 30 detik
    thresholdCache.set(deviceId, { temp_max: tempMax, hum_max: humMax, cachedAt: Date.now() })
    console.log(`[Cache] Threshold ${deviceId} diperbarui dari API`)
}

/**
 * Kirim perintah nyala atau mati ke relay ESP32.
 * Topik yang digunakan bersifat dinamis per device: cmd/relay/{deviceId}
 * Sehingga jika ada banyak device, perintah tidak tercampur.
 *
 * @param {string} deviceId - ID perangkat target
 * @param {'ON'|'OFF'} state - Perintah yang dikirim
 */
function publishRelay(deviceId, state) {
    client.publish(`${TOPIC_RELAY}/${deviceId}`, state, { qos: 1 })
    console.log(`[MQTT] Relay ${deviceId} → ${state}`)
}

module.exports = { connect, publishThreshold, publishRelay }