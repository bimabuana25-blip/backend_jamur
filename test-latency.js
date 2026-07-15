require('dotenv').config();
const mqtt = require('mqtt');

console.log('=== HIVE MQTT LATENCY TESTER ===');
console.log('Menghubungkan ke:', process.env.MQTT_BROKER_URL);

const client = mqtt.connect(process.env.MQTT_BROKER_URL, {
    port: parseInt(process.env.MQTT_PORT) || 8883,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    protocol: 'mqtts',
    clientId: `latency-tester-${Date.now()}`,
    clean: true,
});

const TOPIC_SENSOR = 'sensor/sht31';
const TOPIC_RELAY_WILDCARD = 'cmd/relay/+';
const TOPIC_PING = 'latency/test/ping';

// Map untuk mencatat waktu kirim perintah relay
const pendingCommands = new Map();

// Map untuk melacak waktu pengiriman ping loopback
const pingSentTimes = new Map();
const pingPubAckTimes = new Map();

client.on('connect', () => {
    console.log('✅ Terhubung ke HiveMQ Cloud!');
    console.log('--------------------------------------------------');
    console.log('1. Silakan lakukan aksi di Flutter app untuk tes latensi kontrol.');
    console.log('2. Atau tekan [ENTER] di terminal ini untuk tes ping.');
    console.log('--------------------------------------------------');
    
    // Subscribe ke topik sensor, perintah, dan ping
    client.subscribe([TOPIC_SENSOR, TOPIC_RELAY_WILDCARD, TOPIC_PING], (err) => {
        if (err) console.error('❌ Gagal subscribe:', err.message);
    });
});

client.on('message', (topic, payload) => {
    const now = Date.now();
    const timeStr = new Date().toLocaleTimeString();

    // 1. Logika untuk Ping Loopback (Mengukur Backend -> MQTT dan MQTT -> Backend secara presisi)
    if (topic === TOPIC_PING) {
        try {
            const data = JSON.parse(payload.toString());
            const { pingId } = data;
            const t_receive = now;
            
            const t0 = pingSentTimes.get(pingId);
            if (t0) {
                const totalRTT = t_receive - t0;         // Total waktu bolak-balik
                const oneWayLatency = Math.round(totalRTT / 2); // Estimasi satu arah
                
                console.log(`\n[${timeStr}] ⚡ HASIL PENGUKURAN LATENSI:`);
                console.log(` 🔸 1. Backend ➔ MQTT Broker (Kirim Perintah) : ${oneWayLatency} ms`);
                console.log(` 🔸 2. MQTT Broker ➔ Backend (Terima Data ESP)   : ${oneWayLatency} ms`);
                console.log(` ➔ Total Round-Trip Time (RTT)                   : ${totalRTT} ms`);
                console.log(`--------------------------------------------------`);
                
                // Bersihkan memori cache
                pingSentTimes.delete(pingId);
                pingPubAckTimes.delete(pingId);
            }
        } catch (e) {}
        return;
    }

    // 2. Jika menerima pesan perintah relay
    if (topic.startsWith('cmd/relay/')) {
        const deviceId = topic.split('/')[2];
        const state = payload.toString().trim();
        console.log(`[${timeStr}] 📤 Perintah [${state}] terkirim ke device: ${deviceId}`);
        pendingCommands.set(deviceId, {
            targetState: state === 'ON',
            sentAt: now
        });
        return;
    }

    // 3. Jika menerima data sensor dari ESP32
    if (topic === TOPIC_SENSOR) {
        try {
            const data = JSON.parse(payload.toString());
            const deviceId = data.device_id || 'esp32-01';
            const relayState = data.relay_state ?? data.relay ?? false;
            
            console.log(`[${timeStr}] 📥 Data sensor masuk dari ${deviceId} (Suhu: ${data.temp || data.temperature}°C | Hum: ${data.hum || data.humidity}% | Relay: ${relayState})`);
            
            // Cek apakah ada perintah relay yang sedang ditunggu responnya
            const pending = pendingCommands.get(deviceId);
            if (pending && pending.targetState === relayState) {
                const latency = now - pending.sentAt;
                console.log(`🔥 [Control RTT] Perintah dikirim hingga status terkonfirmasi: ${latency} ms`);
                console.log(`      └─ Estimasi Latensi Kirim Perintah (Backend ➔ ESP32): ${Math.round(latency / 2)} ms`);
                pendingCommands.delete(deviceId);
            }
        } catch (e) {
            console.log(`[${timeStr}] 📥 Data sensor masuk (Bukan JSON):`, payload.toString());
        }
    }
});

client.on('error', (err) => {
    console.error('❌ MQTT Error:', err.message);
});

// Setup agar saat menekan Enter di terminal akan memicu publish ping ke HiveMQ
process.stdin.on('data', () => {
    if (client.connected) {
        const pingId = Math.random().toString(36).substring(7);
        const t0 = Date.now();
        pingSentTimes.set(pingId, t0);

        // Gunakan QoS 1 agar mendapatkan callback PUBACK dari broker saat pesan sukses diterima broker
        client.publish(TOPIC_PING, JSON.stringify({ pingId }), { qos: 1 }, (err) => {
            if (!err) {
                const t_puback = Date.now();
                pingPubAckTimes.set(pingId, t_puback);
            } else {
                console.error('❌ Gagal publish ping:', err.message);
            }
        });
    }
});
