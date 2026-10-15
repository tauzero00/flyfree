/**
 * 地图模块：高德地图初始化、图层管理、测区绘制交互
 */

const MapModule = (() => {
  let map = null;
  let polygonPath = [];         // 当前测区顶点 (GCJ-02)
  let waypointMarkers = [];     // 航点标记（polylines + markers）
  let polygonOverlay = null;    // 测区多边形
  let drawing = false;          // 是否正在绘制
  let tempMarkers = [];         // 临时顶点标记
  let currentLayer = 'standard';// 当前地图图层模式
  let defaultLayers = null;     // 初始化时的默认图层（用于切回标准地图）

  const COLORS = {
    photoLine: '#00D2A0',
    turnLine: '#FFD700',
    photoPoint: '#4A90D9',
    videoPoint: '#8E6BE8',
    polygon: '#FF6B35',
    polygonFill: 'rgba(255, 107, 53, 0.15)'
  };

  function init(containerId, key) {
    return new Promise((resolve, reject) => {
      window._amapReady = function () {
        map = new AMap.Map(containerId, {
          zoom: 15,
          center: [116.397428, 39.90923],
          rotateEnable: true,
          touchZoomEnable: true,
          dragEnable: true,
          zoomEnable: true
        });

        // 缓存默认图层，用于后续切换回标准地图
        defaultLayers = map.getLayers();

        // 添加工具条
        map.plugin(['AMap.ToolBar', 'AMap.Scale'], () => {
          map.addControl(new AMap.ToolBar({ position: 'RT' }));
          map.addControl(new AMap.Scale({ position: 'LB' }));
        });

        // 点击地图添加顶点（绘制模式）
        map.on('click', onMapClick);

        // 双击结束绘制
        map.on('dblclick', (e) => {
          if (drawing && polygonPath.length >= 3) {
            e.stopPropagation();
            stopDrawing();
          }
        });

        // 右键结束绘制
        map.on('rightclick', (e) => {
          if (drawing && polygonPath.length >= 3) {
            e.stopPropagation();
            stopDrawing();
          }
        });

        // 鼠标移动显示坐标
        map.on('mousemove', (e) => {
          const info = document.getElementById('coordInfo');
          if (info) {
            info.textContent =
              `坐标: ${e.lnglat.lng.toFixed(6)}, ${e.lnglat.lat.toFixed(6)} | 缩放: ${map.getZoom()}`;
          }
        });

        // 键盘回车结束绘制
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && drawing && polygonPath.length >= 3) {
            stopDrawing();
          }
        });

        resolve(map);
      };

      // 动态加载高德脚本
      if (!key) {
        reject(new Error('未配置高德地图 Key，请在 js/config.js 中设置 window.AMAP_KEY'));
        return;
      }
      const script = document.createElement('script');
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&callback=_amapReady`;
      script.onerror = () => reject(new Error('高德地图加载失败'));
      document.head.appendChild(script);
    });
  }

  function getMap() { return map; }

  function setCenter(lng, lat) {
    if (map) map.setCenter([lng, lat]);
  }

  function switchLayer() {
    if (!map) return currentLayer;
    if (currentLayer === 'standard') {
      map.setLayers([
        new AMap.TileLayer.Satellite(),
        new AMap.TileLayer.RoadNet()
      ]);
      currentLayer = 'satellite';
    } else {
      // 恢复默认图层（用缓存的引用，避免重新构造无参 TileLayer 导致 getBounds 报错）
      if (defaultLayers && defaultLayers.length > 0) {
        map.setLayers(defaultLayers);
      }
      currentLayer = 'standard';
    }
    return currentLayer;
  }

  function getLayerType() {
    return currentLayer;
  }

  // ---- 测区绘制 ----

  function startDrawing() {
    drawing = true;
    clearDrawing();
    polygonPath = [];
    map.setStatus({ doubleClickZoom: false });
    updateDrawingUI('绘制中，点击地图添加顶点，双击/右键/回车完成…');
  }

  function stopDrawing() {
    drawing = false;
    map.setStatus({ doubleClickZoom: true });
    if (polygonPath.length < 3) {
      clearDrawing();
      updateDrawingUI('');
      return null;
    }
    drawPolygon(polygonPath);
    updateDrawingUI(`测区已锁定（${polygonPath.length} 个顶点），可拖拽顶点编辑`);
    if (window._onPolygonUpdated) window._onPolygonUpdated([...polygonPath]);
    return [...polygonPath];
  }

  function isDrawing() {
    return drawing;
  }

  function onMapClick(e) {
    if (!drawing) return;
    const lng = e.lnglat.lng;
    const lat = e.lnglat.lat;
    polygonPath.push([lng, lat]);

    // 添加临时顶点标记（不可拖动）
    const icon = makeVertexIcon(COLORS.polygon);
    const marker = new AMap.Marker({
      position: [lng, lat],
      icon: icon,
      offset: [-10, -10],
      cursor: 'pointer',
      zIndex: 70
    });
    map.add(marker);
    marker.setMap(map);
    tempMarkers.push(marker);

    if (polygonPath.length >= 2) {
      drawTempPolygon();
    }
  }

  // 顶点图标（SVG data URL — Amap 2.0 使用 icon 才能正常拖动）
  function makeVertexIcon(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
      <circle cx="10" cy="10" r="7" fill="${color}" stroke="#fff" stroke-width="2.5"/>
      <circle cx="10" cy="10" r="2.5" fill="rgba(255,255,255,0.8)"/>
    </svg>`;
    return new AMap.Icon({
      size: [20, 20],
      image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
      imageSize: [20, 20]
    });
  }

  function drawTempPolygon() {
    if (polygonOverlay) {
      map.remove(polygonOverlay);
    }
    polygonOverlay = new AMap.Polygon({
      path: polygonPath,
      strokeColor: COLORS.polygon,
      strokeWeight: 2,
      strokeStyle: 'dashed',
      fillColor: COLORS.polygonFill,
      fillOpacity: 0.15,
      zIndex: 40
    });
    map.add(polygonOverlay);
  }

  function drawPolygon(path) {
    if (polygonOverlay) map.remove(polygonOverlay);
    polygonOverlay = new AMap.Polygon({
      path: path,
      strokeColor: COLORS.polygon,
      strokeWeight: 2,
      fillColor: COLORS.polygonFill,
      fillOpacity: 0.15,
      zIndex: 40
    });
    map.add(polygonOverlay);

    // 添加可拖拽的顶点标记
    clearTempMarkers();
    const vIcon = makeVertexIcon(COLORS.polygon);
    for (const [lng, lat] of path) {
      const marker = new AMap.Marker({
        position: [lng, lat],
        icon: vIcon,
        offset: [-10, -10],
        draggable: true,
        cursor: 'grab',
        zIndex: 80
      });
      marker.on('dragstart', () => { marker.setCursor('grabbing'); });
      marker.on('dragging', onVertexDragging);
      marker.on('dragend', onVertexDragEnd);
      map.add(marker);
      marker.setMap(map);
      tempMarkers.push(marker);
    }
  }

  function onVertexDragging(e) {
    // 拖拽中实时更新多边形形状
    const draggedIdx = tempMarkers.indexOf(e.target);
    if (draggedIdx >= 0) {
      polygonPath[draggedIdx] = [e.lnglat.lng, e.lnglat.lat];
      if (polygonOverlay) {
        polygonOverlay.setPath(polygonPath);
      }
    }
  }

  function onVertexDragEnd(e) {
    // 拖拽结束，重新读取所有顶点位置
    polygonPath = tempMarkers.map(m => {
      const pos = m.getPosition();
      return [pos.lng, pos.lat];
    });
    e.target.setCursor('grab');
    drawPolygon(polygonPath);
    if (window._onPolygonUpdated) window._onPolygonUpdated([...polygonPath]);
  }

  function clearDrawing() {
    if (!map) return;
    clearTempMarkers();
    if (polygonOverlay) {
      map.remove(polygonOverlay);
      polygonOverlay = null;
    }
    polygonPath = [];
  }

  function clearTempMarkers() {
    for (const m of tempMarkers) {
      map.remove(m);
      m.setMap(null);
    }
    tempMarkers = [];
  }

  function getPolygonPath() {
    return polygonPath;
  }

  function updateDrawingUI(msg) {
    const el = document.getElementById('drawingStatus');
    if (el) el.textContent = msg;
  }

  // ---- 航线渲染 ----

  function renderRoute(waypoints, stats) {
    clearRoute();

    // 将航点转为 GCJ-02
    const gcjWaypoints = waypoints.map(w => {
      const [lng, lat] = CoordTransform.wgs84ToGcj02(w.lng, w.lat);
      return { ...w, lng, lat };
    });

    // 绘制航线 — 每段连续「作业航段」为一条实线折线
    // 拍照任务：连续拍照点；摄像任务：同一排的进入点→离开点（录像航段）。
    // 其余段（换排转向 / 排内跳转）画虚线。
    const isWorkLeg = (a, b) => {
      if (a.type === 'photo' && b.type === 'photo') return true;
      if (a.type === 'video' && b.type === 'video') {
        // 摄像航点在排内成对出现（进入 → 离开），跨排即为转向段
        return a.rowIndex != null && a.rowIndex === b.rowIndex;
      }
      return false;
    };

    let segStart = -1;
    for (let i = 0; i < gcjWaypoints.length - 1; i++) {
      const a = gcjWaypoints[i];
      const b = gcjWaypoints[i + 1];

      if (isWorkLeg(a, b)) {
        if (segStart === -1) segStart = i;
      } else {
        if (segStart !== -1) {
          const seg = gcjWaypoints.slice(segStart, i + 1).map(w => [w.lng, w.lat]);
          if (seg.length >= 2) {
            const polyline = new AMap.Polyline({
              path: seg,
              strokeColor: COLORS.photoLine,
              strokeWeight: 3,
              strokeStyle: 'solid',
              zIndex: 101
            });
            map.add(polyline);
            waypointMarkers.push(polyline);
          }
          segStart = -1;
        }
        // 绘制转弯段（虚线）
        const seg = [[a.lng, a.lat], [b.lng, b.lat]];
        const polyline = new AMap.Polyline({
          path: seg,
          strokeColor: COLORS.turnLine,
          strokeWeight: 2,
          strokeStyle: 'dashed',
          zIndex: 100
        });
        map.add(polyline);
        waypointMarkers.push(polyline);
      }
    }
    // 收尾最后一段拍照航线
    if (segStart !== -1) {
      const seg = gcjWaypoints.slice(segStart).map(w => [w.lng, w.lat]);
      if (seg.length >= 2) {
        const polyline = new AMap.Polyline({
          path: seg,
          strokeColor: COLORS.photoLine,
          strokeWeight: 3,
          strokeStyle: 'solid',
          zIndex: 101
        });
        map.add(polyline);
        waypointMarkers.push(polyline);
      }
    }

    // 绘制航点标记（起点标记 + 拍照点 / 摄像航点编号）
    const photos = gcjWaypoints.filter(w => w.type === 'photo');
    const photoCount = photos.length;
    const videos = gcjWaypoints.filter(w => w.type === 'video');
    const videoCount = videos.length;
    const isVideoMission = videoCount > 0 && photoCount === 0;

    // 编号：拍照点用 photoIndex、摄像航点用 videoIndex（生成器写入；
    // 缺失时——如 KMZ 导入的航线——按出现顺序补齐）
    let seq = 0;
    let vseq = 0;
    for (const w of gcjWaypoints) {
      if (w.type === 'photo') {
        seq++;
        if (!Number.isFinite(w.photoIndex)) w.photoIndex = seq;
      } else if (w.type === 'video') {
        vseq++;
        if (!Number.isFinite(w.videoIndex)) w.videoIndex = vseq;
      }
    }

    // 起始点：绿色徽标 + 「起点」标签，编号为其在拍照序列中的序号
    const startWp = gcjWaypoints[0];
    if (startWp) {
      const isPhoto = startWp.type === 'photo';
      const startBadge = `<div style="position:relative;">
        <div style="position:absolute;left:50%;top:-21px;transform:translateX(-50%);
          background:#00B578;color:#fff;font:700 10px/14px sans-serif;
          padding:0 6px;border-radius:7px;white-space:nowrap;
          box-shadow:0 1px 3px rgba(0,0,0,.45);">起点</div>
        <div style="width:22px;height:22px;border-radius:50%;background:#00B578;
          border:2px solid #fff;color:#fff;font:700 11px/18px sans-serif;
          text-align:center;box-shadow:0 0 6px rgba(0,181,120,.9);">${isPhoto ? startWp.photoIndex : '起'}</div>
      </div>`;
      const startMarker = new AMap.Marker({
        position: [startWp.lng, startWp.lat],
        anchor: 'center',
        content: startBadge,
        offset: [0, 0],
        zIndex: 130
      });
      startMarker.setTitle(isPhoto
        ? `起点 · 拍照点 ${startWp.photoIndex}/${photoCount}（航点 #${startWp.id}） 高度:${startWp.alt}m`
        : (startWp.type === 'video'
          ? `起点 · 开始录像（航点 #${startWp.id}） 高度:${startWp.alt}m`
          : `起点（航点 #${startWp.id}） 高度:${startWp.alt}m`));
      map.add(startMarker);
      startMarker.setMap(map);
      waypointMarkers.push(startMarker);
    }

    // 其余航点
    // 如果拍照点太多，使用海量点（数百个编号徽标在地图上不可读，起点仍单独渲染）
    if (photoCount > 200) {
      const massData = gcjWaypoints
        .filter((w, i) => i > 0 && w.type === 'photo')
        .map(w => ({
          lnglat: [w.lng, w.lat],
          style: 0
        }));

      const mass = new AMap.MassMarks(massData, {
        opacity: 0.8,
        zIndex: 110,
        style: [{
          anchor: 'center',
          size: [6, 6],
          url: 'data:image/svg+xml,' + encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6">
              <circle cx="3" cy="3" r="3" fill="${COLORS.photoPoint}"/></svg>`
          )
        }]
      });
      mass.setMap(map);
      waypointMarkers.push(mass);
    } else {
      // 使用独立标记：拍照点 / 摄像航点为编号徽标，转弯点为小黄点
      for (let i = 1; i < gcjWaypoints.length; i++) {
        const wp = gcjWaypoints[i];
        let content = '';
        let title = '';

        if (wp.type === 'photo') {
          content = `<div style="
            min-width:15px;height:15px;padding:0 3px;box-sizing:border-box;
            border-radius:8px;background:${COLORS.photoPoint};
            border:1.5px solid #fff;color:#fff;
            font:700 9px/12px sans-serif;text-align:center;
            white-space:nowrap;box-shadow:0 0 3px rgba(74,144,217,.8);">${wp.photoIndex}</div>`;
          title = `拍照点 ${wp.photoIndex}/${photoCount}（航点 #${wp.id}） 高度:${wp.alt}m`;
        } else if (wp.type === 'video') {
          const isLast = (i === gcjWaypoints.length - 1);
          content = `<div style="
            min-width:15px;height:15px;padding:0 3px;box-sizing:border-box;
            border-radius:8px;background:${COLORS.videoPoint};
            border:1.5px solid #fff;color:#fff;
            font:700 9px/12px sans-serif;text-align:center;
            white-space:nowrap;box-shadow:0 0 3px rgba(142,107,232,.85);">${wp.videoIndex}</div>`;
          title = isLast
            ? `终点 · 停止录像（摄像航点 ${wp.videoIndex}/${videoCount}，航点 #${wp.id}） 高度:${wp.alt}m`
            : `摄像航点 ${wp.videoIndex}/${videoCount} · 转向处（航点 #${wp.id}） 高度:${wp.alt}m`;
        } else {
          content = `<div style="
            width:6px;height:6px;background:${COLORS.turnLine};
            border-radius:50%;border:1px solid #fff;
            box-shadow:0 0 3px rgba(255,215,0,0.6);"></div>`;
          title = `转弯点（航点 #${wp.id}） 高度:${wp.alt}m`;
        }

        const marker = new AMap.Marker({
          position: [wp.lng, wp.lat],
          anchor: 'center',
          content: content,
          offset: [0, 0],
          zIndex: (wp.type === 'photo' || wp.type === 'video') ? 110 : 105
        });

        // 悬停提示
        marker.setTitle(title);

        map.add(marker);
        marker.setMap(map);
        waypointMarkers.push(marker);
      }
    }

    // 调整地图视野
    if (gcjWaypoints.length > 0) {
      const lngs = gcjWaypoints.map(w => w.lng);
      const lats = gcjWaypoints.map(w => w.lat);
      try {
        const sw = new AMap.LngLat(Math.min(...lngs), Math.min(...lats));
        const ne = new AMap.LngLat(Math.max(...lngs), Math.max(...lats));
        map.setBounds(new AMap.Bounds(sw, ne), false, [60, 60, 350, 60]);
      } catch (e) {
        // 降级：直接设置中心和缩放级别
        map.setCenter([lngs.reduce((a, b) => a + b) / lngs.length, lats.reduce((a, b) => a + b) / lats.length]);
      }
    }
  }

  function clearRoute() {
    if (!map) { waypointMarkers = []; return; }
    for (const item of waypointMarkers) {
      if (item.setMap) {
        item.setMap(null);
      }
      map.remove(item);
    }
    waypointMarkers = [];
  }

  // ---- 飞行模拟 ----

  function addDroneMarker(lng, lat) {
    const el = document.createElement('div');
    el.id = 'droneIcon';
    const gcj = CoordTransform.wgs84ToGcj02(lng, lat);
    el.innerHTML = `<div style="
      width:32px;height:32px;position:relative;
      transform: translate(-50%, -50%);">
      <svg viewBox="0 0 32 32" width="32" height="32">
        <circle cx="16" cy="16" r="14" fill="none" stroke="#00D2A0" stroke-width="1.5" opacity="0.6"/>
        <circle cx="16" cy="16" r="4" fill="#00D2A0" opacity="0.8"/>
        <line x1="16" y1="2" x2="16" y2="8" stroke="#fff" stroke-width="1.5"/>
        <line x1="4" y1="16" x2="8" y2="16" stroke="#fff" stroke-width="1.5"/>
        <line x1="28" y1="16" x2="24" y2="16" stroke="#fff" stroke-width="1.5"/>
        <line x1="16" y1="24" x2="16" y2="30" stroke="#fff" stroke-width="1.5"/>
      </svg></div>`;

    const marker = new AMap.Marker({
      position: [gcj[0], gcj[1]],
      content: el.outerHTML,
      anchor: 'center',
      offset: [0, 0],
      zIndex: 200
    });
    map.add(marker);
    marker.setMap(map);
    return marker;
  }

  function updateDronePosition(marker, lng, lat) {
    const gcj = CoordTransform.wgs84ToGcj02(lng, lat);
    marker.setPosition([gcj[0], gcj[1]]);
  }

  function removeDrone(marker) {
    map.remove(marker);
    marker.setMap(null);
  }

  return {
    init, getMap, setCenter,
    switchLayer, getLayerType,
    startDrawing, stopDrawing, isDrawing, clearDrawing, getPolygonPath,
    renderRoute, clearRoute,
    addDroneMarker, updateDronePosition, removeDrone,
    COLORS
  };
})();
