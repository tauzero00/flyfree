/**
 * 航线规划核心算法模块
 * 根据测区多边形和飞行参数生成蛇形（之字形）覆盖航线
 *
 * 坐标约定：所有内部计算在「局部平面坐标 (米)」中进行，最后才转回 WGS-84。
 * 这样避免「局部坐标 → 经纬度 → 再转局部坐标」的往返换算误差。
 */

const RoutePlanner = (() => {
  const EARTH_RADIUS = 6371000; // 地球半径 (m)

  // 航线数上限：防止极端参数（间距趋近 0）导致循环失控
  const MAX_SCAN_LINES = 5000;

  // 测区覆盖率自检的容差：留白小于半个网格即视为覆盖合格
  const COVERAGE_TOLERANCE_FACTOR = 0.5;

  // ---- 地理坐标工具 ----

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  /**
   * 计算两点间的距离 (Haversine)
   */
  function distance(lng1, lat1, lng2, lat2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * 从起点出发，沿给定方位角和距离计算终点坐标
   * @param bearing 方位角（度，正北为0，顺时针）
   * @param dist 距离（米）
   * @returns [lng, lat]
   */
  function destination(lng, lat, bearing, dist) {
    const br = toRad(bearing);
    const angularDist = dist / EARTH_RADIUS;
    const lat1 = toRad(lat);
    const lng1 = toRad(lng);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDist) +
      Math.cos(lat1) * Math.sin(angularDist) * Math.cos(br));
    const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(angularDist) * Math.cos(lat1),
      Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2));
    return [toDeg(lng2), toDeg(lat2)];
  }

  /**
   * 将多边形顶点从经纬度转为以中心为原点的局部平面坐标 (米)
   * 返回 { center: [lng, lat], points: [{x, y}] }
   */
  function toLocalCoords(polygon) {
    const n = polygon.length;
    let sumLng = 0, sumLat = 0;
    for (const p of polygon) { sumLng += p[0]; sumLat += p[1]; }
    const center = [sumLng / n, sumLat / n];
    const points = polygon.map(p => ({
      x: distance(center[0], center[1], p[0], center[1]) * (p[0] >= center[0] ? 1 : -1),
      y: distance(center[0], center[1], center[0], p[1]) * (p[1] >= center[1] ? 1 : -1)
    }));
    return { center, points };
  }

  /**
   * 将局部平面坐标转回经纬度
   */
  function fromLocalCoords(center, x, y) {
    const bearingX = x >= 0 ? 90 : 270;
    const bearingY = y >= 0 ? 0 : 180;
    const [tmpLng, tmpLat] = destination(center[0], center[1], bearingY, Math.abs(y));
    return destination(tmpLng, tmpLat, bearingX, Math.abs(x));
  }

  // ---- 数值与参数校验 ----

  /**
   * 严格解析有限数值：空值 / 非数字 / Infinity / NaN 一律拒绝
   */
  function readFinite(value, name) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n)) {
      throw new Error(`参数「${name}」不是有效数值，请检查输入。`);
    }
    return n;
  }

  /**
   * 参数守卫
   *
   * 为什么必须在这里拦截：lineSpacing / pointSpacing 会直接作为 for 循环步长，
   * 一旦为 0 或负数，循环不会终止（步长为 0 时条件恒真且每轮都在追加数据），
   * 浏览器页签会因此耗尽内存挂死。派生量校验比单个入参校验更可靠。
   */
  function validatePlanInput(polygonWgs, params) {
    if (!Array.isArray(polygonWgs) || polygonWgs.length < 3) {
      throw new Error('测区至少需要 3 个顶点，请重新绘制测区。');
    }
    for (let i = 0; i < polygonWgs.length; i++) {
      const p = polygonWgs[i];
      if (!Array.isArray(p) || p.length < 2 ||
          !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        throw new Error(`测区第 ${i + 1} 个顶点坐标无效，请重新绘制测区。`);
      }
    }

    const v = {
      altitude: readFinite(params.altitude, '飞行高度'),
      speed: readFinite(params.speed, '飞行速度'),
      forwardOverlap: readFinite(params.forwardOverlap, '航向重叠率'),
      sideOverlap: readFinite(params.sideOverlap, '旁向重叠率'),
      sensorWidth: readFinite(params.sensorWidth, '传感器宽度'),
      sensorHeight: readFinite(params.sensorHeight, '传感器高度'),
      focalLength: readFinite(params.focalLength, '焦距'),
      pixelSize: readFinite(params.pixelSize, '像元尺寸'),
      gimbalPitch: params.gimbalPitch == null
        ? -90 : readFinite(params.gimbalPitch, '云台俯仰角')
    };

    // 边界外扩系数（0 ~ 1），默认 0 = 不外扩，与历史行为一致
    v.edgeBuffer = params.edgeBuffer == null ? 0 : readFinite(params.edgeBuffer, '边界外扩');
    if (v.edgeBuffer < 0 || v.edgeBuffer > 1) {
      throw new Error(`边界外扩需在 0% ~ 100% 之间（当前 ${(v.edgeBuffer * 100).toFixed(0)}%）。`);
    }

    // 拍照点悬停时间（秒）：到点先悬停稳定再拍摄，消除运动模糊；0 = 不停留
    //
    // 单位是「秒」：导出的 WPML 悬停动作 wpml:hoverTime 在 DJI 端按秒解释
    // （DJI Pilot 的悬停时间可调范围是 0 ~ 500 秒）。旧实现按毫秒写入
    // （0.5s → 500），设备上被读成 500 秒——每个拍照点要悬停 8 分 20 秒，
    // 全航线累计数十小时，表现为「卡在第一个航点、后续航点无法执行」。
    v.photoHoverSeconds = params.photoHoverSeconds == null
      ? 1 : readFinite(params.photoHoverSeconds, '拍照停留时间');
    if (v.photoHoverSeconds < 0 || v.photoHoverSeconds > 500) {
      throw new Error(`拍照停留时间需在 0 ~ 500 秒之间（当前 ${v.photoHoverSeconds}）。`);
    }

    // 任务类型：photo = 拍照航测（蛇形覆盖 + 定点悬停拍照）
    //           video = 摄像（同一套蛇形排布，但只在起点/终点/转向处设航点，
    //                   中途不停留，全程录像）
    const missionType = params.missionType == null ? 'photo' : String(params.missionType);
    if (missionType !== 'photo' && missionType !== 'video') {
      throw new Error(`任务类型只能是「拍照航测」或「摄像」（当前 ${params.missionType}）。`);
    }
    v.missionType = missionType;

    if (v.altitude < 1 || v.altitude > 1500) {
      throw new Error(`飞行高度需在 1 ~ 1500 m 之间（当前 ${v.altitude}）。`);
    }
    if (v.speed <= 0 || v.speed > 30) {
      throw new Error(`飞行速度需在 0 ~ 30 m/s 之间（当前 ${v.speed}）。`);
    }
    if (v.sensorWidth <= 0 || v.sensorHeight <= 0) {
      throw new Error('传感器宽高必须大于 0。');
    }
    if (v.focalLength <= 0) {
      throw new Error('焦距必须大于 0。');
    }
    if (v.pixelSize <= 0) {
      throw new Error('像元尺寸必须大于 0。');
    }
    if (v.gimbalPitch < -90 || v.gimbalPitch > 30) {
      throw new Error(`云台俯仰角需在 -90° ~ 30° 之间（当前 ${v.gimbalPitch}）。`);
    }
    // 上限 0.95：重叠率取 1 会使对应间距退化为 0，属于物理上不可执行的参数
    if (v.forwardOverlap < 0 || v.forwardOverlap > 0.95) {
      throw new Error(`航向重叠率需在 0% ~ 95% 之间（当前 ${(v.forwardOverlap * 100).toFixed(0)}%）。`);
    }
    if (v.sideOverlap < 0 || v.sideOverlap > 0.95) {
      throw new Error(`旁向重叠率需在 0% ~ 95% 之间（当前 ${(v.sideOverlap * 100).toFixed(0)}%）。`);
    }

    if (params.courseAngle != null && params.courseAngle !== '') {
      v.courseAngle = readFinite(params.courseAngle, '航线角度');
    } else {
      v.courseAngle = null;
    }

    return v;
  }

  // ---- 几何工具 ----

  /**
   * 将多边形绕原点旋转 angle 弧度
   */
  function rotatePolygon(points, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return points.map(p => ({
      x: p.x * cos - p.y * sin,
      y: p.x * sin + p.y * cos
    }));
  }

  /**
   * 计算水平线 y = const 与多边形的交点区间
   * 返回 [[x1, x2], ...] 有序区间对
   */
  function linePolygonIntersections(y, points) {
    const intersections = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      // 跳过水平边
      if (Math.abs(a.y - b.y) < 1e-9) continue;
      // 检查边是否跨越 y 水平线（使用 >= 确保端点在扫描线上也被正确计数）
      if ((a.y < y && b.y >= y) || (b.y < y && a.y >= y)) {
        const t = (y - a.y) / (b.y - a.y);
        intersections.push(a.x + t * (b.x - a.x));
      }
    }
    intersections.sort((a, b) => a - b);
    const segments = [];
    for (let i = 0; i < intersections.length - 1; i += 2) {
      segments.push([intersections[i], intersections[i + 1]]);
    }
    return segments;
  }

  /**
   * 计算多边形的 y 范围
   */
  function getYRange(points) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minY, maxY };
  }

  /**
   * 排布平行航线（主流程与方向择优共用同一套数学）：
   * 先按跨度与航线间距定排数，再把余量在两端对称分配。
   *
   * margin 下限 1e-6：跨度被间距整除时余量为 0，首排会恰好压在边界上，
   * 而扫描线求交对「恰好在边界上」的横线返回空（水平边被跳过、
   * 端点接触的边不触发跨越判定），整排拍照点会静默丢失。
   */
  function layoutRows(rotated, lineSpacing, crosstrackBuffer, alongTrackBuffer) {
    const { minY, maxY } = getYRange(rotated);
    const bufferedMinY = minY - crosstrackBuffer;
    const bufferedSpan = Math.max(0, (maxY + crosstrackBuffer) - bufferedMinY);
    const lineCount = Math.max(1, Math.floor(bufferedSpan / lineSpacing) + 1);
    const margin = Math.max((bufferedSpan - (lineCount - 1) * lineSpacing) / 2, 1e-6);
    const rows = [];
    if (lineCount <= MAX_SCAN_LINES) {
      for (let k = 0; k < lineCount; k++) {
        const y = bufferedMinY + margin + k * lineSpacing;
        const segs = linePolygonIntersections(y, rotated)
          .map(([x1, x2]) => [x1 - alongTrackBuffer, x2 + alongTrackBuffer])
          .filter(([x1, x2]) => x2 - x1 > 1e-6);
        if (segs.length) rows.push({ y, segs: segs.sort((a, b) => a[0] - b[0]) });
      }
    }
    return { rows, lineCount, margin };
  }

  /**
   * 逐排飞行方向优化（动态规划）。
   *
   * 每排有两个可选方向：正向（沿 x 轴）或反向。旧实现强制排排交替
   * （严格蛇形），这在凸测区上恰好最优，但在凹测区上会产生横穿
   * 测区的长过渡——分排结构随排变化时，局部打破交替更省里程。
   * DP 在「所有方向序列」上最小化相邻排出口→入口的连接距离，
   * 严格交替只是解空间中的一个特解，因此结果永远不会比旧实现差。
   *
   * 排内访问顺序固定为沿排单调（对一维区间集合，单调序使跳转总长最小），
   * 排内里程与方向无关，DP 只需裁决方向序列。连接成本取区间端点的
   * 欧氏距离（实际路径经转弯点中转，等于该直线距离，见生成段注释）。
   */
  function planRowDirections(rows) {
    const m = rows.length;
    if (m === 0) return { dirs: [], cost: 0 };
    const dp = Array.from({ length: m }, () => [Infinity, Infinity]);
    const par = Array.from({ length: m }, () => [0, 0]);
    dp[0][0] = 0;
    dp[0][1] = 0;
    for (let i = 1; i < m; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const dy = cur.y - prev.y;
      // 正向：最左段左端进、最右段右端出；反向：镜像
      const prevOut = [prev.segs[prev.segs.length - 1][1], prev.segs[0][0]];
      const curIn = [cur.segs[0][0], cur.segs[cur.segs.length - 1][1]];
      for (let d = 0; d < 2; d++) {
        for (let pd = 0; pd < 2; pd++) {
          const cost = dp[i - 1][pd] + Math.hypot(curIn[d] - prevOut[pd], dy);
          if (cost < dp[i][d] - 1e-9) {
            dp[i][d] = cost;
            par[i][d] = pd;
          }
        }
      }
    }
    let d = dp[m - 1][1] < dp[m - 1][0] ? 1 : 0;
    const dirs = new Array(m);
    for (let i = m - 1; i >= 0; i--) {
      dirs[i] = d === 1;
      d = par[i][d];
    }
    return { dirs, cost: Math.min(dp[m - 1][0], dp[m - 1][1]) };
  }

  /**
   * 一排内的拍照点横坐标序列（按飞行顺序）。
   *
   * 相位对齐：把「区间长度 − (n−1)×间距」的残差平分到两端，
   * 与排布留白的对称分配同一哲学。旧实现从区间端点起步，
   * 残差（最大接近一个间距）全部压在另一端，边界覆盖不对称。
   */
  function photoXsInRow(row, reverse, spacing) {
    const xs = [];
    const ordered = reverse ? row.segs.slice().reverse() : row.segs;
    for (const [a, b] of ordered) {
      const len = b - a;
      const n = Math.max(1, Math.floor(len / spacing + 1e-9) + 1);
      const pad = (len - (n - 1) * spacing) / 2;
      const start = reverse ? b - pad : a + pad;
      for (let k = 0; k < n; k++) {
        xs.push(reverse ? start - k * spacing : start + k * spacing);
      }
    }
    return xs;
  }

  /**
   * 估算某候选方向下的航线总长：排内里程 + DP 连接里程。
   * 排内里程用「最左段左端 → 最右段右端」的总跨度（含分段间跳转）
   * 近似拍照里程；对所有候选口径一致，仅用于横向比较。
   */
  function estimateRouteLength(rows) {
    let total = 0;
    for (const r of rows) total += r.segs[r.segs.length - 1][1] - r.segs[0][0];
    return total + planRowDirections(rows).cost;
  }

  /**
   * 选出航测效率最高的扫描方向，并返回该方向下的完整排布。
   *
   * 主判据是「垂直跨度最小 ⇒ 航线趟数最少」，不是「最长边」。
   * 这两者常被混为一谈，而在细长测区上结果完全相反：
   * 一个 800×150 m 的竖长矩形，取最长边会竖着扫，把测区切成
   * 约 17 趟的碎条，转弯次数与空飞里程爆炸；取垂直跨度最小的
   * 方向才会横着扫，只需 4 趟。
   *
   * 为什么以「趟数」为目标：总航程 ≈ 趟数 × 测区长边 + 转弯空飞 × 趟数，
   * 而转弯空飞在总里程里占比可观；趟数同时最小化这两个量，
   * 且它不依赖 GSD / 重叠率等参数，是稳定的几何判据。
   *
   * 候选方向取每条边的「平行」与「垂直」两个朝向（各贡献一个旋转角）：
   * 旋转角 θ 与航线方位的换算是「航线方位 = 90° − θ」（跨度则沿
   * 方位 −θ 度量，即镜像方向）。传统做法只取边方向本身，等价于只允许
   * 航线取边的镜像方向——轴对齐测区上两者重合，斜边多边形上则既不
   * 平行也不垂直于任何边。补齐两个朝向后，「航线与某条边平行」可被
   * 枚举到，在斜边多边形（三角形 / 平行四边形）上可显著减少趟数
   * ——如直角三角形沿斜边扫，跨度从直角边 400m 降到斜边高 333m。
   *
   * 趟数相同时用「精确估算总里程」再判（排内跨度 + DP 连接成本），
   * 替代旧版的采样近似：等长边多边形下这一步是决定性的，
   * 否则结果会由浮点比较决定（同一测区两次可能得到不同航线）。
   */
  function chooseLayout(localPoints, lineSpacing, crosstrackBuffer, alongTrackBuffer) {
    const n = localPoints.length;
    const candidates = new Map();
    const addCandidate = (angle) => {
      const a = ((angle % 180) + 180) % 180;
      const key = a.toFixed(6);
      if (candidates.has(key)) return;
      candidates.set(key, { angle: a, rotated: rotatePolygon(localPoints, -toRad(a)) });
    };
    for (let i = 0; i < n; i++) {
      const a = localPoints[i];
      const b = localPoints[(i + 1) % n];
      const bearing = toDeg(Math.atan2(b.x - a.x, b.y - a.y));
      addCandidate(90 - bearing); // 航线与该边平行（跨度沿边法线度量）
      addCandidate(-bearing);     // 航线与该边垂直（跨度沿边方向度量）
    }

    let best = null;
    for (const cand of candidates.values()) {
      const { rows, lineCount } = layoutRows(cand.rotated, lineSpacing, crosstrackBuffer, alongTrackBuffer);
      const cost = rows.length ? estimateRouteLength(rows) : Infinity;
      if (!best ||
          lineCount < best.lineCount ||
          (lineCount === best.lineCount && cost < best.cost - 1e-6)) {
        best = { angle: cand.angle, rotated: cand.rotated, lineCount, cost };
      }
    }
    return best;
  }

  // ---- 测区内点判定（用于转弯点纠偏） ----

  /**
   * 测区内点判定
   *
   * 点集同时接受 {x, y} 对象与 [x, y] 数组两种形态：内部统一用对象，
   * 但校验脚本 / 调用方常写成数组字面量，形状不一致会让比较退化成
   * undefined 与 undefined 相比而恒返回 false（静默给出错误结论）。
   */
  function pointInPolygon(x, y, points) {
    const px = (i) => (Array.isArray(points[i]) ? points[i][0] : points[i].x);
    const py = (i) => (Array.isArray(points[i]) ? points[i][1] : points[i].y);
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = px(i), yi = py(i);
      const xj = px(j), yj = py(j);
      if ((yi > y) !== (yj > y) &&
          x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function distanceToBoundary(x, y, points) {
    const px = (i) => (Array.isArray(points[i]) ? points[i][0] : points[i].x);
    const py = (i) => (Array.isArray(points[i]) ? points[i][1] : points[i].y);
    let best = Infinity;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const x1 = px(j), y1 = py(j);
      const x2 = px(i), y2 = py(i);
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
    }
    return best;
  }

  /**
   * 凹多边形里，两排之间的中点可能落在测区外（例如 L 形的凹口）。
   *
   * 回退目标必须是「下一排线段的中点」——它按构造必在测区内。
   * 早期版本朝局部坐标原点回退，而原点完全可能落在凹口外侧，
   * 于是从采样里找不到任何内点，最后把区外坐标原样返回。
   */
  function pullInside(x, y, points, targetX, targetY) {
    if (pointInPolygon(x, y, points)) return [x, y];
    for (let k = 1; k <= 16; k++) {
      const t = k / 16;
      const cx = x + (targetX - x) * t;
      const cy = y + (targetY - y) * t;
      if (pointInPolygon(cx, cy, points)) return [cx, cy];
    }
    return [targetX, targetY];
  }

  // ---- 覆盖率自检 ----

  /**
   * 以像幅地面对角线为网格步长，光栅化测区并统计未被任何像幅覆盖的采样点。
   *
   * 用途：当前算法把测区边界压在首末航线之下，对称化留白后必须有一个
   * 运行时闸门来证明「没有把留白做大到产生空洞」。属粗精度自检，
   * 精确复核由 tools/verify-route-algorithm.js 的 1~2m 网格承担。
   */
  function checkCoverage(rotatedPoly, photoLocal, footprintW, footprintH) {
    const step = Math.max(1, Math.min(footprintW, footprintH) / 4);
    const halfW = footprintW / 2;
    const halfH = footprintH / 2;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of rotatedPoly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const cols = Math.max(1, Math.ceil((maxX - minX) / step));
    const rows = Math.max(1, Math.ceil((maxY - minY) / step));
    const cells = cols * rows;

    // 大测区降采样，保证自检本身不成为性能瓶颈
    let cellSize = step;
    const MAX_CELLS = 40000;
    if (cells > MAX_CELLS) {
      cellSize = step * Math.sqrt(cells / MAX_CELLS);
    }

    const c = Math.ceil((maxX - minX) / cellSize);
    const r = Math.ceil((maxY - minY) / cellSize);
    const inside = new Uint8Array(c * r);
    const covered = new Uint8Array(c * r);
    const at = (i, j) => i * r + j;

    let insideCount = 0;
    for (let i = 0; i < c; i++) {
      const x = minX + (i + 0.5) * cellSize;
      for (let j = 0; j < r; j++) {
        const y = minY + (j + 0.5) * cellSize;
        if (pointInPolygon(x, y, rotatedPoly)) {
          inside[at(i, j)] = 1;
          insideCount++;
        }
      }
    }

    if (insideCount === 0) return null;

    for (const p of photoLocal) {
      const u = cellSize * Math.ceil(halfW / cellSize);
      const v = cellSize * Math.ceil(halfH / cellSize);
      const i0 = Math.max(0, Math.floor((p.x - u - minX) / cellSize));
      const i1 = Math.min(c - 1, Math.ceil((p.x + u - minX) / cellSize));
      const j0 = Math.max(0, Math.floor((p.y - v - minY) / cellSize));
      const j1 = Math.min(r - 1, Math.ceil((p.y + v - minY) / cellSize));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) covered[at(i, j)] = 1;
      }
    }

    let uncovered = 0;
    let maxGap = 0;
    for (let i = 0; i < c; i++) {
      for (let j = 0; j < r; j++) {
        if (!inside[at(i, j)] || covered[at(i, j)]) continue;
        uncovered++;
        const d = distanceToBoundary(minX + (i + 0.5) * cellSize, minY + (j + 0.5) * cellSize, rotatedPoly);
        if (d > maxGap) maxGap = d;
      }
    }

    const tolerance = cellSize * COVERAGE_TOLERANCE_FACTOR;
    return {
      gridCell: Math.round(cellSize * 100) / 100,
      samples: insideCount,
      uncovered: uncovered,
      holeRatio: uncovered / insideCount,
      maxGap: Math.round(maxGap * 100) / 100,
      tolerance: Math.round(tolerance * 100) / 100,
      ok: maxGap <= tolerance
    };
  }

  // ---- 重叠率自检 ----

  /**
   * 按相机像幅参数复核实际拍照重叠率是否达到要求值。
   *
   * 航向：同一拍照跑内相邻拍照点（同排、间距 ≈ pointSpacing），
   *       实际重叠率 = 1 − 实际间距 / 像幅地面高度；
   * 旁向：相邻排（rows 内实际有拍照点的排，y 单调递增），
   *       实际重叠率 = 1 − 排间距 / 像幅地面宽度。
   *
   * 为什么必须复核：间距/排距由 GSD→像幅→(1−重叠率) 推导而来，
   * 相机参数、GSD 公式或排布环节的任何改动都可能让「实际重叠率」
   * 偏离「要求重叠率」——间距回归校验（不变量 2）只能证明间距恒定，
   * 不能证明间距与像幅的配比仍然成立。分排跳转（> 1.5 倍间距）与
   * 换排转弯（隔转弯点）不参与航向统计；遗漏（覆盖空洞）由
   * checkCoverage 负责，两者合起来构成完整的质量自检。
   */
  function checkOverlap(photoLocal, rows, imageWidthM, imageHeightM,
                        pointSpacing, forwardOverlap, sideOverlap, missionType) {
    const TOL = 1e-4; // 构造上应严格相等，浮点余量
    const isVideo = missionType === 'video';

    const fwdPairs = [];
    if (!isVideo) {
      for (let i = 1; i < photoLocal.length; i++) {
        const a = photoLocal[i - 1];
        const b = photoLocal[i];
        if (Math.abs(a.y - b.y) > 1e-6) continue;          // 不同排（隔转弯点）
        const d = Math.abs(b.x - a.x);
        if (d > pointSpacing * 1.5) continue;              // 分段跳转（过渡段）
        fwdPairs.push(1 - d / imageHeightM);
      }
    }

    const sidePairs = [];
    for (let k = 1; k < rows.length; k++) {
      sidePairs.push(1 - (rows[k].y - rows[k - 1].y) / imageWidthM);
    }

    const pack = (pairs, required, applicable) => ({
      pairs: pairs.length,
      min: pairs.length ? Math.round(Math.min(...pairs) * 1000) / 1000 : null,
      avg: pairs.length
        ? Math.round(pairs.reduce((s, v) => s + v, 0) / pairs.length * 1000) / 1000
        : null,
      required,
      // 不适用的情况（摄像为连续录制，不存在航向「拍照间距」）恒判达标，
      // 并在 applicable 上显式标注，避免界面把它读成「已校验通过」
      applicable: applicable !== false,
      ok: pairs.length === 0 || Math.min(...pairs) >= required - TOL
    });

    const forward = pack(fwdPairs, forwardOverlap, !isVideo);
    const side = pack(sidePairs, sideOverlap, true);
    return { forward, side, ok: forward.ok && side.ok };
  }

  // ---- 主算法 ----

  /**
   * 生成航线
   * @param polygonWgs - 测区多边形 [[lng, lat], ...] (WGS-84)
   * @param params - 飞行参数
   * @returns { waypoints: Waypoint[], stats: object }
   */
  function generateRoute(polygonWgs, params) {
    // Step 0: 参数守卫（必须在任何循环之前）
    const {
      altitude,
      forwardOverlap,  // 0-1
      sideOverlap,     // 0-1
      sensorWidth,     // px
      sensorHeight,    // px
      focalLength,     // mm
      pixelSize,       // μm
      speed,
      courseAngle,     // 度，航线方向角；null 表示自动
      gimbalPitch,     // 度，云台俯仰角
      edgeBuffer,      // 边界外扩系数 0~1：相对航向两条基线 / 旁向半个像幅
      photoHoverSeconds, // 拍照点悬停时间（秒），默认 0.5
      missionType      // 'photo' = 拍照航测 / 'video' = 摄像
    } = validatePlanInput(polygonWgs, params);

    // Step 1: 计算 GSD 和间距
    // GSD (cm/px) = (pixelSize_μm × altitude_m) / (focalLength_mm × 10)
    const GSD = (pixelSize * altitude) / (focalLength * 10); // cm/px
    const imageWidthM = (sensorWidth * GSD) / 100;  // 像幅地面宽度 (m)
    const imageHeightM = (sensorHeight * GSD) / 100; // 像幅地面高度 (m)
    const pointSpacing = imageHeightM * (1 - forwardOverlap); // 航点间距 (m)
    const lineSpacing = imageWidthM * (1 - sideOverlap);      // 航线间距 (m)

    // 派生量守卫：这两个值直接作为循环步长，必须严格为正
    if (!(lineSpacing >= 0.5)) {
      throw new Error(`航线间距过小（${lineSpacing.toFixed(3)} m），请降低旁向重叠率或降低飞行高度。`);
    }
    if (!(pointSpacing >= 0.2)) {
      throw new Error(`航点间距过小（${pointSpacing.toFixed(3)} m），请降低航向重叠率或降低飞行高度。`);
    }

    // Step 2: 转换到局部平面坐标
    const { center, points: localPoints } = toLocalCoords(polygonWgs);

    // Step 3: 确定航线方向并完成该方向下的排布
    // 手动指定角度时直接用；自动时按「趟数最少 → 估算里程最小」择优（见 chooseLayout）
    // 旋转 -angleDeg 使航线与局部 x 轴平行
    //
    // 边界外扩（可选，默认 0）：
    //   0 = 不外扩（历史行为）
    //   1 = 航向两端各外扩两条基线(pointSpacing)，旁向两侧各外扩半个像幅宽
    // 实际外扩量 = edgeBuffer × 上述上限，故 0.5 = 航向一条基线 / 旁向四分之一像幅。
    //
    // 为什么默认 0：外扩会把拍照排排到测区之外，与「航点严格在测区内」冲突。
    // 行业文件（非标准正文）对边界覆盖的表述为「航向覆盖超出摄区边界线
    // 不少于两条基线」；本实现未取得标准完整原文，因此不设为默认值，
    // 由使用者按项目要求显式开启。
    const crosstrackBuffer = edgeBuffer * (imageWidthM / 2);
    const alongTrackBuffer = edgeBuffer * 2 * pointSpacing;

    let angleDeg, rotated, rotAngle;
    if (courseAngle != null) {
      angleDeg = courseAngle;
      rotAngle = -toRad(angleDeg);
      rotated = rotatePolygon(localPoints, rotAngle);
    } else {
      const layout = chooseLayout(localPoints, lineSpacing, crosstrackBuffer, alongTrackBuffer);
      angleDeg = layout.angle;
      rotAngle = -toRad(angleDeg);
      rotated = layout.rotated;
    }

    // Step 4: 排布平行航线（首末留白对称分配，见 layoutRows）
    const { rows, lineCount, margin } = layoutRows(rotated, lineSpacing, crosstrackBuffer, alongTrackBuffer);

    // 两端留白必须小于像幅半宽，否则相邻排之间的覆盖会断开
    if (margin >= imageWidthM / 2) {
      throw new Error(`无法覆盖测区：两端留白 ${margin.toFixed(1)} m 达到像幅半宽 ${(imageWidthM / 2).toFixed(1)} m，` +
        `请降低${edgeBuffer > 0 ? '边界外扩或' : ''}旁向重叠率。`);
    }
    if (lineCount > MAX_SCAN_LINES) {
      throw new Error(`航线数 ${lineCount} 超过上限 ${MAX_SCAN_LINES}，请降低${edgeBuffer > 0 ? '外扩或' : ''}旁向重叠率或降低飞行高度。`);
    }
    if (rows.length === 0) {
      throw new Error('无法生成航线：测区太小或航线间距过大，请调整参数。');
    }

    // Step 6: 逐排方向优化 → 生成航点（蛇形/之字形），并只在换排处插入转弯点
    const waypoints = [];
    const photoLocal = [];
    const cosR = Math.cos(-rotAngle);
    const sinR = Math.sin(-rotAngle);
    let seqId = 0;
    let photoSeq = 0;

    const pushPoint = (lx, ly, type, action, rowIndex) => {
      // 局部坐标 → WGS-84
      const ux = lx * cosR - ly * sinR;
      const uy = lx * sinR + ly * cosR;
      const [wlng, wlat] = fromLocalCoords(center, ux, uy);
      const wp = {
        id: seqId++,
        lat: wlat,
        lng: wlng,
        alt: altitude,
        type,
        action,
        gimbalPitch: type === 'photo' ? gimbalPitch : 0,
        speed,
        // 拍照点序号（1 起，仅拍照点有值，转弯点 / 摄像航点为 null）：
        // 供地图编号渲染 / 导出使用；id 是全序列序号，两者口径不同
        photoIndex: type === 'photo' ? ++photoSeq : null,
        // 到点悬停时间（秒，仅拍照点）：导出为 WPML hover 动作，先悬停后拍摄
        hoverTime: type === 'photo' ? photoHoverSeconds : null,
        // 所属排号（摄像模式用于区分「同排覆盖段」与「跨排转向段」）
        rowIndex: rowIndex == null ? null : rowIndex
      };
      waypoints.push(wp);
      if (type === 'photo') photoLocal.push({ x: lx, y: ly });
      return wp;
    };

    const { dirs } = planRowDirections(rows);

    // 摄像模式：与拍照航测共用同一套蛇形排布（排数、方向、逐排 DP 全同），
    // 但不放置拍照点、不悬停 —— 只在每排的「进入点」与「离开点」各设一个航点
    // （排端即转向处，上一排离开点 → 下一排进入点构成蛇形转折），
    // 全程连续录像（首点 startRecord、末点 stopRecord）。
    // 云台俯仰 / 高度 / 速度沿用拍照任务的参数。
    if (missionType === 'video') {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rev = dirs[i];
        const ordered = rev ? row.segs.slice().reverse() : row.segs;
        for (const [a, b] of ordered) {
          pushPoint(rev ? b : a, row.y, 'video', null, i); // 进入点
          pushPoint(rev ? a : b, row.y, 'video', null, i); // 离开点（转向处）
        }
      }
      if (waypoints.length > 0) {
        waypoints[0].action = 'startRecord';
        waypoints[waypoints.length - 1].action = 'stopRecord';
      }
    } else {
      const rowPhotoXs = rows.map((row, i) => photoXsInRow(row, dirs[i], pointSpacing));

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const xs = rowPhotoXs[i];

        if (i > 0) {
          // 换排转弯点：取「上一排最后一个拍照点 → 本排第一个拍照点」连线的中点。
          //
          // 旧实现取「上排区间末端 × 两排中线」再纠偏，且方向标志用错排，
          // 每次换排都会先横穿整个测区再折回，转弯里程约为最优的 10~20 倍。
          // 取连线中点后，转弯路径 = 两拍照点的直线距离（拉回点始终位于
          // 该连线上，路径长度不变）；中点天然位于两排之间，与设计的
          // 「转弯点在两排中点」语义一致。
          // 凹测区里中点可能落在区外：沿连线向进入点方向采样拉回区内；
          // 若拉回点退化到与进入点重合（< 0.1m），省略该转弯点，直接过渡。
          const prevXs = rowPhotoXs[i - 1];
          const lastX = prevXs[prevXs.length - 1];
          const firstX = xs[0];
          const midX = (lastX + firstX) / 2;
          const midY = (rows[i - 1].y + row.y) / 2;
          const [tx, ty] = pullInside(midX, midY, rotated, firstX, row.y);
          if (Math.hypot(tx - firstX, ty - row.y) > 0.1) {
            pushPoint(tx, ty, 'turn', null);
          }
        }

        for (const x of xs) pushPoint(x, row.y, 'photo', 'takePhoto');
      }
    }

    // Step 7: 覆盖率自检（遗漏检查）+ 重叠率自检（航向/旁向达标检查）
    // 摄像模式没有离散拍照点：沿每条排的覆盖是连续的，按像幅步长在排上
    // 密集采样后复用同一套覆盖自检（连续录制 ⇒ 航向不存在间距概念）。
    const coveragePoints = missionType === 'video'
      ? sampleRowPoints(rows, imageWidthM, imageHeightM)
      : photoLocal;
    const coverage = checkCoverage(rotated, coveragePoints, imageWidthM, imageHeightM);
    const overlap = checkOverlap(photoLocal, rows, imageWidthM, imageHeightM,
      pointSpacing, forwardOverlap, sideOverlap, missionType);

    // Step 8: 统计（口径见 calcStats：按段起点分类，含转弯点；预估时间含拍照停留）
    const stats = calcStats(waypoints, lineSpacing, pointSpacing, imageWidthM, imageHeightM,
      GSD, polygonWgs, coverage, overlap, photoHoverSeconds, missionType);
    // 实际排数（= 航线趟数）：界面「航线趟数」直接用它，
    // 不能由航点数反推（摄像模式的航点结构与拍照不同）
    stats.rowCount = rows.length;

    return {
      waypoints,
      stats,
      // courseAngle 回填实际采用的角度：自动模式下这是 chooseLayout 的选择结果，
      // 调用方（界面 / 测试 / 导出）需要知道"到底朝哪个方向飞"
      params: {
        ...params, courseAngle: angleDeg, autoCourseAngle: courseAngle == null,
        GSD, lineSpacing, pointSpacing, photoHoverSeconds, missionType
      }
    };
  }

  /**
   * 摄像模式的覆盖采样：沿每排区间按像幅步长取点。
   * 摄像为连续录制，排上的覆盖是连续的，采样密度取像幅短边的 1/4，
   * 与 checkCoverage 的网格步长一致，不会把连续覆盖误判成空洞。
   */
  function sampleRowPoints(rows, imageWidthM, imageHeightM) {
    const step = Math.max(1, Math.min(imageWidthM, imageHeightM) / 4);
    const points = [];
    for (const row of rows) {
      for (const [a, b] of row.segs) {
        const len = b - a;
        const n = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k <= n; k++) {
          points.push({ x: a + (len * k) / n, y: row.y });
        }
      }
    }
    return points;
  }

  /**
   * 计算统计信息
   *
   * 分段口径：按「段起点」分类——起点是拍照点则计入拍照段，
   * 起点是转弯点（即从本排末端飞往下一排起点的过渡段）则计入转弯段。
   * 旧实现用「任一端为 photo 即算拍照段」，而转弯点两侧必然都是拍照点，
   * 导致转弯段距离恒为 0。
   *
   * 预估时间 = 航程 ÷ 平均速度 + 拍照点数 × 拍照停留时间。
   *
   * 摄像模式没有拍照点：分段按排号区分——同排航段是「摄像覆盖段」
   * （计入 photoDistance，与拍照口径对齐），跨排航段是转向过渡段
   * （计入 turnDistance），全程不停留。
   */
  function calcStats(waypoints, lineSpacing, pointSpacing, imageWidthM, imageHeightM,
                     GSD, polygonWgs, coverage, overlap, photoHoverSeconds, missionType) {
    let photoCount = 0;
    let photoDistance = 0;
    let turnDistance = 0;
    const isVideo = missionType === 'video';

    for (const wp of waypoints) {
      if (wp.type === 'photo') photoCount++;
    }

    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i];
      const b = waypoints[i + 1];
      const d = distance(a.lng, a.lat, b.lng, b.lat);
      if (isVideo) {
        if (a.rowIndex != null && a.rowIndex === b.rowIndex) photoDistance += d;
        else turnDistance += d;
      } else if (a.type === 'photo') {
        photoDistance += d;
      } else {
        turnDistance += d;
      }
    }

    const totalDistance = photoDistance + turnDistance;
    const avgSpeed = waypoints.reduce((s, w) => s + (w.speed || 8), 0) / waypoints.length;
    const hoverTotal = photoCount * (photoHoverSeconds || 0);

    // 测区面积（使用局部坐标的 Shoelace 公式）
    const { points: local } = toLocalCoords(polygonWgs);
    let area = 0;
    for (let i = 0; i < local.length; i++) {
      const j = (i + 1) % local.length;
      area += local[i].x * local[j].y;
      area -= local[j].x * local[i].y;
    }
    area = Math.abs(area) / 2;

    return {
      missionType: isVideo ? 'video' : 'photo',
      photoCount,
      // 摄像模式：航点即「起点 / 转向处 / 终点」，没有拍照点
      videoPointCount: isVideo ? waypoints.length : 0,
      totalPoints: waypoints.length,
      photoDistance: Math.round(photoDistance),
      turnDistance: Math.round(turnDistance),
      totalDistance: Math.round(totalDistance),
      estimatedTime: Math.round(totalDistance / avgSpeed + hoverTotal),
      hoverTotalTime: Math.round(hoverTotal),
      areaSize: Math.round(area),
      gsd: Math.round(GSD * 100) / 100,
      lineSpacing: Math.round(lineSpacing * 100) / 100,
      pointSpacing: Math.round(pointSpacing * 100) / 100,
      imageCoverW: Math.round(imageWidthM * 100) / 100,
      imageCoverH: Math.round(imageHeightM * 100) / 100,
      coverage,
      overlap
    };
  }

  // ---- 任务拆分 ----

  /**
   * 把一次规划的航点序列拆分为多个可独立执行的任务（多文件导出）。
   *
   * 动机：航点过多（数百个）时，浏览器渲染卡顿、部分机型（如
   * Phantom 4 RTK 上限 99）也无法单任务执行；拆成多个 KMZ 文件、
   * 依次导入执行即可。拍照点是覆盖与重叠率的载体，全部保留且
   * 保持原顺序——拆分不影响测绘成果，只影响起降次数。
   *
   * 拆分规则：
   * 1. 按转弯点切块：块 = 一排拍照点 + 其后的转弯点（排间过渡）。
   *    任务边界只落在块边界上，每个任务包含完整的拍照排；
   * 2. 贪心装箱：任务数最少（起降次数最少），单任务 ≤ maxPerMission；
   * 3. 边界转弯点丢弃：它只服务「本任务末排 → 下一任务首排」的
   *    连续飞行，拆分后两个任务各自独立起降，该过渡没有执行意义；
   * 4. 单排拍照点数超过上限时（≈单排长度 > 上限×航点间距），
   *    在拍照点边界硬切——所有照片仍按原顺序拍摄，覆盖不受影响。
   *
   * @param {Waypoint[]} waypoints 完整航点序列
   * @param {number} maxPerMission 单任务航点数上限（正整数）
   * @returns {{ missions: {waypoints: Waypoint[], photoCount: number}[], droppedTurns: number }}
   */
  function splitMission(waypoints, maxPerMission) {
    if (!Array.isArray(waypoints)) {
      throw new Error('航点列表无效，无法拆分。');
    }
    if (!Number.isInteger(maxPerMission) || maxPerMission < 1) {
      throw new Error(`拆分上限须为正整数（当前 ${maxPerMission}）。`);
    }
    if (waypoints.length === 0) return { missions: [], droppedTurns: 0 };

    // Step 1: 按转弯点切块
    const blocks = [];
    let cur = [];
    for (const w of waypoints) {
      cur.push(w);
      if (w.type === 'turn') { blocks.push(cur); cur = []; }
    }
    if (cur.length) blocks.push(cur);

    // Step 2: 超限块在拍照点边界硬切（转弯点跟最后一段）
    const units = [];
    for (let block of blocks) {
      if (block.length <= maxPerMission) { units.push(block); continue; }
      const hasTurn = block[block.length - 1].type === 'turn';
      const turn = hasTurn ? block.pop() : null;
      // 留出转弯点位置，保证「照片段 + 转弯点」整体不超过上限
      const cap = Math.max(1, hasTurn ? maxPerMission - 1 : maxPerMission);
      for (let i = 0; i < block.length; i += cap) {
        units.push(block.slice(i, i + cap));
      }
      if (turn) {
        const last = units[units.length - 1];
        if (last.length < maxPerMission) last.push(turn);
        else units.push([turn]);
      }
    }

    // Step 3: 贪心装箱；任务边界上的转弯点（块的收尾转弯点）丢弃
    const missions = [];
    let droppedTurns = 0;
    let chunk = [];
    const closeChunk = () => {
      if (chunk.length === 0) return;
      if (chunk[chunk.length - 1].type === 'turn') {
        chunk.pop();
        droppedTurns++;
      }
      if (chunk.length) {
        missions.push({
          waypoints: chunk,
          photoCount: chunk.reduce((s, w) => s + (w.type === 'photo' ? 1 : 0), 0)
        });
      }
      chunk = [];
    };
    for (const u of units) {
      if (chunk.length > 0 && chunk.length + u.length > maxPerMission) closeChunk();
      chunk.push(...u);
    }
    closeChunk();

    return { missions, droppedTurns };
  }

  return {
    generateRoute, distance, destination, toLocalCoords, fromLocalCoords,
    pointInPolygon, splitMission
  };
})();
