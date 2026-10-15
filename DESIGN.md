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
| 任务类型 | 拍照航测（蛇形覆盖 + 定点拍照）/ 摄像（同航线，仅起点·转向·终点设点，连续录像） | 拍照航测 |
| 拍照停留 (s) | 拍照点悬停后拍摄（`photoHoverSeconds`，0 ~ 500 秒，按秒写入 `wpml:hoverTime`） | 1 |
| 航线角度 (°) | 航线方向（0=正北，90=正东） | 自动/手动 |
| 起飞点 | 经纬度 | 手动设置或使用首顶点 |

### 2.3 航线自动生成

- 计算 GSD（地面采样距离）
- 根据重叠率和 GSD 计算航线间距、航点间距
- 生成覆盖多边形的蛇形航线
- 自动在航线首尾添加起飞/返航点

### 2.4 可视化

- 航点标记（起点绿色徽标带「起点」标签、拍照点按飞行顺序编号徽标、坐标、高度）
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
- 拍照点动作组为 `sequence`：`hover`（停留 1s，秒制）→ `takePhoto`
- **任务拆分**：航点数超过「任务拆分上限」（默认 300，0=关闭）时
  拆分为多个 KMZ（`_partNofM` 后缀）依次执行，适配机型航点上限
  （如 Phantom 4 RTK 99）；拍照点全保留、顺序不变

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
  id: number;                    // 序号（全序列，含转弯点）
  lat: number;                   // WGS-84 纬度
  lng: number;                   // WGS-84 经度
  alt: number;                   // 相对高度 (m)
  type: 'takeoff' | 'photo' | 'turn' | 'land';  // 航点类型
  action: 'takePhoto' | 'startRecord' | 'stopRecord' | 'hover' | null;
  gimbalPitch: number;           // 云台俯仰角 (-90~0)
  speed: number;                 // 该段飞行速度 (m/s)
  photoIndex: number | null;     // 拍照点序号（1 起，仅拍照点有值，转弯点/摄像航点为 null）
  hoverTime: number | null;      // 到点悬停时间（秒，仅拍照点；导出为 WPML hover 动作）
  rowIndex: number | null;       // 所属排号（摄像模式用于区分「同排录像段」与「跨排转向段」）
}
```

### 3.3.1 任务类型（`missionType`）

| 类型 | 航线排布 | 航点 | 动作 | 停留 |
|---|---|---|---|---|
| `photo` 拍照航测 | 蛇形覆盖（逐排按航点间距布拍照点） | 拍照点 + 换排转弯点 | 每点 `hover` → `takePhoto` | 每点 1s（0~500s 可调） |
| `video` 摄像 | **同一套蛇形排布**（排数 / 方向择优 / 逐排方向 DP 完全相同） | **仅每排的进入点与离开点**（起点、终点、转向处），无中间点 | 首点 `startRecord`、末点 `stopRecord`，中途无动作 | 不停留 |

摄像模式的覆盖自检：连续录制下沿排的覆盖是连续的，按像幅步长在排上
密集采样后复用同一套覆盖自检；航向重叠率不适用（不存在拍照间距），
旁向重叠率仍按排距校验。

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
  estimatedTime: number;         // 预估飞行时间 (s) = 航程 ÷ 平均速度 + photoCount × 拍照停留
  hoverTotalTime: number;        // 拍照停留总时长 (s)
  areaSize: number;              // 测区面积 (m²)
  gsd: number;                   // 地面采样距离 (cm/px)
  lineSpacing: number;           // 航线间距 (m)
  pointSpacing: number;          // 航点间距 (m)
  coverage: object;              // 覆盖率（遗漏）自检：holeRatio / maxGap / ok
  overlap: object;               // 重叠率自检：forward / side（min/avg/required/ok）
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
   2.2 否则自动择优，判据为**垂直跨度最小 ⇒ 航线趟数最少**：
       - 候选角度取每条边的「平行」「垂直」两个朝向
         （旋转角 θ 与航线方位的换算：航线方位 = 90° − θ，
          跨度沿方位 −θ 度量。只取边方向本身等价于只允许航线
          取边的镜像方向，轴对齐测区上两者重合，斜边多边形上
          会漏掉「沿斜边扫」这类更优解）
       - 对每个候选，把多边形绕 -角度 旋转后取 y 方向跨度
       - 跨度 ÷ 航线间距 + 1 即该方向的趟数，取趟数最小者
       - 趟数相同时，取「估算总里程」更小的方向——排内跨度之和
         加上逐排方向 DP 的连接成本，替代采样近似，消除浮点平局
   2.3 注意：判据**不是**「最长边」。两者在细长测区上结果相反——
       150×800 m 竖长测区下，最长边判据给 17 趟，趟数判据给 4 趟。
       以「趟数」为目标是因为它同时最小化转弯次数与空飞里程，
       且不依赖 GSD / 重叠率，是稳定的几何判据。
   2.4 采用的角度会回写到 `result.params.courseAngle`，
       并标记 `autoCourseAngle`，供界面与导出使用

3. 生成平行航线
   3.1 将多边形按航线方向旋转，使航线与 x 轴平行
   3.2 计算旋转后多边形的 y 范围 [y_min, y_max]，跨度 extent = y_max − y_min
   3.3 先定排数：lineCount = max(1, floor(extent / lineSpacing) + 1)
   3.4 再把余量在两端对称分配：margin = (extent − (lineCount−1) × lineSpacing) / 2
       第 k 排位于 y = y_min + margin + k × lineSpacing
       margin 下限 1e-6：整除时余量为 0，首排恰好压在边界上，
       扫描线求交会整排落空（水平边被跳过、端点接触不触发跨越判定）
       注意：margin 必须 < 像幅地面宽度 / 2，否则相邻排之间会出现覆盖断裂
       —— 算法对此有显式校验，超限即抛错而不是静默产生空洞
   3.5 对每条水平线与多边形的交点排序，得到覆盖区间
   3.6 将交点逆旋转回原始坐标系

4. 逐排方向优化与航点生成
   （任务类型见 2.2 / 3.3.1：photo 按下述方式布拍照点；video 用同一套
     排布，但每排只取「进入点 + 离开点」两个航点——排端即转向处，
     不布拍照点、不停留，首点开录、末点停录）
   4.1 每排两个可选方向（正向 / 反向），DP 在所有方向序列上最小化
       相邻排「出口 → 入口」的连接距离。严格蛇形（排排交替）只是
       解空间中的一个特解：凸测区上 DP 结果与交替一致，凹测区的
       分排结构随排变化时，局部打破交替可省下横穿测区的长过渡。
       排内访问顺序固定为沿排单调（对一维区间集最优），排内里程
       与方向无关，DP 只裁决方向序列
   4.2 沿每条航线区间放置拍照点，间距 = pointSpacing；残差
       （段长 − 整数倍间距）两端均分（相位对齐），边界覆盖对称
   4.3 换排处插入转弯点（见 6.3）

5. 添加起飞/降落点
   5.1 当前实现不生成独立的起降航点，任务由遥控器按
       `flyToWaylineMode=safely` + `finishAction=goHome` 自行处理起降
   5.2 首个航点即首个作业点（拍照任务为首个拍照点，摄像任务为起点）；
       序列中只有作业点与换排转弯点
   5.3 如需显式起降点，属待开发功能（见第八章「已知限制」）

6. 航点动作设置
   6.1 拍照航点：action = 'takePhoto'，gimbalPitch 取参数值（默认 -90°）；
       到点先悬停 photoHoverSeconds（默认 1s、范围 0~500s，字段 hoverTime）再拍摄，
       消除运动模糊；预估时间按 photoCount × 停留时间计入
   6.2 摄像航点：action = 首点 'startRecord' / 末点 'stopRecord'，中途 null；
       gimbalPitch 同拍照口径，全程不停留
   6.3 转弯点：action = null，gimbalPitch = 0°，不停留
   6.4 转弯点只在换排处插入，取「上一排最后一个拍照点 → 本排第一个
       拍照点」连线的中点（天然位于两排中线之间）。转弯路径长度
       恰等于两拍照点的直线距离；若中点落在测区外（凹多边形），
       沿连线向进入点方向采样拉回区内——拉回点仍在连线上，路径
       长度不变。拉回点与进入点重合（< 0.1m）时省略该转弯点
       （摄像模式不插入转弯点：排端航点本身即转向处）
   6.5 序列末点即最后一个作业点，不再额外追加区外的收尾航点

7. 质量自检（生成后、统计前）
   7.1 覆盖率（遗漏）：以像幅尺寸为网格采样测区，统计未被任何像幅
       覆盖的采样点，写入 stats.coverage（holeRatio / maxGap / ok）；
       摄像模式无离散拍照点，沿排按像幅步长密集采样后复用同一自检
   7.2 重叠率：按像幅复核航向（同跑相邻拍照点，1 − 间距/像幅高）与
       旁向（相邻排，1 − 排距/像幅宽）的实际重叠率是否 ≥ 要求值，
       写入 stats.overlap（forward / side / ok）——间距回归校验只能
       证明间距恒定，不能证明「间距与像幅的配比」仍然成立；
       摄像模式航向重叠不适用（连续录像），以 applicable=false 标注
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
generateWaypoints(rows, pointSpacing, altitude):
  // 1) 逐排方向 DP：dirs[i] ∈ {正向, 反向}，
  //    最小化 Σ dist(上排出口(dirs[i-1]), 本排入口(dirs[i]))
  dirs = planRowDirections(rows)

  // 2) 逐排生成拍照点（相位对齐：残差两端均分）
  waypoints = []
  for i, row in enumerate(rows):
    if i > 0:
      // 换排转弯点：两拍照点连线的中点，区外则沿连线拉回
      last  = 上一排最后一个拍照点
      first = 本排第一个拍照点
      turn  = pullInside(midpoint(last, first))
      if dist(turn, first) > 0.1:
        waypoints.push(createTurnPoint(turn, altitude))

    n   = floor(row.len / pointSpacing) + 1
    pad = (row.len - (n-1) * pointSpacing) / 2
    for k in 0..n-1:   // 方向由 dirs[i] 决定遍历起点与走向
      waypoints.push(createPhotoPoint(x_k, row.y, altitude))
  return waypoints
```

### 4.4 拍照点相位对齐

拍照点严格落在测区内（不外扩），段长往往不是航点间距的整数倍。
残差（段长 − 整数倍间距）在两端均分，而非全部压在末尾：

```
n   = floor(len / pointSpacing) + 1
pad = (len - (n-1) * pointSpacing) / 2
拍照点横坐标 = x_enter + pad + k * pointSpacing,  k = 0..n-1
```

与排布留白的对称分配同一哲学：边界覆盖对称，末点不会恰好
压在像幅边缘（畸变最大区）。

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

> **本节为格式说明，与实现存在两处差异，以 `js/kmzExport.js` 实现为准：**
> 1. **命名空间**：实现使用 `http://www.uav.com/wpmz/1.0.2`（与 README 一致），
>    非下方模板中的 `dji.com` 域名。
> 2. **`takeOffSecurityHeight` 未生成**：下方模板含该元素，但实现未写入。
>    它属于「最大起飞安全高度」约束，如需限制爬升高度需先确认业务口径再补。
>
> 另：`wpml:waypointGimbalPitchAngle` 在实现中**固定为 0**，俯仰实际由
> `gimbalRotate` action 承担。这两者对姿态的优先级尚未在真机验证，
> 修改此项前必须先过真机测试。
>
> 3. **拍照动作组为 `sequence` 模式**：拍照航点的动作组内按
>    `hover`（停留 1s，`wpml:hoverTime` **按秒解释**）→ `takePhoto` 顺序执行，
>    保证「先停稳、后快门」；`parallel` 组内悬停与拍照并发，停留无意义。
>    WP0 若为拍照点，顺序为 `gimbalRotate → hover → takePhoto`。

### 6.0 官方规范加硬项（`js/kmzExport.js`）

依据 [DJI WPML 共用元素文档](https://github.com/dji-sdk/Cloud-API-Doc/blob/master/docs/cn/60.api-reference/00.dji-wpml/40.common-element.md)：

| 项 | 要求 | 旧实现 |
|---|---|---|
| `wpml:takeOffSecurityHeight` | `missionConfig` 必需（起飞安全高度，m） | **缺失** → 现默认取作业高度 |
| `wpml:actionGroupId` | 单个 KMZ 内唯一，建议 0 起单调递增 | 每个航点复用 1、每段复用 2 → 现按输出顺序全局分配 |
| `gimbalEvenlyRotate` 触发器 | **必须** `betweenAdjacentPoints` | 用 `reachPoint` |
| `takePhoto`/`startRecord`/`stopRecord` | 必需元素 `wpml:fileSuffix` | 缺失 |
| `wpml:actionGroupMode` | 文档化为 `sequence` | 部分组用 `parallel` |
| `wpml:hoverTime` | 单位为**秒**（浮点，> 0） | 误按毫秒写入（0.5s → 500 → 设备读成 500 秒） |
| `wpml:droneEnumValue` | 合法值仅 89/60/67/77/91；消费级机型不在覆盖范围 | 固定写 68（**68 实为 Mavic 3M 相机的 payloadEnumValue**） |

回归校验对以上各项均有断言（B7/B8 组）。
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
     xmlns:wpml="http://www.uav.com/wpmz/1.0.2">
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

### 6.2.1 导出文件命名

| 命名风格 | 格式 | 说明 |
|---|---|---|
| `dji`（默认） | `<大写 UUID v4>.kmz` | 与 RC2 / DJI Fly 自身导出的航线文件**完全同构**（实测样例 `0B161508-C1D8-42E9-B06F-628AAF65C3B0.kmz`：36 字符 / 8-4-4-4-12 / 版本位 4 / 变体位 8-B；该 UUID 不出现在 KMZ 内容里，属 App 侧航线标识）。拆分导出时每份一个独立 UUID，界面会在导出提示里给出 part 对照 |
| `readable` | `mission_YYYY-MM-DD[_partNofM].kmz` | 便于人工区分第几份 |

### 6.3 导出流程

```
1. 收集所有航点数据（WGS-84 坐标）
2. 构建 KML XML 字符串（template.kml + waylines.wpml）
3. 使用 JSZip 创建 ZIP（wpmz/ 目录），生成 Blob 并触发浏览器下载
4. 任务拆分（可选）：航点数 > 任务拆分上限时，先按转弯点切块
   拆分为多个任务（贪心装箱、边界转弯点丢弃、拍照点全保留），
   再逐个导出 `mission_..._partNofM.kmz`，下载间隔 400ms
```

### 6.4 任务拆分算法（`RoutePlanner.splitMission`）

```
输入：完整航点序列、单任务航点上限 N（正整数）

1. 按转弯点切块：块 = 一排拍照点 + 其后的转弯点
2. 超限块（块长度 > N）在拍照点边界硬切，转弯点跟最后一段
   —— 仅发生在单排拍照点数 > N 时；照片仍按原顺序拍摄，覆盖不受影响
3. 贪心装箱：任务数最少（起降次数最少），单任务 ≤ N
4. 收尾处理：任务边界上的转弯点丢弃（它只服务跨任务的连续飞行，
   拆分后两个任务各自独立起降），故任务首尾均为拍照点

输出：{ missions: [{ waypoints, photoCount }], droppedTurns }
不变量：拍照点是覆盖与重叠率的载体 —— 数量与顺序完全不变，
        拆分只影响起降次数，不影响测绘成果
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

已实现（代码内可验证）：

| 场景 | 实际处理 |
|---|---|
| 多边形顶点 < 3 | **拒绝**：抛「测区至少需要 3 个顶点」 |
| 顶点坐标非有限数 | **拒绝**：逐个顶点校验 |
| 高度越界（< 1 或 > 1500 m） | **拒绝**：抛可读错误 |
| 重叠率取 1.0 或 > 0.95 | **拒绝**：该值使对应间距退化为 0，旧实现会死循环 |
| 派生间距过小（航线间距 < 0.5 m / 航点间距 < 0.2 m） | **拒绝**：直接指出应调整哪个参数 |
| 航线数 > 5000 | **拒绝**：防止极端参数下的循环失控 |
| 两端留白 > 像幅半宽 | **拒绝**：该情况会产生真实覆盖空洞 |
| 留白造成覆盖不足 | **放行 + 标记**：`stats.coverage.ok = false`，界面「测区覆盖自检」显示告警 |
| 重叠率不达标 | **放行 + 标记**：`stats.overlap.ok = false`，界面「重叠率自检」显示告警（防相机参数 / GSD→间距推导链路改动破坏配比） |
| 航点逸出测区 | **放行 + 标记**：生成后逐点复核，界面「区外航点数」显示数量 |
| 凹多边形转弯点落在区外 | **自动纠正**：沿「转弯点 → 下一拍照点」连线方向拉回区内；拉回点与进入点重合时省略该转弯点 |
| 航点数超过机型 / 渲染上限 | **拆分导出**：「任务拆分上限」（默认 300，0=关闭）在统计面板显示拆分方案；导出拆为多个 KMZ 依次执行，边界转弯点丢弃、拍照点全保留 |

未实现（属已知缺口，不要按本节旧描述预期）：

| 场景 | 状态 |
|---|---|
| 多边形自相交 | **未检测**，会得到不可预期的航线 |
| 测区面积过大的分段规划 | 未实现（当前仅按航点数拆分，不按电量 / 面积分段） |
| 限飞区高度警告 | 未实现（需外部空域数据） |

### 8.3 错误处理

- 高德 API 加载失败 → 底栏显示失败原因并 toast 提示（未提供重试按钮）
- localStorage 满 → 未处理
- KMZ 生成失败 → 未回退（JSZip 缺失时抛错）

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

本项目**实际导出** `wpmz/1.0.2`。上表列出的 1.0.3 / 1.0.0 属设备参考信息，
尚未实现按机型切换版本的能力（`app.js` 曾传入 `wpmlVersion` 参数但从未被读取，该死参数已移除）。
改造前需先在目标机型上验证版本兼容性。

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
