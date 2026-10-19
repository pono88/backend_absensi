require('dotenv').config();
const express = require('express');
//const mysql = require('mysql2');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(express.json());

// TENTUKAN PORT DARI PROCESS.ENV ATAU DEFAULT 8000
const PORT = process.env.PORT || 8000;

// 1. Koneksi Database MySQL Aiven
// const db = mysql.createConnection({
//   host: process.env.DB_HOST,
//   port: process.env.DB_PORT,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME
// });

// db.connect((err) => {
//   if (err) {
//     console.error('Gagal terhubung ke database Aiven:', err);
//   } else {
//     console.log('Berhasil terhubung ke database Aiven MySQL!');
//   }
// });

const mysql = require('mysql2/promise');

// 1. Koneksi Database MySQL Aiven dengan Pool & SSL
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 11340,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false // Wajib untuk Aiven MySQL
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Hapus atau beri komentar pada bagian db.connect() lama
// karena mysql.createPool mengelola koneksi secara otomatis

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

// Endpoint Hapus Anggota (Khusus Admin Global)
app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { peran_pengirim } = req.body;

  // Validasi Peran
  if (peran_pengirim !== 'admin_global') {
    return res.status(403).json({ 
      message: 'Akses ditolak. Fitur ini hanya dapat dilakukan oleh Admin Global.' 
    });
  }

  // Hapus data pengguna dari database Aiven
  const sql = 'DELETE FROM users WHERE id = ?';
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error('Gagal menghapus user:', err);
      return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Anggota tidak ditemukan.' });
    }
    res.json({ message: 'Anggota berhasil dihapus.' });
  });
});

// -------------------------------------------------------------------------
// ENDPOINT: PRESENSI MASUK (POST /api/absensi/masuk)
// -------------------------------------------------------------------------
app.post('/api/absensi/masuk', upload.single('foto'), (req, res) => {
  try {
    const { user_id, lokasi_id, latitude, longitude } = req.body;
    const fotoFile = req.file;

    // Validasi input
    if (!user_id || !lokasi_id || !latitude || !longitude || !fotoFile) {
      return res.status(400).json({
        success: false,
        message: 'Data tidak lengkap. user_id, lokasi_id, latitude, longitude, dan foto wajib diisi.'
      });
    }

    const fotoPath = `uploads/${fotoFile.filename}`;
    const tanggalSekarang = new Date().toISOString().split('T')[0];
    const jamSekarang = new Date();

    // Query simpan ke tabel absensi
    const query = `
      INSERT INTO absensi (
        user_id, lokasi_id, tanggal, jam_masuk, 
        lat_masuk, long_masuk, foto_masuk, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'hadir')
    `;

    const values = [
      user_id,
      lokasi_id,
      tanggalSekarang,
      jamSekarang,
      latitude,
      longitude,
      fotoPath
    ];

    db.query(query, values, (err, result) => {
      if (err) {
        // Tangani jika user sudah absen hari ini
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

      return res.status(201).json({
        success: true,
        message: 'Presensi berhasil dicatat!',
        data: {
          absensi_id: result.insertId,
          user_id: user_id,
          tanggal: tanggalSekarang,
          foto: fotoPath
        }
      });
    });

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server backend.'
    });
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT: ABSEN PULANG (POST /api/absensi/keluar)
// -----------------------------------------------------------------------------
app.post('/api/absensi/keluar', upload.single('foto'), (req, res) => {
  const { user_id, latitude, longitude } = req.body;
  const fotoPath = req.file ? req.file.path.replace(/\\/g, '/') : null;
  const tanggalSekarang = new Date().toISOString().split('T')[0];
  const jamSekarang = new Date();

  if (!user_id || !latitude || !longitude || !fotoPath) {
    return res.status(400).json({ success: false, message: 'Data lokasi, foto, atau user ID tidak lengkap.' });
  }

  // Update record absensi hari ini yang jam_keluar-nya masih NULL
  const query = `
    UPDATE absensi 
    SET jam_keluar = ?, lat_keluar = ?, long_keluar = ?, foto_keluar = ?
    WHERE user_id = ? AND tanggal = ? AND jam_keluar IS NULL
  `;

  db.query(query, [jamSekarang, latitude, longitude, fotoPath, user_id, tanggalSekarang], (err, result) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Gagal mencatat absen pulang.', error: err.message });
    }

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
  });
});

// -----------------------------------------------------------------------------
// ENDPOINT: AMBIL DATA ANGGOTA SESUAI HIRARKI (GET /api/users)
// -----------------------------------------------------------------------------
app.get('/api/users', async (req, res) => {
  const { requester_id } = req.query;

  // Validasi jika requester_id kosong atau bernilai string 'null'
  if (!requester_id || requester_id === 'null' || requester_id === 'undefined') {
    return res.status(400).json({ message: 'ID pengguna tidak valid. Silakan login ulang.' });
  }

  try {
    // Ambil data peran dari pemanggil
    const [requesters] = await db.query('SELECT id, peran FROM users WHERE id = ?', [requester_id]);

    if (!requesters || requesters.length === 0) {
      return res.status(404).json({ message: 'Akun pemanggil tidak ditemukan.' });
    }

    const requesterRole = (requesters[0].peran || '').toLowerCase().trim();

    let sqlQuery = 'SELECT id, nip, nama_lengkap, email, peran FROM users';
    let queryParams = [];

    // Jika manajer atau admin biasa, sembunyikan admin_global
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
app.post('/api/users', (req, res) => {
  const { nip, nama_lengkap, email, password, peran, requester_id } = req.body;

  if (!requester_id) {
    return res.status(400).json({ success: false, message: 'ID Peminta (requester_id) diperlukan.' });
  }

  db.query('SELECT peran FROM users WHERE id = ?', [requester_id], (err, userResults) => {
    if (err || userResults.length === 0) {
      return res.status(403).json({ success: false, message: 'Akses ditolak.' });
    }

    const requesterRole = userResults[0].peran;

    // Hanya Admin Global yang memiliki izin membuat anggota baru
    if (requesterRole !== 'admin_global') {
      return res.status(403).json({ success: false, message: 'Akses ditolak. Hanya Admin Global yang dapat membuat anggota baru!' });
    }

    if (!nip || !nama_lengkap || !email || !password) {
      return res.status(400).json({ success: false, message: 'NIP, nama lengkap, email, dan password wajib diisi!' });
    }

    const query = 'INSERT INTO users (nip, nama_lengkap, email, password, peran) VALUES (?, ?, ?, ?, ?)';
    const values = [nip, nama_lengkap, email, password, peran || 'karyawan'];

    db.query(query, values, (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ success: false, message: 'NIP atau Email sudah terdaftar!' });
        }
        return res.status(500).json({ success: false, message: 'Gagal menambah anggota.', error: err.message });
      }

      return res.status(201).json({
        success: true,
        message: 'Anggota berhasil ditambahkan!',
        data: { id: result.insertId, nip, nama_lengkap, email, peran: peran || 'karyawan' }
      });
    });
  });
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
    // Cari user berdasarkan NIP atau Email
    const [rows] = await db.query(
      'SELECT id, nip, nama_lengkap, email, password, peran FROM users WHERE nip = ? OR email = ?',
      [identifier, identifier]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: 'NIP / Email tidak terdaftar.' });
    }

    const user = rows[0];

    // Cek kecocokan password
    if (user.password !== password) {
      return res.status(400).json({ message: 'Password salah.' });
    }

    // Kirim respon sukses beserta data user
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
app.put('/api/users/change-password', (req, res) => {
  const { user_id, password_lama, password_baru } = req.body;

  if (!user_id || !password_lama || !password_baru) {
    return res.status(400).json({ success: false, message: 'Semua kolom wajib diisi!' });
  }

  db.query('SELECT password FROM users WHERE id = ?', [user_id], (err, results) => {
    if (err || results.length === 0) {
      return res.status(500).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    }

    if (results[0].password !== password_lama) {
      return res.status(400).json({ success: false, message: 'Password lama kamu salah!' });
    }

    db.query('UPDATE users SET password = ? WHERE id = ?', [password_baru, user_id], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Gagal memperbarui password.' });
      }
      return res.status(200).json({ success: true, message: 'Password berhasil diperbarui!' });
    });
  });
});

// -----------------------------------------------------------------------------
// ENDPOINT: REKAPAN / RIWAYAT ABSENSI SESUAI HIRARKI (GET /api/absensi/riwayat)
// -----------------------------------------------------------------------------
app.get('/api/absensi/riwayat', (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ success: false, message: 'User ID (user_id) diperlukan.' });
  }

  // Cek peran peminta di database
  db.query('SELECT peran FROM users WHERE id = ?', [user_id], (err, userResults) => {
    if (err || userResults.length === 0) {
      return res.status(403).json({ success: false, message: 'Akses ditolak.' });
    }

    const role = userResults[0].peran;
    let query = '';
    let params = [];

    if (role === 'admin_global') {
      // Admin Global: Melihat rekapan absensi SELURUH anggota
      query = `
        SELECT a.*, u.nama_lengkap, u.nip, u.peran 
        FROM absensi a 
        JOIN users u ON a.user_id = u.id 
        ORDER BY a.tanggal DESC, a.jam_masuk DESC
      `;
    } else if (role === 'admin') {
      // Admin: Melihat rekapan absensi semua anggota KECUALI Admin Global
      query = `
        SELECT a.*, u.nama_lengkap, u.nip, u.peran 
        FROM absensi a 
        JOIN users u ON a.user_id = u.id 
        WHERE u.peran != 'admin_global' 
        ORDER BY a.tanggal DESC, a.jam_masuk DESC
      `;
    } else if (role === 'manajer') {
      // Manajer: Melihat rekapan absensi semua anggota KECUALI Admin Global dan Admin
      query = `
        SELECT a.*, u.nama_lengkap, u.nip, u.peran 
        FROM absensi a 
        JOIN users u ON a.user_id = u.id 
        WHERE u.peran NOT IN ('admin_global', 'admin') 
        ORDER BY a.tanggal DESC, a.jam_masuk DESC
      `;
    } else {
      // Karyawan: Hanya melihat rekapan absensi dirinya sendiri
      query = `
        SELECT a.*, u.nama_lengkap, u.nip, u.peran 
        FROM absensi a 
        JOIN users u ON a.user_id = u.id 
        WHERE a.user_id = ? 
        ORDER BY a.tanggal DESC, a.jam_masuk DESC
      `;
      params = [user_id];
    }

    db.query(query, params, (err, results) => {
      if (err) {
        return res.status(500).json({ 
          success: false, 
          message: 'Gagal mengambil riwayat absensi.', 
          error: err.message 
        });
      }
      return res.status(200).json({ success: true, data: results });
    });
  });
});

// Jalankan Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server REST API berjalan di http://localhost:${PORT}`);
});