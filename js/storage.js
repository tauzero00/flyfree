/**
 * 本地存储模块
 * 保存/加载航线规划历史到 localStorage
 */

const Storage = (() => {
  const KEY = 'drone_route_plans';
  const MAX_ITEMS = 20;

  function getAll() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function save(plan) {
    const plans = getAll();
    // 添加时间戳和 ID
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: plan.name || `航线 ${new Date().toLocaleString('zh-CN')}`,
      createdAt: new Date().toISOString(),
      waypoints: plan.waypoints,
      stats: plan.stats,
      params: plan.params,
      polygon: plan.polygon || []
    };

    plans.unshift(entry);

    // 裁剪到最大数量
    if (plans.length > MAX_ITEMS) {
      plans.length = MAX_ITEMS;
    }

    try {
      localStorage.setItem(KEY, JSON.stringify(plans));
    } catch (e) {
      // localStorage 满，删除最旧的
      plans.pop();
      localStorage.setItem(KEY, JSON.stringify(plans));
    }

    return entry;
  }

  function getById(id) {
    const plans = getAll();
    return plans.find(p => p.id === id) || null;
  }

  function remove(id) {
    let plans = getAll();
    plans = plans.filter(p => p.id !== id);
    localStorage.setItem(KEY, JSON.stringify(plans));
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  function getList() {
    return getAll().map(p => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      photoCount: p.stats?.photoCount || 0,
      totalDistance: p.stats?.totalDistance || 0,
      areaSize: p.stats?.areaSize || 0
    }));
  }

  return { getAll, save, getById, remove, clear, getList };
})();
