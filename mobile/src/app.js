import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

/* ============================================================
   时光轴 手机版
   第一原则：提醒必达（预调度系统通知，不依赖进程存活）
   ============================================================ */

const K = 'sgz.mobile.v1';
const MAX_SCHED = 48;
const CH_ID = 'reminders_v2';   // importance 创建后不可改，只能换渠道 id          // 滚动窗口，规避 iOS 待调度通知上限
const IS_NATIVE = Capacitor.isNativePlatform();
const PLATFORM = Capacitor.getPlatform();

// 本地原生插件：系统设置跳转 + 电池白名单/厂商探测
const SystemSettings = registerPlugin('SystemSettings');
const VENDOR_INFO = {
  xiaomi:  { name: '小米/红米', note: '需要允许「自启动」，否则锁屏后提醒可能不响' },
  huawei:  { name: '华为/荣耀', note: '需要在「应用启动管理」改为手动管理，并允许后台活动' },
  oppo:    { name: 'OPPO/一加/realme', note: '需要允许「自启动」与「后台运行」' },
  vivo:    { name: 'vivo/iQOO', note: '需要允许「后台高耗电」与「自启动」' },
  samsung: { name: '三星', note: '需要设为「不受限制」，并关闭「使未使用的应用进入休眠」' },
  meizu:   { name: '魅族', note: '需要允许「后台运行」' },
};
async function getDevice() {
  if (!IS_NATIVE || PLATFORM !== 'android') return null;
  try { return await SystemSettings.getDeviceInfo(); } catch (e) { return null; }
}

/* ---------------- 存储 ---------------- */
const DEFAULT = () => ({
  v: 1,
  tasks: [],
  goals: [],
  metrics: [],
  settings: { remind: true, prepMin: 5, sound: 'default', dark: false, onboarded: false },
  lastBackup: 0,
  lastOpen: 0,
});

let DB = DEFAULT();

function load() {
  try {
    const raw = localStorage.getItem(K);
    if (raw) {
      const o = JSON.parse(raw);
      DB = Object.assign(DEFAULT(), o);
      DB.settings = Object.assign(DEFAULT().settings, o.settings || {});
    }
  } catch (e) { console.warn('load failed', e); }
}
function save() {
  try { localStorage.setItem(K, JSON.stringify(DB)); }
  catch (e) { toast('保存失败：' + e.message); }
}

/* ---------------- 通用工具 ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const pad = n => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayKey() { return dateKey(new Date()); }
function parseKey(k) { const p = String(k).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function toMin(t) { const p = String(t).split(':'); return +p[0] * 60 + (+p[1] || 0); }
function fromMin(m) { m = Math.max(0, Math.min(1439, Math.round(m))); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
function daysBetween(a, b) { return Math.round((parseKey(b) - parseKey(a)) / 86400000); }
const WD = ['日', '一', '二', '三', '四', '五', '六'];

function relDay(k) {
  const d = daysBetween(todayKey(), k);
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  if (d === 2) return '后天';
  if (d === -1) return '昨天';
  const dt = parseKey(k);
  return (dt.getMonth() + 1) + '月' + dt.getDate() + '日 周' + WD[dt.getDay()];
}
function fmtDur(min) {
  if (!min) return '0 分钟';
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60), m = min % 60;
  return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分钟';
}
function dueMs(t) {
  if (!t.date) return 0;
  const base = parseKey(t.date).getTime();
  if (!t.start) return 0;
  return base + toMin(t.start) * 60000;
}
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

/* ---------------- 指标（纯本地） ---------------- */
function log(event, data) {
  DB.metrics.push({ e: event, t: Date.now(), d: data || null });
  if (DB.metrics.length > 2000) DB.metrics = DB.metrics.slice(-1500);
}

/* ---------------- 数据操作 ---------------- */
function taskById(id) { return DB.tasks.find(t => t.id === id); }
function upsertTask(t) { const i = DB.tasks.findIndex(x => x.id === t.id); if (i >= 0) DB.tasks[i] = t; else DB.tasks.push(t); save(); syncNotifications(); }
function removeTask(id) {
  const i = DB.tasks.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = DB.tasks[i];
  DB.tasks.splice(i, 1); save(); syncNotifications();
  return { task: t, index: i };
}
function goalById(id) { return DB.goals.find(g => g.id === id); }
function goalProgress(g) {
  let n = +(g.manual || 0);
  for (const t of DB.tasks) if (t.goalId === g.id) n += doneCount(t);
  return Math.round(n * 100) / 100;
}
/* ---- 重复规则与实例 ---- */
function occursOn(t, key) {
  const r = t.repeat || 'none';
  if (r === 'none') return t.date === key;
  if (!t.date) return false;
  if (key < t.date) return false;
  const s = parseKey(t.date), c = parseKey(key);
  if (r === 'daily') return true;
  if (r === 'weekday') { const w = c.getDay(); return w >= 1 && w <= 5; }
  if (r === 'weekly') return c.getDay() === s.getDay();
  if (r === 'monthly') return c.getDate() === s.getDate();
  return false;
}
function isDoneOn(t, key) {
  if (!t.repeat || t.repeat === 'none') return !!t.done;
  return !!(t.doneMap && t.doneMap[key]);
}
function setDoneOn(t, key, val) {
  if (!t.repeat || t.repeat === 'none') {
    t.done = !!val; t.doneAt = val ? Date.now() : null;
  } else {
    if (!t.doneMap) t.doneMap = {};
    if (val) t.doneMap[key] = true; else delete t.doneMap[key];
  }
  t.updatedAt = Date.now();
}
function doneCount(t) {
  if (!t.repeat || t.repeat === 'none') return t.done ? 1 : 0;
  let n = 0; const m = t.doneMap || {};
  for (const k in m) if (m[k]) n++;
  return n;
}
function repLabel(r) { return ({ daily:'每天', weekday:'工作日', weekly:'每周', monthly:'每月' })[r] || '重复'; }
function nextDates(t, days) {
  const out = []; const base = new Date();
  for (let i = 0; i < days; i++) { const k = dateKey(addDays(base, i)); if (occursOn(t, k)) out.push(k); }
  return out;
}
function tasksOn(k) {
  return DB.tasks.filter(t => occursOn(t, k)).sort((a, b) => {
    const ad = isDoneOn(a, k), bd = isDoneOn(b, k);
    if (ad !== bd) return ad ? 1 : -1;
    const am = a.start ? toMin(a.start) : 9999, bm = b.start ? toMin(b.start) : 9999;
    return am - bm;
  });
}
function inboxTasks() {
  return DB.tasks.filter(t => !t.date).sort((a, b) => a.createdAt - b.createdAt);
}

/* ============================================================
   自然语言解析（记录时免手填）
   ============================================================ */
function parseCapture(text) {
  let s = ' ' + String(text || '').trim() + ' ';
  const out = { title: '', date: null, start: null, dur: null, cat: '' };

  const cm = s.match(/#([^\s#]+)/);
  if (cm) { out.cat = cm[1]; s = s.replace(cm[0], ' '); }

  const dm = s.match(/(\d+(?:\.\d+)?)\s*(小时|个小时|h|小时半|分钟|min|分)(?![a-zA-Z\u4e00-\u9fff])/);
  if (dm) {
    const v = parseFloat(dm[1]);
    out.dur = /小时|h/.test(dm[2]) ? Math.round(v * 60) : Math.round(v);
    s = s.replace(dm[0], ' ');
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let off = null;
  if (/大后天/.test(s)) { off = 3; s = s.replace('大后天', ' '); }
  else if (/后天/.test(s)) { off = 2; s = s.replace('后天', ' '); }
  else if (/明天|明日/.test(s)) { off = 1; s = s.replace(/明天|明日/, ' '); }
  else if (/今天|今日|今晚/.test(s)) { off = 0; s = s.replace(/今天|今日|今晚/, ' '); }
  else {
    const wm = s.match(/(下{1,2})?(?:周|星期|礼拜)([一二三四五六日天1-7])/);
    if (wm) {
      const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };
      const target = map[wm[2]];
      const weeks = wm[1] ? wm[1].length : 0;
      let diff = (target - today.getDay() + 7) % 7;
      if (diff === 0 && weeks === 0) diff = 7;
      off = diff + weeks * 7;
      s = s.replace(wm[0], ' ');
    }
  }

  let hh = null, mm = 0;
  const tm = s.match(/(上午|早上|早晨|凌晨|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2})\s*[点:：时]\s*(半|\d{1,2}分?)?/);
  if (tm) {
    hh = parseInt(tm[2], 10); 
    if (tm[3] === '半') mm = 30;
    else if (tm[3]) mm = parseInt(tm[3], 10);
    const ap = tm[1] || '';
    if (/下午|傍晚|晚上|夜里/.test(ap) && hh < 12) hh += 12;
    if (/中午/.test(ap) && hh < 12) hh = 12;
    if (/凌晨/.test(ap) && hh === 12) hh = 0;
    if (hh >= 24) hh = hh % 24;
    s = s.replace(tm[0], ' ');
  } else {
    const t2 = s.match(/(?:^|\s)(\d{1,2}):(\d{2})(?!\d)/);
    if (t2) { hh = parseInt(t2[1], 10); mm = parseInt(t2[2], 10); s = s.replace(t2[0], ' '); }
  }
  if (hh != null && (hh > 23 || mm > 59)) { hh = null; mm = 0; }

  out.title = s.replace(/\s+/g, ' ').trim() || '未命名';

  if (hh != null) {
    if (off == null) {
      const nowM = nowMin();
      off = (hh * 60 + mm) <= nowM ? 1 : 0;
    }
    out.date = dateKey(addDays(today, off));
    out.start = pad(hh) + ':' + pad(mm);
  } else if (off != null) {
    out.date = dateKey(addDays(today, off));
  }
  return out;
}
/* ============================================================
   提醒必达  预调度系统通知
   原则：不依赖进程存活；提前交给系统；永远有降级路径
   ============================================================ */
let syncTimer = null;
let syncing = false;
let notifReady = false;

async function initNotifications() {
  if (!IS_NATIVE) { notifReady = true; return; }
  try {
    if (PLATFORM === 'android') {
      await LocalNotifications.createChannel({
        id: CH_ID,
        name: '任务提醒',
        description: '到点提醒你开始任务',
        importance: 5,
        visibility: 1,
        vibration: true,
      });
      // 清理 v0.3.x 旧渠道（importance 无法原地修改）
      try { await LocalNotifications.deleteChannel({ id: 'reminders' }); } catch (e) {}
    }
    await LocalNotifications.registerActionTypes({
      types: [{
        id: 'TASK_DUE',
        actions: [
          { id: 'done', title: '完成' },
          { id: 'snooze', title: '稍后10分钟' },
        ],
      }],
    });
    LocalNotifications.addListener('localNotificationActionPerformed', async (ev) => {
      const extra = (ev.notification && ev.notification.extra) || {};
      const id = extra.taskId;
      log('reminder_action', { action: ev.actionId });
      if (!id) return;
      if (ev.actionId === 'done') {
        const t = taskById(id);
        const k = extra.key || (t && t.date) || todayKey();
        if (t && !isDoneOn(t, k)) { setDoneOn(t, k, true); save(); syncNotifications(); toast('已完成：' + t.title); renderAll(); }
      } else if (ev.actionId === 'snooze') {
        snoozeTask(id, 10);
      } else {
        const t = taskById(id);
        if (t) openTask(t);
      }
    });
    LocalNotifications.addListener('localNotificationReceived', () => {
      log('reminder_shown', null);
    });
    notifReady = true;
  } catch (e) { log('notif_init_failed', String(e && e.message || e)); }
}

function syncNotifications() {
  if (!IS_NATIVE) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(doSync, 500);
}

async function doSync() {
  if (syncing) { syncNotifications(); return; }
  syncing = true;
  try {
    const pend = await LocalNotifications.getPending();
    if (pend.notifications && pend.notifications.length) {
      await LocalNotifications.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) });
    }
    if (!DB.settings.remind) { syncing = false; return; }

    const now = Date.now();
    const prep = +DB.settings.prepMin || 0;
    const items = [];
    for (const t of DB.tasks) {
      if (!t.date || !t.start) continue;
      const dates = (t.repeat && t.repeat !== 'none') ? nextDates(t, 30) : [t.date];
      for (const k of dates) {
        if (isDoneOn(t, k)) continue;
        const due = parseKey(k).getTime() + toMin(t.start) * 60000;
        if (due <= now + 20000) continue;
        if (prep > 0) {
          const pp = due - prep * 60000;
          if (pp > now + 20000) items.push({ at: pp, t, kind: 'prep', k });
        }
        items.push({ at: due, t, kind: 'due', k });
      }
    }
    items.sort((a, b) => a.at - b.at);
    const win = items.slice(0, MAX_SCHED);
    if (!win.length) { syncing = false; return; }

    const soundMap = { default: 'default', chime: 'chime', alarm: 'alarm' };
    const notifs = win.map((it, i) => {
      const isDue = it.kind === 'due';
      const t = it.t;
      const n = {
        id: 100000 + i,
        title: isDue ? t.title : (prep + ' 分钟后：' + t.title),
        body: isDue
          ? (t.start + (t.dur ? '  ' + fmtDur(t.dur) : '') + (t.cat ? '  ' + t.cat : ''))
          : '准备一下，马上开始',
        schedule: { at: new Date(it.at), allowWhileIdle: true },
        channelId: CH_ID,
        extra: { taskId: t.id, kind: it.kind, at: it.at, key: it.k },
      };
      if (isDue) n.actionTypeId = 'TASK_DUE';
      if (DB.settings.sound !== 'default') n.sound = DB.settings.sound;
      return n;
    });
    await LocalNotifications.schedule({ notifications: notifs });
    log('reminder_due', { count: notifs.length });
  } catch (e) {
    log('sync_failed', String(e && e.message || e));
  }
  syncing = false;
}

function snoozeTask(id, min) {
  const t = taskById(id);
  if (!t) return;
  const at = Date.now() + min * 60000;
  if (t.repeat && t.repeat !== 'none') {
    if (IS_NATIVE) {
      LocalNotifications.schedule({ notifications: [{
        id: 500000 + Math.floor(Math.random() * 100000),
        title: t.title, body: '（稍后提醒）',
        schedule: { at: new Date(at), allowWhileIdle: true },
        channelId: CH_ID, actionTypeId: 'TASK_DUE',
        extra: { taskId: t.id, kind: 'due', key: todayKey() },
      }] }).catch(() => {});
    }
    toast('已推迟 ' + min + ' 分钟：' + t.title);
    return;
  }
  const d = new Date(at);
  t.date = dateKey(d);
  t.start = pad(d.getHours()) + ':' + pad(d.getMinutes());
  save(); syncNotifications(); renderAll();
  toast('已推迟 ' + min + ' 分钟：' + t.title);
}

async function checkPermStatus() {
  const out = { display: 'unknown', exact: 'unknown' };
  if (!IS_NATIVE) { out.display = 'web'; return out; }
  try {
    const p = await LocalNotifications.checkPermissions();
    out.display = p.display;
  } catch (e) { out.display = 'error'; }
  return out;
}

async function requestPerm() {
  if (!IS_NATIVE) { toast('浏览器中请在站点设置里允许通知'); return; }
  try {
    const p = await LocalNotifications.requestPermissions();
    if (p.display === 'granted') {
      toast('已获得通知权限');
      DB.settings.remind = true; save();
      syncNotifications();
    } else {
      toast('未获得权限，提醒将无法送达');
    }
    refreshPermUI();
  } catch (e) { toast('请求权限失败：' + (e.message || e)); }
}

async function sendTestNotification() {
  const dev = await getDevice();
  if (dev) log('device_info', dev);
  if (!IS_NATIVE) { toast('请在手机上测试'); return; }
  try {
    const p = await LocalNotifications.checkPermissions();
    if (p.display !== 'granted') { await requestPerm(); }
    await LocalNotifications.schedule({
      notifications: [{
        id: 999999,
        title: '测试提醒',
        body: '如果你看到这条通知，说明提醒链路是通的',
        schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true },
        channelId: CH_ID,
        actionTypeId: 'TASK_DUE',
        extra: { test: true },
      }],
    });
    toast('5 秒后会收到测试提醒');
  } catch (e) { toast('发送失败：' + (e.message || e)); }
}

/* ============================================================
   渲染（时间规划版）
   ============================================================ */
let viewY = null, viewM = null, selKey = null;
let listRange = '7d';       // today | 7d | all
let calMode = 'month';      // month | day

function goToDate(k) { selKey = k; viewY = parseKey(k).getFullYear(); viewM = parseKey(k).getMonth(); }

function renderAll() {
  renderList();
  renderCal();
  renderGoals();
  renderMe();
  updateHeader();
  const gd = $('#sheetGoalDetail');
  if (gd && !gd.hidden) renderGoalDetail();
}

function tabKind() {
  return ['list', 'cal', 'goals', 'me'].indexOf(curTab);
}
function updateHeader() {
  const d = new Date();
  const T = { list: '清单', cal: '日历', goals: '目标', me: '我的' };
  $('#hdrTitle').textContent = T[curTab] || '清单';
  const ha = $('#hdrAction');
  if (ha) ha.hidden = (curTab !== 'list');
  if (curTab === 'list') {
    const n = DB.tasks.filter(t => !isDoneOn(t, t.date || todayKey()) && !t.done).length;
    $('#hdrSub').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WD[d.getDay()] + '  ' + n + ' 项待办';
  } else if (curTab === 'cal') {
    $('#hdrSub').textContent = relDay(selKey || todayKey());
  } else if (curTab === 'goals') {
    $('#hdrSub').textContent = DB.goals.length ? DB.goals.length + ' 个目标' : '给每天定个方向';
  } else {
    $('#hdrSub').textContent = '设置与统计';
  }
}

/* ---------------- 任务卡片（时间右置） ---------------- */
function cardHTML(t, opts) {
  opts = opts || {};
  const ckKey = opts.key || t.date || '';
  const done = ckKey ? isDoneOn(t, ckKey) : !!t.done;
  const isRep = t.repeat && t.repeat !== 'none';
  const tk = todayKey();
  const nowM = nowMin();

  let endTxt = '', timeCls = '', timeMain = '';
  if (t.start) {
    const s = toMin(t.start);
    const d = t.dur && t.dur > 0 ? t.dur : 60;
    let isNow = false, late = false;
    if (ckKey === tk) {
      isNow = nowM >= s && nowM < s + d && !done;
      late = !done && nowM >= s + d;
    }
    timeMain = t.start;
    endTxt = fromMin(s + d);
    timeCls = isNow ? ' now' : (late ? ' soon' : '');
  } else {
    timeMain = t.date ? '全天' : '未安排';
  }

  const sub = [];
  if (t.cat) sub.push(esc(t.cat));
  if (t.priority === 'high') sub.push('<b style="color:var(--high)">高</b>');
  else if (t.priority === 'low') sub.push('<b style="color:var(--low)">低</b>');
  if (isRep) sub.push(repLabel(t.repeat));
  if (t.goalId) { const g = goalById(t.goalId); if (g) sub.push('<span class="c-goal">' + esc(g.title) + '</span>'); }
  if (done && isRep) sub.push('已完成 ' + doneCount(t) + ' 次');

  let acts = '';
  if (opts.inboxActions) {
    acts = '<div class="c-act">' +
      '<button class="mini-btn" data-today="' + t.id + '" title="安排到今天"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></button>' +
      '<button class="mini-btn" data-tomorrow="' + t.id + '" title="明天"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>';
  }

  const timeCol = '<div class="c-time-col' + timeCls + '">' + timeMain + (endTxt ? '<em>' + endTxt + '</em>' : '') + '</div>';

  return '<div class="card' + (done ? ' done' : '') + (timeCls === ' now' ? ' now' : '') + '" data-card="' + t.id + '" data-k="' + ckKey + '">' +
    '<button class="check" data-done="' + t.id + '" data-k="' + ckKey + '" aria-label="完成"></button>' +
    '<div class="c-main" data-edit="' + t.id + '">' +
      '<div class="c-title">' + esc(t.title) + '</div>' +
      (sub.length ? '<div class="c-sub">' + sub.map(x => x.indexOf('<') === 0 ? x : '<span>' + x + '</span>').join('') + '</div>' : '') +
    '</div>' + timeCol + acts + '</div>';
}

function itemDone(it, tk) { return isDoneOn(it.t, it.key || it.t.date || tk); }
function sortItems(items, tk) {
  return items.sort((a, b) => {
    const ad = itemDone(a, tk), bd = itemDone(b, tk);
    if (ad !== bd) return ad ? 1 : -1;
    const am = a.t.start ? toMin(a.t.start) : 9999, bm = b.t.start ? toMin(b.t.start) : 9999;
    return am - bm;
  });
}

/* ---------------- 清单：按日期分组 ---------------- */
function renderList() {
  const body = $('#listBody');
  if (!body) return;
  const tk = todayKey();
  const horizon = listRange === 'today' ? 0 : (listRange === '7d' ? 6 : 3650);

  const overdue = [], inbox = [];
  const byDate = new Map();
  const push = (k, it) => { if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(it); };

  for (const t of DB.tasks) {
    const isRep = t.repeat && t.repeat !== 'none';
    if (!t.date) { inbox.push({ t, key: null }); continue; }
    if (isRep) {
      const days = Math.min(horizon + 1, 400);
      for (const k of nextDates(t, days)) {
        if (k < tk) continue;
        push(k, { t, key: k });
      }
    } else {
      if (t.date < tk) { if (!t.done) overdue.push({ t, key: t.date }); continue; }
      if (t.date > tk && daysBetween(tk, t.date) > horizon) continue;
      push(t.date, { t, key: t.date });
    }
  }

  let h = '';
  const group = (title, cls, items, addDate, extraBtn) => {
    if (!items.length) return '';
    sortItems(items, tk);
    const doneN = items.filter(it => itemDone(it, tk)).length;
    const shown = hideDone ? items.filter(it => !itemDone(it, tk)) : items;
    if (!shown.length) return '';
    return '<div class="grp">' +
      '<span class="grp-t ' + cls + '">' + esc(title) + '</span>' +
      '<span class="grp-n">' + (doneN ? doneN + '/' + items.length : items.length) + '</span>' +
      '<span class="grp-line"></span>' +
      (extraBtn || '') +
      (addDate ? '<button class="grp-add" data-newon="' + addDate + '">+ 添加</button>' : '') +
      '</div><div class="list">' + shown.map(it => cardHTML(it.t, { key: it.key })).join('') + '</div>';
  };

  h += group('已逾期', 'past', overdue, null, '<button class="grp-add" data-carry="1">全部顺延</button>');
  h += group('今天', 'today', byDate.get(tk) || [], tk);

  const futureKeys = Array.from(byDate.keys()).filter(k => k > tk).sort();
  for (const k of futureKeys) h += group(relDay(k), '', byDate.get(k), k);

  if (inbox.length) {
    sortItems(inbox, tk);
    h += '<div class="grp"><span class="grp-t">未安排</span>' +
      '<span class="grp-n">' + inbox.length + '</span><span class="grp-line"></span></div>' +
      '<div class="c-empty-note" style="margin:-4px 2px 8px">还没排到具体时间，点右侧箭头安排到今天/明天</div>' +
      '<div class="list">' + inbox.map(it => cardHTML(it.t, { inboxActions: true })).join('') + '</div>';
  }

  if (!h) {
    h = '<div class="empty"><p>这段时间还没有安排</p><p class="muted small">点右下角 + 记一件事，说「明天下午3点」会自动排好</p></div>';
  }
  body.innerHTML = h;

  // 进度条
  const tkItems = byDate.get(tk) || [];
  if (tkItems.length) {
    const dn = tkItems.filter(it => itemDone(it, tk)).length;
    $('#progStrip').hidden = false;
    $('#progText').textContent = '今天 ' + dn + '/' + tkItems.length;
    $('#progBar').style.width = Math.round(dn / tkItems.length * 100) + '%';
  } else {
    $('#progStrip').hidden = true;
  }
}

/* ---------------- 日历 ---------------- */
function renderCal() {
  if (!selKey) selKey = todayKey();
  if (viewY == null) { const d = parseKey(selKey); viewY = d.getFullYear(); viewM = d.getMonth(); }
  const isMonth = calMode === 'month';
  $('#calMonthBox').hidden = !isMonth;
  $('#calDayBox').hidden = isMonth;
  if (!$('#mLabel')) return;

  if (isMonth) {
    $('#mLabel').textContent = viewY + '年' + (viewM + 1) + '月';
    const head = $('#calHead');
    if (!head.innerHTML) head.innerHTML = ['一', '二', '三', '四', '五', '六', '日'].map(x => '<span>' + x + '</span>').join('');
    const first = new Date(viewY, viewM, 1);
    const off = (first.getDay() + 6) % 7;
    const start = addDays(first, -off);
    const tk = todayKey();
    const counts = {};
    for (const t of DB.tasks) {
      if (!t.date) continue;
      const isRep = t.repeat && t.repeat !== 'none';
      if (isRep) continue;
      counts[t.date] = (counts[t.date] || 0) + (t.done ? 0 : 1);
    }
    let h = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i), k = dateKey(d);
      const other = d.getMonth() !== viewM;
      const n = counts[k] || 0;
      const dots = n ? '<span class="cal-dots">' + Array(Math.min(n, 3)).fill('<i></i>').join('') + '</span>' : '<span class="cal-dots"></span>';
      h += '<button class="cal-cell' + (other ? ' other' : '') + (k === tk ? ' today' : '') + (k === selKey ? ' sel' : '') + '" data-day="' + k + '">' +
        '<span>' + d.getDate() + '</span>' + dots + '</button>';
    }
    $('#calGrid').innerHTML = h;
  } else {
    $('#dLabel').textContent = relDay(selKey);
    renderTimeAxis(selKey);
  }
  renderDayList(selKey);
}

function renderTimeAxis(key) {
  const tl = $('#timeline');
  if (!tl) return;
  const H = 48;
  const items = tasksOn(key).filter(t => t.start);
  const now = nowMin();
  let h = '';
  for (let i = 0; i < 24; i++) h += '<div class="tl-row" style="top:' + (i * H) + 'px"><span class="tl-h">' + pad(i) + ':00</span></div>';
  for (const t of items) {
    const s = toMin(t.start);
    const d = t.dur && t.dur > 0 ? t.dur : 60;
    const done = isDoneOn(t, key);
    const isNow = key === todayKey() && now >= s && now < s + d && !done;
    const c = t.priority === 'high' ? 'var(--high)' : (t.priority === 'low' ? 'var(--low)' : 'var(--brand)');
    h += '<div class="tl-ev' + (done ? ' done' : '') + (isNow ? ' now' : '') + '" data-edit="' + t.id + '" ' +
      'style="top:' + (s / 60 * H) + 'px;height:' + Math.max(26, d / 60 * H) + 'px;border-left-color:' + c + '">' +
      esc(t.title) + '<small>' + t.start + '  ' + fromMin(s + d) + '</small></div>';
  }
  if (key === todayKey()) h += '<div class="tl-now" style="top:' + (now / 60 * H) + 'px"></div>';
  if (!items.length) h += '<div class="tl-empty">这天没有安排具体时间的任务</div>';
  tl.innerHTML = h;

  const first = items.length ? Math.min(...items.map(t => toMin(t.start))) : (key === todayKey() ? now : 8 * 60);
  tl.scrollTop = Math.max(0, first / 60 * H - 90);
}

function renderDayList(key) {
  const dl = tasksOn(key);
  $('#dayLabel').textContent = relDay(key) + '的安排';
  $('#dayMeta').textContent = dl.length ? dl.length + ' 项' : '';
  $('#dayList').innerHTML = dl.length
    ? dl.map(t => cardHTML(t, { key })).join('')
    : '<div class="empty"><p class="muted small">这天还没有安排</p></div>';
}

/* ---------------- 目标 ---------------- */
function renderGoals() {
  const list = DB.goals;
  $('#goalEmpty').hidden = !!list.length;
  $('#goalList').innerHTML = list.map(g => {
    const pv = goalProgress(g);
    const tv = +g.target || 1;
    const pct = Math.min(100, Math.round(pv / tv * 100));
    const ts = DB.tasks.filter(t => t.goalId === g.id);
    const dc = ts.reduce((a, t) => a + doneCount(t), 0);
    return '<div class="goal-card" data-goal="' + g.id + '">' +
      '<div class="goal-top"><span class="goal-name">' + esc(g.title) + '</span>' +
      '<span class="goal-pct">' + pct + '%</span></div>' +
      '<div class="goal-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="goal-nums"><span><b>' + pv + '</b> / ' + tv + ' ' + esc(g.unit || '') + '</span>' +
      '<span>' + ts.length + ' 个任务  完成 ' + dc + '</span></div></div>';
  }).join('');
}

/* ---------------- 我的 ---------------- */
function doneOnDate(k) {
  let n = 0;
  for (const t of DB.tasks) {
    if (t.repeat && t.repeat !== 'none') { if (t.doneMap && t.doneMap[k]) n++; }
    else if (t.done) {
      const dk = t.doneAt ? dateKey(new Date(t.doneAt)) : null;
      if (dk === k || (!t.doneAt && t.date === k)) n++;
    }
  }
  return n;
}

function renderMe() {
  const tk = todayKey();
  const items = tasksOn(tk);
  const dn = items.filter(t => isDoneOn(t, tk)).length;
  $('#meTodayDone').textContent = dn;
  let wk = 0;
  for (let i = 0; i < 7; i++) wk += doneOnDate(dateKey(addDays(new Date(), -i)));
  $('#meWeekDone').textContent = wk;
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const k = dateKey(addDays(new Date(), -i));
    if (doneOnDate(k) > 0) streak++;
    else if (i > 0) break;
  }
  $('#meStreak').textContent = streak;
  $('#stCount').textContent = DB.tasks.length + ' 项 / ' + DB.goals.length + ' 个';
  const cd = $('#btnClearDone');
  if (cd) { const cn = completedCount(); cd.textContent = cn ? '清除已完成 (' + cn + ')' : '清除已完成'; }
  $('#stBackup').textContent = DB.lastBackup ? new Date(DB.lastBackup).toLocaleDateString() : '从未';
}
/* ============================================================
   抽屉与编辑
   ============================================================ */
let curTab = 'list';
let editingTask = null;
let editingGoal = null;

function openSheet(id) { const el = $('#' + id); if (el) el.hidden = false; }
function closeSheet(id) { const el = $('#' + id); if (el) el.hidden = true; }
function closeAllSheets() { ['sheetTask', 'sheetGoal', 'sheetGoalDetail', 'sheetListMenu', 'sheetQuick', 'sheetHealth'].forEach(closeSheet); }

function pickNative(type, cur, cb) {
  let inp = document.getElementById('__pick_' + type);
  if (!inp) {
    inp = document.createElement('input');
    inp.type = type;
    inp.id = '__pick_' + type;
    inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { if (inp.value) cb(inp.value); });
  }
  inp.value = cur || '';
  try { inp.showPicker ? inp.showPicker() : inp.click(); } catch (e) { inp.click(); }
}

const DUR_STEPS = [15, 30, 45, 60, 90, 120, 180, 240, 0];

function updateTaskChips() {
  const t = editingTask;
  $('#tDate').textContent = t.date ? relDay(t.date) : '未安排';
  $('#tDate').classList.toggle('active', !!t.date);
  $('#tTime').textContent = t.start ? t.start : '全天';
  $('#tTime').classList.toggle('active', !!t.start);
  $('#tDur').textContent = t.dur ? fmtDur(t.dur) : '不设时长';
  $('#tDur').classList.toggle('active', !!t.dur);
  $$('#tPriRow .chip-btn').forEach(b => b.classList.toggle('active', b.dataset.pri === (t.priority || 'mid')));
}

function renderGoalSelect() {
  const sel = $('#tGoal');
  sel.innerHTML = '<option value="">不关联目标</option>' +
    DB.goals.map(g => '<option value="' + g.id + '">' + esc(g.title) + '</option>').join('');
}

function openTask(t) {
  if (t) {
    editingTask = Object.assign({}, t);
  } else {
    editingTask = newTask();
  }
  $('#tTitle').value = editingTask.title === '未命名' ? '' : (editingTask.title || '');
  $('#tCat').value = editingTask.cat || '';
  $('#tNote').value = editingTask.note || '';
  $('#tRepeat').value = editingTask.repeat || 'none';
  renderGoalSelect();
  $('#tGoal').value = editingTask.goalId || '';
  updateTaskChips();
  $('#tDelete').hidden = !t;
  openSheet('sheetTask');
  if (!t) setTimeout(() => { try { $('#tTitle').focus(); } catch (e) {} }, 260);
}
function openTaskById(id) { const t = taskById(id); if (t) openTask(t); }

function saveTask() {
  const t = editingTask;
  if (!t) return;
  t.title = ($('#tTitle').value || '').trim() || '未命名';
  t.cat = ($('#tCat').value || '').trim();
  t.note = ($('#tNote').value || '').trim();
  t.repeat = $('#tRepeat').value || 'none';
  t.goalId = $('#tGoal').value || '';
  t.updatedAt = Date.now();
  upsertTask(t);
  log('task_created', { date: t.date, start: t.start, cat: t.cat });
  closeSheet('sheetTask');
  renderAll();
  toast(t.date ? ('已安排到 ' + relDay(t.date)) : '已存入收集箱');
}
function deleteTaskById(id) {
  const r = removeTask(id);
  if (!r) return;
  renderAll();
  toast('已删除：' + r.task.title, '撤销', () => {
    DB.tasks.splice(r.index, 0, r.task); save(); syncNotifications(); renderAll();
  });
}

function toggleDone(id, key) {
  const t = taskById(id);
  if (!t) return;
  const k = key || t.date || todayKey();
  const nowDone = !isDoneOn(t, k);
  setDoneOn(t, k, nowDone);
  save(); syncNotifications(); renderAll();
  log('task_completed', { done: nowDone, from: curTab, key: k });
  if (nowDone) toast('完成：' + t.title, '撤销', () => { setDoneOn(t, k, false); save(); syncNotifications(); renderAll(); });
}

function assignTask(id, dateKeyVal) {
  const t = taskById(id);
  if (!t) return;
  t.date = dateKeyVal; t.updatedAt = Date.now();
  save(); syncNotifications(); renderAll();
  toast('已安排到 ' + relDay(dateKeyVal), '撤销', () => { t.date = null; save(); syncNotifications(); renderAll(); });
}

/* ------------- 目标详情：直接为目标添加任务 ------------- */
let curGoalId = null;
let gdRepeatVal = 'none';

function openGoalDetail(id) {
  const g = goalById(id);
  if (!g) return;
  curGoalId = id;
  gdRepeatVal = 'none';
  $('#gdInput').value = '';
  $('#gdHint').textContent = '默认安排到今天，输入「明天下午3点」可自动识别时间';
  $$('#gdRepeat .chip-btn').forEach(b => b.classList.toggle('active', b.dataset.rep === 'none'));
  renderGoalDetail();
  openSheet('sheetGoalDetail');
  log('goal_open', { id: id });
}

function goalTaskRow(t) {
  const tk = todayKey();
  const occurs = occursOn(t, tk);
  const doneToday = occurs && isDoneOn(t, tk);
  const isRep = t.repeat && t.repeat !== 'none';
  const parts = [];
  if (isRep) { parts.push(repLabel(t.repeat)); parts.push('已完成 ' + doneCount(t) + ' 次'); }
  else if (t.date) parts.push(t.date === tk ? '今天' : relDay(t.date));
  else parts.push('未安排');
  if (t.start) parts.push(t.start);
  if (t.cat) parts.push(t.cat);
  return '<div class="card' + (doneToday ? ' done' : '') + '">' +
    (occurs
      ? '<button class="check" data-done="' + t.id + '" data-k="' + tk + '" aria-label="完成"></button>'
      : '<span class="check ghost"></span>') +
    '<div class="c-main" data-edit="' + t.id + '">' +
      '<div class="c-title">' + esc(t.title) + '</div>' +
      '<div class="c-sub">' + parts.map(x => '<span>' + esc(x) + '</span>').join('') + '</div>' +
    '</div>' +
    '<div class="c-act"><button class="mini-btn" data-edit="' + t.id + '" title="编辑">' +
    '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button></div>' +
  '</div>';
}

function renderGoalDetail() {
  const g = goalById(curGoalId);
  if (!g) return;
  const pv = goalProgress(g);
  const tv = +g.target || 1;
  const pct = Math.min(100, Math.round(pv / tv * 100));
  $('#gdTitle').textContent = g.title;
  $('#gdPct').textContent = pct + '%';
  $('#gdBar').style.width = pct + '%';
  $('#gdNums').innerHTML = '<b>' + pv + '</b> / ' + tv + ' ' + esc(g.unit || '');
  const ts = DB.tasks.filter(t => t.goalId === g.id);
  const tk = todayKey();
  const isRep = t => t.repeat && t.repeat !== 'none';
  const pending = ts.filter(t => isRep(t) ? true : !t.done);
  const finished = ts.filter(t => isRep(t) ? false : !!t.done);
  pending.sort((a, b) => {
    const ao = occursOn(a, tk) ? 0 : 1, bo = occursOn(b, tk) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const am = a.start ? toMin(a.start) : 9999, bm = b.start ? toMin(b.start) : 9999;
    return am - bm;
  });
  finished.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  $('#gdSub').textContent = ts.length + ' 个关联任务';
  $('#gdTodoMeta').textContent = pending.length ? pending.length + ' 项' : '';
  $('#gdTodo').innerHTML = pending.length ? pending.map(goalTaskRow).join('')
    : '<div class="empty"><p class="muted small">还没有关联任务</p><p class="muted small">用上面的输入框加一个，选「每天」就是每日任务</p></div>';
  $('#gdDoneHead').hidden = !finished.length;
  $('#gdDoneMeta').textContent = finished.length ? finished.length + ' 项' : '';
  $('#gdDone').innerHTML = finished.slice(0, 20).map(goalTaskRow).join('');
}

function goalQuickAdd() {
  const g = goalById(curGoalId);
  if (!g) return;
  const raw = ($('#gdInput').value || '').trim();
  if (!raw) { toast('先输入任务内容'); return; }
  const p = parseCapture(raw);
  const t = {
    id: uid(),
    title: p.title,
    date: p.date || todayKey(),
    start: p.start || null,
    dur: p.dur != null ? p.dur : 60,
    done: false, doneMap: {},
    priority: 'mid',
    cat: p.cat || '',
    goalId: g.id,
    repeat: gdRepeatVal,
    note: '',
    createdAt: Date.now(),
  };
  DB.tasks.push(t);
  save(); syncNotifications(); renderAll();
  $('#gdInput').value = '';
  log('task_created', { entry: 'goal', repeat: gdRepeatVal, hasTime: !!t.start });
  toast('已添加「' + t.title + '」' + (t.repeat !== 'none' ? '  ' + repLabel(t.repeat) : ''), '撤销', () => {
    const i = DB.tasks.indexOf(t); if (i >= 0) DB.tasks.splice(i, 1);
    save(); syncNotifications(); renderAll();
  });
}

function bindGoalDetail() {
  $('#gdAdd').addEventListener('click', goalQuickAdd);
  $('#gdInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); goalQuickAdd(); } });
  $('#gdInput').addEventListener('input', () => {
    const v = $('#gdInput').value.trim();
    if (!v) { $('#gdHint').textContent = '默认安排到今天，输入「明天下午3点」可自动识别时间'; return; }
    const p = parseCapture(v);
    const bits = [];
    if (p.date) bits.push(relDay(p.date));
    if (p.start) bits.push(p.start);
    if (p.dur) bits.push(fmtDur(p.dur));
    $('#gdHint').innerHTML = bits.length
      ? '识别为：<b>' + bits.join('  ') + '</b>  ' + esc(p.title)
      : '将安排到今天（可用「明天下午3点」「1小时」）';
  });
  $('#gdRepeat').addEventListener('click', e => {
    const b = e.target.closest('[data-rep]');
    if (!b) return;
    gdRepeatVal = b.dataset.rep;
    $$('#gdRepeat .chip-btn').forEach(x => x.classList.toggle('active', x === b));
  });
  $('#gdEdit').addEventListener('click', () => {
    const g = goalById(curGoalId);
    closeSheet('sheetGoalDetail');
    if (g) openGoal(g);
  });
  $('#gdClose').addEventListener('click', () => closeSheet('sheetGoalDetail'));
}

/* ------------- 目标 ------------- */
let editingGoalId = null;
function openGoal(g) {
  editingGoalId = g ? g.id : null;
  $('#gTitle').value = g ? g.title : '';
  $('#gTarget').value = g ? (g.target || 10) : 10;
  $('#gUnit').value = g ? (g.unit || '') : '';
  $('#gManual').value = g ? (g.manual || 0) : 0;
  $('#gDelete').hidden = !g;
  openSheet('sheetGoal');
  if (!g) setTimeout(() => { try { $('#gTitle').focus(); } catch (e) {} }, 260);
}
function saveGoal() {
  const title = ($('#gTitle').value || '').trim();
  if (!title) { toast('请填写目标名称'); return; }
  const data = {
    title,
    target: Math.max(1, +$('#gTarget').value || 1),
    unit: ($('#gUnit').value || '').trim(),
    manual: Math.max(0, +$('#gManual').value || 0),
    updatedAt: Date.now(),
  };
  if (editingGoalId) {
    const g = goalById(editingGoalId);
    if (g) Object.assign(g, data);
  } else {
    DB.goals.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
  }
  save(); closeSheet('sheetGoal'); renderAll();
  toast('目标已保存');
}
function deleteGoal() {
  if (!editingGoalId) return;
  const i = DB.goals.findIndex(g => g.id === editingGoalId);
  if (i < 0) return;
  const g = DB.goals[i];
  const rel = DB.tasks.filter(t => t.goalId === g.id);
  DB.goals.splice(i, 1);
  rel.forEach(t => { t.goalId = ''; });
  save(); closeSheet('sheetGoal'); renderAll();
  toast('已删除目标', '撤销', () => {
    DB.goals.splice(i, 0, g);
    rel.forEach(t => { t.goalId = g.id; });
    save(); renderAll();
  });
}

/* ------------- 快速记录计时 ---- */
let captureStartAt = 0;

/* ============================================================
   设置 / 备份
   ============================================================ */
function applyTheme() {
  document.documentElement.dataset.theme = DB.settings.dark ? 'dark' : 'light';
  $('#setDark').checked = !!DB.settings.dark;
}

function exportData() {
  const json = JSON.stringify(DB, null, 2);
  DB.lastBackup = Date.now(); save();
  $('#stBackup').textContent = '刚刚';
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'shiguangzhou-' + todayKey() + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 800);
  } catch (e) {}
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).then(
      () => toast('备份已导出，同时也复制到了剪贴板'),
      () => toast('备份已导出')
    );
  } else toast('备份已导出');
}

function importData(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const o = JSON.parse(fr.result);
      if (!o || !Array.isArray(o.tasks)) throw new Error('格式不正确');
      if (!confirm('导入将覆盖当前数据，确定吗？')) return;
      DB = Object.assign(DEFAULT(), o);
      DB.settings = Object.assign(DEFAULT().settings, o.settings || {});
      save(); applyTheme(); syncNotifications(); renderAll(); refreshPermUI();
      toast('已导入 ' + DB.tasks.length + ' 项任务');
    } catch (e) { toast('导入失败：' + e.message); }
  };
  fr.readAsText(file);
}

function clearAll() {
  if (!confirm('确定清空全部任务与目标？此操作不可撤销。')) return;
  const backup = JSON.parse(JSON.stringify(DB));
  DB.tasks = []; DB.goals = []; DB.metrics = [];
  save(); syncNotifications(); renderAll();
  toast('已清空', '撤销', () => { DB = backup; save(); syncNotifications(); renderAll(); });
}

/* ============================================================
   事件
   ============================================================ */
function switchTab(tab) {
  curTab = tab;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === tab));
  if (tab === 'cal' && !selKey) selKey = todayKey();
  renderAll();
  const sc = document.querySelector('.screen.active');
  if (sc) sc.scrollTop = 0;
}

/* ---------------- 已完成：统计 / 隐藏 / 清除 ---------------- */
let hideDone = false;

/* 重复任务是常驻系列（doneMap 只记某天），不能整条清除 */
function isCompleted(t) {
  if (t.repeat && t.repeat !== 'none') return false;
  return !!t.done;
}
function completedCount() {
  let n = 0;
  for (const t of DB.tasks) if (isCompleted(t)) n++;
  return n;
}
function overdueCount() {
  const tk = todayKey();
  let n = 0;
  for (const t of DB.tasks) {
    if (!t.date || t.done) continue;
    if (t.repeat && t.repeat !== 'none') continue;
    if (t.date < tk) n++;
  }
  return n;
}
function clearCompleted() {
  const n = completedCount();
  if (!n) { toast('没有已完成的任务'); return; }
  const backup = DB.tasks.slice();
  DB.tasks = DB.tasks.filter(t => !isCompleted(t));
  save(); syncNotifications(); renderAll();
  log('clear_completed', { n: n });
  toast('已清除 ' + n + ' 项已完成', '撤销', () => {
    DB.tasks = backup;
    save(); syncNotifications(); renderAll();
    toast('已恢复 ' + n + ' 项');
  });
}

/* ---------------- 清单操作菜单 ---------------- */
function openListMenu() {
  $('#lmHideState').textContent = hideDone ? '已开启' : '已关闭';
  const cn = completedCount();
  $('#lmClearCount').textContent = cn ? cn + ' 项' : '无';
  const on = overdueCount();
  $('#lmOverdueCount').textContent = on ? on + ' 项' : '无';
  openSheet('sheetListMenu');
}

/* ---------------- 快速添加（FAB） ---------------- */
let qDateOverride = null;

function newTask(extra) {
  return Object.assign({
    id: uid(), title: '', date: todayKey(), start: null, dur: 60,
    done: false, doneMap: {}, priority: 'mid', cat: '', goalId: '',
    repeat: 'none', note: '', createdAt: Date.now(),
  }, extra || {});
}

function openQuick() {
  qDateOverride = null;
  $('#qInput').value = '';
  $$('#qDates .chip-btn').forEach(b => b.classList.remove('active'));
  updateQuickHint();
  openSheet('sheetQuick');
  log('capture_start', { entry: 'fab' });
  captureStartAt = Date.now();
  setTimeout(() => { try { $('#qInput').focus(); } catch (e) {} }, 260);
}

function updateQuickHint() {
  const el = $('#qHint');
  if (!el) return;
  const v = ($('#qInput').value || '').trim();
  if (!v) { el.innerHTML = '支持「明天下午3点」「1小时」「#分类」；不写日期默认排到今天'; return; }
  const p = parseCapture(v);
  const bits = [];
  let date = p.date, start = p.start;
  if (qDateOverride === 'none') { date = null; start = null; }
  else if (qDateOverride) date = qDateOverride;
  if (date) bits.push(relDay(date));
  if (start) bits.push(start);
  if (p.dur) bits.push(fmtDur(p.dur));
  if (p.cat) bits.push('#' + p.cat);
  el.innerHTML = bits.length
    ? '将创建：<b>' + bits.join('  ') + '</b>  ' + esc(p.title)
    : '将存入<b>未安排</b>（点上面的按钮也能指定日期）';
}

function markQuickDate(v) {
  $$('#qDates .chip-btn').forEach(b => {
    const on = (v === 'none' && b.dataset.qd === 'none') || (v && v !== 'none' && b.dataset.qd === 'pick' && qDateOverride && qDateOverride !== 'none');
    b.classList.toggle('active', !!on);
  });
}

function quickAdd() {
  const raw = ($('#qInput').value || '').trim();
  if (!raw) { toast('先输入内容'); return; }
  const p = parseCapture(raw);
  let date = p.date, start = p.start;
  if (qDateOverride === 'none') { date = null; start = null; }
  else if (qDateOverride) { date = qDateOverride; }
  else if (!date) { date = todayKey(); }
  const t = newTask({
    title: p.title, date: date, start: start,
    dur: start ? (p.dur != null ? p.dur : 60) : 0,
    cat: p.cat || '',
  });
  DB.tasks.push(t);
  save(); syncNotifications(); renderAll();
  log('task_created', { entry: 'fab', hasDate: !!t.date, hasTime: !!t.start, latency: Date.now() - captureStartAt });
  closeSheet('sheetQuick');
  toast('已添加「' + t.title + '」' + (t.date ? '  ' + relDay(t.date) + (t.start ? ' ' + t.start : '') : '  未安排'), '撤销', () => {
    const i = DB.tasks.indexOf(t); if (i >= 0) DB.tasks.splice(i, 1);
    save(); syncNotifications(); renderAll();
  });
}

/* ---------------- 权限 UI ---------------- */
/* ---------------- 环境变更（时区 / 跨天）---------------- */
function checkEnvChange() {
  const tz = new Date().getTimezoneOffset();
  const tk = todayKey();
  const changed = [];
  const lastTz = DB.settings.lastTz;
  const lastDay = DB.settings.lastDay;
  if (lastTz !== undefined && lastTz !== null && lastTz !== tz) changed.push('tz');
  if (lastDay && lastDay !== tk) changed.push('day');
  DB.settings.lastTz = tz;
  DB.settings.lastDay = tk;
  save();
  if (changed.indexOf('tz') >= 0) {
    syncNotifications();
    toast('检测到时区变更，已重新排程提醒');
  }
  if (changed.indexOf('day') >= 0) renderAll();
  return changed;
}

/* ---------------- 提醒健康度 ---------------- */
const HEALTH_MUTE_DAYS = 7;
let lastHealth = null;

async function getHealth() {
  const rows = [];
  let level = 'ok';

  let perm = 'web';
  if (IS_NATIVE) {
    try { const pp = await LocalNotifications.checkPermissions(); perm = pp.display; } catch (e) { perm = 'unknown'; }
  }
  const permOk = (perm === 'granted');
  rows.push({ key: 'perm', label: '通知权限', state: permOk ? 'ok' : 'bad',
    note: permOk ? '已开启' : '没有它，提醒完全收不到',
    action: permOk ? null : 'perm', actionText: permOk ? '' : '去开启' });
  if (!permOk && IS_NATIVE) level = 'danger';

  let chOk = true;
  if (IS_NATIVE && PLATFORM === 'android') {
    try {
      const r = await LocalNotifications.listChannels();
      const ch = (r.channels || []).find(function (x) { return x.id === CH_ID; });
      chOk = !!ch && ch.importance !== 0;
    } catch (e) { chOk = true; }
  }
  rows.push({ key: 'channel', label: '提醒渠道', state: chOk ? 'ok' : 'bad',
    note: chOk ? '正常' : '这个渠道被关掉了，到点不会响',
    action: chOk ? null : 'channel', actionText: chOk ? '' : '去开启' });
  if (!chOk && level === 'ok') level = 'warn';

  let exact = 'granted';
  if (IS_NATIVE && PLATFORM === 'android') {
    try { const s = await LocalNotifications.checkExactNotificationSetting(); exact = s.display; } catch (e) {}
  }
  const exactOk = (exact === 'granted');
  rows.push({ key: 'exact', label: '准时性', state: exactOk ? 'ok' : 'warn',
    note: exactOk ? '已优化，提醒会准点' : '开启后提醒才能准点；不开也能用，可能晚 5~15 分钟',
    action: exactOk ? null : 'exact', actionText: exactOk ? '' : '去优化' });
  if (!exactOk && level === 'ok') level = 'warn';

  const dev = await getDevice();
  const vendor = dev && dev.vendor ? dev.vendor : 'other';
  const battOk = dev ? !!dev.ignoringBatteryOptimizations : false;
  rows.push({ key: 'battery', label: '电池白名单', state: battOk ? 'ok' : 'warn',
    note: battOk ? '已加入白名单，锁屏后也能提醒' : '未加入白名单；省电模式下提醒可能被延迟或拦截',
    action: battOk ? null : 'battery', actionText: battOk ? '' : '去设置' });
  if (!battOk && level === 'ok') level = 'warn';

  if (vendor !== 'other' && VENDOR_INFO[vendor]) {
    const autoOk = !!DB.settings.autoStartConfirmed;
    rows.push({ key: 'autostart', label: '自启动  ' + VENDOR_INFO[vendor].name, state: autoOk ? 'ok' : 'warn',
      note: autoOk ? '已确认' : VENDOR_INFO[vendor].note,
      action: autoOk ? null : 'autostart', actionText: autoOk ? '' : '去设置' });
    if (!autoOk && level === 'ok') level = 'warn';
  }

  return { level: level, rows: rows, perm: perm, exact: exact, exactOk: exactOk, chOk: chOk, vendor: (dev && dev.vendor) || 'other' };
}

async function refreshPermUI() {
  const h = await getHealth();
  lastHealth = h;
  const banner = $('#permBanner');
  if (!banner) return;
  const muted = Date.now() < (DB.settings.healthMuteUntil || 0);
  const hasTimed = DB.tasks.some(function (t) { return !!t.start; });
  if (!IS_NATIVE || !hasTimed || h.level === 'ok' || muted) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    banner.className = 'banner' + (h.level === 'danger' ? ' danger' : '');
    $('#permBannerText').textContent = h.level === 'danger'
      ? '提醒收不到  去开启'
      : '提醒可能晚几分钟  去优化';
    $('#permBannerBtn').textContent = h.level === 'danger' ? '去开启' : '去优化';
  }
  const map = { granted: '已开启', denied: '已拒绝', prompt: '未请求',
    'prompt-with-rationale': '未请求', web: '浏览器模式', unknown: '未知', error: '检测失败' };
  const el = $('#stPerm');
  if (el) {
    el.textContent = map[h.perm] || h.perm;
    el.className = 'set-val ' + (h.perm === 'granted' ? 'ok' : 'bad');
  }
  const ex = $('#stExact');
  if (ex) {
    if (PLATFORM !== 'android') { ex.textContent = '不适用'; ex.className = 'set-val'; }
    else { ex.textContent = h.exactOk ? '已授权' : '未授权'; ex.className = 'set-val ' + (h.exactOk ? 'ok' : 'bad'); }
  }
  const rb = $('#rowBattery');
  if (rb) rb.hidden = PLATFORM !== 'android';
}

function renderHealthPanel() {
  const h = lastHealth;
  if (!h || !$('#healthRows')) return;
  $('#healthSummary').textContent = h.level === 'ok'
    ? '一切正常，提醒会准点送达。'
    : (h.level === 'danger'
      ? '提醒目前收不到，建议先开启通知权限。'
      : '提醒可能延迟，按下面提示可优化。先用着也不影响。');
  $('#healthRows').innerHTML = h.rows.map(function (r) {
    return '<div class="hrow"><span class="hrow-dot ' + r.state + '"></span>' +
      '<div class="hrow-main"><div class="hrow-t">' + r.label + '</div>' +
      '<div class="hrow-n">' + esc(r.note) + '</div></div>' +
      (r.action ? '<button class="btn sm" data-hact="' + r.action + '">' + r.actionText + '</button>' : '') +
      '</div>';
  }).join('');
}

async function openHealth() {
  await refreshPermUI();
  renderHealthPanel();
  openSheet('sheetHealth');
}
/* ---------------- 事件 ---------------- */
function bindEvents() {
  $$('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 清单范围
  $('#listSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    listRange = b.dataset.range;
    DB.settings.range = listRange; save();
    $$('#listSeg button').forEach(x => x.classList.toggle('active', x === b));
    renderList(); updateHeader();
  });

  // 日历模式
  $('#calSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    calMode = b.dataset.mode;
    $$('#calSeg button').forEach(x => x.classList.toggle('active', x === b));
    renderCal();
  });

  // 日历导航
  $('#mPrev').addEventListener('click', () => { viewM--; if (viewM < 0) { viewM = 11; viewY--; } renderCal(); });
  $('#mNext').addEventListener('click', () => { viewM++; if (viewM > 11) { viewM = 0; viewY++; } renderCal(); });
  $('#mToday').addEventListener('click', () => { goToDate(todayKey()); renderCal(); });
  $('#dPrev').addEventListener('click', () => { goToDate(dateKey(addDays(parseKey(selKey || todayKey()), -1))); renderCal(); });
  $('#dNext').addEventListener('click', () => { goToDate(dateKey(addDays(parseKey(selKey || todayKey()), 1))); renderCal(); });
  $('#dToday').addEventListener('click', () => { goToDate(todayKey()); renderCal(); });
  $('#dayAdd').addEventListener('click', () => openTask(newTask({ date: selKey || todayKey() })));
  $('#goalAdd').addEventListener('click', () => openGoal(null));
  $('#hdrAction').addEventListener('click', openListMenu);
  $('#lmCancel').addEventListener('click', () => closeSheet('sheetListMenu'));
  $('#lmHide').addEventListener('click', () => {
    hideDone = !hideDone;
    DB.settings.hideDone = hideDone; save();
    closeSheet('sheetListMenu'); renderList();
    toast(hideDone ? '已隐藏已完成' : '已显示已完成');
  });
  $('#lmClear').addEventListener('click', () => { closeSheet('sheetListMenu'); clearCompleted(); });
  $('#lmCarry').addEventListener('click', () => { closeSheet('sheetListMenu'); carryOver(); });
  $('#btnClearDone').addEventListener('click', clearCompleted);

  // FAB 快速添加
  $('#fab').addEventListener('click', openQuick);
  $('#qAdd').addEventListener('click', quickAdd);
  $('#qCancel').addEventListener('click', () => closeSheet('sheetQuick'));
  $('#qInput').addEventListener('input', updateQuickHint);
  $('#qInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } });
  $('#qDates').addEventListener('click', e => {
    const b = e.target.closest('[data-qd]');
    if (!b) return;
    const v = b.dataset.qd;
    if (v === 'pick') {
      const cur = (qDateOverride && qDateOverride !== 'none' && qDateOverride !== 'pick') ? qDateOverride : todayKey();
      pickNative('date', cur, val => { qDateOverride = val; markQuickDate('pick'); updateQuickHint(); });
      return;
    }
    qDateOverride = (v === 'none') ? 'none' : dateKey(addDays(new Date(), +v));
    $$('#qDates .chip-btn').forEach(x => x.classList.toggle('active', x === b));
    updateQuickHint();
  });

  // 我的 - 提醒设置
  $('#setRemind').addEventListener('change', e => { DB.settings.remind = e.target.checked; save(); syncNotifications(); toast(e.target.checked ? '已开启任务提醒' : '已关闭任务提醒'); });
  $('#setPrep').addEventListener('change', e => { DB.settings.prepMin = +e.target.value; save(); syncNotifications(); });
  $('#setSound').addEventListener('change', e => { DB.settings.sound = e.target.value; save(); });
  $('#setDark').addEventListener('change', e => { DB.settings.dark = e.target.checked; save(); applyTheme(); });
  $('#setRange').addEventListener('change', e => {
    listRange = e.target.value; DB.settings.range = listRange; save();
    $$('#listSeg button').forEach(x => x.classList.toggle('active', x.dataset.range === listRange));
    renderList();
  });
  $('#btnTestNotif').addEventListener('click', sendTestNotification);
  $('#btnBattery').addEventListener('click', () => toast('请在系统「设置  应用  时光轴  电池」中选择「不限制」'));
  $('#btnExport').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; });
  $('#btnClear').addEventListener('click', clearAll);
  $('#permBannerBtn').addEventListener('click', openHealth);
  $('#permBanner').addEventListener('click', openHealth);
  $('#btnHealth').addEventListener('click', openHealth);
  $('#healthTest').addEventListener('click', sendTestNotification);
  $('#healthLater').addEventListener('click', function () {
    DB.settings.healthMuteUntil = Date.now() + HEALTH_MUTE_DAYS * 86400000;
    save(); closeSheet('sheetHealth'); refreshPermUI();
    toast('7 天内不再提示');
  });
  $('#healthRows').addEventListener('click', async function (e) {
    const btn = e.target.closest('[data-hact]');
    if (!btn) return;
    const act = btn.dataset.hact;
    if (act === 'perm') { await requestPerm(); }
    else if (act === 'exact') {
      try { await LocalNotifications.changeExactNotificationSetting(); }
      catch (err) { toast('请到 系统设置  应用  时光轴  闹钟和提醒 中开启'); }
    }
    else if (act === 'channel') {
      try { await SystemSettings.openChannelSettings({ channelId: CH_ID }); }
      catch (err) { toast('请到 系统设置  应用  时光轴  通知 中开启'); }
    }
    else if (act === 'battery') {
      try {
        const r = await SystemSettings.openBatteryOptimization();
        if (r && r.alreadyOk) toast('已在白名单中');
      } catch (err) { toast('请到 系统设置  电池  不受限制 中设置'); }
    }
    else if (act === 'autostart') {
      try {
        const r = await SystemSettings.openAutoStart({ vendor: (lastHealth && lastHealth.vendor) || 'other' });
        DB.settings.autoStartConfirmed = true; save();
        if (r && r.ok) toast('请按页面提示允许自启动');
        else toast('已打开应用详情页，请手动允许「自启动 / 后台运行」');
      } catch (err) {
        DB.settings.autoStartConfirmed = true; save();
        toast('请到 系统设置  应用  时光轴 中允许「自启动 / 后台运行」');
      }
    }
    setTimeout(refreshPermUI, 900);
  });

  $$('[data-close]').forEach(m => m.addEventListener('click', closeAllSheets));
  bindGoalDetail();

  // 全局委托
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-done],[data-edit],[data-day],[data-today],[data-tomorrow],[data-goal],[data-newon],[data-carry],[data-pri],#tDate,#tTime,#tDur,#tSave,#tCancel,#tDelete,#gSave,#gCancel,#gDelete');
    if (!el) return;
    const d = el.dataset;
    if (d.done) { toggleDone(d.done, el.dataset.k || ''); return; }
    if (d.edit) { openTaskById(d.edit); return; }
    if (d.today) { assignTask(d.today, todayKey()); return; }
    if (d.tomorrow) { assignTask(d.tomorrow, dateKey(addDays(new Date(), 1))); return; }
    if (d.newon) { openTask(newTask({ date: d.newon })); return; }
    if (d.carry) { carryOver(); return; }
    if (d.day) { goToDate(d.day); renderCal(); updateHeader(); return; }
    if (d.goal) { openGoalDetail(d.goal); return; }
    if (d.pri) { editingTask.priority = d.pri; updateTaskChips(); return; }
    if (el.id === 'tDate') { pickNative('date', editingTask.date, v => { editingTask.date = v; updateTaskChips(); }); return; }
    if (el.id === 'tTime') { pickNative('time', editingTask.start, v => { editingTask.start = v; if (!editingTask.date) editingTask.date = todayKey(); updateTaskChips(); }); return; }
    if (el.id === 'tDur') {
      const cur = editingTask.dur == null ? 60 : editingTask.dur;
      let i = DUR_STEPS.indexOf(cur); i = (i + 1) % DUR_STEPS.length;
      editingTask.dur = DUR_STEPS[i]; updateTaskChips(); return;
    }
    if (el.id === 'tSave') { saveTask(); return; }
    if (el.id === 'tCancel') { closeSheet('sheetTask'); return; }
    if (el.id === 'tDelete') { const id = editingTask.id; closeSheet('sheetTask'); deleteTaskById(id); return; }
    if (el.id === 'gSave') { saveGoal(); return; }
    if (el.id === 'gCancel') { closeSheet('sheetGoal'); return; }
    if (el.id === 'gDelete') { deleteGoal(); return; }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { checkEnvChange(); refreshPermUI(); renderAll(); }
  });
}
/* ============================================================
   顺延：昨天没做完的，今天继续
   ============================================================ */
function carryOver() {
  const tk = todayKey();
  const moved = [];
  for (const t of DB.tasks) {
    if (t.done || !t.date) continue;
    if (t.repeat && t.repeat !== 'none') continue;
    if (t.date < tk) { moved.push({ id: t.id, from: t.date }); t.date = tk; }
  }
  if (!moved.length) { toast('没有逾期任务'); return; }
  save(); syncNotifications(); renderAll();
  toast('已顺延 ' + moved.length + ' 项未完成到今天', '撤销', () => {
    moved.forEach(m => { const t = taskById(m.id); if (t) t.date = m.from; });
    save(); syncNotifications(); renderAll();
  });
}

/* ============================================================
   启动
   ============================================================ */
let tickTimer = null;

async function init() {
  load();
  const gap = DB.lastOpen ? Date.now() - DB.lastOpen : null;
  log('app_open', { gap, entry: 'launch' });
  DB.lastOpen = Date.now();

  applyTheme();
  bindEvents();
  listRange = DB.settings.range || '7d';
  hideDone = !!DB.settings.hideDone;
  $$('#listSeg button').forEach(x => x.classList.toggle('active', x.dataset.range === listRange));
  const sr = $('#setRange'); if (sr) sr.value = listRange;
  if (!selKey) selKey = todayKey();
  await initNotifications();
  checkEnvChange();
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === curTab));
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === curTab));
  renderAll();
  refreshPermUI();

  const d = new Date();
  viewY = d.getFullYear(); viewM = d.getMonth(); selKey = todayKey();

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => { if (curTab === 'today') { renderToday(); updateHeader(); } }, 30000);

  save();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

/* ---------------- Toast ---------------- */
function toast(msg, actionLabel, action) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  const sp = document.createElement('span');
  sp.textContent = msg;
  el.appendChild(sp);
  if (actionLabel && action) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.addEventListener('click', () => { action(); el.remove(); });
    el.appendChild(b);
  }
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, actionLabel ? 5000 : 2600);
}
