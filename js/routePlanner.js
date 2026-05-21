/**
 * 航线规划核心算法模块
 * 根据测区多边形和飞行参数生成蛇形（之字形）覆盖航线
 */

const RoutePlanner = (() => {
  const EARTH_RADIUS = 6371000; // 地球半径 (m)

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

  // ---- 主算法 ----

  /**
   * 生成航线
   * @param polygonWgs - 测区多边形 [[lng, lat], ...] (WGS-84)
   * @param params - 飞行参数
   * @returns { waypoints: Waypoint[], stats: object }
   */
  function generateRoute(polygonWgs, params) {
    const {
      altitude,
      forwardOverlap,  // 0-1
      sideOverlap,     // 0-1
      sensorWidth,     // px
      sensorHeight,    // px
      focalLength,     // mm
      pixelSize,       // μm
      speed,
      courseAngle,    // 度，航线方向角；null 表示自动
      gimbalPitch     // 度，云台俯仰角
    } = params;

    // Step 1: 计算 GSD 和间距
    // GSD (cm/px) = (pixelSize_μm × altitude_m) / (focalLength_mm × 10)
    const GSD = (pixelSize * altitude) / (focalLength * 10); // cm/px
    const imageWidthM = (sensorWidth * GSD) / 100;  // 像幅地面宽度 (m)
    const imageHeightM = (sensorHeight * GSD) / 100; // 像幅地面高度 (m)
    const pointSpacing = imageHeightM * (1 - forwardOverlap); // 航点间距 (m)
    const lineSpacing = imageWidthM * (1 - sideOverlap);      // 航线间距 (m)

    // Step 2: 转换到局部平面坐标
    const { center, points: localPoints } = toLocalCoords(polygonWgs);

    // Step 3: 确定航线方向角
    let angleDeg;
    if (courseAngle != null) {
      angleDeg = courseAngle;
    } else {
      // 自动：取多边形最长边方向
      angleDeg = calcBestAngle(localPoints);
    }
    // Step 4: 旋转多边形使航线与 x 轴平行
    // 航线方向角 = 0 表示正北（y轴局部坐标），>0 顺时针旋转
    // 旋转 -angleDeg 使航线对齐 x 轴
    const rotAngle = -toRad(angleDeg);
    const rotated = rotatePolygon(localPoints, rotAngle);

    // Step 5: 生成平行航线区间（航点严格在测区内）
    const { minY, maxY } = getYRange(rotated);
    const epsilon = 1e-3;

    const lineSegments = [];

    for (let y = minY + epsilon; y <= maxY; y += lineSpacing) {
      const segs = linePolygonIntersections(y, rotated);
      for (const [x1, x2] of segs) {
        lineSegments.push({ y, x1, x2 });
      }
    }

    if (lineSegments.length === 0) {
      throw new Error('无法生成航线：测区太小或航线间距过大，请调整参数。');
    }

    // Step 6: 沿每条线段生成航点（蛇形/之字形）
    const rawWaypoints = [];
    let seqId = 0;

    for (let i = 0; i < lineSegments.length; i++) {
      const seg = lineSegments[i];
      const pointsOnLine = [];

      if (i % 2 === 0) {
        // 偶数行：左→右
        for (let x = seg.x1; x <= seg.x2 + 0.001; x += pointSpacing) {
          pointsOnLine.push([x, seg.y]);
        }
      } else {
        // 奇数行：右→左
        for (let x = seg.x2; x >= seg.x1 - 0.001; x -= pointSpacing) {
          pointsOnLine.push([x, seg.y]);
        }
      }

      for (const [lx, ly] of pointsOnLine) {
        // 逆旋转回局部坐标
        const cos = Math.cos(-rotAngle);
        const sin = Math.sin(-rotAngle);
        const ux = lx * cos - ly * sin;
        const uy = lx * sin + ly * cos;

        // 局部坐标 → WGS-84
        const [wlng, wlat] = fromLocalCoords(center, ux, uy);

        rawWaypoints.push({
          id: seqId++,
          lat: wlat,
          lng: wlng,
          alt: altitude,
          type: 'photo',
          action: 'takePhoto',
          gimbalPitch: gimbalPitch,
          speed: speed
        });
      }

      // 添加行间转弯点（最后一行不加）
      if (i < lineSegments.length - 1) {
        const nextSeg = lineSegments[i + 1];

        // 转弯点在当前行末端 x 和两行中间 y 位置
        const turnX = i % 2 === 0 ? seg.x2 : seg.x1;
        const turnY = (seg.y + nextSeg.y) / 2;
        const cosR = Math.cos(-rotAngle), sinR = Math.sin(-rotAngle);
        const turnUx = turnX * cosR - turnY * sinR;
        const turnUy = turnX * sinR + turnY * cosR;
        const [tLng, tLat] = fromLocalCoords(center, turnUx, turnUy);

        rawWaypoints.push({
          id: seqId++,
          lat: tLat,
          lng: tLng,
          alt: altitude,
          type: 'turn',
          action: null,
          gimbalPitch: gimbalPitch,
          speed: speed
        });
      }
    }

    // Step 7: 添加终止航点（最后一行末尾，云台归零位置）
    if (lineSegments.length > 0 && rawWaypoints.length > 0) {
      const lastSeg = lineSegments[lineSegments.length - 1];
      const lastIdx = lineSegments.length - 1;
      const dir = lastIdx % 2 === 0 ? 1 : -1;        // 偶数行→右, 奇数行→左
      const lastX = lastIdx % 2 === 0 ? lastSeg.x2 : lastSeg.x1;

      const termX = lastX + dir * pointSpacing;
      const termY = lastSeg.y;
      const cosR = Math.cos(-rotAngle), sinR = Math.sin(-rotAngle);
      const tuX = termX * cosR - termY * sinR;
      const tuY = termX * sinR + termY * cosR;
      const [tLng, tLat] = fromLocalCoords(center, tuX, tuY);

      rawWaypoints.push({
        id: seqId++,
        lat: tLat,
        lng: tLng,
        alt: altitude,
        type: 'turn',
        action: null,
        gimbalPitch: gimbalPitch,
        speed: speed
      });
    }

    // Step 8: 直接使用生成的航点（无起降点）
    const waypoints = rawWaypoints;

    // Step 9: 计算统计
    const stats = calcStats(waypoints, pointSpacing, lineSpacing, imageWidthM, imageHeightM, GSD, polygonWgs);

    return { waypoints, stats, params: { ...params, GSD, lineSpacing, pointSpacing } };
  }

  /**
   * 计算多边形最佳航线角度（最长边方向）
   */
  function calcBestAngle(points) {
    let maxDist = 0;
    let bestAngle = 0;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxDist) {
        maxDist = d;
        // 边方向角：atan2(dx, dy) 从正北顺时针
        bestAngle = toDeg(Math.atan2(dx, dy));
      }
    }
    // 归一化到 [0, 180)
    return ((bestAngle % 180) + 180) % 180;
  }

  /**
   * 计算统计信息
   */
  function calcStats(waypoints, pointSpacing, lineSpacing, imageWidthM, imageHeightM, GSD, polygonWgs) {
    let photoCount = 0;
    let photoDistance = 0;
    let turnDistance = 0;

    for (const wp of waypoints) {
      if (wp.type === 'photo') photoCount++;
    }

    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i];
      const b = waypoints[i + 1];
      const d = distance(a.lng, a.lat, b.lng, b.lat);
      if (a.type === 'photo' || b.type === 'photo') {
        photoDistance += d;
      } else {
        turnDistance += d;
      }
    }

    const totalDistance = photoDistance + turnDistance;
    const avgSpeed = waypoints.reduce((s, w) => s + (w.speed || 8), 0) / waypoints.length;

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
      photoCount,
      totalPoints: waypoints.length,
      photoDistance: Math.round(photoDistance),
      turnDistance: Math.round(turnDistance),
      totalDistance: Math.round(totalDistance),
      estimatedTime: Math.round(totalDistance / avgSpeed),
      areaSize: Math.round(area),
      gsd: Math.round(GSD * 100) / 100,
      lineSpacing: Math.round(lineSpacing * 100) / 100,
      pointSpacing: Math.round(pointSpacing * 100) / 100,
      imageCoverW: Math.round(imageWidthM * 100) / 100,
      imageCoverH: Math.round(imageHeightM * 100) / 100
    };
  }

  return { generateRoute, distance, destination, toLocalCoords, fromLocalCoords };
})();
