# PaceCraft – Generator TCX Lari

**PaceCraft** adalah aplikasi web statis yang menghasilkan file TCX simulasi berdasarkan rute lari dari file GPX yang diunggah.

> ⚠️ Data performa (pace, HR, cadence) merupakan **simulasi**, bukan rekaman perangkat nyata.

---

## Cara Menjalankan

### Tanpa instalasi (buka langsung di browser)

Cukup buka file `index.html` di browser modern (Chrome, Firefox, Safari, Edge).

```
Klik dua kali file index.html
```

> **Catatan:** Peta menggunakan OpenStreetMap via Leaflet.js — membutuhkan koneksi internet. Jika offline, rute tetap tampil sebagai garis di atas kanvas abu-abu (mode fallback).

### Via server lokal (opsional, untuk menghindari batasan CORS)

```bash
# Python 3
python3 -m http.server 8080

# Node.js (npx)
npx serve .

# PHP
php -S localhost:8080
```

Lalu buka: `http://localhost:8080`

---

## Cara Menggunakan

1. **Unggah GPX** – seret file GPX ke zona upload atau klik untuk memilih file.
2. **Lihat rute** – peta otomatis muncul dengan garis rute berwarna oranye.
3. **Atur detail aktivitas** – nama, deskripsi, tanggal, waktu (WIB), dan perangkat.
4. **Atur Pace & Split** – pace rata-rata (menit:detik/km), variasi pace, dan tren split.
5. **Atur HR & Cadence** – nilai minimum, rata-rata, dan maksimum HR; cadence rata-rata.
6. **Lihat ringkasan** – statistik, tabel split per km, dan grafik pace/HR.
7. **Unduh TCX** – klik tombol oranye untuk mengunduh file TCX siap impor.
8. **Acak ulang** – klik "Acak ulang variasi" untuk pola baru dengan pengaturan yang sama.

---

## Fitur

| Fitur | Keterangan |
|---|---|
| Upload GPX | Drag-and-drop atau pilih file |
| Validasi GPX | XML, koordinat, ukuran, titik duplikat |
| Peta interaktif | OpenStreetMap + Leaflet; fallback canvas offline |
| Kalkulasi jarak | Haversine dari koordinat GPX |
| Simulasi pace | Variasi bertahap + tren split |
| Simulasi HR | Pola pemanasan, naik bertahap, dalam batas min–maks |
| Simulasi cadence | Variasi ringan sekitar rata-rata target |
| Grafik | Pace dan HR berdasarkan data simulasi aktual |
| Tabel split | Per kilometer + sisa jarak |
| Download TCX | Nama file = nama lari |
| Tema terang/gelap | Mengikuti preferensi perangkat; tersimpan di localStorage |
| Responsif | Desktop & HP, satu kolom di layar kecil |

---

## Perangkat yang Didukung (dalam file TCX)

- **Garmin Forerunner 55** – ProductID 4001
- **Amazfit Active Edge** – ProductID 0

Namespace garmin.com digunakan sebagai format TCX standar untuk kedua perangkat.

---

## Struktur File

```
PaceCraft/
├── index.html   – Halaman utama aplikasi
├── style.css    – Semua gaya tampilan
├── app.js       – Logika JavaScript (parser GPX, simulasi, generator TCX)
├── test.js      – Pengujian unit (jalankan via Node.js)
└── README.md    – Dokumentasi ini
```

---

## Memasang di Hosting

PaceCraft adalah web statis murni — tidak perlu backend atau database.

### GitHub Pages

```bash
git init
git add .
git commit -m "PaceCraft v1.0"
gh repo create pacecraft --public --push --source=.
# Aktifkan Pages di Settings → Pages → Branch: main
```

### Netlify (drag-and-drop)

Kunjungi [app.netlify.com](https://app.netlify.com), lalu seret folder PaceCraft ke area deploy.

### Vercel

```bash
npx vercel --prod
```

### Hosting biasa (cPanel, shared hosting)

Upload semua file ke direktori `public_html` atau subdirektori pilihan Anda.

---

## Catatan Teknis

- **Konversi zona waktu:** Input waktu WIB (UTC+7) dikonversi ke UTC untuk timestamp TCX.
- **Cadence TCX:** Input pengguna dalam total langkah/menit (kedua kaki). Di file TCX disimpan sebagai half-step (satu kaki, bagi 2) sesuai konvensi format TCX yang digunakan Garmin/Amazfit.
- **Elevasi:** Tidak disertakan dalam TCX yang dihasilkan. File GPX yang mengandung elevasi tidak akan digunakan elevasinya untuk menghindari data tidak konsisten.
- **Seed variasi:** Acak saat GPX diunggah baru atau tombol "Acak ulang" ditekan. Perubahan parameter lain tidak mengacak ulang pola.

---

## Keterbatasan yang Diketahui

- Tidak diuji impor langsung ke Garmin Connect atau Strava (memerlukan akun dan app nyata).
- Peta memerlukan internet; mode offline hanya menampilkan garis rute di atas latar polos.
- File GPX dengan segmen terputus (multi-trkseg) akan diproses per segmen; antar segmen tidak disambung.
- Tidak ada kalori karena tidak ada sumber data metabolisme.
- Browser lama (IE, Edge Legacy) tidak didukung.

---

## Pengujian

Jalankan tes unit via Node.js:

```bash
node test.js
```

---

*PaceCraft dibuat sebagai utilitas perencanaan lari. Gunakan secara bertanggung jawab.*
