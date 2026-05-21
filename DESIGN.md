# 无人机航测路线规划系统 - 设计文档

## 一、项目概述

面向大疆无人机用户的航测路线规划 Web 工具。用户在地图上划定测区，系统自动生成高效的蛇形（之字形）航线，支持航线统计、飞行模拟预览，并导出为 KMZ 格式直接导入 DJI 遥控器（如 DJI Pilot、DJI GS Pro）执行自动飞行和拍摄任务。

### 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | 纯 HTML/CSS/JavaScript（无框架依赖） |
| 地图服务 | 高德地图 JS API 2.0 |
| 文件导出 | JSZip + Blob（客户端生成 KMZ） |
| 存储 | localStorage（保存规划历史） |

### 核心指标

- 支持测区面积：0.01 ~ 50 km²
- 航线生成时间：< 500ms（100 个航点以内）
- KMZ 兼容设备：DJI Pilot 2 / DJI GS Pro / DJI Fly

---

## 二、功能模块

### 2.1 地图交互

- **底图**：高德卫星影像（`AMap.Satellite`），便于识别地物
- **绘制测区**：用户点击添加多边形顶点，支持拖拽编辑、删除顶点
- **导入测区**：支持导入 KML/KMZ 中的面要素作为测区
- **坐标系**：内部使用 WGS-84（GPS 坐标），高德地图默认 GCJ-02，需转换模块

### 2.2 参数设置面板

| 参数 | 说明 | 典型值 |
|---|---|---|
| 飞行高度 (m) | 相对起飞点高度 | 50 ~ 500 |
| 航向重叠率 (%) | 沿航线方向照片重叠 | 75 |
| 旁向重叠率 (%) | 相邻航线间照片重叠 | 65 |
| 传感器宽度 (px) | 相机照片像素宽 | 5472（Mavic 3E） |
| 传感器高度 (px) | 相机照片像素高 | 3648 |
| 焦距 (mm) | 相机镜头焦距 | 24（Mavic 3E 广角） |
| 像素尺寸 (μm) | 像元大小 | 2.4 |
| 飞行速度 (m/s) | 巡航速度 | 8 |
| 航线角度 (°) | 航线方向（0=正北，90=正东） | 自动/手动 |
| 起飞点 | 经纬度 | 手动设置或使用首顶点 |

### 2.3 航线自动生成

- 计算 GSD（地面采样距离）
- 根据重叠率和 GSD 计算航线间距、航点间距
- 生成覆盖多边形的蛇形航线
- 自动在航线首尾添加起飞/返航点

### 2.4 可视化

- 航点标记（编号、坐标、高度）
- 航线连接线（区分拍照段和转弯段）
- 起飞/降落点特殊图标
- 测区边界半透明叠加

### 2.5 航线统计

- 总航点数量
- 总航线长度（拍照段 + 转弯段）
- 预估飞行时间
- 测区面积
- 预估照片数量
- 预估覆盖面积

### 2.6 飞行模拟

- 沿航线动画移动无人机图标
- 可调速（1x / 2x / 5x）
- 显示当前位置、已飞行距离、剩余时间
- 拍照点闪烁提示

### 2.7 KMZ 导出

- 按 DJI Waypoint Mission 格式生成 KML
- 使用 JSZip 打包为 KMZ
- 包含航点坐标、高度、动作类型、云台角度等

### 2.8 持久化

- 自动保存最近 10 条航线规划到 localStorage
- 支持载入历史规划
- 支持从 KMZ 导入已有航线

---

## 三、架构设计

### 3.1 文件结构

```
航测线路/
├── index.html            # 主页面 + UI 布局
├── css/
│   └── style.css         # 样式（面板、控件、动画）
├── js/
│   ├── app.js            # 主控制器，协调各模块
│   ├── map.js            # 地图初始化、图层管理、交互
│   ├── routePlanner.js   # 核心航线规划算法
│   ├── routeStats.js     # 航线统计计算
│   ├── flightSim.js      # 飞行模拟动画
│   ├── kmzExport.js      # KMZ 生成与导出
│   ├── coordTransform.js # WGS-84 ↔ GCJ-02 坐标转换
│   └── storage.js        # localStorage 读写
└── lib/
    ├── jszip.min.js      # JSZip 库
    └── FileSaver.min.js  # 文件保存辅助
```

### 3.2 模块依赖关系

```
app.js (主控制器)
  ├── map.js            → 高德地图 API
  ├── routePlanner.js   → coordTransform.js
  ├── routeStats.js     → routePlanner.js (读取数据)
  ├── flightSim.js      → map.js (更新图标位置)
  ├── kmzExport.js      → routePlanner.js (读取航点)
  └── storage.js        → localStorage
```

### 3.3 核心数据结构

```javascript
// 单个航点
interface Waypoint {
  id: number;                    // 序号
  lat: number;                   // WGS-84 纬度
  lng: number;                   // WGS-84 经度
  alt: number;                   // 相对高度 (m)
  type: 'takeoff' | 'photo' | 'turn' | 'land';  // 航点类型
  action: 'takePhoto' | 'startRecord' | 'stopRecord' | 'hover' | null;
  gimbalPitch: number;           // 云台俯仰角 (-90~0)
  speed: number;                 // 该段飞行速度 (m/s)
}

// 航线整体结构
interface RoutePlan {
  waypoints: Waypoint[];         // 所有航点
  area: [number, number][];      // 测区多边形 [lng, lat][]
  params: PlanParams;            // 规划参数
  stats: RouteStats;             // 统计信息
  createdAt: string;             // 创建时间
}

// 规划参数
interface PlanParams {
  altitude: number;              // 飞行高度 (m)
  forwardOverlap: number;        // 航向重叠率 (0-1)
  sideOverlap: number;           // 旁向重叠率 (0-1)
  sensorWidth: number;           // 传感器像素宽
  sensorHeight: number;          // 传感器像素高
  focalLength: number;           // 焦距 (mm)
  pixelSize: number;             // 像元大小 (μm)
  speed: number;                 // 飞行速度 (m/s)
  courseAngle: number;           // 航线角度 (°)
  takeoffLat: number;            // 起飞点纬度
  takeoffLng: number;            // 起飞点经度
}

// 统计信息
interface RouteStats {
  photoCount: number;            // 拍照航点数
  totalPoints: number;           // 总航点数
  photoDistance: number;         // 拍照段总长度 (m)
  turnDistance: number;          // 转弯段总长度 (m)
  totalDistance: number;         // 总长度 (m)
  estimatedTime: number;         // 预估飞行时间 (s)
  areaSize: number;              // 测区面积 (m²)
  gsd: number;                   // 地面采样距离 (cm/px)
  lineSpacing: number;           // 航线间距 (m)
  pointSpacing: number;          // 航点间距 (m)
  photoCountEst: number;         // 预估照片数
}
```

---

## 四、航线规划算法设计

### 4.1 算法总流程

```
输入：测区多边形、飞行参数
输出：有序航点列表（Waypoint[]）

1. 参数计算
   1.1 计算 GSD = (pixelSize × altitude × 100) / focalLength         单位：cm/px
   1.2 像幅地面宽度  = (sensorWidth  × GSD) / 100                    单位：m
   1.3 像幅地面高度  = (sensorHeight × GSD) / 100                    单位：m
   1.4 航点间距 = 像幅地面高度 × (1 - forwardOverlap)                单位：m
   1.5 航线间距 = 像幅地面宽度  × (1 - sideOverlap)                  单位：m

2. 确定航线方向
   2.1 若用户指定角度，使用指定角度
   2.2 否则自动计算：取多边形最小外接矩形的最长边方向
       - 对多边形每条边计算方向角度
       - 取最长边方向或面积最小外接矩形方向

3. 生成平行航线
   3.1 将多边形按航线方向旋转，使航线与 x 轴平行
   3.2 计算旋转后多边形的 y 范围 [y_min, y_max]
   3.3 从 y_min + lineSpacing/2 开始，以 lineSpacing 为步长生成水平线
   3.4 对每条水平线与多边形的交点排序，得到覆盖区间
   3.5 将交点逆旋转回原始坐标系

4. 生成航点
   4.1 沿每条航线区间，从进入点开始，以 pointSpacing 为步长放置拍照点
   4.2 奇数行从左到右，偶数行从右到左（蛇形/之字形 pattern）
   4.3 相邻航线末端添加转弯点（可选，用于平滑转弯）

5. 添加起飞/降落点
   5.1 在首个航线起点附近添加起飞点（高度 = 飞行高度）
   5.2 在末条航线终点附近添加降落点（高度 = 0）
   5.3 起飞点 → 首个拍照点 之间添加过渡航点

6. 航点动作设置
   6.1 拍照航点：action = 'takePhoto', gimbalPitch = -90°
   6.2 转弯点：action = null, gimbalPitch = 0°（水平）
   6.3 起降点：speed = 2m/s（缓慢升降）
```

### 4.2 多边形旋转与裁剪算法

```
rotatePolygon(polygon, angle):
  // 将多边形绕其中心旋转 -angle，使航线方向对齐 x 轴
  for each vertex (x, y):
    x' = x·cos(-θ) - y·sin(-θ)
    y' = x·sin(-θ) + y·cos(-θ)
  return rotatedPolygon

getLinePolygonIntersections(y, polygon):
  // 计算水平线 y = const 与多边形的交点
  intersections = []
  for each edge (v1, v2) in polygon:
    if edge crosses y_line:
      t = (y - v1.y) / (v2.y - v1.y)
      x = v1.x + t × (v2.x - v1.x)
      intersections.push(x)
  intersections.sort()
  // 返回不相交的区间对 (进入点, 离开点)
  return pairs(intersections)  // [(x1, x2), (x3, x4), ...]
```

### 4.3 蛇形航线航点生成

```
generateWaypoints(polygonSegments, pointSpacing, lineSpacing, altitude):
  waypoints = []
  for i, segment in enumerate(polygonSegments):
    y = segment.y
    [x_enter, x_exit] = segment.xRange

    // 沿线段均匀放置拍照点
    if i % 2 == 0:  // 偶数行：左→右
      x = x_enter
      while x <= x_exit:
        waypoints.push(createPhotoPoint(x, y, altitude))
        x += pointSpacing
    else:            // 奇数行：右→左
      x = x_exit
      while x >= x_enter:
        waypoints.push(createPhotoPoint(x, y, altitude))
        x -= pointSpacing

    // 除最后一行外，添加行间转弯连接点
    if i < len(segments) - 1:
      waypoints.push(createTurnPoint(end_x, (y + next_y)/2, altitude))
  return waypoints
```

### 4.4 航点间距边距优化

为避免边界漏拍，在航线两端各扩展半个像幅：

```
扩展后的区间 = [x_enter + margin, x_exit - margin]
其中 margin = 像幅地面宽度 / 2
```

### 4.5 复杂度分析

- 旋转多边形：O(n)，n = 多边形顶点数
- 线段与多边形求交：O(n × m)，m = 航线数
- 航点生成：O(k)，k = 航点总数
- 总体：O(n × m + k)，通常 n < 20, m < 100, k < 500，计算时间 < 50ms

---

## 五、坐标转换

高德地图使用 GCJ-02 坐标系，DJI 无人机使用 WGS-84。KMZ 文件必须包含 WGS-84 坐标。

### 转换策略

```
用户交互（地图显示）: GCJ-02
内部航线计算: WGS-84（或统一使用 GCJ-02，导出时转换）
KMZ 导出: WGS-84 ← 核心转换
```

实现 GCJ-02 ↔ WGS-84 双向转换（使用公开的转换算法）。

---

## 六、KMZ 导出格式

### 6.1 文件结构

KMZ 是 ZIP 压缩包，内部包含一个 KML 文件：

```
mission.kmz
└── doc.kml
```

### 6.2 KML 文件模板（DJI Waypoint Mission 格式）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:wpml="http://www.dji.com/wpmz/1.0.3">
  <Document>
    <!-- 航线任务配置 -->
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:takeOffSecurityHeight>{起飞安全高度}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>{全局过渡速度}</wpml:globalTransitionalSpeed>
    </wpml:missionConfig>

    <!-- 航线 -->
    <Folder>
      <Placemark>
        <Point>
          <coordinates>{lng},{lat},{alt}</coordinates>
        </Point>
        <wpml:index>0</wpml:index>
        <wpml:executeHeight>{飞行高度}</wpml:executeHeight>
        <wpml:waypointSpeed>{航点速度}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>0</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadCourse</wpml:waypointHeadingPathMode>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
          <wpml:waypointTurnMode>coordinateTurn</wpml:waypointTurnMode>
        </wpml:waypointTurnParam>
        <!-- 航点动作 -->
        <wpml:actionGroup>
          <wpml:actionGroupId>0</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>0</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>{末航点序号}</wpml:actionGroupEndIndex>
          <wpml:actionGroupType>takePhoto</wpml:actionGroupType> <!-- 或其他的 -->
          <wpml:actionGroupTrigger>
            <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
          </wpml:actionGroupTrigger>
          <wpml:action>
            <wpml:actionId>0</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          </wpml:action>
        </wpml:actionGroup>
      </Placemark>
      <!-- 更多航点 Placemark... -->
    </Folder>
  </Document>
</kml>
```

### 6.3 导出流程

```
1. 收集所有航点数据（WGS-84 坐标）
2. 构建 KML XML 字符串
3. 使用 JSZip 创建 ZIP，添加 doc.kml
4. 生成 Blob 并触发浏览器下载
```

---

## 七、UI 设计

### 7.1 布局

```
┌─────────────────────────────────────────────┐
│  Logo    无人机航测路线规划    [导入] [导出] │  ← 顶栏 48px
├──────────┬──────────────────────────────────┤
│ 参数面板  │                                    │
│          │                                    │
│ 飞行高度  │       高德地图（卫星影像）            │
│ 重叠率…  │                                    │
│          │     - 测区多边形                    │
│ ──────── │     - 航线 + 航点                   │
│ 统计面板  │     - 起飞/降落点                   │
│          │                                    │
│ 航点:42  │                                    │
│ 总长:3km │                                    │
│ 时间:25m │                                    │
│          │                                    │
│ ──────── │                                    │
│ [生成航线]│                                    │
│ [模拟飞行]│                                    │
│ [导出KMZ]│                                    │
│          │                                    │
├──────────┴──────────────────────────────────┤
│  状态栏：已就绪  |  坐标: xxx,xxx  |  缩放: 18 │  ← 底栏 28px
└─────────────────────────────────────────────┘
    320px                          剩余宽度
```

### 7.2 交互流程

1. 打开页面 → 地图定位到用户大致位置（IP 定位或默认中国中心）
2. 点击"绘制测区"→ 在地图上依次点击添加顶点 → 双击完成
3. 调整参数 → 点击"生成航线"→ 显示航线及统计
4. 点击"模拟飞行"→ 无人机图标沿航线移动
5. 点击"导出 KMZ"→ 下载文件

### 7.3 颜色规范

| 元素 | 颜色 | 说明 |
|---|---|---|
| 测区边界 | `#FF6B35` 橙色 | 醒目、与卫星图区分 |
| 拍照航线 | `#00D2A0` 绿色 | 实线，代表巡航拍摄 |
| 转弯航线 | `#FFD700` 黄色 | 虚线，代表非拍摄转弯 |
| 拍照航点 | `#4A90D9` 蓝色 | 圆形标记 |
| 起飞/降落点 | `#FF4444` 红色 | 三角形标记 |
| 无人机图标 | 自定义 SVG | 带方向的无人机 |

---

## 八、性能与鲁棒性考虑

### 8.1 性能

- 航点数 > 500 时，使用高德地图的 `MassMarks`（海量点）渲染
- 航线生成使用增量计算，避免重复遍历
- KMZ 生成使用字符串拼接而非 DOM 操作

### 8.2 边界条件

| 场景 | 处理策略 |
|---|---|
| 多边形自相交 | 检测并拒绝，提示用户重新绘制 |
| 多边形顶点 < 3 | 禁止生成，提示至少 3 个顶点 |
| 航线间距 < 1m | 警告，建议调整参数 |
| 航点数 > 1000 | 警告，超出大多数 DJI 设备限制 |
| 测区面积过大 | 分段规划或提示降低高度 |
| 高度超出限飞区 | 警告提示 |

### 8.3 错误处理

- 高德 API 加载失败 → 显示重试按钮
- localStorage 满 → 清理旧数据
- KMZ 生成失败 → 回退到纯 KML 导出

---

## 九、浏览器兼容性

| 浏览器 | 最低版本 |
|---|---|
| Chrome | 90+ |
| Edge | 90+ |
| Firefox | 88+ |
| Safari | 14+ |

核心依赖：ES2020、Canvas、Blob、FileReader API。

---

## 十、实施计划

| 阶段 | 内容 | 预估工时 |
|---|---|---|
| Phase 1 | 基础框架搭建（HTML布局 + 地图加载 + 绘制多边形） | 2h |
| Phase 2 | 核心算法实现（GSD计算 + 航线生成 + 坐标转换） | 3h |
| Phase 3 | 可视化渲染（航线绘制 + 航点标记 + 统计面板） | 2h |
| Phase 4 | KMZ 导出（KML 模板 + JSZip 打包） | 2h |
| Phase 5 | 飞行模拟（动画 + 速度控制） | 2h |
| Phase 6 | 持久化与导入（localStorage + KML导入） | 1h |
| Phase 7 | 打磨（样式优化 + 边界处理 + 测试） | 2h |
| **合计** | | **~14h** |

---

## 十一、DJI 航点格式参考

### 11.1 支持的动作类型

| 动作 | wpml:actionActuatorFunc |
|---|---|
| 拍照 | `takePhoto` |
| 开始录像 | `startRecord` |
| 停止录像 | `stopRecord` |
| 悬停 | `hover` |
| 云台角度调整 | `gimbalRotate` |
| 变焦 | `zoom` |

### 11.2 DJI WPML 命名空间版本

不同 DJI 设备/软件支持的 WPML 版本有所不同：

| 设备/软件 | WPML 版本 |
|---|---|
| DJI Pilot 2 (Mavic 3/Matrice) | `wpmz/1.0.3` |
| DJI GS Pro (Phantom 4) | `wpmz/1.0.0` |
| DJI Fly (Mini 3/4, Air 3) | `wpmz/1.0.3` |

本项目默认使用 `wpmz/1.0.3`，同时提供 `wpmz/1.0.0` 兼容选项。

### 11.3 设备航点上限

| 设备系列 | 航点上限 |
|---|---|
| Mavic 3 Enterprise | 65535 |
| Matrice 350 | 65535 |
| Phantom 4 RTK | 99 |
| Mini 4 Pro | 65535 |
| Air 3 | 65535 |

---

## 十二、参考资源

- 高德地图 JS API 2.0：https://lbs.amap.com/api/javascript-api-v2/summary
- DJI Cloud API - Wayline：https://developer.dji.com/doc/cloud-api-tutorial/cn/
- JSZip：https://stuk.github.io/jszip/
- WGS-84 / GCJ-02 转换算法：https://github.com/wandergis/coordtransform
- OGC KML 标准：https://www.ogc.org/standard/kml/
