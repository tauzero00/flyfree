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
   * 计算两点间的方位角 (bearing)，正北为0，顺时针为正
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
   * 生成 template.kml
   */
  function buildTemplateKml(params) {
    const now = Date.now();
    const speed = (params.speed || 8).toFixed(1);

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
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:globalTransitionalSpeed>${speed}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>68</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>0</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>
  </Document>
</kml>`;
  }

  // ---- action group XML builders ----

  function buildActionGroupOpen(groupId, startIdx, endIdx) {
    return `        <wpml:actionGroup>
          <wpml:actionGroupId>${groupId}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${startIdx}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${endIdx}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>parallel</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
          </wpml:actionTrigger>`;
  }

  function buildActionGroupClose() {
    return `        </wpml:actionGroup>`;
  }

  function buildTakePhotoAction(actionId) {
    return `          <wpml:action>
            <wpml:actionId>${actionId}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>
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

    // waypointIdx -> [{ groupId, actions: [xml strings] }]
    const groupsByWp = {};
    function addGroup(wpIdx, groupId, startIdx, endIdx) {
      if (!groupsByWp[wpIdx]) groupsByWp[wpIdx] = [];
      groupsByWp[wpIdx].push({ groupId, startIdx, endIdx, actions: [] });
    }
    function addActionToLastGroup(wpIdx, xml) {
      const groups = groupsByWp[wpIdx];
      groups[groups.length - 1].actions.push(xml);
    }

    // WP 0: groupId=1 — gimbalRotate (and takePhoto if WP0 is a photo waypoint)
    addGroup(0, 1, 0, 0);
    if (missionWps[0].type === 'photo') {
      addActionToLastGroup(0, buildTakePhotoAction(actionId++));
    }
    addActionToLastGroup(0, buildGimbalRotateAction(actionId++, gimbalPitch.toFixed(1)));

    // Process remaining waypoints and segments, interleaved (matching reference pattern)
    for (let i = 0; i < totalWps - 1; i++) {
      // takePhoto for WP i+1 (if photo waypoint)
      if (missionWps[i + 1].type === 'photo') {
        addGroup(i + 1, 1, i + 1, i + 1);
        addActionToLastGroup(i + 1, buildTakePhotoAction(actionId++));
      }

      // gimbalEvenlyRotate for segment i→i+1 (groupId=2)
      const isLastSegment = (i === totalWps - 2);
      const segmentPitch = isLastSegment ? 0 : gimbalPitch;
      addGroup(i, 2, i, i + 1);
      addActionToLastGroup(i, buildGimbalEvenlyRotateAction(actionId++, i, i + 1, segmentPitch.toFixed(1)));
    }

    // 构建 Placemark 列表
    let placemarks = '';
    for (let i = 0; i < totalWps; i++) {
      const wp = missionWps[i];
      const isFirst = (i === 0);
      const isLast = (i === totalWps - 1);

      const turnMode = (isFirst || isLast)
        ? 'toPointAndStopWithContinuityCurvature'
        : 'toPointAndPassWithContinuityCurvature';

      const headingMode = isFirst ? 'smoothTransition' : 'followWayline';
      const headingAngle = isFirst ? firstHeading.toFixed(1) : '0';
      const headingAngleEnable = (isFirst || isLast) ? '1' : '0';

      // Build action groups for this waypoint
      let actionGroupsXml = '';
      const groups = groupsByWp[i];
      if (groups) {
        for (const g of groups) {
          actionGroupsXml += '\n' + buildActionGroupOpen(g.groupId, g.startIdx, g.endIdx) + '\n';
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

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NS}">
  <Document>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:globalTransitionalSpeed>${speedStr}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>68</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>0</wpml:droneSubEnumValue>
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

      if (coords) {
        const parts = coords.textContent.trim().split(',');
        const hasPhotoAction = Array.from(actionFuncs).some(a => a.textContent === 'takePhoto');

        waypoints.push({
          id: index ? parseInt(index.textContent) : waypoints.length,
          lng: parseFloat(parts[0]),
          lat: parseFloat(parts[1]),
          alt: height ? parseFloat(height.textContent) : 100,
          speed: wpSpeed ? parseFloat(wpSpeed.textContent) : 8,
          type: hasPhotoAction ? 'photo' : 'turn',
          action: hasPhotoAction ? 'takePhoto' : null,
          gimbalPitch: -90
        });
      }
    });

    return { waypoints };
  }

  return { exportKmz, importKmz };
})();
