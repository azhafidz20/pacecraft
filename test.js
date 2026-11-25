/**
 * PaceCraft – test.js
 * Pengujian unit untuk logika inti (parser GPX, simulasi, generator TCX)
 * Jalankan: node test.js
 */

'use strict';

// ============ POLYFILL untuk Node.js ============
const { DOMParser } = require('@xmldom/xmldom');
global.DOMParser = DOMParser;

// ============ IMPORT FUNGSI DARI app.js ============
// Karena app.js menggunakan browser globals, kita ekstrak fungsi yang diperlukan

function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function fmtPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDur(secs) {
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function seededRng(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// Parser GPX (versi Node.js)
function parseGPX(text) {
  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(text, 'application/xml');
  } catch (e) {
    return { ok: false, error: 'XML tidak valid' };
  }

  const ns = doc.documentElement.namespaceURI || '';

  function qsAll(el, tag) {
    if (ns) {
      const r = Array.from(el.getElementsByTagNameNS(ns, tag));
      if (r.length) return r;
    }
    return Array.from(el.getElementsByTagName(tag));
  }

  const segs = qsAll(doc, 'trkseg');
  if (!segs.length) return { ok: false, error: 'Tidak ada trkseg' };

  const segments = [];
  let totalDist = 0, totalPts = 0;

  for (const seg of segs) {
    const trkpts = qsAll(seg, 'trkpt');
    if (!trkpts.length) continue;

    const pts = [];
    for (const tp of trkpts) {
      const lat = parseFloat(tp.getAttribute('lat'));
      const lon = parseFloat(tp.getAttribute('lon'));
      if (isNaN(lat) || isNaN(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      pts.push({ lat, lon });
    }
    if (pts.length < 2) continue;

    let segDist = 0;
    const ptsWithDist = [{ ...pts[0], cumDist: 0 }];
    for (let i = 1; i < pts.length; i++) {
      const d = haversine([pts[i-1].lat, pts[i-1].lon], [pts[i].lat, pts[i].lon]);
      if (d < 0.01) continue;
      segDist += d;
      ptsWithDist.push({ ...pts[i], cumDist: segDist });
    }
    segments.push({ pts: ptsWithDist, dist: segDist });
    totalDist += segDist;
    totalPts += ptsWithDist.length;
  }

  if (!segments.length) return { ok: false, error: 'Tidak ada titik valid' };
  if (totalDist < 10) return { ok: false, error: 'Jarak terlalu pendek' };

  const allPts = [];
  let baseD = 0;
  for (const seg of segments) {
    for (const p of seg.pts) allPts.push({ ...p, cumDist: baseD + p.cumDist });
    baseD += seg.dist;
  }

  return { ok: true, segments, totalDist, totalPts, allPts, segmentCount: segments.length };
}

function simulateSpeeds(totalDist, avgPaceSecPerKm, variancePct, splitPct, seed) {
  const targetSpeed = 1000 / avgPaceSecPerKm;
  const rng = seededRng(seed * 1e9 | 0);
  const N = Math.max(50, Math.ceil(totalDist / 5));
  const speeds = new Float64Array(N);
  const noiseRaw = new Float64Array(N);
  for (let i = 0; i < N; i++) noiseRaw[i] = rng() * 2 - 1;
  const winSize = Math.max(10, Math.round(N * 0.04));
  const noise = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - winSize); j <= Math.min(N-1, i+winSize); j++) { sum += noiseRaw[j]; cnt++; }
    noise[i] = sum / cnt;
  }
  let noiseMax = 0;
  for (let i = 0; i < N; i++) noiseMax = Math.max(noiseMax, Math.abs(noise[i]));
  if (noiseMax > 0) for (let i = 0; i < N; i++) noise[i] /= noiseMax;
  const splitHalf = splitPct / 100 * 0.5;
  let sumW = 0;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const splitFactor = 1 + splitHalf * (1 - 2 * t);
    const varFactor = 1 + (variancePct / 100) * noise[i];
    speeds[i] = targetSpeed * splitFactor * varFactor;
    sumW += speeds[i];
  }
  const scale = targetSpeed / (sumW / N);
  let sum2 = 0;
  for (let i = 0; i < N; i++) { speeds[i] = Math.max(0.5, speeds[i] * scale); sum2 += speeds[i]; }
  const scale2 = targetSpeed / (sum2 / N);
  for (let i = 0; i < N; i++) speeds[i] *= scale2;
  return speeds;
}

function simulateHR(N, hrMin, hrAvg, hrMax, seed) {
  const rng = seededRng((seed + 1) * 1e9 | 0);
  const rawNoise = Array.from({ length: N }, () => rng() * 2 - 1);
  const winSize = Math.max(8, Math.round(N * 0.03));
  const noise = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i-winSize); j <= Math.min(N-1, i+winSize); j++) { s += rawNoise[j]; c++; }
    noise[i] = s / c;
  }
  let nMax = 0;
  for (let i = 0; i < N; i++) nMax = Math.max(nMax, Math.abs(noise[i]));
  if (nMax > 0) for (let i = 0; i < N; i++) noise[i] /= nMax;
  const range = hrMax - hrMin;
  const hrs = new Float64Array(N);
  let totalHr = 0;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    let baseHr;
    if (t < 0.12) { baseHr = hrMin + (hrAvg - hrMin) * Math.pow(t / 0.12, 1.5); }
    else if (t < 0.85) { baseHr = hrAvg + (hrMax - hrAvg) * 0.15 * (t - 0.12) / 0.73; }
    else { baseHr = hrAvg + (hrMax - hrAvg) * (0.15 + 0.2 * (t - 0.85) / 0.15); }
    hrs[i] = clamp(Math.round(baseHr + noise[i] * range * 0.08), hrMin, hrMax);
    totalHr += hrs[i];
  }
  const avg = totalHr / N;
  const off = Math.round(hrAvg - avg);
  if (Math.abs(off) > 1) for (let i = 0; i < N; i++) hrs[i] = clamp(hrs[i] + off, hrMin, hrMax);
  return hrs;
}

function simulateCadence(N, cadAvg, seed) {
  const rng = seededRng((seed + 2) * 1e9 | 0);
  const rawNoise = Array.from({ length: N }, () => rng() * 2 - 1);
  const winSize = Math.max(10, Math.round(N * 0.04));
  const noise = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i-winSize); j <= Math.min(N-1, i+winSize); j++) { s += rawNoise[j]; c++; }
    noise[i] = s / c;
  }
  let nMax = 0;
  for (let i = 0; i < N; i++) nMax = Math.max(nMax, Math.abs(noise[i]));
  if (nMax > 0) for (let i = 0; i < N; i++) noise[i] /= nMax;
  const cads = new Float64Array(N);
  const varRange = cadAvg * 0.04;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    cads[i] = Math.round(clamp(cadAvg + noise[i] * varRange, cadAvg * 0.85, cadAvg * 1.15));
    sum += cads[i];
  }
  const off = Math.round(cadAvg - sum / N);
  if (Math.abs(off) > 0) for (let i = 0; i < N; i++) cads[i] = Math.max(60, cads[i] + off);
  return cads;
}

function runSimulation(gpx, settings) {
  const { avgPaceSecPerKm, variancePct, splitPct, hrMin, hrAvg, hrMax, cadAvg, startUtcMs, seed } = settings;
  const totalDist = gpx.totalDist;
  const allPts = gpx.allPts;

  function interpolatePos(dist) {
    dist = clamp(dist, 0, totalDist);
    let lo = 0, hi = allPts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (allPts[mid].cumDist <= dist) lo = mid; else hi = mid;
    }
    const a = allPts[lo], b = allPts[hi];
    const span = b.cumDist - a.cumDist;
    if (span < 0.001) return { lat: a.lat, lon: a.lon };
    const t = (dist - a.cumDist) / span;
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  }

  const speedProfile = simulateSpeeds(totalDist, avgPaceSecPerKm, variancePct, splitPct, seed);
  const N = speedProfile.length;
  const hrProfile = simulateHR(N, hrMin, hrAvg, hrMax, seed);
  const cadProfile = simulateCadence(N, cadAvg, seed);

  const totalDurSec = totalDist * avgPaceSecPerKm / 1000;
  const distPerSample = totalDist / N;
  const timePerSample = new Float64Array(N);
  let totalTime = 0;
  for (let i = 0; i < N; i++) { timePerSample[i] = distPerSample / speedProfile[i]; totalTime += timePerSample[i]; }
  const timeScale = totalDurSec / totalTime;

  const cumTime = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cumTime[i + 1] = cumTime[i] + timePerSample[i] * timeScale;

  function sampleAtTime(tSec) {
    tSec = clamp(tSec, 0, totalDurSec);
    let lo = 0, hi = N;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumTime[mid] <= tSec) lo = mid; else hi = mid;
    }
    const lo2 = clamp(lo, 0, N - 1);
    const t = cumTime[lo2 + 1] > cumTime[lo2] ? (tSec - cumTime[lo2]) / (cumTime[lo2 + 1] - cumTime[lo2]) : 0;
    const idx = clamp(Math.floor(lo2 + t), 0, N - 1);
    const dist = clamp(lo2 * distPerSample + t * distPerSample, 0, totalDist);
    const pos = interpolatePos(dist);
    return { dist, pos, speed: speedProfile[idx], hr: hrProfile[idx], cad: cadProfile[idx] };
  }

  const totalSecs = Math.round(totalDurSec);
  const stepSec = Math.max(1, Math.ceil(totalSecs / 5000));
  const trackpoints = [];
  for (let sec = 0; sec <= totalSecs; sec += stepSec) {
    const s = Math.min(sec, totalSecs);
    const { dist, pos, speed, hr, cad } = sampleAtTime(s);
    trackpoints.push({ sec: s, utcMs: startUtcMs + s * 1000, dist, lat: pos.lat, lon: pos.lon, speed, hr, cad });
  }
  if (trackpoints[trackpoints.length - 1].sec < totalSecs) {
    const { dist, pos, speed, hr, cad } = sampleAtTime(totalSecs);
    trackpoints.push({ sec: totalSecs, utcMs: startUtcMs + totalSecs * 1000, dist, lat: pos.lat, lon: pos.lon, speed, hr, cad });
  }

  let hrSum = 0, hrMin2 = Infinity, hrMax2 = -Infinity, cadSum = 0;
  for (const tp of trackpoints) {
    hrSum += tp.hr; hrMin2 = Math.min(hrMin2, tp.hr); hrMax2 = Math.max(hrMax2, tp.hr); cadSum += tp.cad;
  }

  return {
    trackpoints,
    stats: {
      totalDist, totalDurSec, avgPaceSecPerKm,
      avgHr: Math.round(hrSum / trackpoints.length),
      minHr: hrMin2, maxHr: hrMax2,
      avgCad: Math.round(cadSum / trackpoints.length),
    }
  };
}

function generateTCX(sim, settings) {
  const { trackpoints, stats } = sim;
  const { device, runName, startUtcMs, avgPaceSecPerKm } = settings;
  const startIso = new Date(startUtcMs).toISOString();
  const totalSecs = stats.totalDurSec;
  const totalDist = stats.totalDist;
  const maxSpeed = Math.max(...trackpoints.map(tp => tp.speed));
  const avgSpeed = 1000 / avgPaceSecPerKm;
  const tcxCadence = cad => Math.round(cad / 2);
  const lines = [];
  lines.push(`<?xml version='1.0' encoding='UTF-8'?>`);
  lines.push(`<!-- PaceCraft simulation -->`);
  lines.push(`<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ae="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
  lines.push(`  <Activities><Activity Sport="Running"><Id>${startIso}</Id>`);
  lines.push(`    <Lap StartTime="${startIso}"><TotalTimeSeconds>${totalSecs.toFixed(3)}</TotalTimeSeconds><DistanceMeters>${totalDist.toFixed(3)}</DistanceMeters>`);
  lines.push(`    <AverageHeartRateBpm><Value>${stats.avgHr}</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>${stats.maxHr}</Value></MaximumHeartRateBpm>`);
  lines.push(`    <Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>`);
  lines.push(`    <Track>`);
  for (const tp of trackpoints) {
    lines.push(`      <Trackpoint><Time>${new Date(tp.utcMs).toISOString()}</Time>`);
    lines.push(`        <Position><LatitudeDegrees>${tp.lat.toFixed(8)}</LatitudeDegrees><LongitudeDegrees>${tp.lon.toFixed(8)}</LongitudeDegrees></Position>`);
    lines.push(`        <DistanceMeters>${tp.dist.toFixed(3)}</DistanceMeters>`);
    lines.push(`        <HeartRateBpm><Value>${tp.hr}</Value></HeartRateBpm>`);
    lines.push(`        <Cadence>${tcxCadence(tp.cad)}</Cadence>`);
    lines.push(`        <Extensions><ae:TPX><ae:Speed>${tp.speed.toFixed(6)}</ae:Speed></ae:TPX></Extensions>`);
    lines.push(`      </Trackpoint>`);
  }
  lines.push(`    </Track></Lap></Activity></Activities></TrainingCenterDatabase>`);
  return lines.join('\n');
}

// ============ TEST RUNNER ============
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    → ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion gagal');
}

function assertNear(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || ''}: expected ${b} ± ${tol}, got ${a}`);
}

// ============ DATA TEST ============
const GPX_VALID = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="-6.95973" lon="107.69959"/>
    <trkpt lat="-6.96073" lon="107.70059"/>
    <trkpt lat="-6.96173" lon="107.70159"/>
    <trkpt lat="-6.96273" lon="107.70259"/>
    <trkpt lat="-6.96373" lon="107.70359"/>
  </trkseg></trk>
</gpx>`;

const GPX_MULTI_SEG = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <trkseg>
      <trkpt lat="-6.95" lon="107.70"/>
      <trkpt lat="-6.96" lon="107.71"/>
    </trkseg>
    <trkseg>
      <trkpt lat="-7.00" lon="107.75"/>
      <trkpt lat="-7.01" lon="107.76"/>
    </trkseg>
  </trk>
</gpx>`;

const GPX_NO_TRKPT = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg></trkseg></trk></gpx>`;
const GPX_INVALID_XML = `<?xml bukan xml valid <<<<`;
const GPX_BAD_COORDS = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="999" lon="999"/><trkpt lat="-999" lon="-999"/></trkseg></trk></gpx>`;

const GPX_SPECIAL_CHARS = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="-6.95" lon="107.70"/>
    <trkpt lat="-6.96" lon="107.71"/>
    <trkpt lat="-6.97" lon="107.72"/>
    <trkpt lat="-6.98" lon="107.73"/>
  </trkseg></trk>
</gpx>`;

// ============ TESTS ============

console.log('\n=== PaceCraft Unit Tests ===\n');

console.log('[ GPX Parser ]');

test('GPX valid – parse berhasil', () => {
  const r = parseGPX(GPX_VALID);
  assert(r.ok, `Parse gagal: ${r.error}`);
  assert(r.totalPts >= 4, `Titik kurang: ${r.totalPts}`);
  assert(r.totalDist > 10, `Jarak terlalu kecil: ${r.totalDist}`);
});

test('GPX valid – jarak Haversine masuk akal', () => {
  const r = parseGPX(GPX_VALID);
  assert(r.ok);
  // 5 titik diagonal ~1.4km (estimasi kasar)
  assert(r.totalDist > 500, `Jarak kurang: ${r.totalDist} m`);
  assert(r.totalDist < 10000, `Jarak berlebih: ${r.totalDist} m`);
});

test('GPX multi-segmen – diproses sebagai segmen terpisah', () => {
  const r = parseGPX(GPX_MULTI_SEG);
  assert(r.ok);
  assert(r.segmentCount === 2, `Ekspektasi 2 segmen, dapat ${r.segmentCount}`);
});

test('GPX tanpa trkpt – error jelas', () => {
  const r = parseGPX(GPX_NO_TRKPT);
  assert(!r.ok, 'Seharusnya gagal');
  assert(r.error, 'Harus ada pesan error');
});

test('XML tidak valid – error', () => {
  const r = parseGPX(GPX_INVALID_XML);
  assert(!r.ok);
});

test('GPX koordinat di luar batas – titik dibuang', () => {
  const r = parseGPX(GPX_BAD_COORDS);
  assert(!r.ok, 'Seharusnya gagal karena semua titik invalid');
});

test('GPX titik duplikat – difilter', () => {
  const gpxDup = `<?xml version="1.0"?>
  <gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
    <trkpt lat="-6.95" lon="107.70"/>
    <trkpt lat="-6.95" lon="107.70"/>
    <trkpt lat="-6.95" lon="107.70"/>
    <trkpt lat="-6.96" lon="107.71"/>
    <trkpt lat="-6.97" lon="107.72"/>
  </trkseg></trk></gpx>`;
  const r = parseGPX(gpxDup);
  assert(r.ok);
  // Duplikat tidak menyebabkan error
  assert(r.totalDist > 0);
});

test('GPX file kosong – error', () => {
  const r = parseGPX('');
  assert(!r.ok);
});

console.log('\n[ Simulasi Kecepatan ]');

test('Variasi 0% – kecepatan seragam (toleransi kecil)', () => {
  const gpx = parseGPX(GPX_VALID);
  assert(gpx.ok);
  const speeds = simulateSpeeds(gpx.totalDist, 7 * 60 + 25, 0, 0, 42);
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const target = 1000 / (7 * 60 + 25);
  assertNear(avg, target, 0.001, 'Rata-rata kecepatan var=0%');
  // Semua nilai identik atau sangat mirip
  const diff = Math.max(...speeds) - Math.min(...speeds);
  assert(diff < 0.01, `Variasi kecepatan ${diff.toFixed(4)} m/s saat var=0%`);
});

test('Variasi 15% – kecepatan bervariasi tapi rata-rata tetap', () => {
  const gpx = parseGPX(GPX_VALID);
  const speeds = simulateSpeeds(gpx.totalDist, 7 * 60 + 25, 15, 0, 42);
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const target = 1000 / (7 * 60 + 25);
  assertNear(avg, target, 0.02, 'Rata-rata kecepatan var=15%');
  const diff = Math.max(...speeds) - Math.min(...speeds);
  assert(diff > 0.01, `Variasi ${diff.toFixed(4)} seharusnya >0.01`);
});

test('Split negatif – awal lebih lambat dari akhir', () => {
  const totalDist = 10000; // 10 km
  const speeds = simulateSpeeds(totalDist, 7 * 60 + 25, 0, -20, 42);
  const N = speeds.length;
  const firstThird = speeds.slice(0, Math.floor(N / 3));
  const lastThird = speeds.slice(Math.floor(2 * N / 3));
  const avgFirst = firstThird.reduce((a, b) => a + b, 0) / firstThird.length;
  const avgLast = lastThird.reduce((a, b) => a + b, 0) / lastThird.length;
  assert(avgLast > avgFirst, `Split negatif: akhir (${avgLast.toFixed(3)}) harus lebih cepat dari awal (${avgFirst.toFixed(3)})`);
});

test('Split positif – awal lebih cepat dari akhir', () => {
  const totalDist = 10000;
  const speeds = simulateSpeeds(totalDist, 7 * 60 + 25, 0, 20, 42);
  const N = speeds.length;
  const avgFirst = speeds.slice(0, Math.floor(N / 3)).reduce((a, b) => a + b, 0) / Math.floor(N / 3);
  const avgLast = speeds.slice(Math.floor(2 * N / 3)).reduce((a, b) => a + b, 0) / Math.floor(N / 3);
  assert(avgFirst > avgLast, `Split positif: awal (${avgFirst.toFixed(3)}) harus lebih cepat dari akhir (${avgLast.toFixed(3)})`);
});

test('Split nol – tidak ada tren signifikan', () => {
  const totalDist = 10000;
  const speeds = simulateSpeeds(totalDist, 7 * 60 + 25, 0, 0, 42);
  const N = speeds.length;
  const avgFirst = speeds.slice(0, Math.floor(N / 3)).reduce((a, b) => a + b, 0) / Math.floor(N / 3);
  const avgLast = speeds.slice(Math.floor(2 * N / 3)).reduce((a, b) => a + b, 0) / Math.floor(N / 3);
  assertNear(avgFirst, avgLast, 0.05, 'Split=0: awal dan akhir mirip');
});

console.log('\n[ Simulasi Heart Rate ]');

test('HR dalam batas min-maks', () => {
  const hrs = simulateHR(500, 142, 158, 175, 42);
  for (const hr of hrs) {
    assert(hr >= 142 && hr <= 175, `HR ${hr} di luar batas [142,175]`);
  }
});

test('HR rata-rata mendekati target (toleransi ±3)', () => {
  const hrs = simulateHR(1000, 142, 158, 175, 42);
  const avg = hrs.reduce((a, b) => a + b, 0) / hrs.length;
  assertNear(avg, 158, 3, 'HR rata-rata');
});

test('HR min = maks = avg – tidak error', () => {
  const hrs = simulateHR(100, 160, 160, 160, 42);
  for (const hr of hrs) assert(hr === 160, `HR ${hr} harus 160`);
});

test('HR pola pemanasan – awal lebih rendah', () => {
  const hrs = simulateHR(500, 100, 155, 180, 42);
  const awal = hrs.slice(0, 30);
  const tengah = hrs.slice(200, 300);
  const avgAwal = awal.reduce((a, b) => a + b, 0) / awal.length;
  const avgTengah = tengah.reduce((a, b) => a + b, 0) / tengah.length;
  assert(avgAwal < avgTengah, `HR awal (${avgAwal.toFixed(1)}) harus lebih rendah dari tengah (${avgTengah.toFixed(1)})`);
});

console.log('\n[ Simulasi Cadence ]');

test('Cadence rata-rata mendekati target (toleransi ±3)', () => {
  const cads = simulateCadence(500, 165, 42);
  const avg = cads.reduce((a, b) => a + b, 0) / cads.length;
  assertNear(avg, 165, 3, 'Cadence rata-rata');
});

test('Konversi cadence TCX – bagi 2', () => {
  const tcxCad = cad => Math.round(cad / 2);
  assert(tcxCad(165) === 83, `165/2 = 82.5 → 83, dapat ${tcxCad(165)}`);
  assert(tcxCad(180) === 90, `180/2 = 90, dapat ${tcxCad(180)}`);
  assert(tcxCad(160) === 80, `160/2 = 80, dapat ${tcxCad(160)}`);
});

console.log('\n[ Simulasi Utuh ]');

test('Simulasi GPX referensi – durasi ~1:32:31', () => {
  const gpxText = require('fs').readFileSync(
    '/mnt/user-data/uploads/onthegomap-124kmroute-01a21107-588c-7cef-a3b1-77869fc6f545.gpx', 'utf8'
  );
  const gpx = parseGPX(gpxText);
  assert(gpx.ok, `Parse gagal: ${gpx && gpx.error}`);

  // Verifikasi jarak
  assertNear(gpx.totalDist / 1000, 12.475, 0.1, 'Jarak GPX (km)');

  const settings = {
    avgPaceSecPerKm: 7 * 60 + 25,
    variancePct: 8, splitPct: -10,
    hrMin: 142, hrAvg: 158, hrMax: 175,
    cadAvg: 165, startUtcMs: Date.UTC(2026, 10, 25, 0, 30, 0),
    device: 'amazfit', runName: 'Morning Run', runDesc: '',
    seed: 0.42,
  };

  const sim = runSimulation(gpx, settings);
  assertNear(sim.stats.totalDurSec, 5551, 60, 'Durasi (detik)'); // 1:32:31 = 5551 detik
});

test('Timestamp berurutan', () => {
  const gpx = parseGPX(GPX_VALID);
  assert(gpx.ok);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 8, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs: Date.UTC(2026, 10, 25, 0, 30, 0),
    device: 'amazfit', runName: 'Test', runDesc: '', seed: 0.5,
  });
  for (let i = 1; i < sim.trackpoints.length; i++) {
    assert(sim.trackpoints[i].utcMs >= sim.trackpoints[i-1].utcMs,
      `Timestamp tidak berurutan di index ${i}`);
  }
});

test('Jarak kumulatif monoton naik', () => {
  const gpx = parseGPX(GPX_VALID);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 0, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs: Date.UTC(2026, 10, 25, 0, 30, 0),
    device: 'garmin', runName: 'Test', runDesc: '', seed: 0.1,
  });
  for (let i = 1; i < sim.trackpoints.length; i++) {
    assert(sim.trackpoints[i].dist >= sim.trackpoints[i-1].dist - 0.001,
      `Jarak turun di index ${i}`);
  }
});

test('Titik pertama di koordinat awal rute', () => {
  const gpx = parseGPX(GPX_VALID);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 0, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs: 0, device: 'amazfit', runName: 'T', runDesc: '', seed: 0.1,
  });
  const first = sim.trackpoints[0];
  assertNear(first.dist, 0, 0.1, 'Jarak awal');
  assertNear(first.lat, -6.95973, 0.0001, 'Lat awal');
});

test('Simulasi melewati tengah malam – timestamp UTC benar', () => {
  const gpx = parseGPX(GPX_VALID);
  // Mulai 23:30 WIB = 16:30 UTC
  const startUtcMs = Date.UTC(2026, 10, 25, 16, 30, 0);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 0, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs, device: 'amazfit', runName: 'Malam', runDesc: '', seed: 0.2,
  });
  const last = sim.trackpoints[sim.trackpoints.length - 1];
  assert(last.utcMs > startUtcMs, 'Waktu selesai harus setelah mulai');
});

console.log('\n[ Generator TCX ]');

test('TCX valid XML – mengandung elemen wajib', () => {
  const gpx = parseGPX(GPX_VALID);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 0, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs: Date.UTC(2026, 10, 25, 0, 30, 0),
    device: 'amazfit', runName: 'Test', runDesc: '', seed: 0.1,
  });
  const tcx = generateTCX(sim, {
    device: 'amazfit', runName: 'Test', startUtcMs: Date.UTC(2026, 10, 25, 0, 30, 0),
    avgPaceSecPerKm: 7 * 60 + 25,
  });
  assert(tcx.includes('TrainingCenterDatabase'), 'Harus ada TrainingCenterDatabase');
  assert(tcx.includes('Activity Sport="Running"'), 'Harus ada Activity Running');
  assert(tcx.includes('Trackpoint'), 'Harus ada Trackpoint');
  assert(tcx.includes('HeartRateBpm'), 'Harus ada HeartRateBpm');
  assert(tcx.includes('Cadence'), 'Harus ada Cadence');
  assert(tcx.includes('DistanceMeters'), 'Harus ada DistanceMeters');
});

test('TCX tidak mengandung kalori palsu', () => {
  const gpx = parseGPX(GPX_VALID);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 0, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs: 0, device: 'amazfit', runName: 'T', runDesc: '', seed: 0,
  });
  const tcx = generateTCX(sim, { device: 'amazfit', runName: 'T', startUtcMs: 0, avgPaceSecPerKm: 7*60+25 });
  assert(!tcx.includes('<Calories>'), 'TCX tidak boleh mengandung Calories');
});

test('TCX tidak mengandung elevasi', () => {
  const gpx = parseGPX(GPX_VALID);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 0, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs: 0, device: 'garmin', runName: 'T', runDesc: '', seed: 0,
  });
  const tcx = generateTCX(sim, { device: 'garmin', runName: 'T', startUtcMs: 0, avgPaceSecPerKm: 7*60+25 });
  assert(!tcx.includes('AltitudeMeters'), 'TCX tidak boleh mengandung AltitudeMeters');
});

test('TCX mengandung label PaceCraft sebagai Author', () => {
  const gpx = parseGPX(GPX_VALID);
  const sim = runSimulation(gpx, {
    avgPaceSecPerKm: 7 * 60 + 25, variancePct: 0, splitPct: 0,
    hrMin: 142, hrAvg: 158, hrMax: 175, cadAvg: 165,
    startUtcMs: 0, device: 'amazfit', runName: 'T', runDesc: '', seed: 0,
  });
  const tcx = generateTCX(sim, { device: 'amazfit', runName: 'T', startUtcMs: 0, avgPaceSecPerKm: 7*60+25 });
  assert(tcx.includes('PaceCraft'), 'Harus ada label PaceCraft');
});

test('Karakter khusus di nama – di-escape XML', () => {
  assert(xmlEsc('Run & <Test> "Hari\'s"') === 'Run &amp; &lt;Test&gt; &quot;Hari&apos;s&quot;', 'XML escape tidak benar');
});

test('Konversi UTC dari WIB – benar', () => {
  // 25/11/2026 07:30 WIB = 25/11/2026 00:30 UTC
  const y = 2026, mo = 11, d = 25, hh = 7, mm = 30;
  const wibMs = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const utcMs = wibMs - 7 * 3600 * 1000;
  const iso = new Date(utcMs).toISOString();
  assert(iso === '2026-11-25T00:30:00.000Z', `Ekspektasi 00:30 UTC, dapat ${iso}`);
});

test('Format pace – benar', () => {
  assert(fmtPace(7 * 60 + 25) === '7:25', `${fmtPace(7 * 60 + 25)}`);
  assert(fmtPace(5 * 60) === '5:00', `${fmtPace(5 * 60)}`);
  assert(fmtPace(10 * 60 + 9) === '10:09', `${fmtPace(10 * 60 + 9)}`);
});

test('Format durasi – benar', () => {
  assert(fmtDur(5551) === '1:32:31', `${fmtDur(5551)}`);
  assert(fmtDur(60) === '1:00', `${fmtDur(60)}`);
  assert(fmtDur(3661) === '1:01:01', `${fmtDur(3661)}`);
});

// ============ RINGKASAN ============
console.log('\n' + '='.repeat(40));
console.log(`Hasil: ${passed} lulus, ${failed} gagal dari ${passed + failed} tes`);
if (failed > 0) {
  console.log('\n⚠ Ada tes yang gagal. Periksa output di atas.\n');
  process.exit(1);
} else {
  console.log('\n✓ Semua tes lulus!\n');
  process.exit(0);
}
