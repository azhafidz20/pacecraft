/**
 * PaceCraft – app.js
 * Generator file TCX simulasi berbasis rute GPX
 * Data performa adalah simulasi, bukan rekaman perangkat nyata.
 */

'use strict';

/* ============================================================
   STATE GLOBAL
   ============================================================ */
const state = {
  gpx: null,          // { segments, totalDist, points } parsed GPX
  sim: null,          // hasil simulasi terakhir
  varianceSeed: Math.random(),
  map: null,
  routeLayer: null,
  mapLoaded: false,
  chartPace: null,
  chartHr: null,
};

/* ============================================================
   UTILITAS
   ============================================================ */

/** Haversine distance antara dua koordinat [lat, lon] dalam meter */
function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Format menit:detik dari detik total */
function fmtPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format durasi HH:MM:SS dari detik */
function fmtDur(secs) {
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format tanggal WIB untuk tampilan */
function fmtDateWIB(utcMs) {
  return new Date(utcMs).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit', minute: '2-digit',
    day: '2-digit', month: 'short', year: 'numeric',
    hour12: false,
  });
}

/** Format waktu WIB singkat HH:MM WIB */
function fmtTimeWIB(utcMs) {
  const t = new Date(utcMs).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const d = new Date(utcMs).toLocaleDateString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short',
  });
  return `${t} WIB, ${d}`;
}

/** Escape XML */
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** PRNG sederhana berdasarkan seed untuk reprodusibilitas */
function seededRng(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** Clamp nilai */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ============================================================
   PARSER GPX
   ============================================================ */
function parseGPX(text) {
  const errors = [];

  // Validasi XML
  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(text, 'application/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) throw new Error('XML tidak valid');
  } catch (e) {
    return { ok: false, error: 'File bukan XML yang valid.' };
  }

  // Namespace
  const ns = doc.documentElement.namespaceURI || '';
  const nsMap = ns ? { ns: ns } : null;

  function qs(el, sel) {
    // coba dengan namespace dan tanpa
    return el.querySelector(sel) ||
      el.getElementsByTagNameNS(ns, sel.replace(/^[^:]+:/, '').replace(/\[.*\]/, '')) ||
      el.getElementsByTagName(sel.split(':').pop())[0];
  }

  function qsAll(el, tag) {
    if (ns) {
      const r = Array.from(el.getElementsByTagNameNS(ns, tag));
      if (r.length) return r;
    }
    return Array.from(el.getElementsByTagName(tag));
  }

  // Ambil semua trkseg
  const segs = qsAll(doc, 'trkseg');
  if (!segs.length) {
    // Coba wpt
    const wpts = qsAll(doc, 'wpt');
    if (!wpts.length) return { ok: false, error: 'File GPX tidak mengandung data rute (trkseg/trkpt).' };
    // Jadikan satu segmen dari wpt
    segs.push({ _wpts: wpts });
  }

  const segments = [];
  let totalDist = 0;
  let totalPts = 0;

  for (const seg of segs) {
    const trkpts = seg._wpts
      ? seg._wpts
      : qsAll(seg, 'trkpt');

    if (!trkpts.length) continue;

    const pts = [];
    for (const tp of trkpts) {
      const lat = parseFloat(tp.getAttribute('lat'));
      const lon = parseFloat(tp.getAttribute('lon'));
      if (isNaN(lat) || isNaN(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

      // Elevasi opsional
      const eleEl = tp.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent) : null;

      pts.push({ lat, lon, ele: (ele !== null && !isNaN(ele)) ? ele : null });
    }

    if (pts.length < 2) continue;

    // Hitung jarak segmen (skip titik duplikat persis)
    let segDist = 0;
    const ptsWithDist = [{ ...pts[0], cumDist: 0 }];
    for (let i = 1; i < pts.length; i++) {
      const d = haversine([pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]);
      if (d < 0.01 && i > 0) continue; // skip duplikat <1cm
      segDist += d;
      ptsWithDist.push({ ...pts[i], cumDist: segDist });
    }

    segments.push({ pts: ptsWithDist, dist: segDist });
    totalDist += segDist;
    totalPts += ptsWithDist.length;
  }

  if (!segments.length) return { ok: false, error: 'Tidak ada data koordinat yang valid dalam file GPX.' };
  if (totalDist < 10) return { ok: false, error: 'Jarak rute terlalu pendek (< 10 meter). Periksa file GPX.' };
  if (totalDist > 500000) return { ok: false, error: 'Jarak rute terlalu jauh (> 500 km). Periksa file GPX.' };

  // Flatten semua titik dengan cumDist absolut
  const allPts = [];
  let baseD = 0;
  for (const seg of segments) {
    for (const p of seg.pts) {
      allPts.push({ ...p, cumDist: baseD + p.cumDist });
    }
    baseD += seg.dist;
  }

  return {
    ok: true,
    segments,
    totalDist,
    totalPts,
    allPts,
    segmentCount: segments.length,
  };
}

/* ============================================================
   SIMULASI AKTIVITAS
   ============================================================ */

/**
 * Buat array kecepatan per-meter (m/s) sepanjang rute,
 * dengan variasi acak bertahap dan tren split.
 *
 * Prinsip:
 * - targetSpeed = basePace dalam m/s
 * - split: kecepatan di awal vs akhir berbeda berdasar splitPct
 *   splitPct negatif → akhir lebih cepat (negative split)
 * - variance: perubahan bertahap via noise Perlin-sederhana
 * - rata-rata akhir = targetSpeed dijaga
 */
function simulateSpeeds(totalDist, avgPaceSecPerKm, variancePct, splitPct, seed) {
  const targetSpeed = 1000 / avgPaceSecPerKm; // m/s
  const rng = seededRng(seed * 1e9 | 0);

  // Jumlah sampel: satu per ~5 meter
  const N = Math.max(50, Math.ceil(totalDist / 5));
  const speeds = new Float64Array(N);

  // Buat noise bertahap (moving-average dari random)
  const noiseRaw = new Float64Array(N);
  for (let i = 0; i < N; i++) noiseRaw[i] = rng() * 2 - 1;

  // Smooth noise dengan window
  const winSize = Math.max(10, Math.round(N * 0.04));
  const noise = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - winSize); j <= Math.min(N - 1, i + winSize); j++) {
      sum += noiseRaw[j]; cnt++;
    }
    noise[i] = sum / cnt;
  }

  // Normalisasi noise ke [-1, 1]
  let noiseMax = 0;
  for (let i = 0; i < N; i++) noiseMax = Math.max(noiseMax, Math.abs(noise[i]));
  if (noiseMax > 0) for (let i = 0; i < N; i++) noise[i] /= noiseMax;

  // Faktor split: linier dari (1 + splitHalf) di awal ke (1 - splitHalf) di akhir
  // splitPct negatif → akhir lebih cepat
  const splitHalf = splitPct / 100 * 0.5;

  // Hitung speeds raw
  let sumW = 0;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1); // 0..1
    const splitFactor = 1 + splitHalf * (1 - 2 * t); // awal lebih lambat jika split<0
    // Note: negatif split → akhir lebih cepat → faktor kecepatan lebih besar di akhir
    const varFactor = 1 + (variancePct / 100) * noise[i];
    speeds[i] = targetSpeed * splitFactor * varFactor;
    sumW += speeds[i];
  }

  // Normalisasi untuk mempertahankan rata-rata
  const avgActual = sumW / N;
  const scale = targetSpeed / avgActual;
  let sum2 = 0;
  for (let i = 0; i < N; i++) {
    speeds[i] = Math.max(0.5, speeds[i] * scale); // min 0.5 m/s
    sum2 += speeds[i];
  }
  // Normalisasi kedua (karena clamp)
  const avg2 = sum2 / N;
  const scale2 = targetSpeed / avg2;
  for (let i = 0; i < N; i++) speeds[i] *= scale2;

  return speeds; // per-indeks, bukan per-meter
}

/**
 * Buat array HR bertahap dengan pola pemanasan.
 * - Awal dari hrMin, naik ke sekitar hrAvg selama ~10% pertama
 * - Fluktuasi bertahap di tengah
 * - Akhir bisa naik mendekati hrMax
 */
function simulateHR(N, hrMin, hrAvg, hrMax, seed) {
  const rng = seededRng((seed + 1) * 1e9 | 0);

  // Smooth noise
  const rawNoise = Array.from({ length: N }, () => rng() * 2 - 1);
  const winSize = Math.max(8, Math.round(N * 0.03));
  const noise = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - winSize); j <= Math.min(N - 1, i + winSize); j++) {
      s += rawNoise[j]; c++;
    }
    noise[i] = s / c;
  }

  // Normalisasi noise
  let nMax = 0;
  for (let i = 0; i < N; i++) nMax = Math.max(nMax, Math.abs(noise[i]));
  if (nMax > 0) for (let i = 0; i < N; i++) noise[i] /= nMax;

  const hrs = new Float64Array(N);
  const range = hrMax - hrMin;

  // Fase pemanasan: 0..15% → hrMin → hrAvg
  // Fase aktif: 15..85% → sekitar hrAvg ± variasi
  // Fase akhir: 85..100% → cenderung naik sedikit

  let totalHrWeight = 0;
  let totalTime = 0;

  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);

    let baseHr;
    if (t < 0.12) {
      // Pemanasan
      const warmRatio = t / 0.12;
      baseHr = hrMin + (hrAvg - hrMin) * Math.pow(warmRatio, 1.5);
    } else if (t < 0.85) {
      // Aktif: sekitar hrAvg, sedikit naik menuju akhir
      const activeT = (t - 0.12) / 0.73;
      baseHr = hrAvg + (hrMax - hrAvg) * 0.15 * activeT;
    } else {
      // Akhir: sedikit lebih tinggi
      const endT = (t - 0.85) / 0.15;
      baseHr = hrAvg + (hrMax - hrAvg) * (0.15 + 0.2 * endT);
    }

    // Tambah noise bertahap
    const varRange = range * 0.08;
    let hr = baseHr + noise[i] * varRange;
    hr = clamp(Math.round(hr), hrMin, hrMax);
    hrs[i] = hr;
    totalHrWeight += hr;
    totalTime++;
  }

  // Cek rata-rata dan koreksi offset jika perlu
  const actualAvg = totalHrWeight / totalTime;
  const offset = Math.round(hrAvg - actualAvg);
  if (Math.abs(offset) > 1) {
    for (let i = 0; i < N; i++) {
      hrs[i] = clamp(hrs[i] + offset, hrMin, hrMax);
    }
  }

  return hrs;
}

/**
 * Buat array cadence bertahap.
 */
function simulateCadence(N, cadAvg, seed) {
  const rng = seededRng((seed + 2) * 1e9 | 0);
  const rawNoise = Array.from({ length: N }, () => rng() * 2 - 1);
  const winSize = Math.max(10, Math.round(N * 0.04));
  const noise = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - winSize); j <= Math.min(N - 1, i + winSize); j++) {
      s += rawNoise[j]; c++;
    }
    noise[i] = s / c;
  }
  let nMax = 0;
  for (let i = 0; i < N; i++) nMax = Math.max(nMax, Math.abs(noise[i]));
  if (nMax > 0) for (let i = 0; i < N; i++) noise[i] /= nMax;

  const cads = new Float64Array(N);
  const varRange = cadAvg * 0.04; // ±4%

  let sum = 0;
  for (let i = 0; i < N; i++) {
    // Cadence dalam TCX per trkpt biasanya half (satu kaki), tapi kita simpan full lalu konversi saat export
    cads[i] = Math.round(clamp(cadAvg + noise[i] * varRange, cadAvg * 0.85, cadAvg * 1.15));
    sum += cads[i];
  }
  // Koreksi offset
  const avg = sum / N;
  const off = Math.round(cadAvg - avg);
  if (Math.abs(off) > 0) {
    for (let i = 0; i < N; i++) cads[i] = Math.max(60, cads[i] + off);
  }

  return cads;
}

/**
 * Fungsi utama: jalankan simulasi dan hasilkan trackpoints.
 * Output: { trackpoints, splits, stats }
 */
function runSimulation(gpx, settings) {
  const {
    avgPaceSecPerKm, variancePct, splitPct,
    hrMin, hrAvg, hrMax, cadAvg,
    startUtcMs, seed,
  } = settings;

  const totalDist = gpx.totalDist;
  const allPts = gpx.allPts;

  // Buat fungsi interpolasi posisi berdasarkan jarak kumulatif
  // Input: dist 0..totalDist → {lat, lon}
  function interpolatePos(dist) {
    dist = clamp(dist, 0, totalDist);
    // Binary search
    let lo = 0, hi = allPts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (allPts[mid].cumDist <= dist) lo = mid;
      else hi = mid;
    }
    const a = allPts[lo], b = allPts[hi];
    const span = b.cumDist - a.cumDist;
    if (span < 0.001) return { lat: a.lat, lon: a.lon };
    const t = (dist - a.cumDist) / span;
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
    };
  }

  // Simulasikan kecepatan
  const speedProfile = simulateSpeeds(totalDist, avgPaceSecPerKm, variancePct, splitPct, seed);
  const N = speedProfile.length;

  // Simulasikan HR & cadence
  const hrProfile = simulateHR(N, hrMin, hrAvg, hrMax, seed);
  const cadProfile = simulateCadence(N, cadAvg, seed);

  // Bangun trackpoints per-detik
  // Mapping indeks N → jarak via kecepatan kumulatif
  // Total durasi = totalDist / targetSpeed = totalDist * avgPaceSecPerKm / 1000
  const totalDurSec = totalDist * avgPaceSecPerKm / 1000;

  // Hitung timestamp per sampel (sampel berbasis jarak)
  // Setiap sampel i mewakili segmen jarak = totalDist/N
  const distPerSample = totalDist / N;

  // Konversi kecepatan ke waktu per sampel
  const timePerSample = new Float64Array(N);
  let totalTime = 0;
  for (let i = 0; i < N; i++) {
    timePerSample[i] = distPerSample / speedProfile[i];
    totalTime += timePerSample[i];
  }

  // Skala agar total waktu tepat
  const timeScale = totalDurSec / totalTime;

  // Buat trackpoints pada interval waktu 1 detik
  const totalSecs = Math.round(totalDurSec);
  const trackpoints = [];

  // Buat kurva waktu→jarak
  // cumTime[i] = waktu kumulatif pada akhir sampel i
  const cumTime = new Float64Array(N + 1);
  cumTime[0] = 0;
  for (let i = 0; i < N; i++) {
    cumTime[i + 1] = cumTime[i] + timePerSample[i] * timeScale;
  }

  // Untuk setiap detik, interpolasi posisi & atribut
  function sampleAtTime(tSec) {
    tSec = clamp(tSec, 0, totalDurSec);
    // Binary search indeks sampel
    let lo = 0, hi = N;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumTime[mid] <= tSec) lo = mid;
      else hi = mid;
    }
    const lo2 = clamp(lo, 0, N - 1);
    const t = cumTime[lo2 + 1] > cumTime[lo2]
      ? (tSec - cumTime[lo2]) / (cumTime[lo2 + 1] - cumTime[lo2])
      : 0;
    const idx = clamp(Math.floor(lo2 + t), 0, N - 1);

    const dist = clamp(lo2 * distPerSample + t * distPerSample, 0, totalDist);
    const pos = interpolatePos(dist);
    const speed = speedProfile[idx];
    const hr = hrProfile[idx];
    const cad = cadProfile[idx];
    return { dist, pos, speed, hr, cad };
  }

  // Buat titik per detik (atau setiap N detik untuk rute panjang)
  // Max ~6000 trackpoint untuk performa & ukuran file
  const stepSec = Math.max(1, Math.ceil(totalSecs / 5000));

  for (let sec = 0; sec <= totalSecs; sec += stepSec) {
    const s = Math.min(sec, totalSecs);
    const { dist, pos, speed, hr, cad } = sampleAtTime(s);
    const utcMs = startUtcMs + s * 1000;
    trackpoints.push({ sec: s, utcMs, dist, lat: pos.lat, lon: pos.lon, speed, hr, cad });
  }

  // Pastikan titik terakhir ada persis di akhir
  if (trackpoints[trackpoints.length - 1].sec < totalSecs) {
    const { dist, pos, speed, hr, cad } = sampleAtTime(totalSecs);
    trackpoints.push({ sec: totalSecs, utcMs: startUtcMs + totalSecs * 1000, dist, lat: pos.lat, lon: pos.lon, speed, hr, cad });
  }

  // Hitung split per km
  const splits = [];
  const kmStep = 1000; // 1 km per split
  let kmIdx = 1;
  let prevSplitSec = 0;
  let prevSplitDist = 0;

  for (const tp of trackpoints) {
    while (tp.dist >= kmIdx * kmStep && kmIdx * kmStep <= totalDist) {
      // Interpolasi waktu persis di batas km
      const targetDist = kmIdx * kmStep;
      // Sudah melewati, interpolasi
      const prevTp = trackpoints[trackpoints.indexOf(tp) - 1] || tp;
      const frac = prevTp.dist < tp.dist
        ? (targetDist - prevTp.dist) / (tp.dist - prevTp.dist)
        : 0;
      const splitSec = prevTp.sec + (tp.sec - prevTp.sec) * frac;
      const durSec = splitSec - prevSplitSec;
      const distKm = (targetDist - prevSplitDist) / 1000;
      const paceSecPerKm = durSec / distKm;

      splits.push({
        km: kmIdx,
        distM: targetDist - prevSplitDist,
        durSec,
        paceSecPerKm,
      });

      prevSplitSec = splitSec;
      prevSplitDist = targetDist;
      kmIdx++;
    }
  }

  // Sisa setelah km terakhir
  const lastDist = totalDist;
  if (lastDist > prevSplitDist + 1) {
    const durSec = totalSecs - prevSplitSec;
    const distKm = (lastDist - prevSplitDist) / 1000;
    const paceSecPerKm = distKm > 0 ? durSec / distKm : 0;
    splits.push({
      km: `${(prevSplitDist / 1000).toFixed(1)}–${(lastDist / 1000).toFixed(2)}`,
      distM: lastDist - prevSplitDist,
      durSec,
      paceSecPerKm,
      isPartial: true,
    });
  }

  // Statistik aktual
  let hrSum = 0, hrMin2 = Infinity, hrMax2 = -Infinity, cadSum = 0;
  for (const tp of trackpoints) {
    hrSum += tp.hr; hrMin2 = Math.min(hrMin2, tp.hr); hrMax2 = Math.max(hrMax2, tp.hr);
    cadSum += tp.cad;
  }
  const stats = {
    totalDist,
    totalDurSec,
    avgPaceSecPerKm,
    avgHr: Math.round(hrSum / trackpoints.length),
    minHr: hrMin2,
    maxHr: hrMax2,
    avgCad: Math.round(cadSum / trackpoints.length),
  };

  return { trackpoints, splits, stats };
}

/* ============================================================
   GENERATOR TCX
   ============================================================ */
function generateTCX(sim, settings, gpxName) {
  const { trackpoints, stats } = sim;
  const { device, runName, runDesc, startUtcMs, avgPaceSecPerKm } = settings;

  const startIso = new Date(startUtcMs).toISOString();
  const totalSecs = stats.totalDurSec;
  const totalDist = stats.totalDist;
  const maxSpeed = Math.max(...trackpoints.map(tp => tp.speed));

  // Rata-rata kecepatan m/s
  const avgSpeed = 1000 / avgPaceSecPerKm;

  const isGarmin = device === 'garmin';

  // Cadence di TCX menggunakan half-step (satu kaki) → bagi 2
  // Karena input kita dalam total langkah/menit (kedua kaki)
  function tcxCadence(cad) { return Math.round(cad / 2); }

  let lines = [];
  lines.push(`<?xml version='1.0' encoding='UTF-8'?>`);
  lines.push(`<!-- Dibuat oleh PaceCraft. Data performa adalah simulasi, bukan rekaman perangkat nyata. -->`);
  lines.push(`<TrainingCenterDatabase`);
  lines.push(`  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"`);
  lines.push(`  xmlns:ae="http://www.garmin.com/xmlschemas/ActivityExtension/v2"`);
  lines.push(`  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);
  lines.push(`  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">`);
  lines.push(`  <Activities>`);
  lines.push(`    <Activity Sport="Running">`);
  lines.push(`      <Id>${startIso}</Id>`);
  if (runName) lines.push(`      <Notes>${xmlEsc(runName)}${runDesc ? ' – ' + xmlEsc(runDesc) : ''}</Notes>`);
  lines.push(`      <Lap StartTime="${startIso}">`);
  lines.push(`        <TotalTimeSeconds>${totalSecs.toFixed(3)}</TotalTimeSeconds>`);
  lines.push(`        <DistanceMeters>${totalDist.toFixed(3)}</DistanceMeters>`);
  lines.push(`        <MaximumSpeed>${maxSpeed.toFixed(6)}</MaximumSpeed>`);
  lines.push(`        <AverageHeartRateBpm><Value>${stats.avgHr}</Value></AverageHeartRateBpm>`);
  lines.push(`        <MaximumHeartRateBpm><Value>${stats.maxHr}</Value></MaximumHeartRateBpm>`);
  lines.push(`        <Intensity>Active</Intensity>`);
  lines.push(`        <TriggerMethod>Manual</TriggerMethod>`);
  lines.push(`        <Extensions>`);
  lines.push(`          <ae:LX>`);
  lines.push(`            <ae:AvgSpeed>${avgSpeed.toFixed(6)}</ae:AvgSpeed>`);
  lines.push(`            <ae:AvgRunCadence>${tcxCadence(stats.avgCad)}</ae:AvgRunCadence>`);
  lines.push(`          </ae:LX>`);
  lines.push(`        </Extensions>`);
  lines.push(`        <Track>`);

  for (const tp of trackpoints) {
    const isoTime = new Date(tp.utcMs).toISOString();
    lines.push(`          <Trackpoint>`);
    lines.push(`            <Time>${isoTime}</Time>`);
    lines.push(`            <Position>`);
    lines.push(`              <LatitudeDegrees>${tp.lat.toFixed(8)}</LatitudeDegrees>`);
    lines.push(`              <LongitudeDegrees>${tp.lon.toFixed(8)}</LongitudeDegrees>`);
    lines.push(`            </Position>`);
    lines.push(`            <DistanceMeters>${tp.dist.toFixed(3)}</DistanceMeters>`);
    lines.push(`            <HeartRateBpm><Value>${tp.hr}</Value></HeartRateBpm>`);
    lines.push(`            <Cadence>${tcxCadence(tp.cad)}</Cadence>`);
    lines.push(`            <Extensions>`);
    lines.push(`              <ae:TPX>`);
    lines.push(`                <ae:Speed>${tp.speed.toFixed(6)}</ae:Speed>`);
    lines.push(`              </ae:TPX>`);
    lines.push(`            </Extensions>`);
    lines.push(`          </Trackpoint>`);
  }

  lines.push(`        </Track>`);
  lines.push(`      </Lap>`);
  lines.push(`      <Creator xsi:type="Device_t">`);
  if (isGarmin) {
    lines.push(`        <Name>Garmin Forerunner 55</Name>`);
    lines.push(`        <UnitId>0</UnitId>`);
    lines.push(`        <ProductID>4001</ProductID>`);
  } else {
    lines.push(`        <Name>Amazfit Active Edge</Name>`);
    lines.push(`        <UnitId>0</UnitId>`);
    lines.push(`        <ProductID>0</ProductID>`);
  }
  lines.push(`      </Creator>`);
  lines.push(`    </Activity>`);
  lines.push(`  </Activities>`);
  lines.push(`  <Author xsi:type="Application_t">`);
  lines.push(`    <Name>PaceCraft – Simulated Activity Generator</Name>`);
  lines.push(`    <Build>`);
  lines.push(`      <Version>`);
  lines.push(`        <VersionMajor>1</VersionMajor>`);
  lines.push(`        <VersionMinor>0</VersionMinor>`);
  lines.push(`        <BuildMajor>0</BuildMajor>`);
  lines.push(`        <BuildMinor>0</BuildMinor>`);
  lines.push(`      </Version>`);
  lines.push(`    </Build>`);
  lines.push(`    <LangID>ID</LangID>`);
  lines.push(`  </Author>`);
  lines.push(`</TrainingCenterDatabase>`);

  return lines.join('\n');
}

/* ============================================================
   UI – TEMA
   ============================================================ */
function initTheme() {
  const saved = localStorage.getItem('pc-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pc-theme', theme);
  const sun = document.getElementById('iconSun');
  const moon = document.getElementById('iconMoon');
  if (theme === 'dark') {
    sun.style.display = 'block';
    moon.style.display = 'none';
  } else {
    sun.style.display = 'none';
    moon.style.display = 'block';
  }
  // Update slider warna setelah tema ganti
  updateSliderBg(document.getElementById('paceVar'));
  updateSliderBg(document.getElementById('paceSplit'));
}

document.getElementById('themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

function updateSliderBg(slider) {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const val = Number(slider.value);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(to right, #FC4C02 0%, #FC4C02 ${pct}%, var(--border) ${pct}%, var(--border) 100%)`;
}

/* ============================================================
   UI – SLIDER
   ============================================================ */
function initSliders() {
  const paceVar = document.getElementById('paceVar');
  const paceSplit = document.getElementById('paceSplit');
  const varLabel = document.getElementById('varLabel');
  const splitLabel = document.getElementById('splitLabel');

  function updateVar() {
    varLabel.textContent = `${paceVar.value}%`;
    updateSliderBg(paceVar);
    scheduleUpdate();
  }
  function updateSplit() {
    const v = Number(paceSplit.value);
    splitLabel.textContent = v === 0 ? '0%' : (v < 0 ? `−${Math.abs(v)}%` : `+${v}%`);
    updateSliderBg(paceSplit);
    scheduleUpdate();
  }

  paceVar.addEventListener('input', updateVar);
  paceSplit.addEventListener('input', updateSplit);
  updateVar(); updateSplit();
}

/* ============================================================
   UI – DEVICE SELECTOR
   ============================================================ */
function initDeviceSelector() {
  const radios = document.querySelectorAll('input[name="device"]');
  radios.forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('devGarmin').classList.toggle('active', document.getElementById('radioGarmin').checked);
      document.getElementById('devAmazfit').classList.toggle('active', document.getElementById('radioAmazfit').checked);
    });
  });
}

/* ============================================================
   UI – DEFAULT DATE
   ============================================================ */
function initDefaults() {
  const today = new Date();
  // Format YYYY-MM-DD
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  document.getElementById('runDate').value = `${yyyy}-${mm}-${dd}`;
}

/* ============================================================
   UI – GPX UPLOAD
   ============================================================ */
function initGpxUpload() {
  const dropZone = document.getElementById('dropZone');
  const gpxInput = document.getElementById('gpxInput');
  const btnChange = document.getElementById('btnChangeGpx');

  dropZone.addEventListener('click', () => gpxInput.click());
  dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') gpxInput.click(); });
  gpxInput.addEventListener('change', e => {
    if (e.target.files[0]) loadGpxFile(e.target.files[0]);
  });

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) loadGpxFile(f);
  });

  btnChange.addEventListener('click', e => {
    e.stopPropagation();
    gpxInput.value = '';
    gpxInput.click();
  });
}

function loadGpxFile(file) {
  const errEl = document.getElementById('gpxError');
  errEl.style.display = 'none';

  if (!file.name.toLowerCase().endsWith('.gpx')) {
    showGpxError('File harus berekstensi .gpx'); return;
  }
  if (file.size === 0) {
    showGpxError('File kosong.'); return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showGpxError('File terlalu besar (maks 10 MB).'); return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const result = parseGPX(text);
    if (!result.ok) {
      showGpxError(result.error);
      return;
    }
    state.gpx = result;
    showGpxInfo(file.name, result);
    renderMap(result);
    state.varianceSeed = Math.random();
    scheduleUpdate();
  };
  reader.onerror = () => showGpxError('Gagal membaca file.');
  reader.readAsText(file);
}

function showGpxError(msg) {
  const errEl = document.getElementById('gpxError');
  errEl.textContent = `⚠ ${msg}`;
  errEl.style.display = 'block';
  document.getElementById('gpxInfo').style.display = 'none';
  state.gpx = null;
  updateActionButtons();
}

function showGpxInfo(filename, gpx) {
  document.getElementById('gpxFileName').textContent = filename;
  document.getElementById('gpxPoints').textContent = gpx.totalPts.toLocaleString('id-ID');
  document.getElementById('gpxDist').textContent = (gpx.totalDist / 1000).toFixed(3);
  document.getElementById('gpxSegs').textContent = gpx.segmentCount;
  document.getElementById('gpxInfo').style.display = 'block';
  document.getElementById('gpxError').style.display = 'none';
}

/* ============================================================
   PETA
   ============================================================ */
function renderMap(gpx) {
  const mapEl = document.getElementById('map');
  const mapEmpty = document.getElementById('mapEmpty');
  const mapFallback = document.getElementById('mapFallback');

  mapEmpty.style.display = 'none';

  // Ambil semua koordinat
  const latlngs = gpx.allPts.map(p => [p.lat, p.lon]);

  if (typeof L === 'undefined') {
    // Leaflet tidak tersedia, gambar SVG fallback
    renderFallbackMap(gpx, latlngs);
    return;
  }

  mapEl.style.display = 'block';
  mapFallback.style.display = 'none';

  if (state.map) {
    // Reset peta yang sudah ada
    if (state.routeLayer) state.map.removeLayer(state.routeLayer);
    state.routeLayer = L.polyline(latlngs, {
      color: '#FC4C02', weight: 4, opacity: .9,
    }).addTo(state.map);
    state.map.fitBounds(state.routeLayer.getBounds(), { padding: [20, 20] });
    return;
  }

  try {
    state.map = L.map('map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(state.map);

    state.routeLayer = L.polyline(latlngs, {
      color: '#FC4C02', weight: 4, opacity: .9,
    }).addTo(state.map);
    state.map.fitBounds(state.routeLayer.getBounds(), { padding: [20, 20] });
    state.mapLoaded = true;
  } catch (err) {
    console.warn('Leaflet error, fallback ke canvas:', err);
    renderFallbackMap(gpx, latlngs);
  }
}

function renderFallbackMap(gpx, latlngs) {
  document.getElementById('map').style.display = 'none';
  const fb = document.getElementById('mapFallback');
  fb.style.display = 'block';
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');
  const W = fb.clientWidth || 400;
  const H = 280;
  canvas.width = W;
  canvas.height = H;

  const lats = latlngs.map(p => p[0]);
  const lons = latlngs.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 20;

  function toXY([lat, lon]) {
    const x = pad + (lon - minLon) / (maxLon - minLon + 1e-9) * (W - pad * 2);
    const y = H - pad - (lat - minLat) / (maxLat - minLat + 1e-9) * (H - pad * 2);
    return [x, y];
  }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  ctx.fillStyle = isDark ? '#2A2D2A' : '#E8EAE8';
  ctx.fillRect(0, 0, W, H);

  ctx.beginPath();
  for (let i = 0; i < latlngs.length; i++) {
    const [x, y] = toXY(latlngs[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#FC4C02';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Titik awal
  const [sx, sy] = toXY(latlngs[0]);
  ctx.beginPath();
  ctx.arc(sx, sy, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#FC4C02';
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/* ============================================================
   GRAFIK
   ============================================================ */
function drawCharts(sim) {
  const { splits, trackpoints } = sim;

  // Downsample trackpoints untuk grafik (maks 200 poin)
  const step = Math.max(1, Math.floor(trackpoints.length / 200));
  const tpSampled = trackpoints.filter((_, i) => i % step === 0);

  // Grafik pace
  drawPaceChart(tpSampled);

  // Grafik HR
  drawHrChart(tpSampled);
}

function getChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    text: isDark ? '#9CA3AF' : '#6B7280',
    grid: isDark ? '#2E2E2E' : '#E8E8E8',
    bg: isDark ? '#1E1E1E' : '#FFFFFF',
  };
}

function drawPaceChart(tpSampled) {
  const canvas = document.getElementById('chartPace');
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth || 400;
  const H = 90;
  canvas.width = W;
  canvas.height = H;

  const paces = tpSampled.map(tp => tp.speed > 0 ? 1000 / tp.speed : 0);
  const dists = tpSampled.map(tp => tp.dist / 1000);

  if (!paces.length) return;

  const minP = Math.min(...paces.filter(p => p > 0));
  const maxP = Math.max(...paces);
  const maxD = dists[dists.length - 1] || 1;

  const C = getChartColors();
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 36, r: 8, t: 8, b: 20 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  function toX(d) { return pad.l + (d / maxD) * cW; }
  function toY(p) { return pad.t + (1 - (p - minP * 0.95) / (maxP * 1.05 - minP * 0.95)) * cH; }

  // Grid garis Y
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  const pTicks = 3;
  for (let i = 0; i <= pTicks; i++) {
    const p = minP * 0.95 + (maxP * 1.05 - minP * 0.95) * i / pTicks;
    const y = toY(p);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtPace(p), pad.l - 2, y + 3);
  }

  // Garis pace
  ctx.beginPath();
  for (let i = 0; i < tpSampled.length; i++) {
    const x = toX(dists[i]);
    const y = toY(paces[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#FC4C02';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill bawah
  ctx.lineTo(toX(dists[dists.length - 1]), H - pad.b);
  ctx.lineTo(toX(dists[0]), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = 'rgba(252,76,2,0.1)';
  ctx.fill();

  // Label X
  ctx.fillStyle = C.text;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  const xTicks = Math.min(5, Math.floor(maxD));
  for (let i = 0; i <= xTicks; i++) {
    const d = (maxD / xTicks) * i;
    ctx.fillText(`${d.toFixed(1)}`, toX(d), H - 2);
  }
}

function drawHrChart(tpSampled) {
  const canvas = document.getElementById('chartHr');
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth || 400;
  const H = 90;
  canvas.width = W;
  canvas.height = H;

  const hrs = tpSampled.map(tp => tp.hr);
  const dists = tpSampled.map(tp => tp.dist / 1000);

  if (!hrs.length) return;

  const minH = Math.min(...hrs) - 5;
  const maxH = Math.max(...hrs) + 5;
  const maxD = dists[dists.length - 1] || 1;

  const C = getChartColors();
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 36, r: 8, t: 8, b: 20 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  function toX(d) { return pad.l + (d / maxD) * cW; }
  function toY(h) { return pad.t + (1 - (h - minH) / (maxH - minH)) * cH; }

  // Grid
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  const hTicks = 3;
  for (let i = 0; i <= hTicks; i++) {
    const h = minH + (maxH - minH) * i / hTicks;
    const y = toY(h);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(h), pad.l - 2, y + 3);
  }

  // Garis HR
  ctx.beginPath();
  for (let i = 0; i < tpSampled.length; i++) {
    const x = toX(dists[i]);
    const y = toY(hrs[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#E05555';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill
  ctx.lineTo(toX(dists[dists.length - 1]), H - pad.b);
  ctx.lineTo(toX(dists[0]), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = 'rgba(224,85,85,0.1)';
  ctx.fill();

  // Label X
  ctx.fillStyle = C.text;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  const xTicks = Math.min(5, Math.floor(maxD));
  for (let i = 0; i <= xTicks; i++) {
    const d = (maxD / xTicks) * i;
    ctx.fillText(`${d.toFixed(1)}`, toX(d), H - 2);
  }
}

/* ============================================================
   UPDATE RINGKASAN
   ============================================================ */
function getSettings() {
  const paceMin = Number(document.getElementById('paceMin').value) || 7;
  const paceSec = Number(document.getElementById('paceSec').value) || 25;
  const avgPaceSecPerKm = paceMin * 60 + clamp(paceSec, 0, 59);

  const dateVal = document.getElementById('runDate').value; // YYYY-MM-DD
  const timeVal = document.getElementById('runTime').value || '07:30'; // HH:MM
  const [hh, mm2] = timeVal.split(':').map(Number);

  // Konversi WIB (UTC+7) ke UTC
  let startUtcMs;
  if (dateVal) {
    const [y, mo, d] = dateVal.split('-').map(Number);
    // WIB = UTC+7, jadi UTC = waktu lokal - 7 jam
    const wibMs = Date.UTC(y, mo - 1, d, hh, mm2, 0);
    startUtcMs = wibMs - 7 * 3600 * 1000;
  } else {
    startUtcMs = Date.now() - 7 * 3600 * 1000;
  }

  return {
    avgPaceSecPerKm,
    variancePct: Number(document.getElementById('paceVar').value),
    splitPct: Number(document.getElementById('paceSplit').value),
    hrMin: Number(document.getElementById('hrMin').value),
    hrAvg: Number(document.getElementById('hrAvg').value),
    hrMax: Number(document.getElementById('hrMax').value),
    cadAvg: Number(document.getElementById('cadAvg').value),
    device: document.querySelector('input[name="device"]:checked').value,
    runName: document.getElementById('runName').value.trim() || 'Morning Run',
    runDesc: document.getElementById('runDesc').value.trim(),
    startUtcMs,
    seed: state.varianceSeed,
  };
}

function validateSettings(settings) {
  const { hrMin, hrAvg, hrMax } = settings;
  const errors = [];
  if (hrMin > hrAvg) errors.push('HR minimum harus ≤ HR rata-rata.');
  if (hrAvg > hrMax) errors.push('HR rata-rata harus ≤ HR maksimum.');
  if (hrMin < 30 || hrMax > 250) errors.push('Nilai HR di luar batas wajar (30–250 bpm).');
  return errors;
}

let _updateTimer = null;
function scheduleUpdate() {
  clearTimeout(_updateTimer);
  _updateTimer = setTimeout(doUpdate, 150);
}

function doUpdate(keepSeed = true) {
  if (!keepSeed) state.varianceSeed = Math.random();

  const settings = getSettings();
  const hrErr = document.getElementById('hrError');

  const valErrors = validateSettings(settings);
  if (valErrors.length) {
    hrErr.textContent = valErrors.join(' ');
    hrErr.style.display = 'block';
  } else {
    hrErr.style.display = 'none';
  }

  if (!state.gpx || valErrors.length) {
    updateActionButtons();
    return;
  }

  // Jalankan simulasi
  try {
    const sim = runSimulation(state.gpx, settings);
    state.sim = sim;

    updateSummary(sim, settings);
    updateSplitTable(sim.splits);
    drawCharts(sim);
    updateActionButtons();
  } catch (e) {
    console.error('Simulasi gagal:', e);
  }
}

function updateActionButtons() {
  const ok = !!state.gpx && !!state.sim;
  document.getElementById('btnDownload').disabled = !ok;
  document.getElementById('btnReshuffle').disabled = !ok;
}

function updateSummary(sim, settings) {
  const { stats, trackpoints } = sim;
  const sumContent = document.getElementById('summaryContent');
  const sumEmpty = document.getElementById('summaryEmpty');
  sumContent.style.display = 'block';
  sumEmpty.style.display = 'none';

  document.getElementById('sumDist').textContent = `${(stats.totalDist / 1000).toFixed(3)} km`;
  document.getElementById('sumPace').textContent = `${fmtPace(stats.avgPaceSecPerKm)} /km`;
  document.getElementById('sumDur').textContent = fmtDur(stats.totalDurSec);

  const finishMs = settings.startUtcMs + stats.totalDurSec * 1000;
  document.getElementById('sumFinish').textContent = fmtTimeWIB(finishMs);

  document.getElementById('sumHrAvg').textContent = `${stats.avgHr} bpm`;
  document.getElementById('sumHrRange').textContent = `${stats.minHr}–${stats.maxHr} bpm`;
  document.getElementById('sumCad').textContent = `${stats.avgCad} langkah/mnt`;

  const sp = settings.splitPct;
  let splitText = '';
  if (sp === 0) splitText = 'Rata (even split)';
  else if (sp < -15) splitText = `Negative split kuat (${sp}%)`;
  else if (sp < 0) splitText = `Negative split (${sp}%)`;
  else if (sp > 15) splitText = `Positive split kuat (+${sp}%)`;
  else splitText = `Positive split (+${sp}%)`;
  document.getElementById('sumSplit').textContent = splitText;

  // Badge split
  const splitTag = document.getElementById('splitTag');
  const splitTagText = document.getElementById('splitTagText');
  const splitTagDesc = document.getElementById('splitTagDesc');
  if (sp < -5) {
    splitTag.style.display = 'flex';
    splitTagText.textContent = 'Negative split';
    splitTagDesc.textContent = 'Lebih cepat menjelang akhir';
  } else if (sp > 5) {
    splitTag.style.display = 'flex';
    splitTagText.textContent = 'Positive split';
    splitTagDesc.textContent = 'Lebih lambat menjelang akhir';
  } else {
    splitTag.style.display = 'none';
  }
}

function updateSplitTable(splits) {
  const tbody = document.getElementById('splitTableBody');
  tbody.innerHTML = '';

  for (const s of splits) {
    const tr = document.createElement('tr');
    const kmLabel = s.isPartial ? `${s.km}` : `${s.km}`;
    const distKm = s.distM / 1000;
    const pace = s.paceSecPerKm > 0 ? fmtPace(s.paceSecPerKm) : '-';
    tr.innerHTML = `
      <td>${s.isPartial ? `~${s.km} km` : `${s.km} km`}</td>
      <td>${(s.distM / 1000).toFixed(3)} km</td>
      <td>${fmtDur(s.durSec)}</td>
      <td>${pace} /km</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ============================================================
   INPUT LISTENERS
   ============================================================ */
function initListeners() {
  const textInputs = ['runDate', 'runTime', 'paceMin', 'paceSec', 'hrMin', 'hrAvg', 'hrMax', 'cadAvg'];
  textInputs.forEach(id => {
    document.getElementById(id).addEventListener('change', scheduleUpdate);
    document.getElementById(id).addEventListener('input', scheduleUpdate);
  });

  // Nama dan deskripsi TIDAK memicu simulasi ulang (seed tetap sama)
  ['runName', 'runDesc'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      // Hanya update tombol unduh label dll, tidak resimulasi
    });
  });

  document.querySelectorAll('input[name="device"]').forEach(r => {
    r.addEventListener('change', scheduleUpdate);
  });

  // Pace detik: validasi 0-59
  document.getElementById('paceSec').addEventListener('blur', () => {
    const el = document.getElementById('paceSec');
    let v = parseInt(el.value) || 0;
    if (v < 0) v = 0;
    if (v > 59) v = 59;
    el.value = v;
  });
}

/* ============================================================
   UNDUH TCX
   ============================================================ */
function initDownload() {
  document.getElementById('btnDownload').addEventListener('click', () => {
    if (!state.sim || !state.gpx) return;
    const settings = getSettings();
    const tcxStr = generateTCX(state.sim, settings);
    const safeName = settings.runName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'PaceCraft';
    const filename = `${safeName}.tcx`;
    downloadBlob(new Blob([tcxStr], { type: 'application/xml' }), filename);
  });

  document.getElementById('btnReshuffle').addEventListener('click', () => {
    doUpdate(false); // false = generate seed baru
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/* ============================================================
   RESIZE – redraw canvas jika ukuran berubah
   ============================================================ */
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (state.sim) {
      drawCharts(state.sim);
      if (state.gpx) {
        const fb = document.getElementById('mapFallback');
        if (fb.style.display !== 'none') {
          renderFallbackMap(state.gpx, state.gpx.allPts.map(p => [p.lat, p.lon]));
        }
      }
    }
  }, 200);
});

/* ============================================================
   INIT
   ============================================================ */
function init() {
  initTheme();
  initDefaults();
  initSliders();
  initDeviceSelector();
  initGpxUpload();
  initListeners();
  initDownload();
}

document.addEventListener('DOMContentLoaded', init);
