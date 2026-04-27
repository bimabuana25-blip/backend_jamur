/**
 * =============================================================================
 * ENTRY POINT — Titik Masuk Aplikasi Backend
 * =============================================================================
 * File PERTAMA yang berjalan saat server dinyalakan.
 * Tugasnya: setup semua komponen (Express, MQTT, Worker, Rate Limiter)
 * dan menghubungkan semuanya menjadi satu aplikasi yang siap melayani request.
 *
 * PENTING — Urutan startup sangat penting:
 * 1. connect() -> Koneksi MQTT dijalankan PERTAMA karena Worker butuh MQTT.
 * 2. require Worker -> Worker diaktifkan SETELAH MQTT siap, agar tidak error
 *    ketika Worker mencoba publishRelay di job pertamanya.
 * 3. restoreSchedules() -> Baca jadwal aktif dari DB dan daftarkan ulang ke BullMQ.
 *    Ini menjamin jadwal tidak hilang setelah server restart/redeploy.
 * 4. Baru setelah itu Express & semua route dijalankan.
 *
 * Kalau urutannya salah (misal Worker dijalankan sebelum MQTT connect),
 * penyiraman pertama bisa gagal karena client MQTT belum siap.
 * =============================================================================
 */

require('dotenv').config() // Load semua variabel dari file .env ke process.env
const express = require('express')
const rateLimit = require('express-rate-limit')
const { connect } = require('./mqtt/mqttClient')
const { restoreSchedules } = require('./queues/scheduleRestore')
const { startOfflineDetector } = require('./jobs/offlineDetector')

// LANGKAH 1: Koneksi MQTT ke HiveMQ Cloud terlebih dahulu
// Ini harus jalan duluan sebelum Worker aktif
connect()

// LANGKAH 2: Nyalakan Worker yang memproses antrian penyiraman
// Worker sudah aman dijalankan karena MQTT sudah connect di langkah sebelumnya
require('./queues/irrigationWorker')

// LANGKAH 3: Pulihkan semua jadwal aktif dari Supabase ke BullMQ
// Ini mengatasi masalah jadwal hilang setelah Railway redeploy atau Redis restart.
// Semua job lama dibersihkan dulu, lalu jadwal aktif dari DB didaftarkan ulang.
restoreSchedules()

// LANGKAH 4: Mulai pendeteksi offline (Push Notification)
startOfflineDetector()

// LANGKAH 5: Inisialisasi aplikasi Express
const app = express()

// Percayai 1 layer proxy di depan aplikasi (misal Railway, Fly.io, Nginx)
// Ini WAJIB diaktifkan agar express-rate-limit bisa membaca IP asli pengguna, bukan IP dari Proxy.
app.set('trust proxy', 1)

app.use(express.json()) // Supaya server bisa membaca body request dalam format JSON

// =============================================================================
// RATE LIMITER — Pelindung dari request berlebihan
// =============================================================================
// Rate limiter global: berlaku untuk semua endpoint /api
// Maksimal 100 request per menit dari satu IP address yang sama
const globalLimiter = rateLimit({
    windowMs: 60 * 1000, // Window waktu: 1 menit
    max: 100,            // Maks 100 request per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request, coba lagi dalam 1 menit.' },
})

// Rate limiter ketat khusus untuk endpoint siram manual
// Dibatasi hanya 5x per menit untuk mencegah penyiraman berlebihan yang
// bisa merusak tanaman atau menguras air terlalu cepat
const manualIrrigationLimiter = rateLimit({
    windowMs: 60 * 1000, // Window waktu: 1 menit
    max: 5,              // Maks 5 kali siram manual per menit
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu sering menyiram, tunggu sebentar.' },
})
// =============================================================================

// Terapkan rate limiter global ke semua route /api
app.use('/api', globalLimiter)

// =============================================================================
// ROUTE REGISTRATION — Daftarkan semua endpoint API
// =============================================================================
app.use('/api/threshold', require('./routes/threshold'))    // Atur batas suhu & kelembapan
app.use('/api/history', require('./routes/history'))        // Lihat riwayat data sensor
app.use('/api/schedule/:deviceId/now', manualIrrigationLimiter) // Extra ketat untuk siram manual (HARUS sebelum route schedule!)
app.use('/api/schedule', require('./routes/schedule'))      // Kelola jadwal penyiraman
app.use('/api/device', require('./routes/device'))          // Klaim & kelola perangkat
app.use('/api/mode', require('./routes/mode'))              // Kontrol mode operasi ESP32 (auto/manual/offline)
// =============================================================================

// Endpoint health check untuk platform deployment seperti Fly.io / Railway
app.get('/', (req, res) => {
    res.status(200).send('OK');
});

// Railway secara otomatis menyediakan variabel PORT via environment variable.
// Jangan hardcode port! Gunakan process.env.PORT agar server bisa berjalan di Railway.
// Fallback ke 3000 hanya untuk development lokal.
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`)
})