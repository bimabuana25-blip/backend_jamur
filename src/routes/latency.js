const router = require('express').Router()
const { measureLatency } = require('../mqtt/mqttClient')

/**
 * GET /api/latency
 * -----------------------------------------------------------------------------
 * Mengukur RTT (Round-Trip Time) dari backend ke MQTT Broker (HiveMQ Cloud).
 */
router.get('/', async (req, res) => {
    try {
        const rtt = await measureLatency()
        const oneWay = Math.round(rtt / 2)
        res.json({
            success: true,
            backend_to_broker_rtt_ms: rtt,
            estimated_one_way_latency_ms: oneWay,
            message: `Pengukuran berhasil. RTT: ${rtt} ms.`
        })
    } catch (err) {
        console.error('[Latency Route] Gagal mengukur latensi:', err.message)
        res.status(500).json({
            success: false,
            error: err.message
        })
    }
})

module.exports = router
