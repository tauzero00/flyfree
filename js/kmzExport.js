/**
 * KMZ 导出模块
 * 将航线规划结果导出为 DJI WPML 格式的 KMZ 文件
 * KMZ 结构: wpmz/template.kml + wpmz/waylines.wpml
 */

const KmzExport = (() => {
  const WPML_NS = 'http://www.uav.com/wpmz/1.0.2';

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * 生成 UUID v4（大写）。
   * 实测 RC2 / DJI Fly 导出的航线 KMZ 文件名就是「大写 UUID v4 + .kmz」，
   * 例如 0B161508-C1D8-42E9-B06F-628AAF65C3B0.kmz：
   *   · 36 字符、8-4-4-4-12 五段
   *   · 第 3 段首位固定为 4（v4 = 随机生成），第 4 段首位属 8/9/A/B（RFC 4122 变体）
   *   · 该 UUID 不出现在 KMZ 内容里，是 App 侧的航线标识
   */
  function uuidV4() {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const h = [];
    for (let i = 0; i < 16; i++) h.push(bytes[i].toString(16).padStart(2, '0'));
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`.toUpperCase();
  }

  /**
   * 生成导出文件名。
   * @param style 'dji' = DJI 原生（大写 UUID v4，与 RC2/DJI Fly 导出一致）；
   *              其它 = 可读命名 mission_YYYY-MM-DD[_partNofM].kmz
   * @param partIndex 第几份（1 起）；partTotal 总份数
   */
  function generateMissionFileName(style, partIndex, partTotal, baseFilename) {
    if (style === 'dji') return `${uuidV4()}.kmz`;
    const base = baseFilename || `mission_${new Date().toISOString().slice(0, 10)}`;
    return (partTotal && partTotal > 1)
      ? `${base}_part${partIndex}of${partTotal}.kmz`
      : `${base}.kmz`;
  }

  /**
   * 起飞安全高度（m）：企业版规范把 wpml:takeOffSecurityHeight 列为必需元素，
   * 但实测 RC2/DJI Fly 导出的 Mini 5 Pro 航线**不含**该字段 → 默认不写，
   * 与 App 输出保持一致；需要时用 params.takeOffSecurityHeight 显式开启
   * （走 DJI Pilot 2 / 司空等企业端时建议开启）。
   */
  function takeOffSecurityHeightOf(params) {
    if (!params || params.takeOffSecurityHeight == null) return null;
    const v = Number(params.takeOffSecurityHeight);
    if (!Number.isFinite(v) || v <= 0) return null;
    return String(Math.round(Math.min(v, 1500) * 10) / 10);
  }

  /**
   * 飞行器机型枚举（wpml:droneEnumValue）。
   * 官方合法值仅：89=M350 RTK / 60=M300 RTK / 67=M30·M30T / 77=M3E·M3T·M3M / 91=M3D·M3TD；
   * 消费级机型（Mini/Air 系列）不在该规范覆盖范围内。
   * 注意：旧实现固定写 68 —— 68 并非飞行器枚举（它是「Mavic 3M 相机」的 payloadEnumValue）。
   * 未显式指定时保持历史值 68 不变，待拿到目标机型的官方取值再改默认。
   */
  function droneEnumValueOf(params) {
    const v = params && Number(params.droneEnumValue);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 68;
  }

  function droneSubEnumValueOf(params) {
    const v = params && Number(params.droneSubEnumValue);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  }

  /**
   * 计算两点间的方位角 (bearing)，正北为0，顺时针为正，返回 [0, 360)
   */
  function computeBearing(lng1, lat1, lng2, lat2) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const dLng = toRad(lng2 - lng1);
    const lat1r = toRad(lat1);
    const lat2r = toRad(lat2);
    const y = Math.sin(dLng) * Math.cos(lat2r);
    const x = Math.cos(lat1r) * Math.sin(lat2r) -
              Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLng);
    return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360;
  }

  /**
   * 把 [0,360) 的方位角规范到 WPML 要求的 [-180, 180]。
   *
   * 这条是硬性取值范围：wpml:waypointHeadingAngle 只接受 [-180, 180]。
   * 旧实现直接写入 computeBearing 的 0~360 结果——只要**首段朝西/朝南**
   * （方位角 > 180）就会写出 269.0 这类越界值，DJI Fly 判定航线不可执行
   * （实测：89.0 的 part1 能飞，269.0 的 part2 与 269.4 的摄像任务均报
   * 「执行异常 / 无法执行任务」）。
   */
  function normalizeHeading(deg) {
    let d = ((Number(deg) % 360) + 360) % 360; // → [0, 360)
    if (d > 180) d -= 360;                     // → (-180, 180]
    return d;
  }

  /**
   * 生成 template.kml
   */
  function buildTemplateKml(params) {
    const now = Date.now();
    const speed = (params.speed || 8).toFixed(1);
    const secHeight = takeOffSecurityHeightOf(params);
    const secHeightLine = secHeight
      ? `\n      <wpml:takeOffSecurityHeight>${secHeight}</wpml:takeOffSecurityHeight>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NS}">
  <Document>
    <wpml:author>航测规划工具</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>${secHeightLine}
      <wpml:globalTransitionalSpeed>${speed}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${droneEnumValueOf(params)}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${droneSubEnumValueOf(params)}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>
  </Document>
</kml>`;
  }

  // ---- action group XML builders ----
  //
  // 规范要点（DJI Cloud API WPML 共用元素）：
  //  · wpml:actionGroupId —— 在一个 kmz 文件内必须唯一，建议从 0 单调递增
  //  · wpml:actionGroupMode —— 规范仅文档化 sequence（串行执行）
  //  · wpml:actionTriggerType —— gimbalEvenlyRotate 必须用 betweenAdjacentPoints
  function buildActionGroupOpen(groupId, startIdx, endIdx, triggerType, mode) {
    return `        <wpml:actionGroup>
          <wpml:actionGroupId>${groupId}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${startIdx}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${endIdx}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>${mode || 'sequence'}</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>${triggerType || 'reachPoint'}</wpml:actionTriggerType>
          </wpml:actionTrigger>`;
  }

  function buildActionGroupClose() {
    return `        </wpml:actionGroup>`;
  }

  /**
   * 悬停动作：到点先悬停 hoverSeconds 秒再执行后续动作（拍照），
   * 消除运动模糊。仅在 sequence 模式的动作组里才能保证「先停后拍」。
   *
   * 单位是**秒**：DJI 端 wpml:hoverTime 按秒解释，可调范围 0 ~ 500 秒。
   * 旧实现误按毫秒写入（0.5s → 500），设备上读成每个拍照点悬停 500 秒，
   * 表现为「卡在第一个航点、后续航点无法执行」。
   */
  function buildHoverAction(actionId, hoverSeconds) {
    return `          <wpml:action>
            <wpml:actionId>${actionId}</wpml:actionId>
            <wpml:actionActuatorFunc>hover</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:hoverTime>${hoverSeconds}</wpml:hoverTime>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
  }

  /** takePhoto / startRecord / stopRecord 的参数（fileSuffix 按规范为必需元素，留空不改命名） */
  function buildPayloadFuncParam() {
    return `              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:fileSuffix></wpml:fileSuffix>
              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>`;
  }

  function buildTakePhotoAction(actionId) {
    return `          <wpml:action>
            <wpml:actionId>${actionId}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
${buildPayloadFuncParam()}
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
  }

  /**
   * 录像动作：摄像任务的首点 startRecord、末点 stopRecord，
   * 中途不停机（连续录像），故不需要 hover。
   */
  function buildRecordAction(actionId, actionName) {
    return `          <wpml:action>
            <wpml:actionId>${actionId}</wpml:actionId>
            <wpml:actionActuatorFunc>${actionName}</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
${buildPayloadFuncParam()}
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
  }

  function buildGimbalRotateAction(actionId, pitchAngle) {
    return `          <wpml:action>
            <wpml:actionId>${actionId}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>${pitchAngle}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>1</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
  }

  function buildGimbalEvenlyRotateAction(actionId, startIdx, endIdx, pitchAngle) {
    return `          <wpml:action>
            <wpml:actionId>${actionId}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalEvenlyRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalPitchRotateAngle>${pitchAngle}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
  }

  /**
   * 生成 waylines.wpml
   */
  function buildWaylinesWpml(waypoints, params) {
    const speed = params.speed || 8;
    const altitude = params.altitude || 100;
    const gimbalPitch = params.gimbalPitch != null ? params.gimbalPitch : -90;

    // 筛选需要导出的航点：排除 takeoff/land 类型
    const missionWps = waypoints.filter(w => w.type !== 'takeoff' && w.type !== 'land');
    if (missionWps.length === 0) return '';

    const totalWps = missionWps.length;

    // 计算首航点朝向（从 WP0 到 WP1 的方位角）
    let firstHeading = 0;
    if (totalWps >= 2) {
      firstHeading = computeBearing(
        missionWps[0].lng, missionWps[0].lat,
        missionWps[1].lng, missionWps[1].lat
      );
    }

    let actionId = 1;
    // 动作组 ID 必须在整个 kmz 文件内唯一；具体编号在输出阶段按
    // 「Placemark 文档顺序」统一分配，以满足规范「从 0 单调递增」的建议。
    // 旧实现每个航点都用 groupId=1、每段都用 groupId=2，同文件内大量重复。
    const groupsByWp = {};
    function addGroup(wpIdx, startIdx, endIdx, triggerType, mode) {
      if (!groupsByWp[wpIdx]) groupsByWp[wpIdx] = [];
      groupsByWp[wpIdx].push({
        groupId: null, startIdx, endIdx,
        triggerType: triggerType || 'reachPoint', mode: mode || 'sequence', actions: []
      });
    }
    function addActionToLastGroup(wpIdx, xml) {
      const groups = groupsByWp[wpIdx];
      groups[groups.length - 1].actions.push(xml);
    }

    // 拍照点悬停时长（**秒**，航点字段 hoverTime 即为秒）：
    // 取整为设备支持的整数秒，且正值不小于 1（避免四舍五入成 0 而静默取消停留）；
    // 导入的旧航线若把秒误存成毫秒（≥1000），按毫秒回退容错换算一次。
    const hoverSecondsOf = (wp) => {
      if (!wp || !(wp.hoverTime > 0)) return 0;
      let sec = wp.hoverTime;
      if (sec >= 1000) sec = sec / 1000; // 容错：历史文件中的毫秒值
      sec = Math.round(sec);
      return Math.max(1, Math.min(500, sec));
    };
    // 录像动作：摄像任务的首点 startRecord、末点 stopRecord
    const isRecordAction = (wp) => !!wp && (wp.action === 'startRecord' || wp.action === 'stopRecord');

    // WP 0: 云台转到作业俯仰角；若为拍照点则「转云台 → 悬停 → 拍照」，
    // 若为摄像起点则「转云台 → 开始录像」，均按 sequence 顺序执行
    // （sequence 模式保证悬停完成后才触发快门）
    const wp0 = missionWps[0];
    const wp0IsPhoto = wp0.type === 'photo';
    const wp0Records = isRecordAction(wp0);
    const wp0Hover = hoverSecondsOf(wp0);
    addGroup(0, 0, 0);
    addActionToLastGroup(0, buildGimbalRotateAction(actionId++, gimbalPitch.toFixed(1)));
    if (wp0IsPhoto) {
      if (wp0Hover > 0) addActionToLastGroup(0, buildHoverAction(actionId++, wp0Hover));
      addActionToLastGroup(0, buildTakePhotoAction(actionId++));
    } else if (wp0Records) {
      addActionToLastGroup(0, buildRecordAction(actionId++, wp0.action));
    }

    // Process remaining waypoints and segments, interleaved (matching reference pattern)
    for (let i = 0; i < totalWps - 1; i++) {
      const wpNext = missionWps[i + 1];
      // 拍照点 WP i+1：「悬停 → 拍照」顺序执行
      if (wpNext.type === 'photo') {
        const hSec = hoverSecondsOf(wpNext);
        addGroup(i + 1, i + 1, i + 1);
        if (hSec > 0) addActionToLastGroup(i + 1, buildHoverAction(actionId++, hSec));
        addActionToLastGroup(i + 1, buildTakePhotoAction(actionId++));
      } else if (isRecordAction(wpNext)) {
        // 摄像：末点停止录像（首点的 startRecord 已在 WP0 处理）
        addGroup(i + 1, i + 1, i + 1);
        addActionToLastGroup(i + 1, buildRecordAction(actionId++, wpNext.action));
      }

      // gimbalEvenlyRotate 段动作组：企业版文档要求触发器 betweenAdjacentPoints，
      // 但实测 RC2/DJI Fly 自身导出用 reachPoint + parallel → 以 App 实际输出为准
      const isLastSegment = (i === totalWps - 2);
      const segmentPitch = isLastSegment ? 0 : gimbalPitch;
      addGroup(i, i, i + 1, 'reachPoint', 'parallel');
      addActionToLastGroup(i, buildGimbalEvenlyRotateAction(actionId++, i, i + 1, segmentPitch.toFixed(1)));
    }

    // 构建 Placemark 列表
    let groupIdSeq = 0;
    let placemarks = '';

    // 摄像任务的转向模式：见循环内说明，统一用「曲线飞行、到点停」
    const isVideoMission = missionWps.some(w =>
      w.type === 'video' || w.action === 'startRecord' || w.action === 'stopRecord');
    for (let i = 0; i < totalWps; i++) {
      const wp = missionWps[i];
      const isFirst = (i === 0);
      const isLast = (i === totalWps - 1);

      // 航点转向模式。
      //
      // 拍照任务：中间航点用「曲线飞行、过点不停」。它们的间距只有十几米且共线，
      // 平滑曲线穿过共线点仍是一条直线，所以画出来是笔直的航线（实测可正常执行）。
      //
      // 摄像任务：航段是整排一条（数百米），排间只有十几米 —— 这种「长腿 + 急折返」
      // 几何下，若用「过点不停」，App 会规划一条连续平滑曲线，并在每排末端的
      // 180° 折返处外扩成大圈（实测遥控器截面上就是一串环路，里程估算也从约
      // 6.0km 涨到 6.79km）。因此摄像任务对所有航点用「曲线飞行、到点停」：
      // 到点停会打断平滑曲线，排与排之间保持直线 —— 与 RC2 官方样例的取值一致。
      const turnMode = (isVideoMission || isFirst || isLast)
        ? 'toPointAndStopWithContinuityCurvature'
        : 'toPointAndPassWithContinuityCurvature';

      const headingMode = isFirst ? 'smoothTransition' : 'followWayline';
      // 偏航角必须落在 WPML 规定的 [-180, 180]（见 normalizeHeading 说明）
      const headingAngle = isFirst ? normalizeHeading(firstHeading).toFixed(1) : '0';
      const headingAngleEnable = (isFirst || isLast) ? '1' : '0';

      // Build action groups for this waypoint（按输出顺序分配全局唯一 ID）
      let actionGroupsXml = '';
      const groups = groupsByWp[i];
      if (groups) {
        for (const g of groups) {
          actionGroupsXml += '\n' + buildActionGroupOpen(groupIdSeq++, g.startIdx, g.endIdx, g.triggerType, g.mode) + '\n';
          for (const a of g.actions) {
            actionGroupsXml += a + '\n';
          }
          actionGroupsXml += buildActionGroupClose();
        }
      }

      placemarks += `      <Placemark>
        <Point>
          <coordinates>${wp.lng.toFixed(10)},${wp.lat.toFixed(10)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${wp.alt.toFixed(1)}</wpml:executeHeight>
        <wpml:waypointSpeed>${(wp.speed || speed).toFixed(1)}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>${headingMode}</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>${headingAngle}</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>${headingAngleEnable}</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>${turnMode}</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>0</wpml:useStraightLine>${actionGroupsXml}
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
      </Placemark>
`;
    }

    const speedStr = speed.toFixed(1);
    const secHeight = takeOffSecurityHeightOf(params);
    const secHeightLine = secHeight
      ? `\n      <wpml:takeOffSecurityHeight>${secHeight}</wpml:takeOffSecurityHeight>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NS}">
  <Document>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>${secHeightLine}
      <wpml:globalTransitionalSpeed>${speedStr}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${droneEnumValueOf(params)}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${droneSubEnumValueOf(params)}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>0</wpml:distance>
      <wpml:duration>0</wpml:duration>
      <wpml:autoFlightSpeed>${speedStr}</wpml:autoFlightSpeed>
${placemarks}    </Folder>
  </Document>
</kml>`;
  }

  /**
   * 导出 KMZ（wpmz 文件夹结构）
   */
  async function exportKmz(waypoints, params, filename) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip 库未加载，请刷新页面重试。');
    }

    const templateKml = buildTemplateKml(params);
    const waylinesWpml = buildWaylinesWpml(waypoints, params);

    const zip = new JSZip();
    const wpmz = zip.folder('wpmz');
    wpmz.file('template.kml', templateKml, { compression: 'DEFLATE' });
    wpmz.file('waylines.wpml', waylinesWpml, { compression: 'DEFLATE' });

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    const name = filename || `mission_${new Date().toISOString().slice(0, 10)}.kmz`;
    downloadBlob(blob, name);
  }

  /**
   * 多任务导出：把拆分后的任务逐个导出为独立 KMZ 文件，依次导入遥控器执行。
   * @param options { style: 'dji' | 'readable', baseFilename }
   *        dji      → 每个文件一个大写 UUID v4 名（与 RC2/DJI Fly 原生导出一致）
   *        readable → base_partNofM.kmz
   * 连续下载间隔 400ms，规避浏览器对多文件下载的拦截
   * （Chrome 首次会弹「允许下载多个文件」，需用户确认一次）。
   * @returns {Promise<{count:number, names:string[]}>} 文件名清单（UUID 命名时用于对照第几份）
   */
  async function exportKmzMultiple(missions, params, options) {
    if (!Array.isArray(missions) || missions.length === 0) {
      throw new Error('没有可导出的任务。');
    }
    const opts = options || {};
    const style = opts.style === 'dji' ? 'dji' : 'readable';
    const base = opts.baseFilename || `mission_${new Date().toISOString().slice(0, 10)}`;
    const names = [];
    for (let i = 0; i < missions.length; i++) {
      const name = generateMissionFileName(style, i + 1, missions.length, base);
      names.push(name);
      await exportKmz(missions[i].waypoints, params, name);
      if (i < missions.length - 1) await new Promise(r => setTimeout(r, 400));
    }
    return { count: missions.length, names };
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- KMZ 导入 ----

  async function importKmz(file) {
    const name = file.name.toLowerCase();

    let templateText = '';
    let waylinesText = '';

    if (name.endsWith('.kmz')) {
      if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载');
      const zip = await JSZip.loadAsync(file);

      const templateFile = zip.file('wpmz/template.kml');
      const waylinesFile = zip.file('wpmz/waylines.wpml');

      if (templateFile) templateText = await templateFile.async('string');
      if (waylinesFile) waylinesText = await waylinesFile.async('string');

      if (!waylinesText) {
        const oldKml = Object.keys(zip.files).find(f => f.endsWith('.kml') || f.endsWith('.wpml'));
        if (oldKml) waylinesText = await zip.file(oldKml).async('string');
      }
    } else if (name.endsWith('.kml') || name.endsWith('.wpml')) {
      waylinesText = await file.text();
    } else {
      throw new Error('不支持的文件格式，请选择 .kmz 或 .kml 文件');
    }

    const parser = new DOMParser();
    const xml = parser.parseFromString(waylinesText || templateText, 'text/xml');
    if (xml.querySelector('parsererror')) {
      throw new Error('文件格式错误，不是有效的 KML/KMZ 文件。');
    }

    const waypoints = [];
    const placemarks = xml.querySelectorAll('Placemark');

    placemarks.forEach(pm => {
      const coords = pm.querySelector('coordinates');
      const index = pm.querySelector('index');
      const height = pm.querySelector('executeHeight');
      const wpSpeed = pm.querySelector('waypointSpeed');
      const actionFuncs = pm.querySelectorAll('actionActuatorFunc');
      const hoverEl = pm.querySelector('hoverTime');

      if (coords) {
        const parts = coords.textContent.trim().split(',');
        const actionNames = Array.from(actionFuncs).map(a => a.textContent);
        const hasPhotoAction = actionNames.includes('takePhoto');
        const recordAction = actionNames.find(n => n === 'startRecord' || n === 'stopRecord');

        waypoints.push({
          id: index ? parseInt(index.textContent) : waypoints.length,
          lng: parseFloat(parts[0]),
          lat: parseFloat(parts[1]),
          alt: height ? parseFloat(height.textContent) : 100,
          speed: wpSpeed ? parseFloat(wpSpeed.textContent) : 8,
          // 拍照任务 → photo；摄像任务（含录像动作）→ video；其余为转向点
          type: hasPhotoAction ? 'photo' : (recordAction ? 'video' : 'turn'),
          action: hasPhotoAction ? 'takePhoto' : (recordAction || null),
          gimbalPitch: -90,
          // 悬停时长：文件中的 wpml:hoverTime 按秒解释（DJI 端口径），
          // 直接取原值，不再做毫秒换算；无该动作则不停留
          hoverTime: hoverEl ? parseFloat(hoverEl.textContent) : 0
        });
      }
    });

    return { waypoints };
  }

  // buildWaylinesWpml / generateMissionFileName 一并导出：回归校验
  // （tools/verify-route-algorithm.js）在 Node 中直接驱动，断言动作结构与命名格式
  return {
    exportKmz, exportKmzMultiple, importKmz, buildWaylinesWpml, buildTemplateKml,
    generateMissionFileName, uuidV4
  };
})();
