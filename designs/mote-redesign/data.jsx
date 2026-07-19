// data.jsx — 原型模拟数据（挂在 window.MOTE 上）
// 基准日期：2026-07-15（周三）

// ---------- 主题元数据（Tweaks 面板用） ----------
const THEMES = [
  { id: "celadon", name: "青", ball: "linear-gradient(135deg, hsl(170 58% 34%) 50%, hsl(158 30% 93%) 50%)" },
  { id: "dawn", name: "曦", ball: "linear-gradient(135deg, hsl(216 78% 55%) 50%, hsl(40 30% 94%) 50%)" },
  { id: "ink", name: "墨", ball: "linear-gradient(135deg, hsl(9 68% 48%) 50%, hsl(30 12% 96%) 50%)" },
  { id: "wisteria", name: "紫", ball: "linear-gradient(135deg, hsl(278 70% 64%) 50%, hsl(276 28% 14%) 50%)" },
];

// ---------- 笔记 ----------
// content 为受限 HTML：p / strong / blockquote / pre>code / ul.checks / span.tagchip
const tag = (t) => `<button class="tagchip" data-tag="${t}">#${t}</button>`;

const MEMOS = [
  {
    id: 101,
    day: "今天",
    dayLabel: "7月15日 周三",
    time: "09:24",
    color: null,
    shared: false,
    comments: 0,
    tags: ["产品/灵感"],
    content: `<p>${tag("产品/灵感")} 笔记的「颜色标记」也许可以换个思路：不是分类，而是<strong>温度</strong>——红色是未消化的焦虑，蓝色是冷静的事实，绿色是已经长出来的结论。</p><p>标记不是为了整理，是为了以后回来看时，知道当时的自己处在什么状态。</p>`,
  },
  {
    id: 102,
    day: "今天",
    dayLabel: "7月15日 周三",
    time: "08:02",
    color: "green",
    shared: true,
    comments: 1,
    updatedLabel: "7月15日 08:40",
    tags: ["读书"],
    content: `<p>${tag("读书")} 《禅与摩托车维修艺术》第三遍。</p><blockquote>良质不是物体的属性，也不是主观的感受，它发生在主体与客体相遇的一瞬间。</blockquote><p>做产品也是一样——「好」不在功能列表里，在使用的那一刻。</p>`,
  },
  {
    id: 103,
    day: "昨天",
    dayLabel: "7月14日 周二",
    time: "22:47",
    color: null,
    shared: false,
    comments: 0,
    tags: ["生活/摄影"],
    imgs: [
      { h1: 208, h2: 245, s: 46, label: "港口暮色" },
      { h1: 22, h2: 350, s: 52, label: "晚霞" },
      { h1: 152, h2: 190, s: 38, label: "山谷" },
    ],
    content: `<p>${tag("生活/摄影")} 台风前夜的港口，云压得很低。胶片扫出来颗粒比预想的粗，但暮色的层次全都在。</p>`,
  },
  {
    id: 104,
    day: "昨天",
    dayLabel: "7月14日 周二",
    time: "16:30",
    color: "blue",
    shared: false,
    comments: 0,
    tags: ["工作"],
    content: `<p>${tag("工作")} 本周收尾清单：</p><ul class="checks"><li class="done">云盘分块上传的 502 修复上线</li><li class="done">主题切换动画降级方案</li><li>写 Q3 的 roadmap 草稿</li><li>给新同事过一遍部署流程</li></ul>`,
  },
  {
    id: 105,
    day: "7月12日",
    dayLabel: "7月12日 周日",
    time: "21:15",
    color: null,
    shared: false,
    comments: 2,
    tags: ["开发/mote"],
    content: `<p>${tag("开发/mote")} 虚拟列表在 Safari 上的滚动抖动，原因是 <code>overflow-anchor</code> 默认值不一致：</p><pre><code>.feed {\n  overflow-anchor: none; /* Safari 需要显式声明 */\n}</code></pre><p>记录一下，这类兼容性问题永远比想象中隐蔽。</p>`,
  },
  {
    id: 106,
    day: "7月12日",
    dayLabel: "7月12日 周日",
    time: "10:08",
    color: null,
    shared: false,
    comments: 0,
    tags: ["灵感"],
    quote: "良质不是物体的属性，也不是主观的感受……",
    content: `<p>${tag("灵感")} 接着昨天读书笔记想到的：工具的「良质」大概就是——用完之后你不记得工具本身，只记得事情做成了。</p>`,
  },
  {
    id: 107,
    day: "7月9日",
    dayLabel: "7月9日 周四",
    time: "19:42",
    color: "red",
    shared: false,
    comments: 0,
    tags: ["旅行"],
    content: `<p>${tag("旅行")} 十月的计划先占个坑：大理 → 沙溪 → 诺邓。<strong>三个原则</strong>：不赶路、不打卡、每天留两小时发呆。</p><p>要查的事：诺邓的火腿作坊还接不接受参观。</p>`,
  },
  {
    id: 108,
    day: "7月9日",
    dayLabel: "7月9日 周四",
    time: "08:55",
    color: null,
    shared: true,
    comments: 3,
    tags: ["读书", "灵感"],
    content: `<p>${tag("读书")} 卡尔维诺《新千年文学备忘录》里讲「轻」：</p><blockquote>轻不是回避重，而是用另一种视角承受重。</blockquote><p>${tag("灵感")} 界面设计里的「轻」同理——不是删掉功能，是让重的东西看起来举重若轻。</p>`,
  },
];

// 回收站里的笔记
const TRASHED_MEMOS = [
  {
    id: 201,
    day: "6月30日",
    dayLabel: "6月30日 周二",
    time: "14:20",
    color: null,
    shared: false,
    comments: 0,
    tags: [],
    deleted: true,
    content: `<p>旧的周报模板，已经换新版了。</p>`,
  },
  {
    id: 202,
    day: "6月24日",
    dayLabel: "6月24日 周三",
    time: "09:11",
    color: null,
    shared: false,
    comments: 0,
    tags: ["工作"],
    deleted: true,
    content: `<p>${tag("工作")} 临时记的会议要点，正式纪要已经归档。</p>`,
  },
];

// ---------- 标签树 ----------
const TAGS = [
  { name: "灵感", count: 18, pinned: true },
  { name: "读书", count: 32 },
  {
    name: "开发",
    count: 41,
    children: [
      { name: "开发/前端", count: 16 },
      { name: "开发/mote", count: 12 },
    ],
  },
  {
    name: "生活",
    count: 25,
    children: [{ name: "生活/摄影", count: 7 }],
  },
  { name: "工作", count: 22 },
  { name: "旅行", count: 6 },
];

const STATS = { memo: 486, tag: 24, day: 213 };

// ---------- 热力图（确定性伪随机，末尾对齐今天） ----------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHeatmap() {
  const rnd = mulberry32(20260715);
  const today = new Date(2026, 6, 15); // 7月15日
  const start = new Date(today);
  // 本周周日再回退 16 周 → 共 17 列，铺满侧栏宽度
  start.setDate(start.getDate() - start.getDay() - 16 * 7);
  const cells = [];
  const d = new Date(start);
  while (d <= today) {
    const r = rnd();
    let level = 0;
    if (r > 0.82) level = 4;
    else if (r > 0.62) level = 3;
    else if (r > 0.42) level = 2;
    else if (r > 0.24) level = 1;
    const count = level === 0 ? 0 : Math.max(1, Math.round(level * 2.6 * rnd() + level));
    cells.push({
      key: d.getTime(),
      label: `${d.getMonth() + 1}月${d.getDate()}日`,
      count,
      level,
      today: d.getTime() === today.getTime(),
    });
    d.setDate(d.getDate() + 1);
  }
  return cells;
}
const HEATMAP = buildHeatmap();

// ---------- 云盘 ----------
// kind: folder | image | video | audio | pdf | doc | zip | generic
const DRIVE_NODES = [
  { id: 1, parent: null, kind: "folder", name: "设计资产", items: 4, size: 38.2 * 1048576, mtime: "7月14日 21:36", ts: 714.2136, shares: 1 },
  { id: 2, parent: null, kind: "folder", name: "照片", items: 86, size: 1.9 * 1073741824, mtime: "7月13日 18:04", ts: 713.1804, shares: 1 },
  { id: 3, parent: null, kind: "folder", name: "文档", items: 34, size: 412 * 1048576, mtime: "7月10日 11:22", ts: 710.1122, shares: 0 },
  { id: 4, parent: null, kind: "folder", name: "备份", items: 5, size: 6.4 * 1073741824, mtime: "7月1日 03:00", ts: 701.03, shares: 0 },
  { id: 11, parent: null, kind: "image", name: "深海主题-预览.png", size: 2.4 * 1048576, mtime: "7月14日 20:12", ts: 714.2012, h1: 192, h2: 215, s: 48 },
  { id: 12, parent: null, kind: "pdf", name: "发布会-keynote.pdf", size: 18.6 * 1048576, mtime: "7月12日 15:40", ts: 712.154, shares: 1 },
  { id: 13, parent: null, kind: "video", name: "城市延时-4K.mp4", size: 486 * 1048576, mtime: "7月11日 22:05", ts: 711.2205 },
  { id: 14, parent: null, kind: "audio", name: "播客-第12期.mp3", size: 52.3 * 1048576, mtime: "7月8日 09:30", ts: 708.093 },
  { id: 15, parent: null, kind: "zip", name: "mote-备份-0712.zip", size: 1.2 * 1073741824, mtime: "7月12日 03:00", ts: 712.03 },
  { id: 16, parent: null, kind: "doc", name: "读书笔记-合集.md", size: 86 * 1024, mtime: "7月15日 08:10", ts: 715.081 },
  // 设计资产内部
  { id: 21, parent: 1, kind: "image", name: "主题-配色总表.png", size: 1.8 * 1048576, mtime: "7月14日 21:36", ts: 714.2136, h1: 265, h2: 300, s: 42 },
  { id: 22, parent: 1, kind: "image", name: "Logo-终稿.svg", size: 12 * 1024, mtime: "7月9日 16:20", ts: 709.162, h1: 155, h2: 185, s: 40 },
  { id: 23, parent: 1, kind: "generic", name: "组件规范.sketch", size: 34 * 1048576, mtime: "7月6日 14:12", ts: 706.1412 },
  { id: 24, parent: 1, kind: "pdf", name: "字体授权协议.pdf", size: 2.1 * 1048576, mtime: "6月28日 10:05", ts: 628.1005 },
];

const DRIVE_SHARES = [
  { id: 901, nodeId: 12, kind: "pdf", name: "发布会-keynote.pdf", password: true, expire: "3 天后过期", path: "我的云盘" },
  { id: 902, nodeId: 2, kind: "folder", name: "照片", password: false, expire: "永久有效", path: "我的云盘" },
  { id: 903, nodeId: 21, kind: "image", name: "主题-配色总表.png", password: true, expire: "23 小时后过期", path: "我的云盘 › 设计资产", h1: 265, h2: 300, s: 42 },
];

const DRIVE_TRASH = [
  { id: 951, kind: "image", name: "旧版-logo备份.png", size: 640 * 1024, dtime: "7月8日删除 · 剩 23 天", h1: 20, h2: 45, s: 30 },
  { id: 952, kind: "audio", name: "会议录音-0702.m4a", size: 88 * 1048576, dtime: "7月2日删除 · 剩 17 天" },
];

// ---------- 工具 ----------
function fmtSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

// 文件类型 → 色相与图标名（跨主题固定，让类型可辨识）
const KIND_STYLE = {
  folder: { hue: 36, sat: 80, icon: "folder" },
  image: { hue: 262, sat: 62, icon: "image" },
  video: { hue: 340, sat: 60, icon: "film" },
  audio: { hue: 190, sat: 62, icon: "music" },
  pdf: { hue: 4, sat: 64, icon: "fileText" },
  doc: { hue: 210, sat: 62, icon: "fileText" },
  zip: { hue: 28, sat: 30, icon: "zip" },
  generic: { hue: 220, sat: 12, icon: "file" },
};

window.MOTE = {
  THEMES,
  MEMOS,
  TRASHED_MEMOS,
  TAGS,
  STATS,
  HEATMAP,
  DRIVE_NODES,
  DRIVE_SHARES,
  DRIVE_TRASH,
  KIND_STYLE,
  fmtSize,
};
