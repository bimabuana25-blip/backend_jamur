/**
 * =============================================================================
 * IRRIGATION QUEUE — Antrian Penyiraman
 * =============================================================================
 * File ini mendefinisikan "antrian" penyiraman menggunakan BullMQ.
 *
 * Analogi sederhana:
 * Bayangkan antrian ini seperti "daftar tugas" yang disimpan di Redis.
 * Saat kamu minta "siram sekarang" atau "jadwalkan siram jam 6 pagi",
 * permintaan itu tidak langsung dieksekusi — tapi dulu didaftarkan ke antrian ini.
 * Nanti si Worker (irrigationWorker.js) yang akan mengambil dan mengeksekusinya.
 *
 * Kenapa pakai antrian dan tidak langsung eksekusi saja?
 * - Lebih aman: kalau server mati tiba-tiba, job tidak hilang karena tersimpan di Redis.
 * - Lebih teratur: tidak ada dua job siram yang jalan bersamaan secara tidak terkontrol.
 * - Mendukung jadwal (cron): BullMQ bisa menjalankan tugas berulang sesuai pola waktu.
 *
 * File ini di-import oleh:
 * - routes/schedule.js — untuk mendaftarkan jadwal baru atau siram manual
 * - irrigationWorker.js — untuk tahu ke queue mana ia harus "mendengarkan"
 * =============================================================================
 */

const { Queue } = require('bullmq')

// Koneksi ke Redis menggunakan URL dari .env
// Redis berfungsi sebagai "otak" BullMQ: tempat menyimpan semua data antrian
const connection = { url: process.env.REDIS_URL }

// Buat queue dengan nama 'irrigation'
// Nama ini harus sama persis dengan yang dipakai di Worker!
const irrigationQueue = new Queue('irrigation', { connection })

module.exports = { irrigationQueue, connection }