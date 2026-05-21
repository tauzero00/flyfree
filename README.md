# 无人机航测路线规划

面向 DJI 无人机用户的航测路线规划 Web 工具。在地图上划定测区，自动生成蛇形覆盖航线，支持飞行模拟预览，导出 KMZ 直接导入 DJI Pilot / GS Pro 遥控器执行自动飞行和拍摄任务。

纯前端实现，无需后端服务，浏览器即可运行。

## 功能

- **地图绘制测区** — 基于高德地图（卫星图），点击/拖拽绘制多边形测区
- **自动航线生成** — 蛇形（之字形）覆盖航线，航点严格在测区内
- **多机型相机预设** — Mavic 3E、Phantom 4 RTK、Mini 4/5 Pro，支持自定义参数
- **航线统计** — GSD、航点数、总长度、预估时间、覆盖面积等
- **飞行模拟** — 沿航线动画预览，可调速（0.5x ~ 10x）
- **KMZ 导出** — DJI WPML 格式（`wpmz/template.kml` + `wpmz/waylines.wpml`），兼容 DJI Pilot 2 / GS Pro
- **KMZ 导入** — 支持导入已有航线进行查看和再编辑
- **历史记录** — 自动保存最近规划到本地浏览器

## 快速开始

1. 克隆仓库
   ```bash
   git clone <repo-url>
   ```

2. 替换高德地图 Key
   在 `js/app.js` 中将 `AMAP_KEY` 替换为你的高德地图 JS API Key：
   ```javascript
   const AMAP_KEY = '你的高德Key';
   ```
   申请地址：[高德开放平台](https://lbs.amap.com/api/javascript-api-v2/summary)

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

1. GSD 计算
   GSD (cm/px) = (pixelSize × altitude) / (focalLength × 10)
   像幅地面宽度 = (sensorWidth × GSD) / 100   (m)
   像幅地面高度 = (sensorHeight × GSD) / 100  (m)

2. 航点/航线间距
   航点间距 = 像幅地面高度 × (1 - 航向重叠率)
   航线间距 = 像幅地面宽度 × (1 - 旁向重叠率)

3. 确定航线方向（自动取多边形最长边方向，或手动指定）

4. 旋转多边形 → 水平扫描线求交 → 生成蛇形航线

5. 航点严格在测区内（不扩展边界）
```

详细设计见 [DESIGN.md](DESIGN.md)。

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
- 拍照航点：`takePhoto`，云台俯仰 `-90°`
- 转弯航点：`gimbalEvenlyRotate`，维持云台角度
- 终止航点：云台归 `0°`，无拍照动作

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
