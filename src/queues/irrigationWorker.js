/**
 * =============================================================================
 * IRRIGATION WORKER — Eksekutor Penyiraman
 * =============================================================================
 * File ini adalah "pekerja" yang secara aktif memantau antrian irrigationQueue
 * dan mengeksekusi setiap job penyiraman yang masuk.
 *
 * Cara kerjanya:
 * 1. Worker terus "mendengarkan" antrian 'irrigation' di Redis.
 * 2. Saat ada job masuk (baik dari jadwal cron maupun trigger manual),
 *    Worker langsung mengambil dan menjalankannya.
 * 3. Pertama, Worker kirim perintah relay ON ke ESP32 via MQTT → pompa menyala.
 * 4. Worker menunggu selama `durationSeconds` detik (waktu penyiraman).
 * 5. Setelah waktu habis, Worker kirim perintah relay OFF → pompa mati.
 *
 * Kenapa Worker dijalankan terpisah dari route?
 * - Supaya proses "menunggu" (misal menunggu 60 detik) tidak memblokir server.
 * - Worker jalan di background, sementara server tetap bisa menerima request lain.
 *
 * Penting: Worker harus diinisialisasi SETELAH MQTT sudah terkoneksi,
 * karena worker butuh fungsi publishRelay dari mqttClient.
 * Urutan startup diatur di src/index.js.
 * =============================================================================
 */

const { Worker } = require('bullmq')
const { connection } = require('./irrigationQueue')
const { publishRelay } = require('../mqtt/mqttClient')
const supabase = require('../supabase/client')

/**
 * Definisi Worker untuk queue 'irrigation'.
 * Setiap kali ada job masuk, fungsi async di bawah ini akan dijalankan.
 *
 * @param {Object} job - Objek job dari BullMQ
 * @param {string} job.data.deviceId - ID perangkat ESP32 yang akan disiram
 * @param {number} job.data.durationSeconds - Lama penyiraman dalam detik
 */
const worker = new Worker('irrigation', async (job) => {
    const { deviceId, durationSeconds } = job.data
    console.log(`[Worker] Mulai siram: ${deviceId} selama ${durationSeconds}s`)

    // Langkah 1: Nyalakan pompa dengan kirim perintah ON ke relay ESP32
    publishRelay(deviceId, 'ON')

    // Langkah 2: Tunggu selama durasi yang ditentukan
    // Ini tidak memblokir server karena berjalan di proses worker yang terpisah
    await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000))

    // Langkah 3: Matikan pompa setelah durasi selesai
    publishRelay(deviceId, 'OFF')

    // Catat ke console — sensor_logs hanya untuk data sensor (temperature/humidity)
    // TODO: buat tabel 'irrigation_logs' terpisah jika butuh audit trail penyiraman
    console.log(`[Worker] Selesai: ${deviceId} | durasi: ${durationSeconds}s`)

}, { connection })

/**
 * Event handler jika sebuah job gagal dieksekusi.
 * Ini penting untuk debugging — error akan muncul di console dengan jelas.
 */
worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job.id} gagal:`, err.message)
})

module.exports = worker