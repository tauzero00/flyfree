/**
 * 航测航线算法回归校验
 *
 * 用法：node tools/verify-route-algorithm.js
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 设计原则：只断言**坐标系无关的契约不变量**。
 *
 * 为什么不复刻算法内部坐标系：算法以局部平面坐标生成航点，该坐标系经
 * 「球面距离构造 + 绕中心旋转」两步得到，外部复刻需要精确重现其取舍
 * （尤其自动航线角 calcBestAngle 在等长边多边形下由浮点误差决定）。
 * 试图复刻会引入比被校验代码更多的假设，把校验器的缺陷误判成产品缺陷。
 * 因此本脚本只用以下不变量——它们在任何合理坐标系下都必须成立：
 *
 *   1. 航点全部落在测区内（球面距离平面 + 点多边形测试，容差 0.2m）
 *   2. 相邻同类航点的球面距离：同一拍照跑内 == pointSpacing；
 *      换排 / 排内分段跳转属过渡段，须 ≥ 1.5 × pointSpacing（可区分于拍照间距）
 *   3. 转弯点必在两条拍照段之间（两侧邻居均为拍照点），且转弯路径
 *      （两侧腿长之和）不超过两侧拍照点直线距离的 1.05 倍 ——
 *      旧版缺陷是转弯点接错排末端，每次换排横穿整个测区再折回，
 *      转弯里程是最优的 10~20 倍，本条即为其回归闸门
 *   4. photoDistance + turnDistance == totalDistance，且与独立重算一致
 *   5. 转弯段距离 > 0（旧实现恒为 0）
 *   6. 云台角语义：拍照点 == 参数值，转弯点 == 0
 *   7. id 连续、无重合航点、参数为有限数、拍照点编号 1..N 连续（转弯点编号为空）
 *   8. 覆盖率无空洞（用分排线段长度算出测区覆盖下界，与像幅宽度比较）
 *   9. 退化参数被拒绝而不是死循环
 *  10. 合法边界参数不被误拒
 *  11. E 组效率基线：矩形场景转弯里程 ≤ 趟数 × hypot(航点间距, 航线间距)；
 *      单分段排场景总长 ≤ 扫描线总长 + 端点残差 + 转弯余量的预算
 *  12. 重叠率自检：航向/旁向实际重叠率 ≥ 要求值（内置自检 + 独立复算一致）
 *  13. 拍照点停留 0.5s（转弯点不停留），预估时间含停留；
 *      KMZ 拍照动作组为 sequence 模式且「悬停 1s → 拍照」顺序正确（悬停按秒写入）
 *  14. F 组任务拆分：每任务 ≤ 上限、拍照点全保留有序、边界转弯点丢弃、
 *      转弯点守恒、每任务可独立导出（Placemark 数一致 + 悬停/拍照动作）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_ROOT = path.join(__dirname, '..');
const PLANNER_PATH = path.join(PROJECT_ROOT, 'js', 'routePlanner.js');

// ---- 加载被测模块 ----
const plannerSource = fs.readFileSync(PLANNER_PATH, 'utf8');
const sandbox = { console, Math, Infinity, NaN, Number };
vm.createContext(sandbox);
vm.runInContext(plannerSource + '\n;globalThis.__RoutePlanner = RoutePlanner;', sandbox);
const RoutePlanner = sandbox.__RoutePlanner;

// kmzExport.buildWaylinesWpml 为纯字符串构建（JSZip/document 仅在导出/导入时触达），
// 在 Node 中直接驱动以断言拍照动作（悬停→拍照）的 XML 结构
const KMZ_PATH = path.join(PROJECT_ROOT, 'js', 'kmzExport.js');
vm.runInContext(fs.readFileSync(KMZ_PATH, 'utf8') + '\n;globalThis.__KmzExport = KmzExport;', sandbox);
const KmzExport = sandbox.__KmzExport;

// ---- 断言器 ----
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return true; }
  failures.push({ name, detail: detail || '' });
  return false;
}
function group(title) { console.log(`\n=== ${title} ===`); }
function report(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function num(v, digits) { return Number.isFinite(v) ? Number(v.toFixed(digits === undefined ? 4 : digits)) : String(v); }

// ---- 球面距离平面（与算法同一尺度：以球面距离构造） ----
function makePlane(polygonWgs) {
  const n = polygonWgs.length;
  const cLng = polygonWgs.reduce((s, p) => s + p[0], 0) / n;
  const cLat = polygonWgs.reduce((s, p) => s + p[1], 0) / n;
  const toPlane = (lng, lat) => [
    RoutePlanner.distance(cLng, cLat, lng, cLat) * (lng >= cLng ? 1 : -1),
    RoutePlanner.distance(cLng, cLat, cLng, lat) * (lat >= cLat ? 1 : -1)
  ];
  return { toPlane, polygon: polygonWgs.map(p => toPlane(p[0], p[1])) };
}

function polyInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToBoundary(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const x1 = poly[j][0], y1 = poly[j][1], x2 = poly[i][0], y2 = poly[i][1];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}

/**
 * 扫描线求交（纯平面几何，与算法实现无关）——
 * 用于算出「测区在任意方向上的可覆盖下界」：把测区按 step 间距切成平行线，
 * 所有线段长度之和 × 像幅宽度即像幅并集的理论覆盖面积。
 * 这个量是坐标系无关的（面积不随旋转改变）。
 *
 * 采样从 ymin + 1e-6 起步：恰好压在边界上的横线与水平边重合、
 * 端点接触的边不触发跨越判定，求交结果为空，会把整排算丢。
 */
function scanlineTotalLength(poly, angleDeg, step) {
  const a = angleDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const rot = poly.map(p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
  const ys = rot.map(p => p[1]);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  let total = 0;
  for (let y = ymin + 1e-6; y <= ymax + 1e-9; y += step) {
    const xs = [];
    for (let i = 0; i < rot.length; i++) {
      const A = rot[i], B = rot[(i + 1) % rot.length];
      if (Math.abs(A[1] - B[1]) < 1e-12) continue;
      if ((A[1] < y && B[1] >= y) || (B[1] < y && A[1] >= y)) {
        xs.push(A[0] + ((y - A[1]) / (B[1] - A[1])) * (B[0] - A[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) total += xs[i + 1] - xs[i];
  }
  return total;
}

// ---- 场景定义（以米构造，再转 WGS-84；经度缩放取 cos(参考纬度)） ----
const R = 6371000, D2R = Math.PI / 180;
const REF_LNG = 116.4, REF_LAT = 31.2;
const M_PER_DEG_LNG = R * D2R * Math.cos(REF_LAT * D2R);
const M_PER_DEG_LAT = R * D2R;
const toWgs = (x, y) => [REF_LNG + x / M_PER_DEG_LNG, REF_LAT + y / M_PER_DEG_LAT];

function rect(w, h, rotDeg) {
  const r = (rotDeg || 0) * D2R, c = Math.cos(r), s = Math.sin(r);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => toWgs(x * c - y * s, x * s + y * c));
}

const SCENARIOS = [
  { key: 'S1', name: '正方形 500x500 轴对齐', rectLike: true, polygon: rect(500, 500, 0) },
  { key: 'S2', name: '正方形 500x500 转 45°', rectLike: true, polygon: rect(500, 500, 45) },
  { key: 'S3', name: '长条 800x150', rectLike: true, polygon: rect(800, 150, 0) },
  { key: 'S6', name: '竖长 150x800（截图形态）', rectLike: true, polygon: rect(150, 800, 0) },
  { key: 'S7', name: '扁长 1000x120', rectLike: true, polygon: rect(1000, 120, 0) },
  {
    key: 'S4', name: '凹形 L 600x600',
    polygon: [[0, 0], [600, 0], [600, 200], [200, 200], [200, 600], [0, 600]]
      .map(([x, y]) => toWgs(x - 300, y - 300))
  },
  { key: 'S5', name: '小矩形 120x80', rectLike: true, polygon: rect(120, 80, 0) },
  {
    // U 形：开口朝北，横排在上臂区域被缺口切成两段 —— 覆盖「一排多段」
    // （排内跳转）与逐排方向 DP。手动指定 courseAngle=0 强制横排扫描，
    // 避免方向择优自动选中纵排（单分段）后该路径失去覆盖。
    key: 'S8', name: '凹形 U 600x600 开口朝北（一排多段）', multiSegment: true,
    params: { courseAngle: 0 },
    polygon: [[-300, -300], [300, -300], [300, 300], [100, 300], [100, -100],
      [-100, -100], [-100, 300], [-300, 300]].map(([x, y]) => toWgs(x, y))
  },
  {
    // 直角三角形：验证候选方向扩展 —— 传统「只取边方向」候选选直角边
    // （跨度 400m，9 趟），补充「航线平行于边」候选后可选斜边法线方向
    // （跨度 = 斜边高 333m，7 趟）。
    key: 'S9', name: '直角三角形 600x400（斜边方向择优）',
    polygon: [[0, 0], [600, 0], [0, 400]].map(([x, y]) => toWgs(x - 300, y - 200))
  }
];

// Mavic 3E 广角（与 app.js 预设一致）
const BASE_PARAMS = {
  altitude: 100, forwardOverlap: 0.75, sideOverlap: 0.65,
  sensorWidth: 5280, sensorHeight: 3956, focalLength: 12.29, pixelSize: 3.3,
  speed: 8, courseAngle: null, gimbalPitch: -90
};

const GSD = (BASE_PARAMS.pixelSize * BASE_PARAMS.altitude) / (BASE_PARAMS.focalLength * 10);
const IMG_W = (BASE_PARAMS.sensorWidth * GSD) / 100;
const IMG_H = (BASE_PARAMS.sensorHeight * GSD) / 100;
const LINE_SPACING = IMG_W * (1 - BASE_PARAMS.sideOverlap);
const POINT_SPACING = IMG_H * (1 - BASE_PARAMS.forwardOverlap);

console.log('航测航线算法回归校验');
console.log(`被测文件: ${path.relative(process.cwd(), PLANNER_PATH)}`);
console.log(`派生量: GSD=${GSD.toFixed(3)}cm/px 像幅=${IMG_W.toFixed(2)}x${IMG_H.toFixed(2)}m ` +
  `航线间距=${LINE_SPACING.toFixed(2)}m 航点间距=${POINT_SPACING.toFixed(2)}m`);

// ============================================================
group('A. 回归基线：旧缺陷不得复现');

// A1 参数守卫：退化参数必须拒绝（旧实现死循环）
const GUARD_CASES = [
  { label: 'sideOverlap = 1.0（旧版 lineSpacing=0 死循环）', patch: { sideOverlap: 1.0 } },
  { label: 'sideOverlap = 1.01（旧版负步长死循环）', patch: { sideOverlap: 1.01 } },
  { label: 'forwardOverlap = 1.0（旧版 pointSpacing=0 死循环）', patch: { forwardOverlap: 1.0 } },
  { label: 'altitude = 0（旧版 GSD=0 死循环）', patch: { altitude: 0 } },
  { label: 'altitude = NaN（旧版静默回退默认值）', patch: { altitude: NaN } },
  { label: 'focalLength = 0', patch: { focalLength: 0 } },
  { label: 'pixelSize = -1', patch: { pixelSize: -1 } },
  { label: 'polygon 顶点不足 3 个', polygonOverride: [[116.4, 31.2], [116.41, 31.2]] },
  { label: 'photoHoverSeconds = -1（负停留）', patch: { photoHoverSeconds: -1 } },
  { label: 'photoHoverSeconds = 501（超上限）', patch: { photoHoverSeconds: 501 } }
];

for (const gc of GUARD_CASES) {
  const polygon = gc.polygonOverride || rect(500, 500, 0);
  const t0 = Date.now();
  let error = null;
  try {
    RoutePlanner.generateRoute(polygon, { ...BASE_PARAMS, ...(gc.patch || {}) });
  } catch (e) { error = e; }
  const elapsed = Date.now() - t0;
  const ok = !!error && elapsed < 5000;
  check(`A1 ${gc.label}`, ok, error ? '' : '未抛出错误（应拒绝）');
  report(gc.label, ok, error ? `已拒绝: ${error.message}` : `未抛出错误（耗时 ${elapsed}ms）`);
}

// A2 契约不变量（逐场景）
const results = {};

for (const scn of SCENARIOS) {
  const plane = makePlane(scn.polygon);
  const t0 = Date.now();
  let error = null, out = null;
  try { out = RoutePlanner.generateRoute(scn.polygon, { ...BASE_PARAMS, ...(scn.params || {}) }); }
  catch (e) { error = e; }
  const elapsed = Date.now() - t0;

  if (error) {
    check(`A2 ${scn.key} 正常参数应能生成航线`, false, error.message);
    report(`${scn.key} 生成航线`, false, error.message);
    continue;
  }

  const waypoints = out.waypoints;
  const stats = out.stats;
  const pts = waypoints.map(w => plane.toPlane(w.lng, w.lat));
  const nPhoto = waypoints.filter(w => w.type === 'photo').length;

  console.log(`  [${scn.key}] ${scn.name}: ${waypoints.length} 航点（拍照 ${nPhoto} / 转弯 ${waypoints.length - nPhoto}），${elapsed}ms`);

  // 不变量 1：航点全在测区内
  const outside = [];
  pts.forEach((p, i) => {
    if (!polyInPoly(p[0], p[1], plane.polygon)) {
      outside.push({ i, type: waypoints[i].type, d: distToBoundary(p[0], p[1], plane.polygon) });
    }
  });
  const real = outside.filter(o => o.d > 0.2);
  check(`A2 ${scn.key} 航点全在测区内`, real.length === 0,
    real.slice(0, 6).map(o => `#${o.i}(${o.type}) ${o.d.toFixed(2)}m`).join(', '));
  report('航点全在测区内', real.length === 0, real.length
    ? `${real.length} 个越界: ` + real.slice(0, 6).map(o => `#${o.i}(${o.type}) ${o.d.toFixed(2)}m`).join(', ')
    : `${waypoints.length} 点通过（≤0.2m 浮点抖动 ${outside.length - real.length} 个已忽略）`);

  // 不变量 2：相邻拍照点间距 = pointSpacing（同一拍照跑内），
  // 或为换排 / 排内分段跳转的过渡段（≥ 1.5 × pointSpacing，与拍照间距可区分）
  const photoPairs = [], turnPairs = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const d = RoutePlanner.distance(a.lng, a.lat, b.lng, b.lat);
    if (a.type === 'photo' && b.type === 'photo') photoPairs.push(d);
    if (a.type === 'turn' && b.type === 'turn') turnPairs.push(d);
  }
  const intervals = photoPairs.filter(d => Math.abs(d - POINT_SPACING) <= 0.05);
  const badTransit = photoPairs.filter(d => Math.abs(d - POINT_SPACING) > 0.05 && d < POINT_SPACING * 1.5);
  const photoDev = intervals.length ? Math.max(...intervals.map(d => Math.abs(d - POINT_SPACING))) : Infinity;
  const b2 = photoPairs.length > 0 && badTransit.length === 0 && photoDev <= 0.05;
  check(`A2 ${scn.key} 相邻拍照点间距 = ${POINT_SPACING.toFixed(2)}m（或过渡段）`, b2,
    badTransit.length ? `${badTransit.length} 对间距异常: ${badTransit.slice(0, 4).map(d => num(d)).join(', ')}` : `最大偏差 ${num(photoDev)}m`);
  report(`相邻拍照点间距 = ${POINT_SPACING.toFixed(2)}m（或过渡段）`, b2,
    `${photoPairs.length} 对（拍照间距 ${intervals.length} / 过渡段 ${photoPairs.length - intervals.length}），最大偏差 ${num(photoDev)}m`);

  // 不变量 3：转弯点两侧必是拍照点，且转弯路径不得绕远 ——
  // 两侧腿长之和 ≤ 两侧拍照点直线距离 × 1.05 + 0.5。
  // （转弯点取连线中点时路径恰等于直线距离；拉回纠偏点也在连线上。）
  // 旧版「两侧距离均须大于 pointSpacing」的口径是在转弯点接错排末端的
  // 缺陷下标定的——正确 U 形转弯的腿长约为航线间距的一半，
  // 可小于航点间距，故改以「不绕远」为语义。
  const turnIdx = waypoints.map((w, i) => (w.type === 'turn' ? i : -1)).filter(i => i >= 0);
  const badTurn = turnIdx.filter(i => {
    const prev = waypoints[i - 1], next = waypoints[i + 1];
    if (!prev || !next) return true;
    if (prev.type !== 'photo' || next.type !== 'photo') return true;
    const d1 = RoutePlanner.distance(prev.lng, prev.lat, waypoints[i].lng, waypoints[i].lat);
    const d2 = RoutePlanner.distance(waypoints[i].lng, waypoints[i].lat, next.lng, next.lat);
    const direct = RoutePlanner.distance(prev.lng, prev.lat, next.lng, next.lat);
    return d1 + d2 > direct * 1.05 + 0.5;
  });
  const b3 = badTurn.length === 0;
  check(`A2 ${scn.key} 转弯点语义（夹在两拍照段之间且不绕远）`, b3, `异常 ${badTurn.length}/${turnIdx.length}`);
  report(`转弯点语义（夹在两拍照段之间且不绕远）`, b3,
    `${turnIdx.length} 个转弯点，异常 ${badTurn.length}`);

  // 不变量 4/5：统计口径
  const sumOk = Math.abs((stats.photoDistance + stats.turnDistance) - stats.totalDistance) <= 1;
  let pD = 0, tD = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const d = RoutePlanner.distance(a.lng, a.lat, b.lng, b.lat);
    if (a.type === 'photo') pD += d; else tD += d;
  }
  const recalcOk = sumOk &&
    Math.abs(Math.round(pD) - stats.photoDistance) <= 1 &&
    Math.abs(Math.round(tD) - stats.turnDistance) <= 1;
  check(`A2 ${scn.key} 统计口径自洽且与独立重算一致`, recalcOk,
    `${stats.photoDistance}+${stats.turnDistance} vs ${stats.totalDistance}；重算 ${Math.round(pD)}+${Math.round(tD)}`);
  report('统计口径自洽且与独立重算一致', recalcOk,
    `代码 ${stats.photoDistance}+${stats.turnDistance}=${stats.photoDistance + stats.turnDistance} / total ${stats.totalDistance}；` +
    `重算 ${Math.round(pD)}+${Math.round(tD)}`);

  const b5 = stats.turnDistance > 0;
  check(`A2 ${scn.key} 转弯段距离 > 0（旧版恒为 0）`, b5, `turnDistance=${stats.turnDistance}`);
  report('转弯段距离 > 0（旧版恒为 0）', b5, `turnDistance=${stats.turnDistance}m`);

  // 不变量 6：云台角语义
  const gimbalBad = waypoints.filter(w =>
    (w.type === 'photo' && w.gimbalPitch !== BASE_PARAMS.gimbalPitch) ||
    (w.type === 'turn' && w.gimbalPitch !== 0));
  const b6 = gimbalBad.length === 0;
  check(`A2 ${scn.key} 云台角语义`, b6, `异常 ${gimbalBad.length}`);
  report('云台角语义（拍照点=参数值 / 转弯点=0）', b6, `异常 ${gimbalBad.length} 个`);

  // 不变量 7：id 连续、无重合、无 NaN、拍照编号 1..N 连续
  const idOk = waypoints.every((w, i) => w.id === i);
  const photoList = waypoints.filter(w => w.type === 'photo');
  const photoIdxOk = photoList.length === 0 ||
    photoList.every((w, i) => w.photoIndex === i + 1);
  const turnIdxNullOk = waypoints.every(w =>
    w.type !== 'photo' ? w.photoIndex == null : true);
  let dup = 0;
  for (let i = 1; i < waypoints.length; i++) {
    if (RoutePlanner.distance(waypoints[i - 1].lng, waypoints[i - 1].lat,
        waypoints[i].lng, waypoints[i].lat) < 0.05) dup++;
  }
  const finiteOk = waypoints.every(w =>
    Number.isFinite(w.lng) && Number.isFinite(w.lat) && Number.isFinite(w.alt) && Number.isFinite(w.speed));
  const b7 = idOk && dup === 0 && finiteOk && photoIdxOk && turnIdxNullOk;
  check(`A2 ${scn.key} id 连续 / 无重合 / 数值有限 / 拍照编号连续`, b7,
    `idOk=${idOk} dup=${dup} finite=${finiteOk} photoIdxOk=${photoIdxOk} turnIdxNullOk=${turnIdxNullOk}`);
  report('id 连续 / 无重合 / 数值有限 / 拍照编号连续', b7,
    `id 0..${waypoints.length - 1} 连续=${idOk}，重合段 ${dup}，数值有限=${finiteOk}，` +
    `拍照编号 1..${photoList.length} 连续=${photoIdxOk}，转弯点编号为空=${turnIdxNullOk}`);

  // 不变量 8：扫描方向必须使趟数最少
  //
  // 为什么必须断言这条：旧实现用「最长边」选方向，与「趟数最少」在细长测区上
  // 结果相反——150×800 竖长矩形会被切成 17 趟（截图形态），而最优只需 4 趟。
  // 这里用与算法同源的量（绕 -angle 旋转后的 y 跨度）独立枚举所有边方向，
  // 验证被选中的方向确实取到最小趟数；同时验证转弯点数不超过趟数-1。
  {
    const { points: lp } = RoutePlanner.toLocalCoords(scn.polygon);
    const MIN_LINE_SPACING = 0.5;
    const spans = [];
    for (let i = 0; i < lp.length; i++) {
      const a = lp[i], b = lp[(i + 1) % lp.length];
      const deg = ((Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI) % 180 + 180) % 180;
      const r = -deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      const ys = lp.map(p => p.x * s + p.y * c);
      spans.push(Math.max(...ys) - Math.min(...ys));
    }
    const minSpan = Math.min(...spans);
    const usedAngle = out.params.courseAngle;
    const r = -usedAngle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const usedYs = lp.map(p => p.x * s + p.y * c);
    const usedSpan = Math.max(...usedYs) - Math.min(...usedYs);
    const rowsUsed = Math.floor(usedSpan / LINE_SPACING) + 1;
    const rowsBest = Math.floor(minSpan / LINE_SPACING) + 1;
    const b8 = rowsUsed <= rowsBest;
    check(`A2 ${scn.key} 扫描方向取到最少趟数`, b8,
      `采用 ${usedAngle}° → ${rowsUsed} 趟，理论最少 ${rowsBest} 趟（垂直跨度 ${num(usedSpan, 1)} vs ${num(minSpan, 1)}m）`);
    report('扫描方向取到最少趟数', b8,
      `采用 ${usedAngle}° → ${rowsUsed} 趟（垂直跨度 ${num(usedSpan, 1)}m），` +
      `枚举全部边方向的最少趟数 ${rowsBest} 趟（${num(minSpan, 1)}m）`);
  }

  // 不变量 9：转弯点数不超过「趟数 - 1」
  {
    const turnCount = waypoints.filter(w => w.type === 'turn').length;
    const usedAngle = out.params.courseAngle;
    const { points: lp } = RoutePlanner.toLocalCoords(scn.polygon);
    const r = -usedAngle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const ys = lp.map(p => p.x * s + p.y * c);
    const span = Math.max(...ys) - Math.min(...ys);
    const maxRows = Math.floor(span / LINE_SPACING) + 1;
    const b9 = turnCount <= maxRows - 1;
    check(`A2 ${scn.key} 转弯点数不超过趟数-1`, b9,
      `转弯点 ${turnCount}，最大允许 ${maxRows - 1}`);
    report('转弯点数不超过趟数-1', b9, `转弯点 ${turnCount} ≤ ${maxRows - 1}`);
  }

  results[scn.key] = { scn, plane, waypoints, stats, pts, params: out.params };
}

// ============================================================
group('B. 覆盖率与面积守恒（坐标系无关）');

for (const key of Object.keys(results)) {
  const { scn, plane, waypoints, stats } = results[key];
  const cov = stats.coverage;
  const nPhoto = waypoints.filter(w => w.type === 'photo').length;

  // B1 算法内置自检必须通过
  const b1 = !!(cov && cov.ok);
  check(`B1 ${key} 算法内置覆盖自检通过`, b1, cov ? `maxGap=${cov.maxGap} tol=${cov.tolerance}` : '无 coverage');
  report('算法内置覆盖自检', b1, cov
    ? `最大边界余量 ${cov.maxGap}m ≤ 容差 ${cov.tolerance}m（网格 ${cov.gridCell}m）`
    : '无 coverage 字段');

  // B2 面积守恒：像幅并集的覆盖能力必须 ≥ 测区面积
  //    可覆盖下界 = 沿航线方向的扫描线总长 × 像幅宽度（面积，与旋转无关）
  //    注意：算法的航线方位 = 90° − courseAngle，本校验器的旋转约定与之互为
  //    镜像，须传 −courseAngle 才能切到与被测算法相同的航线方向。
  const angle = (results[key].params && results[key].params.courseAngle) || 0;
  const scanLen = scanlineTotalLength(plane.polygon, -angle, LINE_SPACING);
  const coverageCapacity = scanLen * IMG_W;
  const b2 = coverageCapacity >= stats.areaSize * 0.98;
  check(`B2 ${key} 像幅并集覆盖能力 ≥ 测区面积`, b2,
    `能力 ${Math.round(coverageCapacity)}m² vs 测区 ${stats.areaSize}m²`);
  report('像幅并集覆盖能力 ≥ 测区面积', b2,
    `扫描线总长 ${Math.round(scanLen)}m × 像幅宽 ${IMG_W.toFixed(1)}m = ${Math.round(coverageCapacity)}m²，` +
    `测区面积 ${stats.areaSize}m²`);

  // B3 测区面积与独立 shoelace 一致（相对偏差 < 1%）
  const poly = plane.polygon;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
  }
  area = Math.abs(area) / 2;
  const relErr = Math.abs(area - stats.areaSize) / area;
  const b3 = relErr < 0.01;
  check(`B3 ${key} 测区面积自洽`, b3, `相对偏差 ${(relErr * 100).toFixed(3)}%`);
  report('测区面积自洽（独立 shoelace）', b3,
    `代码 ${stats.areaSize}m² vs 重算 ${Math.round(area)}m²，相对偏差 ${(relErr * 100).toFixed(3)}%`);

  // B4 每张像幅面积与 GSD 推导一致
  const b4 = Math.abs(stats.imageCoverW - IMG_W) <= 0.05 && Math.abs(stats.imageCoverH - IMG_H) <= 0.05;
  check(`B4 ${key} 像幅尺寸与 GSD 推导一致`, b4,
    `${stats.imageCoverW}x${stats.imageCoverH} vs ${num(IMG_W, 2)}x${num(IMG_H, 2)}`);
  report('像幅尺寸与 GSD 推导一致', b4,
    `代码 ${stats.imageCoverW}×${stats.imageCoverH}m vs 期望 ${num(IMG_W, 2)}×${num(IMG_H, 2)}m`);

  // B5 重叠率自检：内置检查通过，且与独立复算一致。
  //   航向独立复算：序列中相邻拍照点（无转弯点间隔、距离 ≤ 1.5×间距），
  //                实际重叠率 = 1 − d/像幅高；
  //   旁向独立复算：按转弯点把拍照序列切成排，相邻排垂直间距 =
  //                上一排末拍照点到下一排首末拍照点所成直线的距离，
  //                实际重叠率 = 1 − 间距/像幅宽。
  //   覆盖遗漏由 B1（内置覆盖自检）承担，本条专注重叠率配比。
  {
    const ov = stats.overlap;
    const fwdIndep = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      if (a.type === 'photo' && b.type === 'photo') {
        const d = RoutePlanner.distance(a.lng, a.lat, b.lng, b.lat);
        if (d <= POINT_SPACING * 1.5) fwdIndep.push(1 - d / IMG_H);
      }
    }
    const rowGroups = [];
    let curRow = [];
    for (const w of waypoints) {
      if (w.type === 'photo') curRow.push(w);
      else if (w.type === 'turn' && curRow.length) { rowGroups.push(curRow); curRow = []; }
    }
    if (curRow.length) rowGroups.push(curRow);
    const sideIndep = [];
    for (let i = 1; i < rowGroups.length; i++) {
      const prevG = rowGroups[i - 1], curG = rowGroups[i];
      if (prevG.length < 2 || curG.length < 2) continue; // 单点排无法拟合直线
      const a = plane.toPlane(curG[0].lng, curG[0].lat);
      const b = plane.toPlane(curG[curG.length - 1].lng, curG[curG.length - 1].lat);
      const p = plane.toPlane(prevG[prevG.length - 1].lng, prevG[prevG.length - 1].lat);
      const abx = b[0] - a[0], aby = b[1] - a[1];
      const len = Math.hypot(abx, aby);
      if (len < 1e-6) continue;
      const d = Math.abs(abx * (p[1] - a[1]) - aby * (p[0] - a[0])) / len;
      sideIndep.push(1 - d / IMG_W);
    }
    const fwdOkIndep = fwdIndep.length === 0 ||
      Math.min(...fwdIndep) >= BASE_PARAMS.forwardOverlap - 1e-3;
    const sideOkIndep = sideIndep.length === 0 ||
      Math.min(...sideIndep) >= BASE_PARAMS.sideOverlap - 1e-3;
    const b5 = !!(ov && ov.ok && ov.forward.ok && ov.side.ok) && fwdOkIndep && sideOkIndep;
    check(`B5 ${key} 重叠率自检（航向/旁向达标，独立复算一致）`, b5,
      `内置 ok=${ov && ov.ok}；独立: 航向 ${fwdOkIndep}(${fwdIndep.length} 对) / 旁向 ${sideOkIndep}(${sideIndep.length} 对)`);
    report('重叠率自检（航向/旁向达标，独立复算一致）', b5,
      `航向最小 ${ov && ov.forward.min != null ? (ov.forward.min * 100).toFixed(1) : '—'}%` +
      `（要求 ≥${(BASE_PARAMS.forwardOverlap * 100).toFixed(0)}%，${fwdIndep.length} 对）；` +
      `旁向最小 ${ov && ov.side.min != null ? (ov.side.min * 100).toFixed(1) : '—'}%` +
      `（要求 ≥${(BASE_PARAMS.sideOverlap * 100).toFixed(0)}%，${sideIndep.length} 对）`);
  }

  // B6 拍照点停留：hoverTime = 1s（产品默认，转弯点不停留），预估时间含停留。
  //    单位是「秒」——DJI 端 wpml:hoverTime 按秒解释（可调 0~500s）；
  //    旧实现误按毫秒写入（0.5s → 500），设备上变成每点 500 秒停留。
  {
    const hoverOk = waypoints.every(w =>
      w.type === 'photo'
        ? Math.abs((w.hoverTime == null ? 0 : w.hoverTime) - 1) < 1e-9
        : (w.hoverTime == null || w.hoverTime === 0));
    const estExpected = stats.totalDistance / BASE_PARAMS.speed + nPhoto * 1;
    const estOk = Math.abs(stats.estimatedTime - estExpected) <= 2;
    const b6 = hoverOk && estOk;
    check(`B6 ${key} 拍照停留 1s + 预估时间含停留`, b6,
      `hoverOk=${hoverOk} estOk=${estOk}（${stats.estimatedTime}s vs 期望 ${estExpected.toFixed(1)}s）`);
    report('拍照停留 1s + 预估时间含停留', b6,
      `${nPhoto} 个拍照点各停 1s（共 ${Math.round(nPhoto * 1)}s）；` +
      `预估 ${stats.estimatedTime}s = 航程 ${stats.totalDistance}m ÷ ${BASE_PARAMS.speed}m/s + 停留`);
  }

  // B7 KMZ 导出 XML：拍照点动作组为 sequence 模式、「悬停 → 拍照」顺序正确，
  //    且悬停值按**秒**写入（默认 1，不得出现毫秒值 500）
  {
    const xml = KmzExport.buildWaylinesWpml(waypoints, { ...BASE_PARAMS });
    const placemarks = xml.split('<Placemark>').slice(1);
    let photoPlacemarks = 0, badHover = 0;
    for (const pm of placemarks) {
      if (!pm.includes('>takePhoto<')) continue;
      photoPlacemarks++;
      const seqOk = pm.includes('<wpml:actionGroupMode>sequence</wpml:actionGroupMode>');
      const hoverIdx = pm.indexOf('<wpml:hoverTime>1</wpml:hoverTime>');
      const photoIdx = pm.indexOf('>takePhoto<');
      if (!seqOk || hoverIdx === -1 || hoverIdx > photoIdx) badHover++;
    }
    const hoverSecondsOnly = !xml.includes('<wpml:hoverTime>500</wpml:hoverTime>') &&
      !xml.includes('<wpml:hoverTime>0.5</wpml:hoverTime>');
    const b7 = photoPlacemarks === nPhoto && badHover === 0 && hoverSecondsOnly;
    check(`B7 ${key} KMZ 拍照动作（sequence + 悬停 1s → 拍照，秒制）`, b7,
      `拍照 Placemark ${photoPlacemarks}/${nPhoto}，异常 ${badHover}，秒制=${hoverSecondsOnly}`);
    report('KMZ 拍照动作（sequence + 悬停 1s → 拍照，秒制）', b7,
      `${photoPlacemarks} 个拍照航点均为 sequence 组、悬停 1s（秒制）先于快门`);

    // B8 KMZ 结构与「RC2/DJI Fly 实测样例」对齐（企业版文档与消费级 App 的差异以 App 为准）：
    //    · actionGroupId 在文件内唯一、从 0 单调递增（官方文档要求）
    //    · gimbalEvenlyRotate 段组：triggerType=reachPoint、mode=parallel（App 自身输出口径）
    //    · 拍照组：mode=sequence（ho ver→takePhoto 必须串行）
    //    · takePhoto / startRecord / stopRecord 带 fileSuffix（文档必需元素）
    //    · takeOffSecurityHeight 默认不写（App 输出无此字段），显式传入时才写出
    {
      const gids = [...xml.matchAll(/<wpml:actionGroupId>(\d+)<\/wpml:actionGroupId>/g)].map(m => +m[1]);
      const gidUnique = new Set(gids).size === gids.length;
      const gidMonotonic = gids.every((v, i) => i === 0 ? v === 0 : v === gids[i - 1] + 1);

      // 段组：按块解析，检查含 gimbalEvenlyRotate 的组
      const groupBlocks = xml.match(/<wpml:actionGroup>[\s\S]*?<\/wpml:actionGroup>/g) || [];
      const segBlocks = groupBlocks.filter(b => b.includes('>gimbalEvenlyRotate<'));
      const segTriggerOk = segBlocks.every(b => b.includes('<wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>'));
      const segModeOk = segBlocks.every(b => b.includes('<wpml:actionGroupMode>parallel</wpml:actionGroupMode>'));

      // 拍照组：必须 sequence
      const photoBlocks = groupBlocks.filter(b => b.includes('>takePhoto<'));
      const photoSeqOk = photoBlocks.every(b => b.includes('<wpml:actionGroupMode>sequence</wpml:actionGroupMode>'));

      const photoActions = (xml.match(/<wpml:actionActuatorFunc>takePhoto<\/wpml:actionActuatorFunc>/g) || []).length;
      const suffix = (xml.match(/<wpml:fileSuffix>/g) || []).length;
      const noSecHeight = !xml.includes('<wpml:takeOffSecurityHeight>');
      const b8 = gidUnique && gidMonotonic && segTriggerOk && segModeOk && photoSeqOk &&
        photoActions === suffix && noSecHeight;
      check(`B8 ${key} KMZ 结构与 DJI Fly 实测样例对齐`, b8,
        `gidUnique=${gidUnique} gidMonotonic=${gidMonotonic} 段组reachPoint=${segTriggerOk} 段组parallel=${segModeOk} ` +
        `拍照组sequence=${photoSeqOk} fileSuffix(${suffix})=${photoActions} 无takeOffSecurityHeight=${noSecHeight}`);
      report('KMZ 结构与 DJI Fly 实测样例对齐', b8,
        `${gids.length} 个动作组 ID 全局唯一且 0..${gids.length - 1} 递增；${segBlocks.length} 个段组 reachPoint+parallel；` +
        `${photoBlocks.length} 个拍照组 sequence；${suffix} 个 fileSuffix；默认不写起飞安全高度`);

      // B9 显式请求时才写 takeOffSecurityHeight（企业端需要）
      const xml2 = KmzExport.buildWaylinesWpml(waypoints, { ...BASE_PARAMS, takeOffSecurityHeight: 20 });
      const b9 = /<wpml:takeOffSecurityHeight>20<\/wpml:takeOffSecurityHeight>/.test(xml2);
      check(`B9 ${key} 显式传入时写出起飞安全高度`, b9, b9 ? '' : '未写出');
      report('显式传入时写出起飞安全高度', b9,
        `params.takeOffSecurityHeight=20 → ${(xml2.match(/<wpml:takeOffSecurityHeight>([^<]*)</) || [])[1] ?? '(缺失)'}`);

      // B10 角度字段必须在官方取值范围内：
      //    wpml:waypointHeadingAngle ∈ [-180, 180]（越界会导致 DJI 判定航线不可执行）
      //    旧实现写入 0~360 的方位角，首段朝西/朝南时写出 269.0 这类越界值
      {
        const headingAngles = [...xml.matchAll(/<wpml:waypointHeadingAngle>([^<]*)<\/wpml:waypointHeadingAngle>/g)]
          .map(m => Number(m[1]));
        const outOfRange = headingAngles.filter(v => !Number.isFinite(v) || v < -180 || v > 180);
        const b10 = outOfRange.length === 0;
        check(`B10 ${key} 偏航角在 [-180, 180] 内`, b10,
          outOfRange.length ? `越界值: ${outOfRange.slice(0, 5).join(', ')}` : `${headingAngles.length} 个角度全部合规`);
        report('偏航角在 [-180, 180] 内', b10,
          outOfRange.length
            ? `越界 ${outOfRange.length} 个: ${outOfRange.slice(0, 5).join(', ')}`
            : `${headingAngles.length} 个角度全部合规（首点 ${headingAngles[0]}）`);
      }
    }
  }
}

// ============================================================
group('C. 参数边界（合法范围内不得被误拒）');

const LEGAL_CASES = [
  { label: 'altitude = 10（下限）', patch: { altitude: 10 } },
  { label: 'altitude = 1500（上限）', patch: { altitude: 1500 } },
  { label: 'forwardOverlap = 0.95（上限）', patch: { forwardOverlap: 0.95 } },
  { label: 'sideOverlap = 0.95（上限）', patch: { sideOverlap: 0.95 } },
  { label: 'forwardOverlap = 0', patch: { forwardOverlap: 0 } },
  { label: 'sideOverlap = 0', patch: { sideOverlap: 0 } },
  { label: 'courseAngle = 30（手动指定）', patch: { courseAngle: 30 } },
  { label: 'courseAngle = 0（正北）', patch: { courseAngle: 0 } },
  { label: 'courseAngle = 179', patch: { courseAngle: 179 } },
  { label: 'gimbalPitch = -60', patch: { gimbalPitch: -60 } },
  { label: 'photoHoverSeconds = 1（默认）', patch: { photoHoverSeconds: 1 } },
  { label: 'photoHoverSeconds = 0（不停留）', patch: { photoHoverSeconds: 0 } },
  { label: 'photoHoverSeconds = 500（上限）', patch: { photoHoverSeconds: 500 } }
];

for (const lc of LEGAL_CASES) {
  const t0 = Date.now();
  let error = null, out = null;
  try { out = RoutePlanner.generateRoute(rect(300, 300, 0), { ...BASE_PARAMS, ...lc.patch }); }
  catch (e) { error = e; }
  const ok = !error && out && out.waypoints.length > 0;
  check(`C1 ${lc.label}`, ok, error ? error.message : '');
  report(lc.label, ok, error
    ? `被误拒: ${error.message}`
    : `${out.waypoints.length} 航点，${Date.now() - t0}ms`);
}

// ============================================================
group('E. 效率基线（转弯不绕远 / 总长不虚胖）');

for (const key of Object.keys(results)) {
  const { scn, waypoints, stats, plane, params } = results[key];
  const turnCount = waypoints.filter(w => w.type === 'turn').length;

  // E1 转弯里程预算（矩形场景）：相邻排端点几乎对齐，每次转弯的
  // 直线距离 ≤ hypot(航点间距, 航线间距)（横向错位不超过一个航点间距）。
  // 旧版错侧缺陷下 S1 的转弯里程 4850m，是本预算（~620m）的 8 倍。
  if (scn.rectLike) {
    const budget = turnCount * Math.hypot(POINT_SPACING, LINE_SPACING) * 1.1 + 5;
    const e1 = stats.turnDistance <= budget;
    check(`E1 ${key} 转弯里程 ≤ 预算`, e1,
      `turnDistance=${stats.turnDistance}，预算 ${Math.round(budget)}`);
    report(`${key} 转弯里程 ≤ ${Math.round(budget)}m`, e1,
      `实际 ${stats.turnDistance}m / ${turnCount} 次转弯（每次 ≈ ${num(turnCount ? stats.turnDistance / turnCount : 0, 1)}m）`);
  }

  // E2 总长预算（单分段排场景）：总长不得超过「扫描线总长（覆盖里程下界）
  // + 排两端拍照点残差余量 + 换排转弯余量」。
  // 一排多段场景（U 形）的排内跳转里程取决于缺口宽度，无方向无关的
  // 独立预算口径，故跳过。
  if (!scn.multiSegment) {
    const angle = params.courseAngle || 0;
    // 与 B2 同理：传 −courseAngle 以对齐被测算法的航线方向（90° − θ）
    const scanLen = scanlineTotalLength(plane.polygon, -angle, LINE_SPACING);
    const { points: lp } = RoutePlanner.toLocalCoords(scn.polygon);
    const r = -angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const ys = lp.map(p => p.x * s + p.y * c);
    const rowsUsed = Math.floor((Math.max(...ys) - Math.min(...ys)) / LINE_SPACING) + 1;
    const budget = scanLen + 2 * POINT_SPACING * rowsUsed +
      (rowsUsed - 1) * (LINE_SPACING + 2 * POINT_SPACING) + 20;
    const e2 = stats.totalDistance <= budget;
    check(`E2 ${key} 总长 ≤ 效率预算`, e2,
      `total=${stats.totalDistance}，预算 ${Math.round(budget)}`);
    report(`${key} 总长 ≤ 效率预算`, e2,
      `实际 ${stats.totalDistance}m ≤ 预算 ${Math.round(budget)}m` +
      `（扫描线 ${Math.round(scanLen)}m × ${rowsUsed} 趟 + 残差/转弯余量）`);
  }
}

// ============================================================
group('F. 任务拆分（多文件导出契约）');

// F1 逐场景拆分契约（上限 60，强制多数场景发生拆分）：
//    每任务 ≤ 上限；拼接后为原序列的有序子序列（仅缺边界转弯点）；
//    拍照点全保留且有序；任务首尾均为拍照点；转弯点守恒；
//    每个任务可独立导出 KMZ（Placemark 数一致且含拍照动作）
for (const key of Object.keys(results)) {
  const { waypoints } = results[key];
  const split = RoutePlanner.splitMission(waypoints, 60);
  const ms = split.missions;

  const sizeOk = ms.length > 0 && ms.every(m => m.waypoints.length <= 60);
  const merged = ms.flatMap(m => m.waypoints);
  let j = 0;
  for (const w of waypoints) {
    if (j < merged.length && merged[j].id === w.id) j++;
  }
  const subseqOk = merged.length === waypoints.length - split.droppedTurns && j === merged.length;
  const origPhotos = waypoints.filter(w => w.type === 'photo').map(w => w.id);
  const splitPhotos = merged.filter(w => w.type === 'photo').map(w => w.id);
  const photosOk = origPhotos.length === splitPhotos.length &&
    origPhotos.every((id, i) => id === splitPhotos[i]);
  const boundaryOk = ms.every(m =>
    m.waypoints[0].type === 'photo' && m.waypoints[m.waypoints.length - 1].type === 'photo');
  const turnTotal = ms.reduce((s, m) =>
    s + m.waypoints.filter(w => w.type === 'turn').length, 0);
  const turnOk = turnTotal + split.droppedTurns ===
    waypoints.filter(w => w.type === 'turn').length;
  const kmzOk = ms.every(m => {
    const xml = KmzExport.buildWaylinesWpml(m.waypoints, { ...BASE_PARAMS });
    const pmCount = xml.split('<Placemark>').length - 1;
    return pmCount === m.waypoints.length &&
      (m.photoCount === 0 || (xml.includes('>takePhoto<') && xml.includes('<wpml:hoverTime>1</wpml:hoverTime>')));
  });
  const f1 = sizeOk && subseqOk && photosOk && boundaryOk && turnOk && kmzOk;
  check(`F1 ${key} 拆分契约（上限 60）`, f1,
    `sizeOk=${sizeOk} subseqOk=${subseqOk} photosOk=${photosOk} boundaryOk=${boundaryOk} turnOk=${turnOk} kmzOk=${kmzOk}`);
  report(`${key} 拆分契约（上限 60）`, f1,
    `${waypoints.length} 航点 → ${ms.length} 个任务（${ms.map(m => m.waypoints.length).join('+')}），` +
    `丢弃边界转弯点 ${split.droppedTurns}，拍照点 ${splitPhotos.length}/${origPhotos.length} 全保留`);
}

// F2 上限 ≥ 总数：单任务、不丢任何点
{
  const { waypoints } = results['S1'];
  const split = RoutePlanner.splitMission(waypoints, 10000);
  const f2 = split.missions.length === 1 &&
    split.missions[0].waypoints.length === waypoints.length &&
    split.droppedTurns === 0;
  check('F2 上限 ≥ 总数时不拆分、不丢点', f2,
    `${split.missions.length} 任务 / ${split.missions[0] && split.missions[0].waypoints.length} 点 / 丢弃 ${split.droppedTurns}`);
  report('上限 ≥ 总数时不拆分、不丢点', f2,
    `S1 ${waypoints.length} 航点 → 单任务原样导出`);
}

// F3 上限小于单排拍照点数：长条测区强制排内硬切，拍照点仍完整
{
  const out = RoutePlanner.generateRoute(rect(2000, 80, 0), { ...BASE_PARAMS });
  const split = RoutePlanner.splitMission(out.waypoints, 50);
  const origPhotos = out.waypoints.filter(w => w.type === 'photo').map(w => w.id);
  const splitPhotos = split.missions.flatMap(m => m.waypoints)
    .filter(w => w.type === 'photo').map(w => w.id);
  const f3 = split.missions.length > 1 &&
    split.missions.every(m => m.waypoints.length <= 50) &&
    origPhotos.length === splitPhotos.length &&
    origPhotos.every((id, i) => id === splitPhotos[i]);
  check('F3 上限小于单排时排内硬切且拍照点完整', f3,
    `${out.waypoints.length} 航点 → ${split.missions.length} 任务（${split.missions.map(m => m.waypoints.length).join('+')}）`);
  report('上限小于单排时排内硬切且拍照点完整', f3,
    `2000×80 长条（单排 ${origPhotos.length / 2} 拍照点）上限 50 → ` +
    `${split.missions.length} 任务，拍照点 ${splitPhotos.length}/${origPhotos.length} 全保留`);
}

// F4 非法上限必须拒绝
for (const bad of [0, -5, 1.5, NaN]) {
  let err = null;
  try { RoutePlanner.splitMission([{ id: 0, type: 'photo' }], bad); } catch (e) { err = e; }
  const f4 = !!err;
  check(`F4 拆分上限 ${bad} 被拒绝`, f4, err ? '' : '未抛出错误');
  report(`上限 ${bad} 被拒绝`, f4, err ? `已拒绝: ${err.message}` : '未抛出错误');
}

// ============================================================
group('V. 摄像任务（同套蛇形排布，只在起点/终点/转向处设航点，不停留，连续录像）');

const VIDEO_PARAMS = { ...BASE_PARAMS, missionType: 'video' };

for (const scn of SCENARIOS) {
  const base = results[scn.key];
  if (!base) continue;
  const params = { ...VIDEO_PARAMS, ...(scn.params || {}) };
  let out = null, err = null;
  try { out = RoutePlanner.generateRoute(scn.polygon, params); } catch (e) { err = e; }
  if (err) {
    check(`V ${scn.key} 摄像任务可生成航线`, false, err.message);
    report(`${scn.key} 摄像任务`, false, err.message);
    continue;
  }

  const wps = out.waypoints;
  const stats = out.stats;

  // V1 航点结构：全部为摄像航点（无拍照点 / 转弯点）；数量远少于拍照任务
  const allVideo = wps.length > 0 && wps.every(w => w.type === 'video');
  const fewer = wps.length < base.waypoints.length;

  // V2 录像动作：仅首点 startRecord、仅末点 stopRecord，其余无动作；全程不悬停
  const recordOk = wps[0].action === 'startRecord' &&
    wps[wps.length - 1].action === 'stopRecord' &&
    wps.filter(w => w.action === 'startRecord').length === 1 &&
    wps.filter(w => w.action === 'stopRecord').length === 1 &&
    wps.slice(1, -1).every(w => !w.action);
  const noHover = wps.every(w => w.hoverTime == null || w.hoverTime === 0);
  const noPhoto = wps.every(w => w.photoIndex == null) && stats.photoCount === 0;

  // V3 只在排端点设点：每个「同排航段」的两个端点都必须落在测区边界上
  //    （排内若插了中间点，中间点不在边界上，此断言即失败）。
  //    尖角排的航段可以很短，故不设长度下限。
  const rowLegOk = (() => {
    let legs = 0;
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      if (a.rowIndex == null || a.rowIndex !== b.rowIndex) continue;
      legs++;
      const pa = base.plane.toPlane(a.lng, a.lat);
      const pb = base.plane.toPlane(b.lng, b.lat);
      if (distToBoundary(pa[0], pa[1], base.plane.polygon) > 0.5) return false;
      if (distToBoundary(pb[0], pb[1], base.plane.polygon) > 0.5) return false;
    }
    return legs > 0;
  })();

  // V4 覆盖自检通过（摄像为连续录制，沿排密集采样后复用覆盖自检）
  const covOk = !!(stats.coverage && stats.coverage.ok);

  // V5 重叠率：旁向达标；航向不适用（连续录像无拍照间距）
  const ov = stats.overlap;
  const overlapOk = !!(ov && ov.side.ok && ov.forward.ok && ov.forward.applicable === false);

  // V6 统计口径：总长 = 覆盖段 + 转向段；无停留；预估时间 = 航程 ÷ 速度
  const estExpected = stats.totalDistance / BASE_PARAMS.speed;
  const statOk = Math.abs(stats.estimatedTime - estExpected) <= 2 && stats.hoverTotalTime === 0;

  // V7 KMZ：首点 startRecord、末点 stopRecord，且全程无 takePhoto / hover
  const xml = KmzExport.buildWaylinesWpml(wps, { ...BASE_PARAMS });
  const pmCount = xml.split('<Placemark>').length - 1;
  const kmzOk = pmCount === wps.length &&
    xml.includes('<wpml:actionActuatorFunc>startRecord</wpml:actionActuatorFunc>') &&
    xml.includes('<wpml:actionActuatorFunc>stopRecord</wpml:actionActuatorFunc>') &&
    !xml.includes('>takePhoto<') && !xml.includes('<wpml:hoverTime>');

  const ok = allVideo && fewer && recordOk && noHover && noPhoto && rowLegOk &&
    covOk && overlapOk && statOk && kmzOk;

  // V10 摄像任务的转向模式必须是「到点停」：
  //     摄像航段是整排一条（数百米）、排间仅十几米，用「过点不停」会让 App 规划出
  //     连续平滑曲线并在 180° 折返处外扩成大圈（实测遥控器上显示为一串环路、
  //     里程虚增）。到点停打断平滑曲线，保持直线排布。
  const turnModes = [...xml.matchAll(/<wpml:waypointTurnMode>([^<]*)<\/wpml:waypointTurnMode>/g)].map(m => m[1]);
  const stopOnly = turnModes.length > 0 &&
    turnModes.every(m => m === 'toPointAndStopWithContinuityCurvature');
  check(`V10 ${scn.key} 摄像转向模式=到点停（不绕圈）`, stopOnly,
    stopOnly ? '' : `出现: ${[...new Set(turnModes)].join(', ')}`);
  report('摄像转向模式=到点停（不绕圈）', stopOnly,
    stopOnly ? `${turnModes.length} 个航点全部为 toPointAndStopWithContinuityCurvature`
      : `出现: ${[...new Set(turnModes)].join(', ')}`);
  check(`V ${scn.key} 摄像任务契约`, ok,
    `allVideo=${allVideo} fewer=${fewer} record=${recordOk} noHover=${noHover} noPhoto=${noPhoto} ` +
    `rowLeg=${rowLegOk} cov=${covOk} overlap=${overlapOk} stat=${statOk} kmz=${kmzOk}`);
  report(`${scn.key} 摄像任务契约`, ok,
    `${wps.length} 个摄像航点（拍照任务同参数 ${base.waypoints.length} 点）| 总长 ${stats.totalDistance}m ` +
    `（录像段 ${stats.photoDistance} + 转向 ${stats.turnDistance}）| 排数 ${stats.rowCount} | ` +
    `覆盖 ok=${covOk} | 旁向 ${(ov.side.min * 100).toFixed(1)}% | 预估 ${stats.estimatedTime}s（无停留）| ` +
    `动作 [${wps.filter(w => w.action).map(w => w.action).join(', ')}]`);
}

// V8 摄像任务的拆分仍然可用（航点少，但契约必须成立）
{
  const out = RoutePlanner.generateRoute(rect(3000, 3000, 0), { ...VIDEO_PARAMS });
  const split = RoutePlanner.splitMission(out.waypoints, 10);
  const merged = split.missions.flatMap(m => m.waypoints);
  const v8 = split.missions.length > 1 &&
    split.missions.every(m => m.waypoints.length <= 10) &&
    merged.length + split.droppedTurns === out.waypoints.length &&
    merged.length === out.waypoints.length &&
    merged.every((w, i) => w.id === out.waypoints[i].id);
  check('V8 摄像任务可拆分且航点无损', v8,
    `${out.waypoints.length} 航点 → ${split.missions.length} 个任务`);
  report('摄像任务可拆分且航点无损', v8,
    `3000×3000 摄像（${out.waypoints.length} 航点）上限 10 → ${split.missions.length} 个任务，` +
    `丢弃 ${split.droppedTurns} 个航点`);
}

// V9 非法任务类型被拒绝
{
  let err = null;
  try { RoutePlanner.generateRoute(rect(300, 300, 0), { ...BASE_PARAMS, missionType: 'panorama' }); }
  catch (e) { err = e; }
  const v9 = !!err;
  check('V9 非法任务类型被拒绝', v9, err ? '' : '未抛出错误');
  report('非法任务类型被拒绝', v9, err ? `已拒绝: ${err.message}` : '未抛出错误');
}

// ============================================================
group('N. 导出命名（DJI 原生 UUID v4 / 可读）');

// N1 DJI 原生命名：与 RC2/DJI Fly 导出的文件名同构
//    （实测样例 0B161508-C1D8-42E9-B06F-628AAF65C3B0.kmz）
{
  const DJI_NAME_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\.kmz$/;
  const names = [];
  for (let i = 0; i < 500; i++) names.push(KmzExport.generateMissionFileName('dji', 1, 1));
  const formatOk = names.every(n => DJI_NAME_RE.test(n));
  const upperOk = names.every(n => n.slice(0, -4) === n.slice(0, -4).toUpperCase());
  const uniqueOk = new Set(names).size === names.length;
  // 版本位/变体位
  const versionOk = names.every(n => n[14] === '4');               // 第 3 段首位
  const variantOk = names.every(n => '89AB'.includes(n[19]));      // 第 4 段首位
  const n1 = formatOk && upperOk && uniqueOk && versionOk && variantOk;
  check('N1 DJI 原生命名 = 大写 UUID v4 + .kmz', n1,
    `format=${formatOk} upper=${upperOk} unique(500)=${uniqueOk} v4=${versionOk} variant=${variantOk}`);
  report('DJI 原生命名 = 大写 UUID v4 + .kmz', n1,
    `样例 ${names[0]}（36 字符 / 8-4-4-4-12 / 版本位 4 / 变体位 8-B）`);
}

// N2 可读命名：单份与拆分命名规则
{
  const single = KmzExport.generateMissionFileName('readable', 1, 1, 'mission_2026-10-15');
  const part2 = KmzExport.generateMissionFileName('readable', 2, 3, 'mission_2026-10-15');
  const n2 = single === 'mission_2026-10-15.kmz' && part2 === 'mission_2026-10-15_part2of3.kmz';
  check('N2 可读命名规则', n2, `单份=${single} 拆分=${part2}`);
  report('可读命名规则', n2, `${single} / ${part2}`);
}

// ============================================================
group('D. 性能基线');

{
  const t0 = Date.now();
  let error = null, out = null;
  try { out = RoutePlanner.generateRoute(rect(1000, 1000, 0), { ...BASE_PARAMS, sideOverlap: 0.8 }); }
  catch (e) { error = e; }
  const elapsed = Date.now() - t0;
  const ok = !error && elapsed < 500;
  check('D1 1000x1000m / 旁向80% 生成耗时 < 500ms', ok, error ? error.message : `${elapsed}ms`);
  report('1000x1000m 测区（高密度航线）', ok, error
    ? error.message
    : `${out.waypoints.length} 航点 / ${elapsed}ms`);
}

// ============================================================
console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
}
console.log(`结果：${passed} 项通过，${failures.length} 项失败\n`);
for (const f of failures) {
  console.log(`  FAIL  ${f.name}${f.detail ? '\n        ' + f.detail : ''}`);
}
process.exit(1);
