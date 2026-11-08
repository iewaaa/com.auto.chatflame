/**
 * 抖音自动续火花 —— 稳健版（基于 v3.0 重构）
 *
 * 相比旧版的主要改动：
 *  1. 用「等待界面就绪」替代固定 sleep，每一步都校验目标界面；
 *  2. 好友定位改为 text/desc/包含 多策略，点击后校验是否真的进入聊天；
 *  3. 列表里找不到时自动滚动，再找不到走「消息页搜索」兜底；
 *  4. 退出聊天时循环 back，直到回到消息页（自动处理键盘遮挡）；
 *  5. 先判断是否锁屏，已解锁则跳过解锁流程；
 *  6. 网络请求加超时和异常兜底；
 *  7. 每个好友独立 try/catch，失败自动回到消息页继续下一个，结束汇总通知。
 *
 * 使用前只需要修改下面 CONFIG 里的 friendNames 和 password。
 * 排查问题时把 debug 改成 true，可在 AutoJs 控制台看到当前页面节点快照。
 */

const CONFIG = {
  // 需要发送的好友昵称（与抖音消息列表里显示的一致，备注名也可以）
  friendNames: ["测试名称1", "测试名称2"],
  // 锁屏密码，几位就写几位，例如 4 位就是 [1, 2, 3, 4]
  password: [1, 2, 3, 4, 5, 6],
  appName: "抖音",
  packageName: "com.ss.android.ugc.aweme",
  // 一言接口失败时发送的兜底内容
  fallbackContent: "今天网络不佳，没词了",
  // 排查问题时改成 true，失败时会在日志里输出当前页面可见节点
  debug: false,
  timeout: {
    launchApp: 10000, // 等待抖音启动
    chatOpen: 3500, // 点好友后等待聊天页
    sendButton: 3000, // 输入内容后等待发送按钮
    pageSwitch: 3000 // 一般页面切换
  }
};

/* ---------------------------- 基础工具 ---------------------------- */

function logMsg(msg) {
  log("[续火花] " + msg);
}

function safeStr(v) {
  return v === null || v === undefined ? "" : String(v);
}

function formatNow() {
  const d = new Date();
  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " +
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function notify(title, content) {
  try {
    if (typeof notice === "function") {
      notice(title, content);
    } else {
      toast(title + "\n" + content);
    }
  } catch (e) {
    try { toast(title); } catch (e2) {}
  }
}

// 轮询等待条件成立，超时返回 false
function waitUntil(condition, timeout, interval) {
  const it = interval || 200;
  const end = Date.now() + (timeout || 3000);
  while (Date.now() < end) {
    try {
      if (condition()) return true;
    } catch (e) {}
    sleep(it);
  }
  return false;
}

function randomSleep(min, max) {
  sleep(min + Math.floor(Math.random() * (max - min + 1)));
}

/* ---------------------------- 节点定位 ---------------------------- */

// 节点是否可用：尺寸大于 0 且中心点在屏幕内
function isUsableNode(node) {
  if (!node) return false;
  try {
    const b = node.bounds();
    if (!b || b.width() <= 0 || b.height() <= 0) return false;
    const cx = b.centerX();
    const cy = b.centerY();
    return cx > 0 && cy > 0 && cx < device.width && cy < device.height;
  } catch (e) {
    return false;
  }
}

function nodeKey(node) {
  try {
    const b = node.bounds();
    return b.left + "," + b.top + "," + b.right + "," + b.bottom;
  } catch (e) {
    return "";
  }
}

function sortByPosition(nodes) {
  try {
    nodes.sort(function (a, b) {
      const ca = a.bounds();
      const cb = b.bounds();
      return (ca.centerY() - cb.centerY()) || (ca.centerX() - cb.centerX());
    });
  } catch (e) {}
  return nodes;
}

// 按选择器优先级收集可见节点并去重（坐标相同的视为同一个）
function collectNodes(selectors) {
  const out = [];
  const seen = {};
  for (let i = 0; i < selectors.length; i++) {
    let arr = [];
    try {
      arr = selectors[i].find() || [];
    } catch (e) {}
    sortByPosition(arr);
    for (let j = 0; j < arr.length; j++) {
      const n = arr[j];
      if (!isUsableNode(n)) continue;
      const k = nodeKey(n);
      if (!k || seen[k]) continue;
      seen[k] = true;
      out.push(n);
    }
  }
  return out;
}

function findFirstUsable(selectors) {
  const nodes = collectNodes(selectors);
  return nodes.length ? nodes[0] : null;
}

// 查找包含指定文本的非输入框节点（用于校验消息是否真的出现在聊天里）
function hasNonEditableText(textValue) {
  const nodes = collectNodes([textContains(textValue)]);
  for (let i = 0; i < nodes.length; i++) {
    if (!isEditable(nodes[i])) return true;
  }
  return false;
}

function isEditable(node) {
  try {
    return /EditText/i.test(safeStr(node.className()));
  } catch (e) {
    return false;
  }
}

// 点击节点：优先点击节点中心坐标；坐标不可用时退化为点击可点击祖先
function clickNode(node) {
  if (!node) return false;
  try {
    const b = node.bounds();
    if (b && b.width() > 0 && b.height() > 0) {
      return click(b.centerX(), b.centerY());
    }
  } catch (e) {}

  let n = node;
  for (let i = 0; i < 5 && n; i++) {
    try {
      if (n.clickable()) return n.click();
    } catch (e) {}
    try {
      n = n.parent();
    } catch (e) {
      n = null;
    }
  }
  return false;
}

/* ---------------------------- 页面判断 ---------------------------- */

function findEditable(predicate) {
  let arr = [];
  try {
    arr = className("android.widget.EditText").find() || [];
  } catch (e) {}
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!isUsableNode(e)) continue;
    if (predicate && !predicate(e)) continue;
    return e;
  }
  return null;
}

// 聊天输入框：位于屏幕下半部分的 EditText（搜索框在顶部，不会命中）
function findChatInput() {
  return findEditable(function (e) {
    try {
      return e.bounds().centerY() > device.height * 0.45;
    } catch (err) {
      return false;
    }
  });
}

function isChatPage() {
  if (findChatInput()) return true;
  // 兜底：部分版本输入框不是标准 EditText，用聊天页的输入提示辅助判断
  return !!findFirstUsable([textContains("发送消息"), descContains("发送消息")]);
}

// 底部 tab（消息 tab 在屏幕最下方）。
// 先用 text 查一次，找不到再用 desc 查，避免每次固定两次慢查询。
function findBottomTab(label) {
  const re = "^" + label + "$";

  function pick(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      if (!isUsableNode(nodes[i])) continue;
      try {
        if (nodes[i].bounds().centerY() > device.height * 0.8) return nodes[i];
      } catch (e) {}
    }
    return null;
  }

  let found = null;
  try { found = pick(textMatches(re).find() || []); } catch (e) {}
  if (found) return found;

  try { found = pick(descMatches(re).find() || []); } catch (e) {}
  return found;
}

// 首页/朋友/我页面顶部会出现的文字，用于排除“不在消息页”的情况
const HOME_MARKERS = ["推荐", "关注", "精选", "同城", "直播", "短剧", "朋友", "编辑资料"];

// 只匹配页面判断需要的文字。不要用 textMatches(".+")，
// 在抖音首页会命中成百上千个节点，单次查找就要好几秒。
const PAGE_MARKER_RE = "^(推荐|关注|精选|同城|直播|短剧|朋友|编辑资料|消息)$";

// 底部 tab 是否处于选中状态（部分版本 selected 挂在父节点上）
function isTabSelected(node) {
  let n = node;
  for (let i = 0; i < 4 && n; i++) {
    try {
      if (n.selected()) return true;
    } catch (e) {}
    try {
      n = n.parent();
    } catch (e) {
      n = null;
    }
  }
  return false;
}

// 收集屏幕顶部区域的页面标记文字，用于判断当前页面和输出诊断信息
// 每项返回 { text, x, y }
function getTopTexts(maxYRatio) {
  const ratio = maxYRatio || 0.2;
  const out = [];
  const selectors = [textMatches(PAGE_MARKER_RE), descMatches(PAGE_MARKER_RE)];

  for (let s = 0; s < selectors.length; s++) {
    let arr = [];
    try {
      arr = selectors[s].find() || [];
    } catch (e) {
      continue;
    }

    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (!isUsableNode(n)) continue;

      let b = null;
      try { b = n.bounds(); } catch (e) {}
      if (!b || b.centerY() >= device.height * ratio) continue;

      let t = "";
      try { t = safeStr(n.text()); } catch (e) {}
      if (!t) { try { t = safeStr(n.desc()); } catch (e) {} }
      if (t) out.push({ text: t, x: b.centerX(), y: b.centerY() });
    }
  }
  return out;
}

function topTextsToString(maxYRatio) {
  const arr = getTopTexts(maxYRatio);
  const parts = [];
  for (let i = 0; i < arr.length; i++) parts.push(arr[i].text);
  return parts.join(" / ");
}

// 是否真的在消息列表页。
// 注意：首页/朋友/我页面同样有底部“消息”tab，不能只看 tab 是否存在。
// 底部“消息”tab 是否处于选中态（部分版本 selected/checked 挂在不同层级）
function isMessageTabActive() {
  const tab = findBottomTab("消息");
  if (!tab) return false;

  let n = tab;
  for (let i = 0; i < 6 && n; i++) {
    try {
      if (n.selected()) return true;
    } catch (e) {}
    try {
      if (n.checked()) return true;
    } catch (e) {}
    try {
      n = n.parent();
    } catch (e) {
      n = null;
    }
  }
  return false;
}

function isMessagePage() {
  const top = getTopTexts(0.2);
  let hasMessageText = false;

  for (let i = 0; i < top.length; i++) {
    // 命中首页/朋友/我的顶部文字，说明不在消息页
    if (HOME_MARKERS.indexOf(top[i].text) >= 0) return false;
    // 你的抖音把“消息”标题渲染在右侧/居中，不能再限制横坐标
    if (top[i].text === "消息") hasMessageText = true;
  }

  if (hasMessageText) return true;

  // 没有“消息”文字时，再用底部 tab 的选中态兜底
  if (isChatPage()) return false;
  return isMessageTabActive();
}

// 点击底部 tab：优先用无障碍点击，坐标点击作为兜底
function clickTabNode(node) {
  if (!node) return false;

  let n = node;
  for (let i = 0; i < 4 && n; i++) {
    try {
      if (n.click()) return true;
    } catch (e) {}
    try {
      n = n.parent();
    } catch (e) {
      n = null;
    }
  }
  return clickNode(node);
}

// 循环返回，直到检测到消息页；键盘打开时第一下只会收起键盘，所以需要循环
function backToMessageList() {
  if (!isChatPage() && isMessagePage()) return true;

  for (let i = 0; i < 5; i++) {
    back();
    if (waitUntil(function () {
      return !isChatPage() && isMessagePage();
    }, 2000)) {
      return true;
    }
    // 已经退出抖音时不要再按返回
    try {
      if (currentPackage() !== CONFIG.packageName) return false;
    } catch (e) {}
  }
  return false;
}

/* ---------------------------- 启动与解锁 ---------------------------- */

function dismissCommonPopups() {
  // 用一次正则查询代替逐个文字查询：原先 12 次查询在抖音首页要耗 70 多秒
  const re = "^(以后再说|跳过|暂不|暂不开启|关闭|我知道了)$";
  const nodes = collectNodes([textMatches(re), descMatches(re)]);
  if (!nodes.length) return;

  const limit = Math.min(nodes.length, 2);
  for (let i = 0; i < limit; i++) {
    let label = "";
    try { label = safeStr(nodes[i].text()); } catch (e) {}
    if (!label) { try { label = safeStr(nodes[i].desc()); } catch (e) {} }
    logMsg("关闭弹窗: " + label);
    clickNode(nodes[i]);
    sleep(600);
  }
}

function launchDouyin() {
  logMsg("启动 " + CONFIG.appName);
  try {
    app.launchApp(CONFIG.appName);
  } catch (e) {
    try {
      app.launchPackage(CONFIG.packageName);
    } catch (e2) {
      logMsg("启动失败: " + e2);
    }
  }

  const inForeground = waitUntil(function () {
    return currentPackage() === CONFIG.packageName;
  }, CONFIG.timeout.launchApp);
  logMsg(inForeground ? "抖音已在前台" : "等待抖音前台超时，继续尝试");

  sleep(1500);
  dismissCommonPopups();
  logMsg("启动流程结束");
}

function waitForBottomTab(label, timeout) {
  let found = null;
  waitUntil(function () {
    found = findBottomTab(label);
    return !!found;
  }, timeout);
  return found;
}

function ensureMessagePage() {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      // 广告弹窗可能是延迟出现的，重试前再清一次
      dismissCommonPopups();
    }

    // 不做点击前的页面判断：首页上一次慢查询就要好几秒。
    // 直接找 tab 点下去（即使已在消息页，点击也是安全的）。
    let tab = findBottomTab("消息");
    if (!tab) {
      // 启动动画期间 tab 可能还没渲染出来
      tab = waitForBottomTab("消息", 2000);
    }

    if (!tab) {
      // 聊天页/个人页没有底部 tab，先退出来
      if (isChatPage()) {
        logMsg("当前在聊天页，返回到消息页");
        backToMessageList();
        continue;
      }
      logMsg("未找到底部「消息」tab，尝试返回/重启 (" + (attempt + 1) + "/4)");
      if (attempt >= 2) {
        launchDouyin();
      } else {
        back();
        sleep(800);
      }
      continue;
    }

    const useNodeClick = attempt % 2 === 0;
    logMsg("点击底部「消息」tab (" + (attempt + 1) + "/4, " +
      (useNodeClick ? "无障碍点击" : "坐标点击") + ")");
    if (useNodeClick) {
      clickTabNode(tab);
    } else {
      clickNode(tab);
    }

    // 点击后校验是否真的进入了消息页，没进去就重试
    if (waitUntil(isMessagePage, 2500, 500)) {
      logMsg("已进入消息页");
      sleep(500);
      return true;
    }

    logMsg("点击「消息」未生效，重试，顶部: " + topTextsToString(0.25));
    sleep(500);
  }

  return false;
}

// 锁屏数字键：优先用 desc 精确匹配（与旧版脚本一致，用户手机实测可用），
// 部分机型只有 text 时再兜底。注意不要限制在屏幕下半部分，部分机型键盘位置更靠上。
function findKeypadDigit(d, timeout) {
  const s = String(d);
  let found = null;

  waitUntil(function () {
    let arr = [];
    try { arr = desc(s).find() || []; } catch (e) {}
    for (let i = 0; i < arr.length; i++) {
      if (isUsableNode(arr[i])) {
        found = arr[i];
        return true;
      }
    }

    arr = [];
    try { arr = text(s).find() || []; } catch (e) {}
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (!isUsableNode(n)) continue;
      try {
        // text 匹配容易撞上时间/日期，限制在屏幕中部以下
        if (n.bounds().centerY() > device.height * 0.3) {
          found = n;
          return true;
        }
      } catch (e) {}
    }
    return false;
  }, timeout || 1000);

  return found;
}

// AutoJS6 的 device 模块没有 isLocked()，用系统 KeyguardManager 判断：
// 返回 true/false；获取失败返回 null（后续按“需要解锁”处理）
function isLocked() {
  try {
    importClass(android.app.KeyguardManager);
    importClass(android.content.Context);
    const km = context.getSystemService(Context.KEYGUARD_SERVICE);
    if (km && typeof km.isKeyguardLocked === "function") {
      return !!km.isKeyguardLocked();
    }
  } catch (e) {
    logMsg("判断锁屏状态失败: " + e);
  }
  return null;
}

// 尝试多种上滑手势，直到密码键盘出现。
// 锁屏通知较多时，屏幕中部的上滑可能只展开/滚动通知，所以增加了贴底部的兜底手势。
function swipeUpForKeypad() {
  const midFromY = Math.min(device.height - 120, device.height / 2 + 400);
  const gestures = [
    [device.width / 2, midFromY, device.width / 2, device.height / 2 - 400, 200], // 用户实测可用
    [device.width / 2, device.height - 150, device.width / 2, device.height * 0.5, 300], // 贴底部，避开通知
    [device.width * 0.5, device.height * 0.8, device.width * 0.5, device.height * 0.35, 250]
  ];

  for (let i = 0; i < gestures.length; i++) {
    const g = gestures[i];
    logMsg("上滑尝试 " + (i + 1) + "/" + gestures.length);
    try { swipe(g[0], g[1], g[2], g[3], g[4]); } catch (e) {}
    sleep(1500);

    const node = findKeypadDigit(CONFIG.password[0], 2500);
    if (node) return node;

    // 通知栏可能被上滑展开，返回一次收起后再换手势
    if (i === 0) {
      try { back(); } catch (e) {}
      sleep(800);
    }
  }
  return null;
}

function unlockScreen() {
  try { device.wakeUpIfNeeded(); } catch (e) {}
  sleep(1000);

  if (isLocked() === false) {
    logMsg("屏幕已解锁，跳过解锁");
    return true;
  }

  logMsg("检测到锁屏，上滑进入密码键盘");

  const keyNode = swipeUpForKeypad();

  if (!keyNode) {
    // 判断不出锁屏状态时，可能本身没有密码锁；交给后续启动流程验证
    logMsg("未检测到密码键盘，按已解锁继续");
    return true;
  }

  for (let i = 0; i < CONFIG.password.length; i++) {
    const node = i === 0 ? keyNode : findKeypadDigit(CONFIG.password[i], 2000);
    if (!node) {
      logMsg("未找到密码数字: " + CONFIG.password[i]);
      return false;
    }
    clickNode(node);
    sleep(500);
  }

  sleep(2000);
  const unlocked = waitUntil(function () {
    if (isLocked() === false) return true;
    // 密码键盘消失也视为解锁成功（个别机型 KeyguardManager 返回不准）
    return !findKeypadDigit(CONFIG.password[0], 300);
  }, 5000);
  logMsg(unlocked ? "解锁成功" : "解锁失败");
  return unlocked;
}

/* ---------------------------- 随机文案 ---------------------------- */

function getMessageContent() {
  try {
    const res = http.get("https://v1.hitokoto.cn/?encode=json&charset=utf-8", { timeout: 8000 });
    if (res && res.statusCode === 200) {
      const data = res.body.json();
      if (data && data.hitokoto) {
        return data.from ? data.hitokoto + " —— " + data.from : data.hitokoto;
      }
    }
    logMsg("一言接口返回异常: " + (res ? res.statusCode : "无响应"));
  } catch (e) {
    logMsg("一言接口请求失败: " + e);
  }
  return CONFIG.fallbackContent;
}

/* ---------------------------- 发送消息 ---------------------------- */

function findSendButton(timeout) {
  let btn = null;
  waitUntil(function () {
    const nodes = collectNodes([desc("发送"), text("发送")]);
    for (let i = 0; i < nodes.length; i++) {
      try {
        const b = nodes[i].bounds();
        // 发送按钮应位于输入框右侧、屏幕下半部分，避免匹配到聊天内容里的“发送”
        if (b.centerX() > device.width * 0.55 && b.centerY() > device.height * 0.45) {
          btn = nodes[i];
          return true;
        }
      } catch (e) {}
    }
    return false;
  }, timeout);
  return btn;
}

function sendMessage() {
  const content = getMessageContent();
  logMsg("准备发送: " + content);

  const input = findChatInput();
  if (!input) throw new Error("聊天页未找到输入框");

  clickNode(input);
  sleep(300);

  let filled = false;
  try {
    filled = input.setText(content);
  } catch (e) {
    logMsg("控件 setText 失败: " + e);
  }
  if (!filled) {
    try {
      setText(content);
    } catch (e) {
      logMsg("全局 setText 失败: " + e);
    }
  }
  sleep(500);

  const sendBtn = findSendButton(CONFIG.timeout.sendButton);
  if (!sendBtn) throw new Error("未找到发送按钮");

  clickNode(sendBtn);
  sleep(500);

  // 校验发送结果：输入框清空或聊天里出现刚发送的内容
  const snippet = content.substring(0, Math.min(8, content.length));
  const cleared = waitUntil(function () {
    try {
      return safeStr(input.text()).length === 0;
    } catch (e) {
      return false;
    }
  }, 2000);
  const appeared = !cleared && waitUntil(function () {
    return hasNonEditableText(snippet);
  }, 1000);

  if (cleared || appeared) {
    logMsg("发送成功");
  } else {
    logMsg("发送后未检测到明确成功标志，继续下一位");
  }
}

/* ---------------------------- 进入好友聊天 ---------------------------- */

function collectFriendCandidates(name) {
  const selectors = [
    text(name),
    textContains(name),
    desc(name),
    descContains(name)
  ];
  // 昵称过长时列表里可能被截断，增加前缀匹配作为兜底
  if (name.length > 6) {
    selectors.push(textContains(name.substring(0, 6)));
  }

  const nodes = collectNodes(selectors);
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!isEditable(nodes[i])) out.push(nodes[i]);
  }
  return out;
}

// 当前屏文本节点的“文本+坐标”签名，用于判断列表是否还在滚动（含惯性）
// 排除状态栏、底部 tab 以及时间/未读数这类会自己变化的文本，减少误报
function pageSignature() {
  let arr = [];
  try {
    arr = textMatches(".+").find() || [];
  } catch (e) {
    return "";
  }

  const parts = [];
  for (let i = 0; i < arr.length && parts.length < 40; i++) {
    const n = arr[i];
    if (!isUsableNode(n)) continue;

    const t = safeStr(n.text());
    if (!t) continue;
    if (/^\d{1,2}:\d{2}$/.test(t) || /^\d+$/.test(t)) continue;

    try {
      const b = n.bounds();
      const cy = b.centerY();
      if (cy < device.height * 0.1 || cy > device.height * 0.9) continue;
      parts.push(t + "@" + b.left + "," + b.top);
    } catch (e) {}
  }
  parts.sort();
  return parts.join("|");
}

// 连续采样签名不变，认为界面已停止滚动
function waitForScrollIdle(timeout, tag) {
  const end = Date.now() + (timeout || 3000);
  let last = null;
  let stable = 0;

  while (Date.now() < end) {
    const sig = pageSignature();
    if (sig && sig === last) {
      stable++;
      if (stable >= 2) return true;
    } else {
      stable = 0;
    }
    last = sig;
    sleep(250);
  }

  logMsg("等待界面停稳超时" + (tag ? " (" + tag + ")" : ""));
  return false;
}

// 确认消息页后给列表少量渲染时间。
// 不要用 textMatches(".+") 遍历整页文本：抖音首页/列表的节点极多，单次查询就要数秒。
function waitForMessageListReady(timeout) {
  const ready = waitUntil(isMessagePage, timeout || 2000, 400);
  sleep(600);
  return ready;
}

// 小步慢速滚动，减少惯性过冲；滚动后等界面停稳
function scrollListOneStep() {
  swipe(device.width / 2, device.height * 0.72, device.width / 2, device.height * 0.45, 700);
  sleep(400);
  return waitForScrollIdle(2500, "滚动后");
}

// 把消息列表拉回顶部。
// 上一位好友是通过搜索处理的，返回消息页时列表可能停在底部，
// 这时只向下找会漏掉上方的目标，必须先回顶。
function scrollListToTop(maxSwipes) {
  const limit = maxSwipes || 8;
  for (let i = 0; i < limit; i++) {
    const before = pageSignature();
    swipe(device.width / 2, device.height * 0.28, device.width / 2, device.height * 0.82, 300);
    sleep(1000);
    const after = pageSignature();
    if (before && after && before === after) {
      logMsg("已回到消息列表顶部");
      return true;
    }
  }
  logMsg("回顶达到最大次数，继续查找");
  return false;
}

function scrollAndFind(name) {
  for (let i = 0; i < 4; i++) {
    waitForScrollIdle(2500, "查找前");
    const found = collectFriendCandidates(name);
    if (found.length) return found;

    logMsg("当前列表未找到，向下滚动 (" + (i + 1) + "/4)");
    scrollListOneStep();
  }
  waitForScrollIdle(2500, "滚动结束");
  return collectFriendCandidates(name);
}

// 校验当前聊天标题是否为目标好友，防止惯性滚动时点错人
// 比对屏幕顶部 20% 的文本；完全拿不到标题时保守放行
function verifyChatTarget(name) {
  let arr = [];
  try {
    arr = classNameMatches(".*").find() || [];
  } catch (e) {
    return true;
  }

  const topTexts = [];
  for (let i = 0; i < arr.length; i++) {
    const n = arr[i];
    if (!isUsableNode(n)) continue;
    try {
      if (n.bounds().centerY() > device.height * 0.2) continue;
    } catch (e) {
      continue;
    }

    let t = "";
    try { t = safeStr(n.text()); } catch (e) {}
    if (!t) { try { t = safeStr(n.desc()); } catch (e) {} }
    if (t) topTexts.push(t);
  }

  if (!topTexts.length) return true;

  // 标题过长时可能被截断，用前缀匹配
  const probe = name.length > 6 ? name.substring(0, 6) : name;
  for (let i = 0; i < topTexts.length; i++) {
    if (topTexts[i].indexOf(probe) >= 0) return true;
  }

  logMsg("聊天标题与目标不符，顶部文本: " + topTexts.join(" / "));
  return false;
}

// 点开的是个人主页时，尝试点击「私信 / 发消息」
function tryEnterChatFromProfile(timeout) {
  if (isChatPage()) return true;

  const btn = findFirstUsable([text("私信"), text("发消息"), desc("私信"), desc("发消息")]);
  if (!btn) return false;

  logMsg("尝试点击「私信/发消息」进入聊天");
  clickNode(btn);
  return waitUntil(isChatPage, timeout || 3000);
}

// 在消息列表里直接点好友
function openChatFromList(name) {
  waitForMessageListReady(5000);
  waitForScrollIdle(3000, "消息列表");

  // 上一位好友若通过搜索处理，返回时列表可能停在底部，先回顶再向下找
  scrollListToTop(8);
  waitForScrollIdle(2500, "回顶后");

  let candidates = collectFriendCandidates(name);
  if (!candidates.length) candidates = scrollAndFind(name);
  if (!candidates.length) return false;

  const clicked = {};
  let clickCount = 0;

  for (let round = 0; round < 5 && clickCount < 6; round++) {
    // 每次点击前都确认惯性已停止，并重新扫描坐标，避免点在滚动的列表上
    waitForScrollIdle(2000, "点击前");
    const fresh = collectFriendCandidates(name);

    let target = null;
    for (let i = 0; i < fresh.length; i++) {
      const k = nodeKey(fresh[i]);
      if (k && !clicked[k]) {
        clicked[k] = true;
        target = fresh[i];
        break;
      }
    }

    if (!target) {
      // 当前屏的候选都点过了，继续向下找
      if (!scrollAndFind(name).length) break;
      continue;
    }

    logMsg("尝试点击列表节点: " + nodeKey(target));
    clickNode(target);
    clickCount++;

    if (waitUntil(isChatPage, CONFIG.timeout.chatOpen)) {
      if (verifyChatTarget(name)) {
        logMsg("已进入聊天: " + name);
        return true;
      }
      logMsg("进入的不是目标好友，返回列表重试");
      backToMessageList();
      continue;
    }

    if (tryEnterChatFromProfile(1500)) {
      if (verifyChatTarget(name)) {
        logMsg("已通过个人页进入聊天: " + name);
        return true;
      }
      logMsg("个人页进入的不是目标好友，返回列表重试");
      backToMessageList();
      continue;
    }

    // 点进了个人页/详情页等，退回来再试下一个；仍停留在主 tab 时不要按返回，避免退出抖音
    if (!isMessagePage() && !isChatPage()) {
      back();
      sleep(700);
    }
  }
  return false;
}

// 消息页搜索兜底：搜索昵称 -> 点结果 -> 必要时点私信
function openChatBySearch(name) {
  logMsg("消息列表未找到，尝试搜索: " + name);
  if (!ensureMessagePage()) return false;

  // 等消息页渲染完成再找搜索入口
  waitForMessageListReady(3000);
  waitForScrollIdle(1500, "搜索前");

  let entry = findFirstUsable([descContains("搜索"), textContains("搜索")]);
  if (!entry) {
    // 部分版本搜索框本身就是顶部 EditText
    entry = findEditable(function (e) {
      try {
        return e.bounds().centerY() < device.height * 0.3;
      } catch (err) {
        return false;
      }
    });
  }
  if (!entry) {
    logMsg("未找到搜索入口");
    return false;
  }

  clickNode(entry);
  sleep(1000);

  let input = null;
  waitUntil(function () {
    input = findEditable(function (e) {
      try {
        return e.bounds().centerY() < device.height * 0.4;
      } catch (err) {
        return false;
      }
    }) || findEditable(null);
    return !!input;
  }, CONFIG.timeout.pageSwitch);

  if (!input) {
    logMsg("搜索页未找到输入框");
    backToMessageList();
    return false;
  }

  clickNode(input);
  sleep(300);
  try {
    input.setText(name);
  } catch (e) {
    try { setText(name); } catch (e2) {}
  }
  sleep(1500);

  waitForScrollIdle(2500, "搜索结果");
  const results = collectFriendCandidates(name);
  for (let i = 0; i < results.length && i < 6; i++) {
    logMsg("尝试搜索结果: " + nodeKey(results[i]));
    clickNode(results[i]);

    if (waitUntil(isChatPage, CONFIG.timeout.chatOpen)) {
      if (verifyChatTarget(name)) return true;
      logMsg("搜索结果进入的不是目标好友，放弃本次搜索");
      break;
    }

    if (tryEnterChatFromProfile(CONFIG.timeout.chatOpen)) {
      if (verifyChatTarget(name)) return true;
      logMsg("搜索结果进入的不是目标好友，放弃本次搜索");
      break;
    }

    if (!isMessagePage() && !isChatPage()) {
      back();
      sleep(800);
    }
  }

  logMsg("搜索兜底失败: " + name);
  backToMessageList();
  return false;
}

function processFriend(name, index) {
  logMsg("(" + (index + 1) + "/" + CONFIG.friendNames.length + ") 处理好友: " + name);
  if (!ensureMessagePage()) throw new Error("无法进入抖音消息页");

  if (openChatFromList(name)) {
    sendMessage();
    backToMessageList();
    return true;
  }

  if (openChatBySearch(name)) {
    sendMessage();
    backToMessageList();
    return true;
  }

  return false;
}

/* ---------------------------- 收尾与调试 ---------------------------- */

// AutoJS6 没有 device.lockScreen()，改用无障碍锁屏（Android 9+）
function lockDevice() {
  try {
    if (typeof automator !== "undefined" && typeof automator.lockScreen === "function") {
      const ok = automator.lockScreen();
      logMsg("自动锁屏: " + (ok === false ? "失败" : "成功"));
      return ok !== false;
    }
  } catch (e) {
    logMsg("automator.lockScreen 失败: " + e);
  }

  // 兜底：直接调用无障碍服务的全局锁屏动作
  try {
    const service = runtime.accessibilityBridge.getService();
    const ok = service.performGlobalAction(
      android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN
    );
    logMsg("自动锁屏(全局动作): " + (ok ? "成功" : "失败"));
    return !!ok;
  } catch (e) {
    logMsg("自动锁屏失败: " + e);
  }
  return false;
}

function closeAppAndLock() {
  logMsg("返回桌面并锁屏");
  try { home(); } catch (e) {}
  sleep(800);

  // 抖音留在后台不影响续火花，不再清理最近任务
  if (!lockDevice()) {
    logMsg("自动锁屏失败，建议在系统设置里调短自动息屏时间");
  }
}

// 调试用：输出当前页面所有可见的文本/描述节点
function dumpPage(tag) {
  logMsg("=== 页面快照 [" + tag + "] pkg=" + safeStr(currentPackage()) + " ===");
  let arr = [];
  try {
    arr = classNameMatches(".*").find() || [];
  } catch (e) {
    logMsg("获取节点失败: " + e);
    return;
  }

  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    const n = arr[i];
    if (!isUsableNode(n)) continue;

    let t = "";
    let d = "";
    try { t = safeStr(n.text()); } catch (e) {}
    try { d = safeStr(n.desc()); } catch (e) {}
    if (!t && !d) continue;

    let b = null;
    try { b = n.bounds(); } catch (e) {}
    logMsg("  [" + safeStr(n.className()) + "] text=" + t + " desc=" + d +
      (b ? " bounds=" + b.left + "," + b.top + "," + b.right + "," + b.bottom : ""));
    count++;
    if (count >= 50) break;
  }
  logMsg("=== 快照结束，共 " + count + " 个可见文本节点 ===");
}

/* ---------------------------- 主流程 ---------------------------- */

function main() {
  auto.waitFor();
  const startTime = Date.now();

  try {
    device.setMusicVolume(0);
  } catch (e) {
    logMsg("设置媒体音量失败: " + e);
  }

  notify("开始执行抖音续火花", "当前时间: " + formatNow());

  if (!unlockScreen()) {
    notify("抖音续火花中断", "屏幕解锁失败，请检查锁屏密码");
    return;
  }

  launchDouyin();
  if (!ensureMessagePage()) {
    logMsg("首次进入消息页失败，重试一次");
    launchDouyin();
    if (!ensureMessagePage()) {
      notify("抖音续火花中断", "无法进入抖音消息页");
      return;
    }
  }

  const success = [];
  const failed = [];
  const names = CONFIG.friendNames || [];

  for (let i = 0; i < names.length; i++) {
    const name = safeStr(names[i]).trim();
    if (!name) continue;
    try {
      if (processFriend(name, i)) {
        success.push(name);
      } else {
        failed.push(name);
      }
    } catch (e) {
      logMsg("处理好友失败: " + name + " -> " + e);
      failed.push(name);
      if (CONFIG.debug) dumpPage("好友失败: " + name);
      backToMessageList();
    }
    randomSleep(1000, 2500);
  }

  closeAppAndLock();

  const runTime = Math.round((Date.now() - startTime) / 1000);
  const summary = "成功: " + (success.length ? success.join("、") : "无") +
    "\n失败: " + (failed.length ? failed.join("、") : "无") +
    "\n耗时: " + runTime + " 秒";
  logMsg(summary.replace(/\n/g, " | "));
  notify("抖音续火花完成", summary);
}

try {
  main();
} catch (e) {
  logMsg("脚本异常: " + e);
  notify("抖音续火花异常", String(e));
}
