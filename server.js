require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const mysql = require('mysql2/promise');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const PORT = process.env.PORT || 8000;

// Helper untuk mendapatkan Tanggal & Jam zona WITA (Asia/Makassar)
function getWITATime() {
  const now = new Date();
  const tanggal = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Makassar' }).format(now);
  const jam = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Makassar',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);

  return { tanggal, jamFull: `${tanggal} ${jam}` };
}

// 1. Koneksi Database MySQL Aiven dengan Pool & SSL
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 11340,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 2. Setup Storage Cloudinary untuk Foto Selfie
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'absensi_selfie',
    allowed_formats: ['jpg', 'jpeg', 'png']
  }
});

const upload = multer({ storage: storage });

// -------------------------------------------------------------------------
// ENDPOINT: HAPUS ANGGOTA (DELETE /api/users/:id)
// -------------------------------------------------------------------------
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { peran_pengirim } = req.body;

  if (peran_pengirim !== 'admin_global') {
    return res.status(403).json({ 
      message: 'Akses ditolak. Fitur ini hanya dapat dilakukan oleh Admin Global.' 
    });
  }

  try {
    const [targetUsers] = await db.query('SELECT peran FROM users WHERE id = ?', [id]);
    
    if (targetUsers.length === 0) {
      return res.status(404).json({ message: 'Anggota tidak ditemukan.' });
    }

    if (targetUsers[0].peran === 'admin_global') {
      return res.status(403).json({ message: 'Akun Admin Global tidak dapat dihapus!' });
    }

    const [result] = await db.query('DELETE FROM users WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Anggota tidak ditemukan.' });
    }

    return res.json({ message: 'Anggota berhasil dihapus.' });
  } catch (err) {
    console.error('Gagal menghapus user:', err);
    return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
  }
});

// -------------------------------------------------------------------------
// ENDPOINT: PRESENSI MASUK (POST /api/absensi/masuk)
// -------------------------------------------------------------------------
app.post('/api/absensi/masuk', upload.single('foto'), async (req, res) => {
  try {
    const { user_id, lokasi_id, latitude, longitude } = req.body;
    const fotoFile = req.file;

    if (!user_id || !lokasi_id || !latitude || !longitude || !fotoFile) {
      return res.status(400).json({
        success: false,
        message: 'Data tidak lengkap. user_id, lokasi_id, latitude, longitude, dan foto wajib diisi.'
      });
    }

    // Ambil URL Cloudinary & Tanggal/Jam Akurat WITA
    const fotoPath = fotoFile.path || fotoFile.secure_url;
    const { tanggal, jamFull } = getWITATime();

    const query = `
      INSERT INTO absensi (
        user_id, lokasi_id, tanggal, jam_masuk, 
        lat_masuk, long_masuk, foto_masuk, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'hadir')
    `;

    const values = [
      user_id,
      lokasi_id,
      tanggal,
      jamFull,
      latitude,
      longitude,
      fotoPath
    ];

    const [result] = await db.query(query, values);

    return res.status(201).json({
      success: true,
      message: 'Presensi berhasil dicatat!',
      data: {
        absensi_id: result.insertId,
        user_id: user_id,
        tanggal: tanggal,
        jam_masuk: jamFull,
        foto: fotoPath
      }
    });

  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        success: false,
        message: 'Anda sudah melakukan presensi masuk hari ini!'
      });
    }

    console.error('Database Error:', err);
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan presensi ke database.',
      error: err.message
    });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: ABSEN PULANG (POST /api/absensi/keluar)
// -----------------------------------------------------------------------------
app.post('/api/absensi/keluar', upload.single('foto'), async (req, res) => {
  const { user_id, latitude, longitude } = req.body;
  const fotoPath = req.file ? (req.file.path || req.file.secure_url) : null;

  if (!user_id || !latitude || !longitude || !fotoPath) {
    return res.status(400).json({ success: false, message: 'Data lokasi, foto, atau user ID tidak lengkap.' });
  }

  // Ambil Tanggal & Jam Akurat WITA
  const { tanggal, jamFull } = getWITATime();

  try {
    const query = `
      UPDATE absensi 
      SET jam_keluar = ?, lat_keluar = ?, long_keluar = ?, foto_keluar = ?
      WHERE user_id = ? AND tanggal = ? AND jam_keluar IS NULL
    `;

    const [result] = await db.query(query, [jamFull, latitude, longitude, fotoPath, user_id, tanggal]);

    if (result.affectedRows === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Anda belum absen masuk hari ini atau sudah mencatat absen pulang.' 
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Absen pulang berhasil dicatat!'
    });
  } catch (err) {
    console.error('Error absen keluar:', err);
    return res.status(500).json({ success: false, message: 'Gagal mencatat absen pulang.', error: err.message });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: AMBIL DATA ANGGOTA SESUAI HIRARKI (GET /api/users)
// -----------------------------------------------------------------------------
app.get('/api/users', async (req, res) => {
  const { requester_id } = req.query;

  if (!requester_id || requester_id === 'null' || requester_id === 'undefined') {
    return res.status(400).json({ message: 'ID pengguna tidak valid. Silakan login ulang.' });
  }

  try {
    const [requesters] = await db.query('SELECT id, peran FROM users WHERE id = ?', [requester_id]);

    if (!requesters || requesters.length === 0) {
      return res.status(404).json({ message: 'Akun pemanggil tidak ditemukan.' });
    }

    const requesterRole = (requesters[0].peran || '').toLowerCase().trim();

    let sqlQuery = 'SELECT id, nip, nama_lengkap, email, peran FROM users';
    let queryParams = [];

    if (requesterRole === 'manajer' || requesterRole === 'admin') {
      sqlQuery += ' WHERE LOWER(peran) != ?';
      queryParams.push('admin_global');
    }

    sqlQuery += ' ORDER BY id DESC';

    const [users] = await db.query(sqlQuery, queryParams);
    return res.status(200).json({ data: users });
  } catch (err) {
    console.error('Error fetch users:', err);
    return res.status(500).json({ message: 'Gagal memuat data anggota dari server.' });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: TAMBAH ANGGOTA BARU (POST /api/users)
// -----------------------------------------------------------------------------
app.post('/api/users', async (req, res) => {
  const { nip, nama_lengkap, email, password, peran, requester_id } = req.body;

  if (!requester_id) {
    return res.status(400).json({ success: false, message: 'ID Peminta (requester_id) diperlukan.' });
  }

  try {
    const [userResults] = await db.query('SELECT peran FROM users WHERE id = ?', [requester_id]);

    if (!userResults || userResults.length === 0) {
      return res.status(403).json({ success: false, message: 'Akses ditolak.' });
    }

    const requesterRole = (userResults[0].peran || '').toLowerCase().trim();

    if (requesterRole !== 'admin_global') {
      return res.status(403).json({ success: false, message: 'Akses ditolak. Hanya Admin Global yang dapat membuat anggota baru!' });
    }

    if (!nip || !nama_lengkap || !email || !password) {
      return res.status(400).json({ success: false, message: 'NIP, nama lengkap, email, dan password wajib diisi!' });
    }

    const query = 'INSERT INTO users (nip, nama_lengkap, email, password, peran) VALUES (?, ?, ?, ?, ?)';
    const values = [nip, nama_lengkap, email, password, peran || 'karyawan'];

    const [result] = await db.query(query, values);

    return res.status(201).json({
      success: true,
      message: 'Anggota berhasil ditambahkan!',
      data: { id: result.insertId, nip, nama_lengkap, email, peran: peran || 'karyawan' }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'NIP atau Email sudah terdaftar!' });
    }
    return res.status(500).json({ success: false, message: 'Gagal menambah anggota.', error: err.message });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: LOGIN USER (POST /api/login)
// -----------------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ message: 'NIP/Email dan Password wajib diisi.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id, nip, nama_lengkap, email, password, peran FROM users WHERE nip = ? OR email = ?',
      [identifier, identifier]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: 'NIP / Email tidak terdaftar.' });
    }

    const user = rows[0];

    if (user.password !== password) {
      return res.status(400).json({ message: 'Password salah.' });
    }

    return res.status(200).json({
      message: 'Login berhasil',
      user: {
        id: user.id,
        nip: user.nip,
        nama_lengkap: user.nama_lengkap,
        email: user.email,
        peran: user.peran
      }
    });
  } catch (err) {
    console.error('Login Server Error:', err);
    return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: GANTI PASSWORD (PUT /api/users/change-password)
// -----------------------------------------------------------------------------
app.put('/api/users/change-password', async (req, res) => {
  const { user_id, password_lama, password_baru } = req.body;

  if (!user_id || !password_lama || !password_baru) {
    return res.status(400).json({ success: false, message: 'Semua kolom wajib diisi!' });
  }

  try {
    const [results] = await db.query('SELECT password FROM users WHERE id = ?', [user_id]);

    if (!results || results.length === 0) {
      return res.status(500).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    }

    if (results[0].password !== password_lama) {
      return res.status(400).json({ success: false, message: 'Password lama kamu salah!' });
    }

    await db.query('UPDATE users SET password = ? WHERE id = ?', [password_baru, user_id]);

    return res.status(200).json({ success: true, message: 'Password berhasil diperbarui!' });
  } catch (err) {
    console.error('Error change password:', err);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui password.' });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: REKAPAN / RIWAYAT ABSENSI SESUAI HIRARKI & BATAS 7 HARI
// -----------------------------------------------------------------------------
app.get('/api/absensi/riwayat', async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ success: false, message: 'User ID (user_id) diperlukan.' });
  }

  try {
    const [userResults] = await db.query('SELECT peran FROM users WHERE id = ?', [user_id]);

    if (!userResults || userResults.length === 0) {
      return res.status(403).json({ success: false, message: 'Akses ditolak.' });
    }

    const role = (userResults[0].peran || '').toLowerCase().trim();
    let query = '';
    let params = [];

    if (role === 'admin_global') {
      // 1. Admin Global: Lihat SEMUA riwayat tanpa batasan waktu
      query = `
        SELECT a.id, a.user_id, a.lokasi_id, a.tanggal, a.jam_masuk, a.jam_keluar, 
               a.foto_masuk, a.foto_keluar, u.nama_lengkap, u.nip, u.peran 
        FROM absensi a 
        JOIN users u ON a.user_id = u.id 
        ORDER BY a.tanggal DESC, a.jam_masuk DESC
      `;
    } else if (role === 'manajer') {
      // 2. Manajer: Lihat seluruh anggota KECUALI Admin Global (Maks 7 hari terakhir)
      query = `
        SELECT a.id, a.user_id, a.lokasi_id, a.tanggal, a.jam_masuk, a.jam_keluar, 
               a.foto_masuk, a.foto_keluar, u.nama_lengkap, u.nip, u.peran 
        FROM absensi a 
        JOIN users u ON a.user_id = u.id 
        WHERE u.peran != 'admin_global' 
          AND a.tanggal >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        ORDER BY a.tanggal DESC, a.jam_masuk DESC
      `;
    } else {
      // 3. Admin & Karyawan: Hanya lihat absensi DIRI SENDIRI (Maks 7 hari terakhir)
      query = `
        SELECT a.id, a.user_id, a.lokasi_id, a.tanggal, a.jam_masuk, a.jam_keluar, 
               a.foto_masuk, a.foto_keluar, u.nama_lengkap, u.nip, u.peran 
        FROM absensi a 
        JOIN users u ON a.user_id = u.id 
        WHERE a.user_id = ? 
          AND a.tanggal >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        ORDER BY a.tanggal DESC, a.jam_masuk DESC
      `;
      params = [user_id];
    }

    const [results] = await db.query(query, params);
    return res.status(200).json({ success: true, data: results });
  } catch (err) {
    console.error('Error fetch riwayat:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Gagal mengambil riwayat absensi.', 
      error: err.message 
    });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: HAPUS RIWAYAT ABSENSI (> 7 HARI) - KHUSUS ADMIN GLOBAL
// -----------------------------------------------------------------------------
app.delete('/api/absensi/:id', async (req, res) => {
  const { id } = req.params;
  const { requester_id } = req.body;

  if (!requester_id) {
    return res.status(400).json({ success: false, message: 'ID peminta (requester_id) diperlukan.' });
  }

  try {
    const [userResults] = await db.query('SELECT peran FROM users WHERE id = ?', [requester_id]);
    
    if (!userResults || userResults.length === 0 || (userResults[0].peran || '').toLowerCase().trim() !== 'admin_global') {
      return res.status(403).json({ success: false, message: 'Akses ditolak. Hanya Admin Global yang dapat menghapus data absensi!' });
    }

    // Proteksi: Mencegah penghapusan data 7 hari terakhir
    const [checkRecent] = await db.query(
      'SELECT id FROM absensi WHERE id = ? AND tanggal >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)',
      [id]
    );

    if (checkRecent.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Akses ditolak. Data absensi 7 hari terakhir tidak boleh dihapus!' 
      });
    }

    const [result] = await db.query('DELETE FROM absensi WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Data absensi tidak ditemukan.' });
    }

    return res.status(200).json({ success: true, message: 'Data absensi berhasil dihapus.' });
  } catch (err) {
    console.error('Error hapus absensi:', err);
    return res.status(500).json({ success: false, message: 'Gagal menghapus data absensi.', error: err.message });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: EKSPOR REKAPAN ABSENSI RENTANG TANGGAL (KHUSUS ADMIN GLOBAL)
// -----------------------------------------------------------------------------
app.get('/api/absensi/export', async (req, res) => {
  const { user_id, start_date, end_date } = req.query;

  if (!user_id || !start_date || !end_date) {
    return res.status(400).json({ 
      success: false, 
      message: 'Parameter user_id, start_date, dan end_date wajib diisi.' 
    });
  }

  try {
    const [userResults] = await db.query('SELECT peran FROM users WHERE id = ?', [user_id]);
    
    if (!userResults || userResults.length === 0 || (userResults[0].peran || '').toLowerCase().trim() !== 'admin_global') {
      return res.status(403).json({ 
        success: false, 
        message: 'Akses ditolak. Hanya Admin Global yang dapat mengekspor data absensi!' 
      });
    }

    const query = `
      SELECT a.id, a.user_id, u.nip, u.nama_lengkap, u.peran, a.tanggal, 
             a.jam_masuk, a.jam_keluar, a.status
      FROM absensi a 
      JOIN users u ON a.user_id = u.id 
      WHERE a.tanggal BETWEEN ? AND ? 
      ORDER BY a.tanggal ASC, a.jam_masuk ASC
    `;

    const [results] = await db.query(query, [start_date, end_date]);
    return res.status(200).json({ success: true, data: results });
  } catch (err) {
    console.error('Error export absensi:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Gagal mengambil data ekspor absensi.', 
      error: err.message 
    });
  }
});

// Jalankan Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server REST API berjalan di http://localhost:${PORT}`);
});