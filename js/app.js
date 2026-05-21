/**
 * 主应用控制器
 * 协调所有模块，处理 UI 交互
 */

const App = (() => {
  // ---- 配置 ----
  const AMAP_KEY = 'YOUR_AMAP_KEY'; // ← 替换为你的高德地图 Key

  // ---- 相机预设 (实际焦距 + 像元尺寸) ----
  const CAMERA_PRESETS = {
    mavic3e: {
      name: 'Mavic 3E 广角 (4/3")',
      sensorWidth: 5280, sensorHeight: 3956,
      focalLength: 12.29, pixelSize: 3.3   // 实际焦距 12.29mm, 像元 3.3μm
    },
    mavic3e_tele: {
      name: 'Mavic 3E 长焦 (1/2")',
      sensorWidth: 4000, sensorHeight: 3000,
      focalLength: 29.6, pixelSize: 1.6    // 实际焦距 29.6mm, 162mm 等效
    },
    p4rtk: {
      name: 'Phantom 4 RTK (1")',
      sensorWidth: 5472, sensorHeight: 3648,
      focalLength: 8.8, pixelSize: 2.41     // 1英寸传感器, 24mm 等效
    },
    mini4pro: {
      name: 'Mini 4 Pro (1/1.3")',
      sensorWidth: 4032, sensorHeight: 3024,
      focalLength: 6.72, pixelSize: 1.6     // 1/1.3英寸, 24mm 等效, 12MP 模式
    },
    mini5pro: {
      name: 'Mini 5 Pro (1")',
      sensorWidth: 8192, sensorHeight: 6144,
      focalLength: 8.8, pixelSize: 1.6      // 1英寸 50MP, 8.8mm 实际焦距, 1.6μm 像元
    }
  };

  let currentPreset = 'mavic3e';
  let currentRoute = null;
  let simActive = false;

  // ---- 初始化 ----

  async function init() {
    try {
      setStatus('正在加载地图…');
      await MapModule.init('map', AMAP_KEY);
      setStatus('已就绪 — 点击"绘制测区"开始规划');
      setupPresetButtons();
      renderHistory();
      updateParamsFromPreset('mavic3e');
    } catch (err) {
      setStatus('地图加载失败: ' + err.message);
      toast('地图加载失败，请检查高德地图 Key 和网络连接', 'error');
    }
  }

  // ---- 参数读取 ----

  function readParams() {
    const courseAngleStr = document.getElementById('paramCourseAngle').value.trim();
    return {
      altitude: parseFloat(document.getElementById('paramAltitude').value) || 100,
      speed: parseFloat(document.getElementById('paramSpeed').value) || 8,
      forwardOverlap: parseInt(document.getElementById('paramForwardOverlap').value) / 100,
      sideOverlap: parseInt(document.getElementById('paramSideOverlap').value) / 100,
      sensorWidth: parseInt(document.getElementById('paramSensorWidth').value) || 5280,
      sensorHeight: parseInt(document.getElementById('paramSensorHeight').value) || 3956,
      focalLength: parseFloat(document.getElementById('paramFocalLength').value) || 12.29,
      pixelSize: parseFloat(document.getElementById('paramPixelSize').value) || 3.3,
      courseAngle: courseAngleStr ? parseFloat(courseAngleStr) : null,
      gimbalPitch: (() => { const v = parseFloat(document.getElementById('paramGimbalPitch').value); return isNaN(v) ? -90 : v; })()
    };
  }

  function updateParamsFromPreset(presetKey) {
    const preset = CAMERA_PRESETS[presetKey];
    if (!preset) return;
    document.getElementById('paramSensorWidth').value = preset.sensorWidth;
    document.getElementById('paramSensorHeight').value = preset.sensorHeight;
    document.getElementById('paramFocalLength').value = preset.focalLength;
    document.getElementById('paramPixelSize').value = preset.pixelSize;
    currentPreset = presetKey;
  }

  function setupPresetButtons() {
    const container = document.getElementById('presetBtns');
    // 动态生成预设按钮
    const presetKeys = Object.keys(CAMERA_PRESETS);
    container.innerHTML = presetKeys.map(key => {
      const p = CAMERA_PRESETS[key];
      return `<button class="preset-btn${key === currentPreset ? ' active' : ''}" data-preset="${key}">${p.name}</button>`;
    }).join('') + `<button class="preset-btn" data-preset="custom">自定义</button>`;

    container.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const preset = btn.dataset.preset;
        if (preset !== 'custom' && CAMERA_PRESETS[preset]) {
          updateParamsFromPreset(preset);
        }
        currentPreset = preset;
      });
    });
  }

  // ---- 绘制测区 ----

  function startDraw() {
    MapModule.clearDrawing();
    MapModule.clearRoute();
    currentRoute = null;
    hideStats();
    hideSim();
    MapModule.startDrawing();

    window._onPolygonUpdated = () => {
      setStatus('测区已更新 — 点击"生成航线"计算');
    };

    setStatus('正在绘制 — 在地图上依次点击顶点');
  }

  function clearAll() {
    MapModule.clearDrawing();
    MapModule.clearRoute();
    currentRoute = null;
    hideStats();
    hideSim();
    setStatus('已就绪 — 点击"绘制测区"开始规划');
  }

  // ---- 生成航线 ----

  function generateRoute() {
    const polygonPath = MapModule.getPolygonPath();
    if (polygonPath.length < 3) {
      toast('请先在图上绘制测区（至少 3 个顶点）', 'warning');
      return;
    }

    try {
      setStatus('正在计算航线…');

      // GCJ-02 测区 → WGS-84 用于航线计算
      const polygonWgs = polygonPath.map(p => {
        const [wgsLng, wgsLat] = CoordTransform.gcj02ToWgs84(p[0], p[1]);
        return [wgsLng, wgsLat];
      });

      const params = readParams();
      const result = RoutePlanner.generateRoute(polygonWgs, params);

      currentRoute = {
        waypoints: result.waypoints,
        stats: result.stats,
        params: { ...params, ...result.params },
        polygon: polygonPath
      };

      MapModule.renderRoute(result.waypoints, result.stats);
      showStats(result.stats);
      showSim();
      Storage.save(currentRoute);
      renderHistory();

      const photoCount = result.stats.photoCount;
      const totalDist = result.stats.totalDistance;
      setStatus(`航线已生成 — ${photoCount} 个拍照航点，总长 ${totalDist}m`);
      toast(`成功生成 ${photoCount} 个航点，总航线 ${totalDist}m`, 'success');
    } catch (err) {
      console.error('航线生成失败:', err);
      toast('航线生成失败: ' + err.message, 'error');
      setStatus('航线生成失败: ' + err.message);
    }
  }

  // ---- 统计显示 ----

  function showStats(stats) {
    document.getElementById('statsSection').style.display = '';
    document.getElementById('statPhotoCount').textContent = stats.photoCount;
    document.getElementById('statTotalPoints').textContent = stats.totalPoints;
    document.getElementById('statTotalDist').textContent = stats.totalDistance;
    document.getElementById('statEstTime').textContent = formatTime(stats.estimatedTime);
    document.getElementById('statArea').textContent = formatArea(stats.areaSize);
    document.getElementById('statGSD').textContent = stats.gsd;
    document.getElementById('statLineSpacing').textContent = stats.lineSpacing;
    document.getElementById('statPointSpacing').textContent = stats.pointSpacing;
    document.getElementById('statPhotoCoverW').textContent = stats.imageCoverW;
    document.getElementById('statPhotoCoverH').textContent = stats.imageCoverH;
  }

  function hideStats() {
    document.getElementById('statsSection').style.display = 'none';
  }

  function showSim() {
    document.getElementById('simSection').style.display = '';
  }

  function hideSim() {
    document.getElementById('simSection').style.display = 'none';
    simStop();
  }

  // ---- 飞行模拟 ----

  function simStart() {
    if (!currentRoute || !currentRoute.waypoints.length) {
      toast('请先生成航线', 'warning');
      return;
    }

    FlightSim.init(currentRoute.waypoints, {
      onUpdate: (state) => updateSimUI(state),
      onComplete: () => {
        updateSimButtons(false, false);
        toast('飞行模拟完成', 'success');
        setStatus('飞行模拟完成');
      }
    });

    FlightSim.setSpeed(parseFloat(document.getElementById('simSpeed').value) || 1);
    FlightSim.start();
    simActive = true;
    updateSimButtons(true, true);
    setStatus('模拟飞行中…');
  }

  function simPause() {
    if (FlightSim.isRunning()) {
      FlightSim.pause();
      updateSimButtons(true, false, '继续');
      setStatus('模拟已暂停');
    } else {
      FlightSim.resume();
      updateSimButtons(true, true);
      setStatus('模拟飞行中…');
    }
  }

  function simStop() {
    FlightSim.stop();
    simActive = false;
    updateSimButtons(false, false);
    document.getElementById('simBar').style.width = '0%';
    document.getElementById('simCompleted').textContent = '已飞: 0m';
    document.getElementById('simPercent').textContent = '0%';
    document.getElementById('simRemaining').textContent = '剩余: -';
    setStatus('已就绪');
  }

  function simSetSpeed(val) {
    FlightSim.setSpeed(parseFloat(val));
  }

  function updateSimUI(state) {
    if (!state) return;
    document.getElementById('simBar').style.width = state.percent + '%';
    document.getElementById('simCompleted').textContent = `已飞: ${state.completedDistance}m`;
    document.getElementById('simPercent').textContent = state.percent + '%';
    document.getElementById('simRemaining').textContent =
      `剩余: ${state.totalDistance - state.completedDistance}m`;
  }

  function updateSimButtons(running, canPause, pauseLabel) {
    document.getElementById('btnSimStart').disabled = running;
    document.getElementById('btnSimPause').disabled = !canPause;
    document.getElementById('btnSimStop').disabled = !running;
    document.getElementById('btnSimPause').textContent = pauseLabel ? '▶ ' + pauseLabel : '⏸ 暂停';
  }

  // ---- KMZ 导出/导入 ----

  function exportKmz() {
    if (!currentRoute || !currentRoute.waypoints.length) {
      toast('请先生成航线', 'warning');
      return;
    }

    try {
      KmzExport.exportKmz(currentRoute.waypoints, {
        ...currentRoute.params,
        wpmlVersion: '1.0.3'
      });
      toast('KMZ 已导出 — 可导入 DJI Pilot / GS Pro', 'success');
      setStatus('KMZ 已导出');
    } catch (err) {
      toast('导出失败: ' + err.message, 'error');
    }
  }

  function importKmz() {
    document.getElementById('fileInput').click();
  }

  async function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      setStatus('正在导入…');
      const result = await KmzExport.importKmz(file);

      if (result.waypoints.length === 0) {
        toast('文件中未找到航点数据', 'warning');
        return;
      }

      currentRoute = {
        waypoints: result.waypoints,
        stats: computeStatsFromWaypoints(result.waypoints),
        params: {},
        polygon: result.polygon || []
      };

      MapModule.clearRoute();
      MapModule.renderRoute(result.waypoints, currentRoute.stats);
      showStats(currentRoute.stats);
      showSim();
      Storage.save(currentRoute);
      renderHistory();

      toast(`成功导入 ${result.waypoints.length} 个航点`, 'success');
      setStatus(`已导入 — ${result.waypoints.length} 个航点`);
    } catch (err) {
      toast('导入失败: ' + err.message, 'error');
      setStatus('导入失败');
    }
    event.target.value = '';
  }

  function computeStatsFromWaypoints(waypoints) {
    let photoCount = 0, photoDist = 0, turnDist = 0;
    for (const w of waypoints) { if (w.type === 'photo') photoCount++; }
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const d = RoutePlanner.distance(a.lng, a.lat, b.lng, b.lat);
      if (a.type === 'photo' || b.type === 'photo') photoDist += d;
      else turnDist += d;
    }
    const total = photoDist + turnDist;
    const avgSpeed = waypoints.length > 0
      ? waypoints.reduce((s, w) => s + (w.speed || 8), 0) / waypoints.length : 8;
    return {
      photoCount, totalPoints: waypoints.length,
      photoDistance: Math.round(photoDist), turnDistance: Math.round(turnDist),
      totalDistance: Math.round(total), estimatedTime: Math.round(total / avgSpeed),
      areaSize: 0, gsd: 0, lineSpacing: 0, pointSpacing: 0,
      imageCoverW: 0, imageCoverH: 0
    };
  }

  // ---- 历史记录 ----

  function renderHistory() {
    const list = Storage.getList();
    const container = document.getElementById('historyList');

    if (list.length === 0) {
      container.innerHTML = `<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:16px 0;">暂无记录</div>`;
      return;
    }

    container.innerHTML = list.map(item => `
      <div class="history-item" onclick="App.loadHistory('${item.id}')">
        <span class="h-name">${escHtml(item.name)}</span>
        <span class="h-meta">${item.photoCount}点 | ${item.totalDistance}m</span>
        <span class="h-del" onclick="event.stopPropagation();App.deleteHistory('${item.id}')">&times;</span>
      </div>
    `).join('');
  }

  function loadHistory(id) {
    const plan = Storage.getById(id);
    if (!plan) { toast('记录不存在', 'error'); return; }

    currentRoute = plan;

    if (plan.params) {
      const p = plan.params;
      document.getElementById('paramAltitude').value = p.altitude || 100;
      document.getElementById('paramSpeed').value = p.speed || 8;
      document.getElementById('paramForwardOverlap').value = Math.round((p.forwardOverlap || 0.75) * 100);
      document.getElementById('forwardOverlapVal').textContent = Math.round((p.forwardOverlap || 0.75) * 100) + '%';
      document.getElementById('paramSideOverlap').value = Math.round((p.sideOverlap || 0.65) * 100);
      document.getElementById('sideOverlapVal').textContent = Math.round((p.sideOverlap || 0.65) * 100) + '%';
      document.getElementById('paramSensorWidth').value = p.sensorWidth || 5280;
      document.getElementById('paramSensorHeight').value = p.sensorHeight || 3956;
      document.getElementById('paramFocalLength').value = p.focalLength || 12.29;
      document.getElementById('paramPixelSize').value = p.pixelSize || 3.3;
      document.getElementById('paramCourseAngle').value = p.courseAngle ?? '';
      document.getElementById('paramGimbalPitch').value = p.gimbalPitch ?? -90;
    }

    MapModule.clearRoute();
    MapModule.renderRoute(plan.waypoints, plan.stats);
    showStats(plan.stats);
    showSim();

    setStatus(`已加载: ${plan.name}`);
    toast(`已加载航线: ${plan.name}`, 'success');
  }

  function deleteHistory(id) {
    Storage.remove(id);
    renderHistory();
    toast('已删除记录', 'warning');
  }

  // ---- 工具方法 ----

  function setStatus(msg) {
    const el = document.getElementById('statusText');
    if (el) el.textContent = msg;
  }

  function toast(msg, type) {
    type = type || 'success';
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, 2500);
  }

  function toggleMapLayer() {
    const type = MapModule.switchLayer();
    const btn = document.getElementById('btnLayer');
    if (btn) {
      btn.textContent = type === 'standard' ? '🗺 标准地图' : '🛰 卫星+路网';
    }
  }

  function formatTime(seconds) {
    if (seconds < 60) return seconds + 's';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + 'm' + s + 's';
  }

  function formatArea(m2) {
    if (m2 >= 1e6) return (m2 / 1e6).toFixed(2) + ' km²';
    return Math.round(m2) + ' m²';
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return {
    init,
    startDraw, clearAll, generateRoute,
    toggleMapLayer,
    simStart, simPause, simStop, simSetSpeed,
    exportKmz, importKmz, handleFileImport,
    loadHistory, deleteHistory
  };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
