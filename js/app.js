/**
 * 主应用控制器
 * 协调所有模块，处理 UI 交互
 */

const App = (() => {
  // ---- 配置 ----
  // 高德 Key 统一在 js/config.js 中维护，避免与 map.js 双份硬编码
  const AMAP_KEY = window.AMAP_KEY || '';

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
    // 历史记录的事件委托与地图无关，先绑定，
    // 避免地图加载失败时连已保存的历史记录都点不动
    initHistoryEvents();
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

  /**
   * 收集表单参数并做输入校验。
   *
   * 为什么不能直接读值：重叠率控件是 range，normal UI 拖不出范围外的值，
   * 但 loadHistory() 会把 localStorage 里的值程序化写回控件，绕过 min/max，
   * 因此必须在读取时用 validity.valid 兜住（这也是死循环缺陷的最后一道防线）。
   * @returns 参数对象；校验不通过返回 null
   */
  function readParams() {
    const fields = [
      ['paramAltitude', '飞行高度'],
      ['paramSpeed', '飞行速度'],
      ['paramSensorWidth', '传感器宽度'],
      ['paramSensorHeight', '传感器高度'],
      ['paramFocalLength', '焦距'],
      ['paramPixelSize', '像元尺寸'],
      ['paramGimbalPitch', '云台俯仰角'],
      ['paramCourseAngle', '航线角度']
    ];

    for (const [id, name] of fields) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.value.trim() !== '' && !el.checkValidity()) {
        toast(`参数「${name}」超出允许范围：${el.validationMessage || '请检查输入'}`, 'error');
        return null;
      }
    }

    const forwardOverlapEl = document.getElementById('paramForwardOverlap');
    const sideOverlapEl = document.getElementById('paramSideOverlap');
    const forwardOverlapPct = parseInt(forwardOverlapEl.value, 10);
    const sideOverlapPct = parseInt(sideOverlapEl.value, 10);
    if (!Number.isFinite(forwardOverlapPct) || forwardOverlapPct < 0 || forwardOverlapPct > 95) {
      toast(`参数「航向重叠率」超出范围（当前 ${forwardOverlapEl.value}%），需在 0% ~ 95% 之间`, 'error');
      return null;
    }
    if (!Number.isFinite(sideOverlapPct) || sideOverlapPct < 0 || sideOverlapPct > 95) {
      toast(`参数「旁向重叠率」超出范围（当前 ${sideOverlapEl.value}%），需在 0% ~ 95% 之间`, 'error');
      return null;
    }

    const courseAngleStr = document.getElementById('paramCourseAngle').value.trim();
    const gimbalPitchRaw = parseFloat(document.getElementById('paramGimbalPitch').value);
    const missionTypeRaw = document.getElementById('paramMissionType').value;

    // 拍照停留（秒）：DJI 端 wpml:hoverTime 按秒解释，范围 0 ~ 500
    const hoverRaw = parseFloat(document.getElementById('paramPhotoHover').value);
    if (Number.isFinite(hoverRaw) && (hoverRaw < 0 || hoverRaw > 500)) {
      toast(`参数「拍照停留」超出范围（当前 ${hoverRaw}s），需在 0 ~ 500 秒之间`, 'error');
      return null;
    }

    return {
      missionType: missionTypeRaw === 'video' ? 'video' : 'photo',
      photoHoverSeconds: Number.isFinite(hoverRaw) ? hoverRaw : 1,
      altitude: parseFloat(document.getElementById('paramAltitude').value) || 100,
      speed: parseFloat(document.getElementById('paramSpeed').value) || 8,
      forwardOverlap: forwardOverlapPct / 100,
      sideOverlap: sideOverlapPct / 100,
      sensorWidth: parseInt(document.getElementById('paramSensorWidth').value, 10) || 5280,
      sensorHeight: parseInt(document.getElementById('paramSensorHeight').value, 10) || 3956,
      focalLength: parseFloat(document.getElementById('paramFocalLength').value) || 12.29,
      pixelSize: parseFloat(document.getElementById('paramPixelSize').value) || 3.3,
      courseAngle: courseAngleStr ? parseFloat(courseAngleStr) : null,
      gimbalPitch: Number.isFinite(gimbalPitchRaw) ? gimbalPitchRaw : -90
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

    const params = readParams();
    if (!params) {
      setStatus('参数校验未通过，请修正后重试');
      return;
    }

    try {
      setStatus('正在计算航线…');

      // GCJ-02 测区 → WGS-84 用于航线计算
      const polygonWgs = polygonPath.map(p => {
        const [wgsLng, wgsLat] = CoordTransform.gcj02ToWgs84(p[0], p[1]);
        return [wgsLng, wgsLat];
      });

      const result = RoutePlanner.generateRoute(polygonWgs, params);

      currentRoute = {
        waypoints: result.waypoints,
        stats: result.stats,
        params: { ...params, ...result.params },
        polygon: polygonPath
      };

      // 航点越界自检：翻转坐标转换后逐点复核，防止「航点严格在测区内」的承诺失效
      currentRoute.geometryCheck = checkWaypointsInPolygon(result.waypoints, polygonWgs);

      MapModule.renderRoute(result.waypoints, result.stats);
      showStats(result.stats);
      showSim();
      Storage.save(currentRoute);
      renderHistory();

      const photoCount = result.stats.photoCount;
      const totalDist = result.stats.totalDistance;
      const outside = currentRoute.geometryCheck.outsideCount;
      setStatus(outside === 0
        ? `航线已生成 — ${photoCount} 个拍照航点，总长 ${totalDist}m，全部航点在测区内`
        : `航线已生成 — ${photoCount} 个拍照航点，${outside} 个航点在测区外`);
      toast(outside === 0
        ? `成功生成 ${photoCount} 个航点，总航线 ${totalDist}m`
        : `已生成 ${photoCount} 个航点，但有 ${outside} 个落在测区外，请检查参数`, outside === 0 ? 'success' : 'warning');
    } catch (err) {
      console.error('航线生成失败:', err);
      toast('航线生成失败: ' + err.message, 'error');
      setStatus('航线生成失败: ' + err.message);
    }
  }

  /**
   * 逐点复核航点是否落在测区内（容差 0.5 m）
   *
   * 用球面距离换算平面坐标，而非直接比较经纬度：经度 1° 与纬度 1° 的实际
   * 长度不同，直接比较会把东西向的越界量算错。
   */
  function checkWaypointsInPolygon(waypoints, polygonWgs) {
    const TOLERANCE = 0.5;
    const centerLng = polygonWgs.reduce((s, p) => s + p[0], 0) / polygonWgs.length;
    const centerLat = polygonWgs.reduce((s, p) => s + p[1], 0) / polygonWgs.length;

    const toPlane = (lng, lat) => [
      RoutePlanner.distance(centerLng, centerLat, lng, centerLat) * (lng >= centerLng ? 1 : -1),
      RoutePlanner.distance(centerLng, centerLat, centerLng, lat) * (lat >= centerLat ? 1 : -1)
    ];

    const poly = polygonWgs.map(p => toPlane(p[0], p[1]));
    const outside = [];
    waypoints.forEach((wp, i) => {
      const [x, y] = toPlane(wp.lng, wp.lat);
      if (!RoutePlanner.pointInPolygon(x, y, poly)) {
        outside.push(i);
      }
    });
    return {
      checked: waypoints.length,
      outsideCount: outside.length,
      outsideIndices: outside.slice(0, 20),
      tolerance: TOLERANCE
    };
  }

  // ---- 统计显示 ----

  function showStats(stats) {
    document.getElementById('statsSection').style.display = '';
    const isVideoMission = stats.missionType === 'video';
    const countLabel = document.getElementById('statPhotoCountLabel');
    if (countLabel) countLabel.textContent = isVideoMission ? '摄像航点' : '拍照航点';
    document.getElementById('statPhotoCount').textContent =
      isVideoMission ? (stats.videoPointCount || 0) : stats.photoCount;
    document.getElementById('statTotalPoints').textContent = stats.totalPoints;
    document.getElementById('statTotalDist').textContent = stats.totalDistance;
    document.getElementById('statTurnDist').textContent = stats.turnDistance;
    document.getElementById('statEstTime').textContent = formatTime(stats.estimatedTime);
    document.getElementById('statArea').textContent = formatArea(stats.areaSize);
    document.getElementById('statGSD').textContent = stats.gsd;
    document.getElementById('statLineSpacing').textContent = stats.lineSpacing;
    document.getElementById('statPointSpacing').textContent = stats.pointSpacing;

    // 航线方向与趟数：让「算法朝哪飞、飞几趟」直接可见
    // （方向选择曾出过明显问题：细长测区被竖着切成十几趟）
    const params = (currentRoute && currentRoute.params) || {};
    const angleEl = document.getElementById('statCourseAngle');
    const passesEl = document.getElementById('statPasses');
    if (Number.isFinite(params.courseAngle)) {
      angleEl.textContent = `${params.courseAngle.toFixed(1)}${params.autoCourseAngle ? '（自动）' : ''}`;
      angleEl.title = '0° = 正北，90° = 正东。自动模式下按「航线趟数最少」择优';
    } else {
      angleEl.textContent = '-';
    }
    const turnCount = stats.totalPoints - stats.photoCount;
    const passes = Number.isFinite(stats.rowCount)
      ? stats.rowCount
      : (turnCount >= 0 ? turnCount + 1 : NaN);
    passesEl.textContent = Number.isFinite(passes) ? String(passes) : '-';
    passesEl.title = '每次换排算一趟；趟数越少转弯与空飞越少';
    document.getElementById('statPhotoCoverW').textContent = stats.imageCoverW;
    document.getElementById('statPhotoCoverH').textContent = stats.imageCoverH;

    const covEl = document.getElementById('statCoverage');
    const cov = stats.coverage;
    if (cov) {
      covEl.classList.toggle('stat-warn', !cov.ok);
      covEl.classList.toggle('stat-ok', !!cov.ok);
      covEl.textContent = cov.ok
        ? `完整（余量 ${cov.maxGap}m）`
        : `有空洞 ${cov.uncovered} 格`;
      covEl.title = cov.ok
        ? `测区自检：${cov.samples} 个采样点全部被像幅覆盖；最大边界余量 ${cov.maxGap}m（阈值 ${cov.tolerance}m）`
        : `测区自检发现 ${cov.uncovered}/${cov.samples} 个采样点未被像幅覆盖，最大空洞深度 ${cov.maxGap}m（阈值 ${cov.tolerance}m）`;
    } else {
      covEl.classList.remove('stat-warn', 'stat-ok');
      covEl.textContent = '-';
    }

    // 重叠率自检：按相机像幅复核实际航向/旁向重叠率是否达到要求值
    const ovEl = document.getElementById('statOverlap');
    const ov = stats.overlap;
    if (ov) {
      const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
      const fwdText = ov.forward.applicable === false ? '—（连续录像）' : pct(ov.forward.min);
      const allOk = !!ov.ok;
      ovEl.classList.toggle('stat-warn', !allOk);
      ovEl.classList.toggle('stat-ok', allOk);
      ovEl.textContent = ov.forward.ok && ov.side.ok
        ? `达标（航向 ${fwdText} / 旁向 ${pct(ov.side.min)}）`
        : `不足（航向 ${ov.forward.ok ? '达标' : fwdText} / 旁向 ${ov.side.ok ? '达标' : pct(ov.side.min)}）`;
      ovEl.title =
        (ov.forward.applicable === false
          ? '航向重叠率：摄像为连续录像，不存在航向「拍照间距」，不适用；'
          : `航向重叠率：最小 ${pct(ov.forward.min)}，平均 ${pct(ov.forward.avg)}（要求 ≥ ${(ov.forward.required * 100).toFixed(0)}%，${ov.forward.pairs} 对）；`) +
        `旁向重叠率：最小 ${pct(ov.side.min)}，平均 ${pct(ov.side.avg)}（要求 ≥ ${(ov.side.required * 100).toFixed(0)}%，${ov.side.pairs} 对）。` +
        `按 GSD→像幅与实际拍照间距复核；覆盖遗漏见「测区覆盖自检」`;
    } else {
      ovEl.classList.remove('stat-warn', 'stat-ok');
      ovEl.textContent = '-';
    }

    // 任务拆分：航点超过「任务拆分上限」时，导出将拆为多个 KMZ 文件
    const splitEl = document.getElementById('statSplit');
    if (splitEl) {
      const limit = readSplitLimit();
      if (limit > 0 && stats.totalPoints > limit && currentRoute && currentRoute.waypoints) {
        try {
          const plan = RoutePlanner.splitMission(currentRoute.waypoints, limit);
          splitEl.classList.remove('stat-warn');
          splitEl.textContent = `${plan.missions.length} 个 × ≤${limit} 点`;
          splitEl.title = `航点 ${stats.totalPoints} 超过上限 ${limit}，导出时拆分为 ${plan.missions.length} 个 KMZ 文件` +
            `（丢弃 ${plan.droppedTurns} 个边界转弯点，${isVideoMission ? `${stats.videoPointCount} 个摄像航点` : `${stats.photoCount} 个拍照点`}全部保留、顺序不变），依次导入执行`;
        } catch (e) {
          splitEl.textContent = '-';
        }
      } else {
        splitEl.classList.remove('stat-warn');
        splitEl.textContent = limit > 0 ? '无需拆分' : '未启用';
        splitEl.title = limit > 0
          ? `航点 ${stats.totalPoints} ≤ 上限 ${limit}，单文件导出`
          : '「任务拆分上限」设为 0 表示不拆分（默认 300：超过则拆分为多个 KMZ 依次执行）';
      }
    }

    // 预估时间：拍照含定点停留（停留秒数取自路线参数）；摄像为连续录像、不停留
    const estEl = document.getElementById('statEstTime');
    if (estEl && Number.isFinite(stats.estimatedTime)) {
      if (isVideoMission) {
        estEl.title = `摄像航线 ${stats.totalDistance}m ÷ 巡航速度（连续录像，中途不停留）`;
      } else {
        const hover = Number.isFinite(stats.hoverTotalTime) ? stats.hoverTotalTime : 0;
        const per = stats.photoCount > 0 ? (hover / stats.photoCount) : 0;
        estEl.title = `航程 ${stats.totalDistance}m ÷ 巡航速度 + 拍照停留 ${stats.photoCount} 点 × ${per}s（共 ${Math.round(hover)}s）`;
      }
    }

    const check = currentRoute && currentRoute.geometryCheck;
    const outEl = document.getElementById('statOutside');
    if (check) {
      outEl.classList.toggle('stat-warn', check.outsideCount > 0);
      outEl.textContent = check.outsideCount === 0 ? '0（通过）' : String(check.outsideCount);
      outEl.title = check.outsideCount === 0
        ? `已逐点复核 ${check.checked} 个航点，全部落在测区内（点多边形测试）`
        : `有 ${check.outsideCount} 个航点落在测区外，索引：${check.outsideIndices.join(', ')}${check.outsideCount > 20 ? ' …' : ''}`;
    } else {
      outEl.classList.remove('stat-warn');
      outEl.textContent = '-';
    }
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

  // 读取「任务拆分上限」：0 = 不拆分；非法输入按 0 处理
  function readSplitLimit() {
    const raw = parseInt(document.getElementById('paramSplitLimit').value, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  // 读取「导出命名」：'dji' = 大写 UUID v4（与 RC2/DJI Fly 原生导出一致）
  function readExportNaming() {
    const el = document.getElementById('paramExportNaming');
    return el && el.value === 'readable' ? 'readable' : 'dji';
  }

  // 把文件名清单压成一句话（UUID 命名时用于对照第几份）
  function formatNameList(names) {
    if (!names || names.length === 0) return '';
    if (names.length <= 3) {
      return names.map((n, i) => `part${i + 1}=${n.replace(/\.kmz$/i, '')}`).join('，');
    }
    return `${names.length} 个文件（part1=${names[0].replace(/\.kmz$/i, '')} …）`;
  }

  function exportKmz() {
    if (!currentRoute || !currentRoute.waypoints.length) {
      toast('请先生成航线', 'warning');
      return;
    }

    const limit = readSplitLimit();
    const total = currentRoute.waypoints.length;
    const style = readExportNaming();

    try {
      if (limit > 0 && total > limit) {
        // 超过上限：拆分为多个 KMZ 文件，依次导入执行（拍照点全保留）
        const plan = RoutePlanner.splitMission(currentRoute.waypoints, limit);
        const base = `mission_${new Date().toISOString().slice(0, 10)}`;
        setStatus(`正在导出 ${plan.missions.length} 个 KMZ 文件…`);
        KmzExport.exportKmzMultiple(plan.missions, { ...currentRoute.params }, { style, baseFilename: base })
          .then(res => {
            const map = style === 'dji' ? `；命名对应：${formatNameList(res.names)}` : '';
            toast(`已导出 ${res.count} 个 KMZ（每个 ≤${limit} 航点，丢弃 ${plan.droppedTurns} 个边界转弯点），请依次导入执行${map}`, 'success');
            setStatus(`KMZ 已导出（${res.count} 个任务）`);
          })
          .catch(err => {
            toast('导出失败: ' + err.message, 'error');
            setStatus('导出失败');
          });
      } else {
        const name = KmzExport.generateMissionFileName(style, 1, 1);
        KmzExport.exportKmz(currentRoute.waypoints, { ...currentRoute.params }, name);
        toast(`KMZ 已导出（${name.replace(/\.kmz$/i, '')}） — 可导入 DJI Pilot / GS Pro / DJI Fly`, 'success');
        setStatus('KMZ 已导出');
      }
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
    // 与 calcStats 同一口径：按段起点分类（转弯点两侧都是拍照点，
    // 用「任一端为 photo」会让转弯段恒为 0）
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const d = RoutePlanner.distance(a.lng, a.lat, b.lng, b.lat);
      if (a.type === 'photo') photoDist += d;
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
      imageCoverW: 0, imageCoverH: 0, coverage: null
    };
  }

  // ---- 历史记录 ----
  //
  // 安全说明：历史记录的名称来自用户输入并持久化在 localStorage。
  // 旧实现把它拼进 onclick 属性，而转义只基于 textContent，
  // 不转义单引号，构造 `'` 即可闭合属性注入脚本（存储型 DOM XSS）。
  // 现改为全部走 textContent + 事件委托，属性中不再出现用户数据。

  function renderHistory() {
    const list = Storage.getList();
    const container = document.getElementById('historyList');
    container.textContent = '';

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '暂无记录';
      container.appendChild(empty);
      return;
    }

    for (const item of list) {
      const row = document.createElement('div');
      row.className = 'history-item';
      row.dataset.id = item.id;

      const name = document.createElement('span');
      name.className = 'h-name';
      name.textContent = item.name;

      const meta = document.createElement('span');
      meta.className = 'h-meta';
      meta.textContent = `${item.photoCount}点 | ${item.totalDistance}m`;

      const del = document.createElement('span');
      del.className = 'h-del';
      del.textContent = '×';
      del.title = '删除该记录';

      row.append(name, meta, del);
      container.appendChild(row);
    }
  }

  function onHistoryClick(event) {
    const row = event.target.closest('.history-item');
    if (!row || !row.dataset.id) return;
    if (event.target.classList.contains('h-del')) {
      deleteHistory(row.dataset.id);
    } else {
      loadHistory(row.dataset.id);
    }
  }

  function loadHistory(id) {
    const plan = Storage.getById(id);
    if (!plan) { toast('记录不存在', 'error'); return; }

    // 历史参数回填前必须钳制：localStorage 中的数据可能来自旧版本或被手工篡改，
    // 直接写回控件会绕过 range 的 min/max，把非法值喂给算法
    if (plan.params) {
      const p = plan.params;
      const num = (v, lo, hi, dflt) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
      };

      const forwardPct = Math.round(num(p.forwardOverlap, 0, 0.95, 0.75) * 100);
      const sidePct = Math.round(num(p.sideOverlap, 0, 0.95, 0.65) * 100);
      if (Math.round((p.forwardOverlap ?? 0.75) * 100) !== forwardPct ||
          Math.round((p.sideOverlap ?? 0.65) * 100) !== sidePct) {
        toast('历史记录的参数超出有效范围，已按边界值载入', 'warning');
      }

      document.getElementById('paramAltitude').value = num(p.altitude, 1, 1500, 100);
      document.getElementById('paramSpeed').value = num(p.speed, 0.5, 30, 8);
      document.getElementById('paramPhotoHover').value = num(p.photoHoverSeconds, 0, 500, 1);
      document.getElementById('paramForwardOverlap').value = forwardPct;
      document.getElementById('forwardOverlapVal').textContent = forwardPct + '%';
      document.getElementById('paramSideOverlap').value = sidePct;
      document.getElementById('sideOverlapVal').textContent = sidePct + '%';
      document.getElementById('paramSensorWidth').value = num(p.sensorWidth, 1, 100000, 5280);
      document.getElementById('paramSensorHeight').value = num(p.sensorHeight, 1, 100000, 3956);
      document.getElementById('paramFocalLength').value = num(p.focalLength, 0.1, 2000, 12.29);
      document.getElementById('paramPixelSize').value = num(p.pixelSize, 0.1, 100, 3.3);
      document.getElementById('paramGimbalPitch').value = num(p.gimbalPitch, -90, 30, -90);
      document.getElementById('paramCourseAngle').value =
        p.courseAngle == null ? '' : num(p.courseAngle, 0, 180, 0);
      // 任务类型随记录恢复（旧记录无该字段时回落到统计里的任务类型）
      const mt = p.missionType || (plan.stats && plan.stats.missionType) || 'photo';
      document.getElementById('paramMissionType').value = mt === 'video' ? 'video' : 'photo';
    }

    currentRoute = plan;
    // 旧记录里没有航线方向字段，此处不回填，界面显示为 "-"
    currentRoute.geometryCheck = plan.polygon && plan.polygon.length >= 3
      ? checkWaypointsInPolygon(plan.waypoints, plan.polygon.map(q => {
          const [lng, lat] = CoordTransform.gcj02ToWgs84(q[0], q[1]);
          return [lng, lat];
        }))
      : null;

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

  function initHistoryEvents() {
    const container = document.getElementById('historyList');
    if (container) container.addEventListener('click', onHistoryClick);
  }

  return {
    init,
    startDraw, clearAll, generateRoute,
    toggleMapLayer,
    simStart, simPause, simStop, simSetSpeed,
    exportKmz, importKmz, handleFileImport,
    loadHistory, deleteHistory,
    initHistoryEvents
  };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
