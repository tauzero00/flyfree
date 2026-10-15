# 无人机航测路线规划

面向 DJI 无人机用户的航测路线规划 Web 工具。在地图上划定测区，自动生成蛇形覆盖航线，支持飞行模拟预览，导出 KMZ 直接导入 DJI Pilot / GS Pro 遥控器执行自动飞行和拍摄任务。

纯前端实现，无需后端服务，浏览器即可运行。

## 功能

- **地图绘制测区** — 基于高德地图（卫星图），点击/拖拽绘制多边形测区
- **两种任务类型** — 「拍照航测」（蛇形覆盖 + 定点悬停拍照）与「摄像」（同一套蛇形航线，但**只在起点、终点、转向处设航点**，中途不停留，全程连续录像：首点 `startRecord`、末点 `stopRecord`）
- **自动航线生成** — 蛇形（之字形）覆盖航线，航点严格在测区内
- **航点编号** — 起点绿色徽标（带「起点」标签），拍照点按飞行顺序显示编号徽标（≤200 个时显示，稠密航线自动切海量点）
- **重叠率自检** — 按相机像幅复核实际航向/旁向重叠率是否达标（`stats.overlap`），配合测区覆盖自检（`stats.coverage`）发现遗漏
- **拍照点停留** — 到点悬停再拍摄（消除运动模糊），默认 **1 秒**、可调 **0~500 秒**（`photoHoverSeconds`，写入 KMZ 的 `wpml:hoverTime`；**DJI 端按秒解释**），停留计入预估时间
- **任务拆分导出** — 航点超过「任务拆分上限」（默认 300，0=关闭）自动拆分为多个 KMZ 文件（`_part1ofN` 后缀）依次导入执行：任务边界只落在换排处、边界转弯点丢弃、拍照点全保留且顺序不变；可适配机型航点上限（如 Phantom 4 RTK 建议 99）
- **多机型相机预设** — Mavic 3E、Phantom 4 RTK、Mini 4/5 Pro，支持自定义参数
- **航线统计** — GSD、航点数、总长度、预估时间、覆盖面积等
- **飞行模拟** — 沿航线动画预览，可调速（0.5x ~ 10x）
- **KMZ 导出** — DJI WPML 格式（`wpmz/template.kml` + `wpmz/waylines.wpml`），兼容 DJI Pilot 2 / GS Pro / DJI Fly
- **导出命名** — 可选「DJI 原生」（大写 UUID v4，与 RC2/DJI Fly 自己导出的文件名完全同构，如 `0B161508-C1D8-42E9-B06F-628AAF65C3B0.kmz`）或「可读」（`mission_日期[_partNofM].kmz`，便于区分拆分出的第几份）
- **KMZ 导入** — 支持导入已有航线进行查看和再编辑
- **历史记录** — 自动保存最近规划到本地浏览器

## 快速开始

1. 克隆仓库
   ```bash
   git clone <repo-url>
   ```

2. 配置高德地图 Key
   复制示例配置并填入自己的 Key（`js/config.js` 已被 .gitignore 排除，不会入库）：
   ```bash
   cp js/config.example.js js/config.js
   ```
   ```javascript
   window.AMAP_KEY = '你的高德Key';
   ```
   申请地址：[高德开放平台](https://lbs.amap.com/api/javascript-api-v2/summary)
   ⚠ 前端 Key 会随页面下发，务必在高德控制台配置「域名白名单」限制来源。

3. 用浏览器打开 `index.html`（或使用本地服务器）
   ```bash
   # Python
   python -m http.server 8080
   # Node.js
   npx serve .
   ```

## 项目结构

```
├── index.html              # 主页面
├── css/
│   └── style.css           # 样式
├── js/
│   ├── app.js              # 主控制器，协调各模块
│   ├── map.js              # 高德地图初始化、测区绘制、航线渲染
│   ├── routePlanner.js     # 核心航线规划算法
│   ├── kmzExport.js        # KMZ 生成（DJI WPML 格式）与导入
│   ├── flightSim.js        # 飞行模拟动画
│   ├── coordTransform.js   # WGS-84 ↔ GCJ-02 坐标转换
│   └── storage.js          # localStorage 持久化
└── lib/
    └── jszip.min.js        # JSZip 库（KMZ 打包）
```

## 航线算法

```
输入：测区多边形、飞行参数
输出：有序航点列表

1. 参数守卫
   高度/速度/重叠率/相机参数逐项校验；航线间距、航点间距等派生量
   必须严格为正（它们直接作为循环步长，为 0 会导致死循环）

2. GSD 计算
   GSD (cm/px) = (pixelSize × altitude) / (focalLength × 10)
   像幅地面宽度 = (sensorWidth × GSD) / 100   (m)
   像幅地面高度 = (sensorHeight × GSD) / 100  (m)

3. 航点/航线间距
   航点间距 = 像幅地面高度 × (1 - 航向重叠率)
   航线间距 = 像幅地面宽度 × (1 - 旁向重叠率)

4. 确定航线方向（自动按「趟数最少」择优，或手动指定角度）
   自动模式的判据是**垂直跨度最小 ⇒ 趟数最少**，不是「最长边」。
   两者在细长测区上结果相反：150×800 m 的竖长测区
     · 最长边判据 → 横向排布，17 趟、16 个转弯点
     · 趟数判据   → 纵向排布，4 趟、3 个转弯点
   候选方向取每条边的「平行」「垂直」两个朝向——只取边方向本身
   等价于只允许航线取边的镜像方向，斜边多边形（如三角形沿斜边扫，
   跨度从直角边 400m 降到斜边高 333m）会漏掉更优解。
   趟数相同时用「估算总里程最小」再判（排内跨度 + 逐排方向 DP 的
   连接成本），避免等长边多边形下由浮点比较决定方向。

5. 排布平行航线
   先按测区跨度与航线间距定出排数，再把余量在两端**对称分配**，
   不把整段余量压在末尾

6. 逐排方向优化（DP）与航点生成
   每排可正向或反向飞行，DP 在所有方向序列上最小化换排连接里程；
   严格蛇形（排排交替）只是解空间中的一个特解，凸测区上两者一致，
   凹测区分排结构变化时局部打破交替更省里程。拍照点在排内做
   **相位对齐**：把「段长 − 整数倍间距」的残差平分到两端。

7. 覆盖率与重叠率自检
   覆盖率：以像幅尺寸为网格采样测区，统计未被任何像幅覆盖的采样点，
   结果写入 stats.coverage（holeRatio / maxGap / ok）
   重叠率：按像幅复核航向（同跑相邻拍照点）/ 旁向（相邻排）的实际
   重叠率是否 ≥ 要求值，结果写入 stats.overlap（forward / side / ok）

航点全部在测区内（不扩展边界），且只在换排处插入转弯点。
转弯点取「上排末拍照点 → 下排首拍照点」连线的中点，转弯路径长度
恰等于两拍照点的直线距离；凹测区中点落在区外时，沿连线向进入点
方向拉回区内（拉回点仍在连线上，路径长度不变）。
拍照点到点悬停后再拍摄（参数 photoHoverSeconds，默认 1 秒、可调 0~500 秒，字段 hoverTime 即为秒）。
```

详细设计见 [DESIGN.md](DESIGN.md)。

## 算法回归校验

```bash
node tools/verify-route-algorithm.js
```

覆盖四类断言（退出码 0 = 全通过 / 1 = 有失败）：

| 类别 | 内容 |
|---|---|
| A 回归基线 | 退化参数必须被拒绝而非死循环；航点全在测区内；相邻拍照点间距等于参数值（换排/分段跳转的过渡段须 ≥ 1.5 倍间距）；转弯点夹在两拍照段之间且不绕远；统计口径自洽；云台角语义；id 连续无重合；拍照点编号 1..N 连续 |
| B 覆盖率 | 算法内置自检通过；像幅并集覆盖能力 ≥ 测区面积；测区面积与独立 shoelace 一致；像幅尺寸与 GSD 推导一致；重叠率达标（内置自检 + 独立复算一致）；拍照停留 1s 且预估时间含停留（秒制）；KMZ 悬停→拍照动作结构正确 |
| C 参数边界 | 合法范围内的上下限参数、手动航线角不得被误拒 |
| E 效率基线 | 转弯路径 ≤ 两侧拍照点直线距离 × 1.05；矩形场景转弯里程 ≤ 趟数 × hypot(航点间距, 航线间距)；单分段场景总长 ≤ 扫描线总长 + 残差/转弯余量预算 |
| F 任务拆分 | 每任务 ≤ 上限；拼接为原序列的有序子序列（仅缺边界转弯点）；拍照点全保留有序；任务首尾均为拍照点；转弯点守恒；每任务可独立导出（Placemark 数一致且含悬停/拍照动作）；非法上限被拒绝 |
| V 摄像任务 | 全部为摄像航点（无拍照点/转弯点）、数量远少于拍照任务；仅首点 `startRecord`、仅末点 `stopRecord` 且全程无悬停无拍照；同排航段两端点均落在测区边界上（证明排内无中间点）；覆盖自检通过；旁向重叠率达标且航向标为不适用（连续录像）；预估时间 = 航程 ÷ 速度；KMZ 无 `takePhoto`/`hover`；可拆分且航点无损；非法任务类型被拒绝 |
| D 性能基线 | 1000×1000 m 高密度测区生成耗时 < 500 ms |

设计取舍：只断言**坐标系无关的契约不变量**。算法内部使用「球面距离构造 + 绕中心旋转」的
局部平面坐标系，外部复刻需要重现其全部取舍（尤其自动航线角在等长边多边形下由浮点误差决定），
试图复刻会把校验器的缺陷误判成产品缺陷。

## 项目结构

```
├── index.html              # 主页面
├── css/
│   └── style.css           # 样式
├── js/
│   ├── config.js           # 配置（高德 Key）
│   ├── app.js              # 主控制器，协调各模块
│   ├── map.js              # 高德地图初始化、测区绘制、航线渲染
│   ├── routePlanner.js     # 核心航线规划算法
│   ├── kmzExport.js        # KMZ 生成（DJI WPML 格式）与导入
│   ├── flightSim.js        # 飞行模拟动画
│   ├── coordTransform.js   # WGS-84 ↔ GCJ-02 坐标转换
│   └── storage.js          # localStorage 持久化
├── tools/
│   └── verify-route-algorithm.js  # 算法回归校验（Node 运行）
└── lib/
    └── jszip.min.js        # JSZip 库（KMZ 打包）
```

## 相机预设

| 预设 | 传感器 | 焦距 (mm) | 像元 (μm) |
|------|--------|-----------|-----------|
| Mavic 3E 广角 | 5280×3956 | 12.29 | 3.3 |
| Mavic 3E 长焦 | 4000×3000 | 29.6 | 1.6 |
| Phantom 4 RTK | 5472×3648 | 8.8 | 2.41 |
| Mini 4 Pro | 4032×3024 | 6.72 | 1.6 |
| Mini 5 Pro | 8192×6144 | 8.8 | 1.6 |

## KMZ 导出格式

导出的 KMZ 文件结构：

```
mission.kmz
└── wpmz/
    ├── template.kml       # 任务元信息
    └── waylines.wpml      # 航点序列（WPML 格式）
```

命名空间：`http://www.uav.com/wpmz/1.0.2`

航点动作：
- 拍照航点：`hover`（停留 1s，**wpml:hoverTime 按秒**）→ `takePhoto`，动作组为 `sequence` 模式（先停稳、后快门），
  云台俯仰取参数值（默认 `-90°`）
- 摄像任务：首点 `startRecord`、末点 `stopRecord`，中途无动作、不停留（连续录像）；
  航点转向模式统一用「曲线飞行、到点停」(`toPointAndStopWithContinuityCurvature`)——摄像航段是
  整排一条（数百米）、排间仅十几米，用「过点不停」会让 App 规划出连续平滑曲线并在每排末端的
  180° 折返处外扩成大圈（遥控器上显示为一串环路、里程虚增）
- 转弯航点：`gimbalEvenlyRotate`（触发器 `betweenAdjacentPoints`），维持云台角度
- 最后一段：云台归 `0°`，无拍照动作

按官方 WPML 规范的加硬要求（详见 [DJI 共用元素文档](https://github.com/dji-sdk/Cloud-API-Doc/blob/master/docs/cn/60.api-reference/00.dji-wpml/40.common-element.md)）：

- `missionConfig` 写入 `wpml:takeOffSecurityHeight`（起飞安全高度，默认取作业高度，可用 `takeOffSecurityHeight` 覆盖）
- `wpml:actionGroupId` 在单个 KMZ 内**全局唯一且从 0 单调递增**（旧实现每个航点都复用 1、每段复用 2）
- `gimbalEvenlyRotate` 的 `wpml:actionTriggerType` 必须是 `betweenAdjacentPoints`
- `takePhoto` / `startRecord` / `stopRecord` 带必需元素 `wpml:fileSuffix`
- `wpml:actionGroupMode` 统一为规范文档化的 `sequence`
- 机型枚举 `wpml:droneEnumValue` 可用 `droneEnumValue` / `droneSubEnumValue` 指定；
  官方合法值仅 89/60/67/77/91（**68 并非飞行器枚举**，它是 Mavic 3M 相机的 payload 值），
  消费级机型（Mini/Air）不在该规范覆盖面内

### 任务拆分（多文件导出）

航点数超过「任务拆分上限」（默认 300）时，导出会拆分为多个文件：

```
mission_2026-10-14_part1of3.kmz
mission_2026-10-14_part2of3.kmz
mission_2026-10-14_part3of3.kmz
```

- 任务边界只落在换排处（每个任务含完整拍照排），单任务 ≤ 上限
- 边界转弯点丢弃（它只服务任务间的连续飞行，拆分后各自独立起降）
- **拍照点全部保留且顺序不变**，覆盖与重叠率不受影响
- 依次导入遥控器执行；浏览器首次多文件下载需允许一次

## 技术栈

| 层 | 技术 |
|----|------|
| 框架 | 纯 HTML/CSS/JavaScript（零依赖框架） |
| 地图 | 高德地图 JS API 2.0 |
| 打包 | JSZip |
| 存储 | localStorage |
| 坐标系 | WGS-84 ↔ GCJ-02 双向转换 |

## 浏览器兼容

Chrome 90+ / Edge 90+ / Firefox 88+ / Safari 14+

## License

MIT
