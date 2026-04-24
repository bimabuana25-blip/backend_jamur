/**
 * =============================================================================
 * ROUTE: SCHEDULE — Jadwal & Kontrol Penyiraman
 * =============================================================================
 * File ini adalah "pusat kontrol" untuk semua hal yang berhubungan dengan
 * penyiraman: jadwal terjadwal, trigger manual, hingga menghentikan pompa.
 *
 * Konsep penting: Hybrid antara Database dan BullMQ
 * Semua jadwal disimpan di DUA tempat sekaligus:
 * 1. Database Supabase → untuk menyimpan data permanen (label, cron, durasi, dll)
 * 2. BullMQ (Redis) → untuk mengeksekusi jadwal tepat waktu
 *
 * Kenapa dua tempat? Karena BullMQ menjalankan jadwal berdasarkan waktu nyata,
 * tapi jika server di-restart, semua data BullMQ hilang. Dengan menyimpan di
 * Supabase, jadwal bisa di-restore saat server dinyalakan kembali.
 *
 * Endpoint yang tersedia:
 * - GET    /api/schedule/:deviceId          → Daftar semua jadwal
 * - POST   /api/schedule/:deviceId          → Buat jadwal baru
 * - DELETE /api/schedule/:id                → Hapus jadwal
 * - POST   /api/schedule/:deviceId/now      → Siram sekarang (sekali jalan)
 * - POST   /api/schedule/:deviceId/stop     → Hentikan pompa sekarang
 * - PATCH  /api/schedule/:id/toggle         → Aktifkan atau nonaktifkan jadwal
 * =============================================================================
 */

const router = require('express').Router()
const supabase = require('../supabase/client')
const { irrigationQueue } = require('../queues/irrigationQueue')
const { publishRelay } = require('../mqtt/mqttClient')

/**
 * GET /api/schedule/:deviceId
 * -----------------------------------------------------------------------------
 * Mengambil semua jadwal penyiraman yang dimiliki oleh sebuah device.
 * Diurutkan berdasarkan waktu pembuatan (paling lama di atas).
 * Biasanya dipanggil saat aplikasi Flutter membuka halaman "Jadwal".
 *
 * Params: deviceId — ID perangkat
 */
router.get('/:deviceId', async (req, res) => {
    const { data, error } = await supabase
        .from('schedules')
        .select('*')
        .eq('device_id', req.params.deviceId)
        .order('created_at')

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
})

/**
 * POST /api/schedule/:deviceId
 * -----------------------------------------------------------------------------
 * Membuat jadwal penyiraman baru yang akan berulang sesuai pola cron.
 *
 * Yang terjadi saat endpoint ini dipanggil:
 * 1. Validasi input (cron dan duration_s wajib ada)
 * 2. Daftarkan job repeatable ke BullMQ (yang akan mengeksekusinya nanti)
 * 3. Simpan data jadwal ke Supabase beserta ID job dari BullMQ
 *
 * Format Cron: "menit jam hari bulan hari-minggu"
 * Contoh:
 * - "0 6 * * *"     → Setiap hari jam 06:00
 * - "30 17 * * *"   → Setiap hari jam 17:30
 * - "0 6,17 * * *"  → Setiap hari jam 06:00 dan 17:00
 *
 * Params: deviceId — ID perangkat
 * Body:   { label: string, cron: string, duration_s: number }
 */
router.post('/:deviceId', async (req, res) => {
    const { label, cron, duration_s } = req.body
    const deviceId = req.params.deviceId

    // Validasi: cron pattern dan durasi penyiraman wajib dikirim
    if (!cron || !duration_s) {
        return res.status(400).json({ error: 'cron dan duration_s wajib diisi' })
    }

    // Validasi format cron (minimal harus ada 5 bagian yang dipisahkan spasi)
    if (cron.split(' ').length !== 5) {
        return res.status(400).json({ error: 'Format cron tidak valid' })
    }

    // Langkah 1: Daftarkan job berulang ke BullMQ menggunakan pola cron
    // PENTING: BullMQ v5+ menggunakan key 'cron' bukan 'pattern' (breaking change)
    const jobId = `schedule-${deviceId}-${Date.now()}`
    const job = await irrigationQueue.add(
        'irrigate',
        { deviceId, durationSeconds: duration_s },
        {
            repeat: { cron },   // BullMQ v5+: gunakan 'cron', bukan 'pattern'
            jobId,              // ID unik untuk tiap jadwal
        }
    )

    // Langkah 2: Simpan jadwal ke database beserta bull_job_id untuk referensi nanti
    // bull_job_id dibutuhkan saat ingin menghapus atau toggle jadwal
    const { data, error } = await supabase
        .from('schedules')
        .insert({ device_id: deviceId, label, cron, duration_s, bull_job_id: job.id })
        .select()
        .single()

    if (error) return res.status(500).json({ error: error.message })
    res.status(201).json(data)
})

/**
 * DELETE /api/schedule/:id
 * -----------------------------------------------------------------------------
 * Menghapus jadwal secara permanen dari database DAN dari antrian BullMQ.
 *
 * Penting: Harus hapus dari keduanya! Kalau hanya hapus dari database tapi
 * tidak dari BullMQ, job tetap akan jalan di waktu yang sudah dijadwalkan.
 *
 * Params: id — UUID jadwal dari tabel schedules di Supabase
 */
router.delete('/:id', async (req, res) => {
    // Langkah 1: Ambil detail jadwal dulu untuk mendapat bull_job_id dan cron pattern
    // Kedua info ini dibutuhkan untuk menghapus job dari BullMQ
    const { data: schedule, error: fetchErr } = await supabase
        .from('schedules')
        .select('bull_job_id, cron, device_id')
        .eq('id', req.params.id)
        .single()

    if (fetchErr) return res.status(404).json({ error: 'Jadwal tidak ditemukan' })

    // Langkah 2: Hapus job dari BullMQ agar tidak dieksekusi lagi
    // BullMQ v5+: gunakan 'cron', bukan 'pattern'
    await irrigationQueue.removeRepeatable('irrigate', {
        cron: schedule.cron,
        jobId: schedule.bull_job_id,
    })

    // Langkah 3: Hapus record dari database Supabase
    await supabase.from('schedules').delete().eq('id', req.params.id)

    res.json({ message: 'Jadwal dihapus' })
})

/**
 * POST /api/schedule/:deviceId/now
 * -----------------------------------------------------------------------------
 * Memicu penyiraman SEKARANG JUGA tanpa membuat jadwal permanen.
 * Cocok untuk penyiraman darurat atau percobaan manual.
 *
 * Job ini tidak akan berulang (tidak pakai cron), langsung diproses Worker
 * segera setelah request masuk.
 *
 * Endpoint ini dilindungi rate limiter ketat (5x/menit) yang didefinisikan
 * di index.js untuk mencegah penyiraman berlebihan.
 *
 * Params: deviceId — ID perangkat
 * Body:   { duration_s: number } — opsional, default 30 detik
 */
router.post('/:deviceId/now', async (req, res) => {
    const { duration_s = 30 } = req.body // Default durasi 30 detik jika tidak dikirim

    // Tambahkan job satu kali ke antrian (tanpa repeat) dengan delay 0 (langsung)
    await irrigationQueue.add(
        'irrigate',
        { deviceId: req.params.deviceId, durationSeconds: duration_s },
        { delay: 0 }   // langsung diproses tanpa jeda
    )

    res.json({ message: `Siram manual ${duration_s}s dijadwalkan` })
})

/**
 * POST /api/schedule/:deviceId/stop
 * -----------------------------------------------------------------------------
 * Menghentikan pompa secara paksa dan instan via MQTT.
 * Berguna jika user ingin menghentikan penyiraman sebelum waktunya habis.
 *
 * Catatan: Ini mengirim perintah OFF langsung ke relay, bukan membatalkan job
 * di BullMQ. Jadi jika ada job yang sedang berjalan, Worker masih akan
 * menunggu sampai durasi habis baru kirim OFF lagi (tidak berbahaya, hanya redundan).
 *
 * Params: deviceId — ID perangkat
 */
router.post('/:deviceId/stop', async (req, res) => {
    const { deviceId } = req.params

    // Kirim perintah OFF langsung ke relay ESP32 via MQTT
    publishRelay(deviceId, 'OFF')

    // Catat event ini ke tabel sensor_logs sebagai audit trail
    await supabase.from('sensor_logs').insert({
        device_id: deviceId,
        event: 'manual_stop',
        note: 'Pompa dimatikan manual',
    })

    res.json({ message: 'Pompa dimatikan' })
})

/**
 * PATCH /api/schedule/:id/toggle
 * -----------------------------------------------------------------------------
 * Mengaktifkan atau menonaktifkan jadwal tanpa menghapusnya.
 * Ini lebih nyaman bagi user daripada harus delete lalu create ulang.
 *
 * Cara kerjanya:
 * - Jika jadwal sedang AKTIF → hapus job dari BullMQ, update is_active = false
 * - Jika jadwal sedang NON-AKTIF → daftarkan ulang job ke BullMQ, update is_active = true
 *
 * Data di database tetap tersimpan dalam kedua kondisi, hanya status is_active yang berubah.
 *
 * Params: id — UUID jadwal dari tabel schedules
 */
router.patch('/:id/toggle', async (req, res) => {
    // Ambil data jadwal saat ini untuk mengetahui status is_active dan detail cron-nya
    const { data: schedule, error: fetchErr } = await supabase
        .from('schedules')
        .select('is_active, cron, duration_s, device_id, bull_job_id')
        .eq('id', req.params.id)
        .single()

    if (fetchErr) return res.status(404).json({ error: 'Jadwal tidak ditemukan' })

    // Status baru adalah kebalikan dari status saat ini
    const newStatus = !schedule.is_active

    if (newStatus) {
        // Jadwal akan DIAKTIFKAN: daftarkan kembali job ke BullMQ
        // BullMQ v5+: gunakan 'cron', bukan 'pattern'
        const job = await irrigationQueue.add(
            'irrigate',
            { deviceId: schedule.device_id, durationSeconds: schedule.duration_s },
            {
                repeat: { cron: schedule.cron }, // BullMQ v5+: key 'cron'
                jobId: schedule.bull_job_id,     // gunakan ID yang sama agar referensi tidak berubah
            }
        )
        console.log(`[Schedule] Job ${job.id} diaktifkan kembali`)
    } else {
        // Jadwal akan DINONAKTIFKAN: hapus job dari BullMQ (tapi data DB tetap ada)
        // BullMQ v5+: gunakan 'cron', bukan 'pattern'
        await irrigationQueue.removeRepeatable('irrigate', {
            cron: schedule.cron,
            jobId: schedule.bull_job_id,
        })
        console.log(`[Schedule] Job ${schedule.bull_job_id} dinonaktifkan`)
    }

    // Update kolom is_active di database Supabase
    const { data, error } = await supabase
        .from('schedules')
        .update({ is_active: newStatus })
        .eq('id', req.params.id)
        .select()
        .single()

    if (error) return res.status(500).json({ error: error.message })

    res.json({
        message: newStatus ? 'Jadwal diaktifkan' : 'Jadwal dinonaktifkan',
        data,
    })
})

module.exports = router