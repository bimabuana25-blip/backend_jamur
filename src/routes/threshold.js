/**
 * =============================================================================
 * ROUTE: THRESHOLD — Pengaturan Batas Suhu & Kelembapan
 * =============================================================================
 * File ini berfungsi mengatur "batas" yang menentukan kapan relay otomatis 
 * menyala atau mati.
 *
 * Cara kerjanya:
 * Saat sensor SHT31 di ESP32 membaca data, backend akan membandingkan nilainya
 * dengan threshold yang tersimpan di sini:
 * - Jika suhu ATAU kelembapan melewati batas → relay ON
 * - Jika keduanya di bawah batas → relay OFF
 *
 * Endpoint yang tersedia:
 * - GET  /api/threshold/:deviceId → Ambil threshold aktif untuk device tertentu
 * - POST /api/threshold/:deviceId → Update threshold (langsung efektif ke ESP32)
 * =============================================================================
 */

const router = require('express').Router()
const supabase = require('../supabase/client')
const { publishThreshold } = require('../mqtt/mqttClient')

/**
 * GET /api/threshold/:deviceId
 * -----------------------------------------------------------------------------
 * Mengambil nilai threshold yang sedang aktif untuk sebuah device.
 * Biasanya dipanggil saat aplikasi Flutter pertama kali dibuka untuk
 * menampilkan pengaturan saat ini kepada user.
 *
 * Params: deviceId — ID perangkat, contoh: "esp32-01"
 */
router.get('/:deviceId', async (req, res) => {
    const { data, error } = await supabase
        .from('thresholds')
        .select('*')
        .eq('device_id', req.params.deviceId)
        .single()

    if (error) return res.status(404).json({ error: error.message })
    res.json(data)
})

/**
 * POST /api/threshold/:deviceId
 * -----------------------------------------------------------------------------
 * Mengubah nilai threshold untuk sebuah device.
 *
 * Yang terjadi saat endpoint ini dipanggil:
 * 1. Validasi input (temp_max dan hum_max wajib ada)
 * 2. Update nilai di database Supabase
 * 3. Kirim nilai baru ke ESP32 via MQTT (langsung efektif!)
 * 4. Update cache in-memory agar tidak perlu tunggu 30 detik untuk efektif
 *
 * Jadi user tidak perlu reload atau menunggu — perubahan langsung terasa.
 *
 * Params: deviceId — ID perangkat
 * Body: { temp_max: number, hum_max: number }
 */
router.post('/:deviceId', async (req, res) => {
    const { temp_max, hum_max } = req.body

    // Validasi: kedua nilai threshold wajib dikirim
    if (!temp_max || !hum_max) {
        return res.status(400).json({ error: 'temp_max dan hum_max wajib diisi' })
    }

    // Simpan nilai baru ke database
    const { data, error } = await supabase
        .from('thresholds')
        .update({ temp_max, hum_max, updated_at: new Date() })
        .eq('device_id', req.params.deviceId)
        .select()
        .single()

    if (error) return res.status(500).json({ error: error.message })

    // Kirim nilai threshold baru langsung ke ESP32 via MQTT
    // Sekaligus memperbarui cache agar langsung efektif tanpa tunggu TTL
    publishThreshold(req.params.deviceId, temp_max, hum_max)

    res.json({ message: 'Threshold diupdate', data })
})

module.exports = router