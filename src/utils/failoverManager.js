/**
 * =============================================================================
 * FAILOVER MANAGER — Pengendali Mode Backup & Utama
 * =============================================================================
 * Berfungsi untuk mengelola status server saat dijalankan di VPS (sebagai backup)
 * atau di Railway (sebagai primary).
 *
 * Cara kerjanya:
 * 1. Jika IS_BACKUP_SERVER !== 'true' (Primary / Railway):
 *    - Langsung aktifkan semua service background (MQTT, Worker, Scheduler, Offline Detector).
 *
 * 2. Jika IS_BACKUP_SERVER === 'true' (Backup / VPS):
 *    - Jangan aktifkan service background pada startup.
 *    - Jalankan pemantauan berkala (ping) ke PRIMARY_SERVER_URL.
 *    - Jika ping sukses (Primary hidup) -> Pastikan service background mati/nonaktif.
 *    - Jika ping gagal/timeout (Primary mati) -> Aktifkan semua service background.
 *    - Jika ping kembali sukses -> Matikan kembali service background.
 * =============================================================================
 */

const { connect, disconnect } = require('../mqtt/mqttClient')
const worker = require('../queues/irrigationWorker')
const { restoreSchedules } = require('../queues/scheduleRestore')
const { startOfflineDetector, stopOfflineDetector } = require('../jobs/offlineDetector')

const IS_BACKUP_SERVER = process.env.IS_BACKUP_SERVER === 'true'
const PRIMARY_SERVER_URL = process.env.PRIMARY_SERVER_URL // Contoh: https://xxx.up.railway.app
const PING_INTERVAL_MS = parseInt(process.env.FAILOVER_PING_INTERVAL_MS) || 10000 // default 10s

let isFailoverActive = false // Apakah backup server sedang melayani background tasks
let pingIntervalId = null

async function pingPrimary() {
    if (!PRIMARY_SERVER_URL) {
        console.error('[Failover] PRIMARY_SERVER_URL tidak disetel! Tidak bisa memantau primary server.')
        return false
    }

    let timeoutId = null
    try {
        const controller = new AbortController()
        timeoutId = setTimeout(() => controller.abort(), 5000) // 5s timeout

        const response = await fetch(PRIMARY_SERVER_URL, {
            method: 'GET',
            signal: controller.signal
        })
        
        return response.ok // true jika status 200-299
    } catch (err) {
        // Bisa error network atau timeout
        return false
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
    }
}

async function activateBackupServices() {
    if (isFailoverActive) return
    isFailoverActive = true
    console.log('[Failover] ⚠️ PRIMARY SERVER TERDETEKSI DOWN! Mengaktifkan layanan backup lokal...')

    try {
        // 1. Hubungkan ke MQTT Broker
        connect()

        // 2. Aktifkan Worker BullMQ
        await worker.resume()
        console.log('[Failover] Worker BullMQ di-resume.')

        // 3. Restore Jadwal dari DB ke BullMQ
        await restoreSchedules()

        // 4. Jalankan offline detector
        startOfflineDetector()

        console.log('[Failover] ✅ Layanan backup berhasil diaktifkan dan siap melayani.')
    } catch (err) {
        console.error('[Failover] Gagal mengaktifkan beberapa layanan backup:', err.message)
    }
}

async function deactivateBackupServices() {
    if (!isFailoverActive) return
    isFailoverActive = false
    console.log('[Failover] 💚 PRIMARY SERVER KEMBALI ONLINE! Menonaktifkan layanan backup lokal ke standby...')

    try {
        // 1. Putuskan hubungan MQTT
        disconnect()

        // 2. Pause Worker BullMQ
        await worker.pause()
        console.log('[Failover] Worker BullMQ di-pause.')

        // 3. Matikan offline detector
        stopOfflineDetector()

        console.log('[Failover] ✅ Layanan backup dinonaktifkan kembali ke mode standby.')
    } catch (err) {
        console.error('[Failover] Gagal menonaktifkan beberapa layanan backup:', err.message)
    }
}

async function initFailover() {
    if (!IS_BACKUP_SERVER) {
        console.log('[Failover] Berjalan sebagai PRIMARY SERVER (Railway). Mengaktifkan semua service...')
        // Mode Primary: Langsung nyalakan semuanya
        connect()
        // BullMQ worker default-nya aktif saat dibuat, jadi tidak perlu resume.
        await restoreSchedules()
        startOfflineDetector()
        return
    }

    console.log('[Failover] Berjalan sebagai BACKUP SERVER (VPS) dalam mode Standby.')
    console.log(`[Failover] Memantau primary server di: ${PRIMARY_SERVER_URL} setiap ${PING_INTERVAL_MS / 1000}s`)

    // Mode Backup: Pause worker terlebih dahulu agar tidak memproses antrian saat standby
    try {
        await worker.pause()
        console.log('[Failover] Worker BullMQ di-pause (Standby).')
    } catch (err) {
        console.error('[Failover] Gagal mem-pause Worker BullMQ di startup:', err.message)
    }

    // Jalankan monitoring loop
    pingIntervalId = setInterval(async () => {
        const isPrimaryAlive = await pingPrimary()

        if (isPrimaryAlive) {
            if (isFailoverActive) {
                await deactivateBackupServices()
            }
        } else {
            if (!isFailoverActive) {
                await activateBackupServices()
            }
        }
    }, PING_INTERVAL_MS)
}

module.exports = { initFailover }
