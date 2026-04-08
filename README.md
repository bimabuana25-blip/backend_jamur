# 🍄 Backend IoT Kumbung Jamur

Backend Node.js untuk sistem monitoring dan kontrol otomatis kumbung jamur berbasis IoT. Sistem ini menghubungkan sensor SHT31 dan relay pada ESP32 ke aplikasi mobile Flutter melalui MQTT, dengan penjadwalan penyiraman otomatis menggunakan BullMQ dan Supabase sebagai database utama.

---

## 🏗️ Arsitektur Sistem

```
Flutter App
    │
    ▼ REST API (HTTP)
┌──────────────────┐
│  Express Server  │
│   (index.js)     │
└────────┬─────────┘
         │
   ┌─────┼─────────┐
   ▼     ▼         ▼
Supabase  BullMQ  MQTT Client
(DB)    (Queue)  (HiveMQ Cloud)
                     │
                     ▼ MQTT (mqtts://)
                  ESP32 + DHT22
```

**Alur Data:**
1. ESP32 membaca sensor DHT22 dan mengirim data ke MQTT topic `sensor/dht22`
2. Backend menerima data sensor, menyimpan ke Supabase, lalu otomatis menyalakan/mematikan relay berdasarkan threshold
3. Aplikasi Flutter mengontrol threshold, jadwal penyiraman, dan memantau data sensor melalui REST API

---

## 📋 Prasyarat

Pastikan sudah memiliki akun dan konfigurasi berikut:

| Layanan | Keterangan |
|---|---|
| [Supabase](https://supabase.com) | Database PostgreSQL (gratis) |
| [HiveMQ Cloud](https://www.hivemq.com/mqtt-cloud-broker/) | MQTT Broker TLS (gratis) |
| [Upstash Redis](https://upstash.com) | Redis untuk BullMQ queue (gratis) |
| Node.js >= 18 | Runtime JavaScript |

---

## ⚙️ Instalasi & Konfigurasi

### 1. Clone & Install Dependencies

```bash
npm install
```

### 2. Setup Environment Variables

Buat file `.env` di root folder, lalu isi dengan nilai dari dashboard masing-masing layanan:

```env
# Supabase — ambil dari: Project Settings > API
SUPABASE_URL=https://xxxxxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_xxxxxxxxxxxxxxxx

# HiveMQ Cloud — ambil dari: Clusters > MQTT Credentials
MQTT_BROKER_URL=mqtts://xxxxxxxxxxxxxxxxxxxxxxxx.s1.eu.hivemq.cloud:8883
MQTT_PORT=8883
MQTT_USERNAME=username_hivemq_kamu
MQTT_PASSWORD=password_hivemq_kamu

# Upstash Redis — ambil dari: Database > Details > Connection URL
REDIS_URL=rediss://default:xxxxxxxx@xxxx.upstash.io:6379
```

> ⚠️ **Jangan commit file `.env` ke Git!** File ini sudah tercantum di `.gitignore`.

### 3. Setup Database Supabase

Buat tabel-tabel berikut di Supabase SQL Editor:

```sql
-- Tabel perangkat ESP32
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT UNIQUE NOT NULL,       -- e.g. "esp32-01"
    label TEXT,                           -- nama display e.g. "Kumbung A"
    location TEXT,
    claim_code TEXT UNIQUE,               -- kode klaim uppercase, e.g. "ABC123"
    claimed_by UUID REFERENCES auth.users(id),
    claimed_at TIMESTAMPTZ,
    is_online BOOLEAN DEFAULT false,
    last_seen TIMESTAMPTZ
);

-- Tabel log sensor DHT22
CREATE TABLE sensor_logs (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    temperature FLOAT,
    humidity FLOAT,
    relay_state TEXT,
    event TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel threshold per device
CREATE TABLE thresholds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT UNIQUE NOT NULL,
    temp_max FLOAT NOT NULL DEFAULT 30.0,    -- suhu max sebelum relay ON
    hum_max FLOAT NOT NULL DEFAULT 85.0,     -- kelembapan max sebelum relay ON
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel jadwal penyiraman
CREATE TABLE schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL,
    label TEXT,
    cron TEXT NOT NULL,          -- contoh: "0 6 * * *" = setiap hari jam 06:00
    duration_s INTEGER NOT NULL, -- durasi penyiraman dalam detik
    bull_job_id TEXT,            -- referensi job ID di BullMQ
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4. Jalankan Server

```bash
# Mode development (auto-restart saat file berubah)
npm run dev

# Mode production
npm start
```

Server berjalan di `http://localhost:3000`.

---

## 🚀 Deploy ke Railway

Railway adalah platform cloud yang memudahkan deploy aplikasi Node.js hanya dalam beberapa menit, tanpa perlu konfigurasi server manual.

### Langkah 1 — Push Code ke GitHub

Pastikan kodenya sudah ada di GitHub terlebih dahulu.

```bash
git add .
git commit -m "feat: ready for railway deployment"
git push origin main
```

> ⚠️ Pastikan file `.env` **tidak ikut ter-push** (sudah dikecualikan di `.gitignore`).

---

### Langkah 2 — Buat Project di Railway

1. Buka [railway.app](https://railway.app) dan login (bisa pakai akun GitHub)
2. Klik **New Project**
3. Pilih **Deploy from GitHub repo**
4. Pilih repository backend kamu
5. Railway akan otomatis mendeteksi bahwa ini adalah aplikasi Node.js

---

### Langkah 3 — Set Environment Variables

Ini adalah langkah **paling penting**. Tanpa ini, server tidak bisa terhubung ke Supabase, MQTT, atau Redis.

Buka tab **Variables** di dashboard Railway project kamu, lalu klik **New Variable** dan masukkan satu per satu:

| Variable | Deskripsi | Ambil dari mana |
|---|---|---|
| `SUPABASE_URL` | URL project Supabase | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Service role key Supabase | Supabase → Project Settings → API |
| `MQTT_BROKER_URL` | URL broker HiveMQ Cloud | HiveMQ → Clusters → Connection Settings |
| `MQTT_PORT` | Port MQTT, isi `8883` | Selalu `8883` untuk HiveMQ Cloud TLS |
| `MQTT_USERNAME` | Username HiveMQ | HiveMQ → Clusters → Credentials |
| `MQTT_PASSWORD` | Password HiveMQ | HiveMQ → Clusters → Credentials |
| `REDIS_URL` | URL koneksi Redis Upstash | Upstash → Database → Details → Connection URL |

> ⚠️ **Jangan tambahkan variabel `PORT`** — Railway sudah menyediakan nilai ini secara otomatis. Kalau ditambahkan manual, bisa konflik.

Kamu juga bisa klik **Raw Editor** untuk paste semua variabel sekaligus dari file `.env` lokal kamu (hapus baris komentar `#` terlebih dahulu).

---

### Langkah 4 — Tunggu Deploy Selesai

Setelah variabel diisi, Railway akan otomatis men-trigger deployment ulang. Pantau prosesnya di tab **Deployments**.

Kalau semua berjalan lancar, kamu akan melihat log seperti ini:
```
[MQTT] Terhubung ke HiveMQ Cloud
[Server] Running on port 8080
```

> 💡 Port yang tampil mungkin bukan 3000, karena Railway assign port-nya sendiri. Itu normal dan sudah ditangani di kode.

---

### Langkah 5 — Ambil URL Publik

Setelah deploy berhasil:
1. Buka tab **Settings** di Railway project
2. Di bagian **Networking**, klik **Generate Domain**
3. Railway akan memberi URL publik seperti: `https://nama-project-kamu.up.railway.app`

URL inilah yang dipakai sebagai **Base URL** di aplikasi Flutter kamu, menggantikan `http://localhost:3000`.

---

### ✅ Checklist Sebelum Deploy

- [ ] File `.env` sudah **tidak** masuk ke Git (`git status` tidak menampilkan `.env`)
- [ ] Semua 7 environment variables sudah diisi di Railway
- [ ] Repository sudah di-push ke GitHub (branch `main`)
- [ ] Akun Supabase, HiveMQ, dan Upstash masih aktif

---

## 🔌 API Reference

Base URL (lokal): `http://localhost:3000/api`
Base URL (production): `https://nama-project-kamu.up.railway.app/api`

> ⚠️ **Rate Limiting**: Semua endpoint dibatasi **100 request/menit per IP**. Endpoint trigger siram manual dibatasi lebih ketat: **5 request/menit**.

---

### 📱 Device

#### Klaim Device (Pasangkan Device ke Akun User)

```
POST /api/device/claim
```

Dipanggil setelah user berhasil register/login, untuk menghubungkan perangkat fisik ke akun user.

**Request Body:**
```json
{
    "claim_code": "ABC123",
    "user_id": "uuid-user-dari-supabase-auth"
}
```

**Response Sukses (200):**
```json
{
    "message": "Device berhasil diklaim",
    "device": {
        "device_id": "esp32-01",
        "label": "Kumbung Jamur 1",
        "location": "Ruang A"
    }
}
```

**Kemungkinan Error:**
| Status | Pesan | Penyebab |
|---|---|---|
| 400 | `claim_code dan user_id wajib diisi` | Body tidak lengkap |
| 404 | `Kode tidak ditemukan` | `claim_code` salah atau tidak terdaftar |
| 409 | `Device sudah diklaim oleh pengguna lain` | Device sudah dimiliki orang lain |
| 409 | `Anda sudah memiliki device terdaftar` | User ini sudah pernah klaim device lain |

---

#### Ambil Device Milik User

```
GET /api/device/my-device/:userId
```

**Contoh:**
```
GET /api/device/my-device/550e8400-e29b-41d4-a716-446655440000
```

**Response Sukses (200):**
```json
{
    "device_id": "esp32-01",
    "label": "Kumbung Jamur 1",
    "location": "Ruang A",
    "is_online": true,
    "last_seen": "2026-04-08T10:00:00Z"
}
```

---

### 🌡️ Threshold

Atur batas suhu dan kelembapan yang memicu relay otomatis menyala.

#### Ambil Threshold Saat Ini

```
GET /api/threshold/:deviceId
```

**Response Sukses (200):**
```json
{
    "device_id": "esp32-01",
    "temp_max": 30.0,
    "hum_max": 85.0,
    "updated_at": "2026-04-08T09:00:00Z"
}
```

#### Update Threshold

```
POST /api/threshold/:deviceId
```

**Request Body:**
```json
{
    "temp_max": 32.5,
    "hum_max": 88.0
}
```

**Response Sukses (200):**
```json
{
    "message": "Threshold diupdate",
    "data": { "device_id": "esp32-01", "temp_max": 32.5, "hum_max": 88.0 }
}
```

> 💡 Saat update threshold berhasil, nilai baru langsung dikirim ke ESP32 via MQTT topic `config/threshold` **dan** cache in-memory diperbarui secara instan.

---

### 🗓️ Jadwal Penyiraman

#### Ambil Semua Jadwal

```
GET /api/schedule/:deviceId
```

**Response Sukses (200):**
```json
[
    {
        "id": "uuid-jadwal",
        "device_id": "esp32-01",
        "label": "Siram Pagi",
        "cron": "0 6 * * *",
        "duration_s": 60,
        "is_active": true,
        "created_at": "2026-04-01T00:00:00Z"
    }
]
```

#### Buat Jadwal Baru

```
POST /api/schedule/:deviceId
```

**Request Body:**
```json
{
    "label": "Siram Sore",
    "cron": "0 17 * * *",
    "duration_s": 90
}
```

> 💡 **Format Cron:** `menit jam hari bulan hari-minggu`
> - `"0 6 * * *"` → setiap hari jam 06:00
> - `"0 6,17 * * *"` → setiap hari jam 06:00 dan 17:00
> - `"*/30 * * * *"` → setiap 30 menit

**Response Sukses (201):**
```json
{
    "id": "uuid-baru",
    "device_id": "esp32-01",
    "label": "Siram Sore",
    "cron": "0 17 * * *",
    "duration_s": 90,
    "is_active": true
}
```

#### Hapus Jadwal

```
DELETE /api/schedule/:id
```

Menghapus jadwal dari database **dan** membatalkan job dari antrian BullMQ.

**Response Sukses (200):**
```json
{
    "message": "Jadwal dihapus"
}
```

#### Aktifkan / Nonaktifkan Jadwal (Toggle)

```
PATCH /api/schedule/:id/toggle
```

Menonaktifkan jadwal tanpa menghapusnya. Job di BullMQ dihapus sementara, dan bisa diaktifkan kembali kapan saja.

**Response Sukses (200):**
```json
{
    "message": "Jadwal dinonaktifkan",
    "data": { "id": "uuid", "is_active": false }
}
```

#### Trigger Siram Manual (Sekali Jalan)

```
POST /api/schedule/:deviceId/now
```

Menyiram sekarang juga tanpa membuat jadwal permanen.

**Request Body (opsional):**
```json
{
    "duration_s": 30
}
```
> Jika body tidak dikirim, default durasi adalah **30 detik**.

**Response Sukses (200):**
```json
{
    "message": "Siram manual 30s dijadwalkan"
}
```

#### Hentikan Pompa Sekarang

```
POST /api/schedule/:deviceId/stop
```

Mengirim perintah `OFF` ke relay secara langsung via MQTT.

**Response Sukses (200):**
```json
{
    "message": "Pompa dimatikan"
}
```

---

### 📊 Riwayat Sensor

#### Ambil Data Sensor Terbaru

```
GET /api/history/:deviceId?limit=100
```

| Query Param | Default | Maks | Keterangan |
|---|---|---|---|
| `limit` | 100 | 500 | Jumlah data yang diambil |

**Response Sukses (200):**
```json
[
    {
        "temperature": 28.5,
        "humidity": 82.3,
        "relay_state": "OFF",
        "created_at": "2026-04-08T10:00:00Z"
    }
]
```

#### Rata-rata Harian

```
GET /api/history/:deviceId/daily?days=7
```

Mengambil rata-rata suhu dan kelembapan per hari (memanggil stored procedure `get_daily_average` di Supabase).

| Query Param | Default | Keterangan |
|---|---|---|
| `days` | 7 | Jumlah hari ke belakang |

---

## 📡 MQTT Topics

Komunikasi antara backend dan ESP32 menggunakan MQTT over TLS (mqtts).

| Topic | Arah | Payload | Keterangan |
|---|---|---|---|
| `sensor/dht22` | ESP32 → Backend | `{"device_id":"esp32-01","temp":28.5,"hum":82.3}` | Data sensor real-time |
| `config/threshold` | Backend → ESP32 | `{"temp":30.0,"hum":85.0}` | Update batas threshold |
| `cmd/relay/{deviceId}` | Backend → ESP32 | `"ON"` atau `"OFF"` | Perintah nyala/mati relay |

---

## 🔁 Sistem Antrian (BullMQ)

Penyiraman terjadwal diproses via **BullMQ** dengan Redis (Upstash) sebagai backing store. Ini memastikan jadwal tetap berjalan meskipun server restart.

**Alur Worker:**
1. Job masuk ke queue `irrigation`
2. Worker memerintahkan relay `ON` via MQTT
3. Worker menunggu selama `duration_s` detik
4. Worker memerintahkan relay `OFF` via MQTT

---

## 📁 Struktur Folder

```
backend/
├── src/
│   ├── index.js              # Entry point, setup Express & rate limiter
│   ├── mqtt/
│   │   └── mqttClient.js     # Koneksi ke HiveMQ, subscriber sensor, publisher relay
│   ├── queues/
│   │   ├── irrigationQueue.js # Definisi queue BullMQ
│   │   └── irrigationWorker.js# Worker yang memproses job penyiraman
│   ├── routes/
│   │   ├── device.js         # POST /claim, GET /my-device
│   │   ├── threshold.js      # GET & POST threshold
│   │   ├── schedule.js       # CRUD jadwal + trigger manual
│   │   └── history.js        # GET riwayat sensor
│   └── supabase/
│       └── client.js         # Inisialisasi Supabase client
├── .env                      # Variabel lingkungan (jangan di-commit!)
├── .gitignore
└── package.json
```

---

## 🚀 Dependencies Utama

| Package | Versi | Fungsi |
|---|---|---|
| `express` | ^5.2.1 | HTTP server & routing |
| `@supabase/supabase-js` | ^2.101.1 | Client database Supabase |
| `mqtt` | ^5.15.1 | Koneksi ke MQTT broker |
| `bullmq` | ^5.73.0 | Job queue penyiraman terjadwal |
| `ioredis` | ^5.10.1 | Koneksi ke Redis (Upstash) |
| `express-rate-limit` | ^8.3.2 | Proteksi rate limiting |
| `dotenv` | ^17.4.1 | Load environment variables |
| `nodemon` | ^3.1.14 | Auto-restart saat development |
