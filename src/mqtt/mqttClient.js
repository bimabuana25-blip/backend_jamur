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

// Daftar topik MQTT yang digunakan dalam sistem ini
const TOPIC_SENSOR = 'sensor/dht22'      // Topik untuk menerima data dari ESP32
const TOPIC_THRESHOLD = 'config/threshold' // Topik untuk kirim setting threshold ke ESP32
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
        .single()

    if (error) {
        console.error('[Cache] Gagal baca threshold:', error.message)
        return null
    }

    // Simpan hasil query ke cache beserta timestamp saat ini
    thresholdCache.set(deviceId, { ...data, cachedAt: Date.now() })
    console.log(`[Cache] Threshold ${deviceId} diperbarui dari DB`)
    return data
}
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
        const { temp, hum, device_id = 'esp32-01' } = data
        console.log(`[MQTT] [${device_id}] Sensor: ${temp}°C | ${hum}%`)

        // Langkah 1: Simpan data sensor ke tabel sensor_logs di Supabase
        const { error: insertErr } = await supabase.from('sensor_logs').insert({
            device_id,
            temperature: temp,
            humidity: hum,
        })
        if (insertErr) {
            console.error('[MQTT] Gagal simpan sensor log:', insertErr.message)
        }

        // Langkah 2: Baca threshold dari cache (hemat query DB)
        const cfg = await getCachedThreshold(device_id)

        // Langkah 3: Otomatis nyalakan/matikan relay berdasarkan threshold
        // Relay ON jika suhu ATAU kelembapan melewati batas yang ditentukan
        if (cfg) {
            const relayOn = temp > cfg.temp_max || hum > cfg.hum_max
            publishRelay(device_id, relayOn ? 'ON' : 'OFF')
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
    client.publish(TOPIC_THRESHOLD, payload, { qos: 1, retain: true })

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