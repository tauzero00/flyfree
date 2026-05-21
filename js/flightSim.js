/**
 * 飞行模拟模块
 * 沿规划航线动画移动无人机图标，模拟飞行预览
 */

const FlightSim = (() => {
  let waypoints = [];
  let currentIndex = 0;
  let progress = 0;       // 当前段内进度 0-1
  let speed = 1;          // 模拟速度倍率
  let animId = null;
  let running = false;
  let droneMarker = null;
  let onUpdate = null;    // 状态更新回调
  let onComplete = null;  // 完成回调

  // 动画参数
  const BASE_INTERVAL = 50; // ms，基础更新间隔

  function init(wps, callbacks) {
    waypoints = wps;
    currentIndex = 0;
    progress = 0;
    speed = 1;
    running = false;
    onUpdate = callbacks?.onUpdate || null;
    onComplete = callbacks?.onComplete || null;
  }

  function setSpeed(s) {
    speed = Math.max(0.5, Math.min(10, s));
  }

  function getState() {
    if (waypoints.length === 0) return null;

    // 计算当前位置
    const a = waypoints[currentIndex];
    const b = waypoints[Math.min(currentIndex + 1, waypoints.length - 1)];

    const lat = a.lat + (b.lat - a.lat) * progress;
    const lng = a.lng + (b.lng - a.lng) * progress;
    const alt = a.alt + (b.alt - a.alt) * progress;

    // 计算累计距离
    let completedDist = 0;
    for (let i = 0; i < currentIndex; i++) {
      completedDist += RoutePlanner.distance(
        waypoints[i].lng, waypoints[i].lat,
        waypoints[i + 1].lng, waypoints[i + 1].lat
      );
    }
    const currentSegDist = RoutePlanner.distance(a.lng, a.lat, b.lng, b.lat);
    completedDist += currentSegDist * progress;

    // 总距离
    let totalDist = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      totalDist += RoutePlanner.distance(
        waypoints[i].lng, waypoints[i].lat,
        waypoints[i + 1].lng, waypoints[i + 1].lat
      );
    }

    return {
      lat, lng, alt,
      currentIndex,
      segmentProgress: progress,
      completedDistance: Math.round(completedDist),
      totalDistance: Math.round(totalDist),
      percent: totalDist > 0 ? Math.round(completedDist / totalDist * 100) : 0,
      currentAction: a.action,
      currentType: a.type
    };
  }

  function start() {
    if (waypoints.length < 2) return;
    if (running) return;
    running = true;

    // 创建无人机标记
    const first = waypoints[0];
    droneMarker = MapModule.addDroneMarker(first.lng, first.lat);
    currentIndex = 0;
    progress = 0;

    tick();
  }

  function pause() {
    running = false;
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  function resume() {
    if (!running && waypoints.length > 0) {
      running = true;
      tick();
    }
  }

  function stop() {
    pause();
    if (droneMarker) {
      MapModule.removeDrone(droneMarker);
      droneMarker = null;
    }
    currentIndex = 0;
    progress = 0;
  }

  function reset() {
    stop();
    if (waypoints.length > 0) {
      const first = waypoints[0];
      droneMarker = MapModule.addDroneMarker(first.lng, first.lat);
    }
  }

  function tick() {
    if (!running) return;

    if (currentIndex >= waypoints.length - 1) {
      // 到达最后一个航点
      running = false;
      if (onComplete) onComplete();
      return;
    }

    const a = waypoints[currentIndex];
    const b = waypoints[currentIndex + 1];
    const segDist = RoutePlanner.distance(a.lng, a.lat, b.lng, b.lat);
    const segSpeed = (a.speed || 8); // m/s
    const segTime = segDist / segSpeed; // 秒

    // 根据速度倍率调整进度
    const dt = (BASE_INTERVAL / 1000) * speed; // 模拟秒数每次更新
    const dProgress = segTime > 0 ? dt / segTime : 0;

    progress += dProgress;

    if (progress >= 1) {
      // 进入下一段
      progress = 0;
      currentIndex++;

      if (currentIndex >= waypoints.length - 1) {
        // 终点
        const last = waypoints[waypoints.length - 1];
        MapModule.updateDronePosition(droneMarker, last.lng, last.lat);
        if (onUpdate) onUpdate(getState());
        running = false;
        if (onComplete) onComplete();
        return;
      }

      // 前进到下一个 segment 再跑一次
      progress = 0.01;
    }

    // 更新无人机位置
    const lat = a.lat + (b.lat - a.lat) * progress;
    const lng = a.lng + (b.lng - a.lng) * progress;
    MapModule.updateDronePosition(droneMarker, lng, lat);

    if (onUpdate) onUpdate(getState());

    animId = requestAnimationFrame(tick);
  }

  function isRunning() {
    return running;
  }

  return {
    init, setSpeed, start, pause, resume, stop, reset,
    getState, isRunning
  };
})();
