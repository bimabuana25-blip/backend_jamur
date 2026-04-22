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
 * 3. Pertama, Worker kirim perintah relay ON ke ESP32 via MQTT -> pompa menyala.
 * 4. Worker menunggu selama `durationSeconds` detik (waktu penyiraman).
 * 5. Setelah waktu habis, Worker kirim perintah relay OFF -> pompa mati.
 *
 * Penting: Worker harus diinisialisasi SETELAH MQTT sudah terkoneksi,
 * karena worker butuh fungsi publishRelay dari mqttClient.
 * Urutan startup diatur di src/index.js.
 * =============================================================================
 */

const { Worker } = require('bullmq')
const { connection } = require('./irrigationQueue')
const { publishRelay } = require('../mqtt/mqttClient')

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
    const nowUTC = new Date().toISOString()
    const nowWIB = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)

    console.log(`[Worker] ============================================================`)
    console.log(`[Worker] JOB DIMULAI — ID: ${job.id}`)
    console.log(`[Worker] Device  : ${deviceId}`)
    console.log(`[Worker] Durasi  : ${durationSeconds} detik`)
    console.log(`[Worker] Waktu   : ${nowWIB} WIB (${nowUTC} UTC)`)
    console.log(`[Worker] Sumber  : ${job.opts?.repeat?.cron ? 'Jadwal otomatis cron: ' + job.opts.repeat.cron : 'Siram manual'}`)
    console.log(`[Worker] ============================================================`)

    // Langkah 1: Nyalakan pompa dengan kirim perintah ON ke relay ESP32
    publishRelay(deviceId, 'ON')
    console.log(`[Worker] >> Relay ON dikirim ke ${deviceId}`)

    // Langkah 2: Tunggu selama durasi yang ditentukan
    // Ini tidak memblokir server karena berjalan di proses worker yang terpisah
    await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000))

    // Langkah 3: Matikan pompa setelah durasi selesai
    publishRelay(deviceId, 'OFF')
    console.log(`[Worker] >> Relay OFF dikirim ke ${deviceId}`)
    console.log(`[Worker] JOB SELESAI — ${deviceId} | durasi: ${durationSeconds}s`)

}, { connection })

// ── Event Handlers ──────────────────────────────────────────────

worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} berhasil diselesaikan.`)
})

worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} GAGAL:`, err.message)
    console.error(`[Worker] Stack:`, err.stack)
})

worker.on('error', (err) => {
    console.error(`[Worker] Worker error:`, err.message)
})

worker.on('ready', () => {
    console.log(`[Worker] Worker siap memproses antrian 'irrigation'`)
})

module.exports = worker