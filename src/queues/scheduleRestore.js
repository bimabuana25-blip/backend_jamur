/**
 * =============================================================================
 * SCHEDULE RESTORE — Pemulihan Jadwal Saat Server Start
 * =============================================================================
 * Masalah yang dipecahkan:
 * BullMQ menyimpan repeatable job di Redis, tapi jika terjadi:
 * - Server restart (Railway redeploy)
 * - Migrasi Redis
 * - Format key berubah (misal upgrade BullMQ dari v4 ke v5)
 * ...maka job di BullMQ bisa hilang atau tidak sinkron dengan database.
 *
 * Solusinya: Setiap kali server start, kita:
 * 1. Hapus SEMUA repeatable job lama dari BullMQ (bersih-bersih)
 * 2. Baca semua jadwal is_active=true dari Supabase
 * 3. Daftarkan ulang ke BullMQ dengan format yang benar (BullMQ v5+: key 'cron')
 *
 * Ini menjamin sinkronisasi antara DB dan BullMQ setiap kali server hidup.
 * =============================================================================
 */

const supabase = require('../supabase/client')
const { irrigationQueue } = require('./irrigationQueue')

/**
 * Restore semua jadwal aktif dari Supabase ke BullMQ.
 * Dipanggil satu kali saat server startup di index.js.
 */
async function restoreSchedules() {
    console.log('[Restore] Memulai pemulihan jadwal dari database...')

    try {
        // Langkah 1: Bersihkan SEMUA repeatable job lama dari BullMQ
        // Ini menghapus job yang mungkin tersimpan dengan format lama (pattern)
        const existingRepeatables = await irrigationQueue.getRepeatableJobs()
        console.log(`[Restore] Ditemukan ${existingRepeatables.length} job lama di BullMQ, membersihkan...`)

        for (const job of existingRepeatables) {
            await irrigationQueue.removeRepeatableByKey(job.key)
        }
        console.log('[Restore] Job lama berhasil dihapus.')

        // Langkah 2: Ambil semua jadwal aktif dari Supabase
        const { data: schedules, error } = await supabase
            .from('schedules')
            .select('*')
            .eq('is_active', true)

        if (error) {
            console.error('[Restore] Gagal mengambil jadwal dari DB:', error.message)
            return
        }

        if (!schedules || schedules.length === 0) {
            console.log('[Restore] Tidak ada jadwal aktif untuk di-restore.')
            return
        }

        console.log(`[Restore] Mendaftarkan ulang ${schedules.length} jadwal aktif...`)

        // Langkah 3: Daftarkan ulang setiap jadwal ke BullMQ dengan format BullMQ v5+
        for (const schedule of schedules) {
            try {
                const job = await irrigationQueue.add(
                    'irrigate',
                    { deviceId: schedule.device_id, durationSeconds: schedule.duration_s },
                    {
                        repeat: { cron: schedule.cron }, // BullMQ v5+: key 'cron'
                        jobId: schedule.bull_job_id,
                    }
                )
                console.log(`[Restore] ✓ Jadwal ${schedule.id} (${schedule.cron}) → Job ${job.id}`)
            } catch (jobErr) {
                console.error(`[Restore] ✗ Gagal restore jadwal ${schedule.id}:`, jobErr.message)
            }
        }

        console.log('[Restore] Pemulihan jadwal selesai.')
    } catch (err) {
        // Jangan sampai error di sini menghentikan server dari start
        console.error('[Restore] Error tidak terduga saat restore jadwal:', err.message)
    }
}

module.exports = { restoreSchedules }
