// notes.jsx — 笔记页（侧栏 + 编辑器 + 笔记流）
// 依赖：window.Ic（icons.jsx）、window.MOTE(data.jsx)；导出 NotesApp 及共享小件到 window。

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---------- 共享小件 ----------

// 点击外部关闭的弹层状态
function usePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function Checkbox({ on, semi, onChange, title }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={semi ? "mixed" : !!on}
      title={title}
      className={"cbx" + (on ? " on" : "") + (semi ? " semi" : "")}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
    >
      {!semi && <Ic.check size={11} strokeWidth={3.2}></Ic.check>}
    </button>
  );
}

// 渐变占位图（模拟照片）
function PhImg({ h1, h2, s = 45, style }) {
  return (
    <div
      className="ph-img"
      style={{
        background: `linear-gradient(135deg, hsl(${h1} ${s}% 62%), hsl(${h2} ${s + 6}% 38%))`,
        ...style,
      }}
    ></div>
  );
}

// 品牌区
function Brand({ children }) {
  return (
    <div className="brand">
      <i className="logo-dot"></i>
      <span className="brand-name">mote</span>
      {children}
    </div>
  );
}

// ---------- 侧栏 ----------

function Stats() {
  const { STATS } = MOTE;
  return (
    <div className="stats" aria-label="统计">
      <div className="stat"><b>{STATS.memo}</b><span>MEMO</span></div>
      <div className="stat"><b>{STATS.tag}</b><span>TAG</span></div>
      <div className="stat"><b>{STATS.day}</b><span>DAY</span></div>
    </div>
  );
}

function HeatMap({ onPick }) {
  return (
    <div className="hm" aria-label="活跃热力图">
      <div className="hm-grid">
        {MOTE.HEATMAP.map((c) => (
          <button
            type="button"
            key={c.key}
            className={"hm-cell" + (c.today ? " today" : "")}
            data-l={c.level}
            data-tip={`${c.label} · ${c.count} 条`}
            onClick={() => onPick(c)}
          ></button>
        ))}
      </div>
      <div className="hm-foot">
        <span>过去 16 周</span>
        <span style={{ marginLeft: "auto" }}>少</span>
        <span className="hm-scale">
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className="hm-cell" data-l={l} style={{ width: 9, height: 9 }}></i>
          ))}
        </span>
        <span>多</span>
      </div>
    </div>
  );
}

function TagMenu({ tag, onAction }) {
  const { open, setOpen, ref } = usePop();
  return (
    <span
      className={"pop-wrap tag-menu-btn" + (open ? " show" : "")}
      ref={ref}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={"icon-btn sm" + (open ? " active" : "")}
        aria-label={`标签「${tag.name}」操作`}
        onClick={() => setOpen(!open)}
      >
        <Ic.more size={14}></Ic.more>
      </button>
      {open && (
        <div className="menu" role="menu" style={{ minWidth: 126 }}>
          <button type="button" className="menu-item" onClick={() => { setOpen(false); onAction("pin", tag); }}>
            <Ic.pin size={14}></Ic.pin>
            {tag.pinned ? "取消置顶" : "置顶"}
          </button>
          <button type="button" className="menu-item" onClick={() => { setOpen(false); onAction("rename", tag); }}>
            <Ic.pencil size={14}></Ic.pencil>重命名
          </button>
          <hr className="menu-sep" />
          <button type="button" className="menu-item danger" onClick={() => { setOpen(false); onAction("delete", tag); }}>
            <Ic.trash size={14}></Ic.trash>删除
          </button>
        </div>
      )}
    </span>
  );
}

function RenameTagDialog({ tag, onClose, onSubmit }) {
  const [name, setName] = useState(tag.name.split("/").pop());
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(320px, 100%)" }}>
        <h3>重命名标签</h3>
        <p className="sub">#{tag.name}</p>
        <div className="field">
          <Ic.hash size={14}></Ic.hash>
          <input
            autoFocus
            value={name}
            placeholder="标签名称"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && onSubmit(name.trim())}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-soft" style={{ flex: 1 }} onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1, opacity: name.trim() ? 1 : 0.45 }}
            disabled={!name.trim()}
            onClick={() => onSubmit(name.trim())}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function TagTree({ tags, filter, setFilter, onNavigate, onTagAction }) {
  const [fold, setFold] = useState({});
  const pick = (name) => {
    setFilter({ kind: "tag", tag: name });
    onNavigate();
  };
  const renderTag = (t, depth) => {
    const active = filter.kind === "tag" && filter.tag === t.name;
    const hasKids = t.children && t.children.length > 0;
    const folded = fold[t.name];
    const short = t.name.split("/").pop();
    return (
      <React.Fragment key={t.name}>
        <div
          role="button"
          tabIndex={0}
          className={"tag-item" + (active ? " active" : "")}
          onClick={() => pick(t.name)}
          onKeyDown={(e) => e.key === "Enter" && pick(t.name)}
        >
          <span className="hash">#</span>
          <span>{short}</span>
          {t.pinned && <Ic.pin size={12} className="pin-ico"></Ic.pin>}
          <span className="spx"></span>
          {hasKids && (
            <button
              type="button"
              className="icon-btn sm"
              style={{ margin: "-4px 0" }}
              aria-label={folded ? "展开子标签" : "收起子标签"}
              onClick={(e) => {
                e.stopPropagation();
                setFold((f) => ({ ...f, [t.name]: !folded }));
              }}
            >
              {folded ? <Ic.chevR size={13}></Ic.chevR> : <Ic.chevD size={13}></Ic.chevD>}
            </button>
          )}
          <span className="count">{t.count}</span>
          <TagMenu tag={t} onAction={onTagAction}></TagMenu>
        </div>
        {hasKids && !folded && (
          <div className="tag-kids">{t.children.map((k) => renderTag(k, depth + 1))}</div>
        )}
      </React.Fragment>
    );
  };
  return (
    <div>
      <div className="tags-head"><span>标签</span></div>
      {tags.map((t) => renderTag(t, 0))}
    </div>
  );
}

function SidebarContent({ tags, onTagAction, filter, setFilter, onNavigate, gotoDrive, mode, setMode, toast }) {
  const nav = (f) => {
    setFilter(f);
    onNavigate();
  };
  const is = (kind, val) =>
    filter.kind === kind && (val === undefined || filter.color === val);
  return (
    <React.Fragment>
      <Brand>
        <span className="brand-actions">
          <button type="button" className="icon-btn sm" title="退出登录" onClick={() => toast("原型演示：退出登录")}>
            <Ic.logout size={15}></Ic.logout>
          </button>
          <button
            type="button"
            className="icon-btn sm"
            title={mode === "dark" ? "切换到亮色" : "切换到暗色"}
            onClick={() => setMode(mode === "dark" ? "light" : "dark")}
          >
            {mode === "dark" ? <Ic.sun size={15}></Ic.sun> : <Ic.moon size={15}></Ic.moon>}
          </button>
        </span>
      </Brand>
      <Stats></Stats>
      <HeatMap onPick={(c) => toast(c.count > 0 ? `${c.label} · ${c.count} 条笔记` : `${c.label} · 无记录`)}></HeatMap>
      <nav className="nav-list" aria-label="主导航">
        <button type="button" className={"nav-item" + (is("all") ? " active" : "")} onClick={() => nav({ kind: "all" })}>
          <Ic.grid2 size={17}></Ic.grid2>全部笔记
        </button>
        <button type="button" className={"nav-item" + (is("shared") ? " active" : "")} onClick={() => nav({ kind: "shared" })}>
          <Ic.share size={17}></Ic.share>已分享
          <span
            className="aux"
            title="打开博客页"
            onClick={(e) => {
              e.stopPropagation();
              toast("原型演示：打开博客页");
            }}
          >
            <Ic.external size={14}></Ic.external>
          </span>
        </button>
        {["red", "blue", "green"].map((c) => (
          <button
            type="button"
            key={c}
            className={"nav-item" + (is("color", c) ? " active" : "")}
            onClick={() => nav({ kind: "color", color: c })}
          >
            <i className={"nav-dot " + c}></i>
            {c === "red" ? "红色" : c === "blue" ? "蓝色" : "绿色"}
          </button>
        ))}
        <button type="button" className="nav-item" onClick={() => toast("原型演示：统计页不在本次范围")}>
          <Ic.chart size={17}></Ic.chart>统计
        </button>
        <button type="button" className="nav-item" onClick={gotoDrive}>
          <Ic.cloud size={17}></Ic.cloud>云盘
          <span className="aux"><Ic.chevR size={14}></Ic.chevR></span>
        </button>
      </nav>
      <TagTree tags={tags} filter={filter} setFilter={setFilter} onNavigate={onNavigate} onTagAction={onTagAction}></TagTree>
      <div className="side-foot">
        <button type="button" className="nav-item" onClick={() => toast("原型演示：设置")}>
          <Ic.settings size={16}></Ic.settings>设置
        </button>
        <button
          type="button"
          className={"nav-item" + (filter.kind === "trash" ? " active" : "")}
          onClick={() => nav({ kind: "trash" })}
        >
          <Ic.trash size={16}></Ic.trash>回收站
        </button>
      </div>
    </React.Fragment>
  );
}

// ---------- 编辑器 ----------

function Composer({ onPublish, autoFocus, toast }) {
  const [text, setText] = useState("");
  const [color, setColor] = useState(null);
  const taRef = useRef(null);

  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + "px";
  };
  useEffect(() => {
    if (autoFocus && taRef.current) taRef.current.focus();
  }, [autoFocus]);

  const publish = () => {
    if (!text.trim()) return;
    onPublish(text.trim(), color);
    setText("");
    setColor(null);
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.focus();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        value={text}
        placeholder="记录此刻的想法… 输入 # 添加标签"
        rows={2}
        onChange={(e) => {
          setText(e.target.value);
          resize();
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") publish();
        }}
      ></textarea>
      <div className="composer-bar">
        <button type="button" className="icon-btn sm" title="标签" onClick={() => setText((t) => t + (t.endsWith(" ") || t === "" ? "#" : " #"))}>
          <Ic.hash size={15}></Ic.hash>
        </button>
        <button type="button" className="icon-btn sm" title="插入图片" onClick={() => toast("原型演示：插入图片")}>
          <Ic.image size={15}></Ic.image>
        </button>
        <button type="button" className="icon-btn sm" title="待办列表" onClick={() => toast("原型演示：待办列表")}>
          <Ic.checksq size={15}></Ic.checksq>
        </button>
        <button type="button" className="icon-btn sm" title="代码块" onClick={() => toast("原型演示：代码块")}>
          <Ic.code size={15}></Ic.code>
        </button>
        <span className="sp"></span>
        <span className="cdots">
          {["red", "blue", "green"].map((c) => (
            <button
              type="button"
              key={c}
              className={"cdot " + c + (color === c ? " on" : "")}
              title={"标记" + (c === "red" ? "红色" : c === "blue" ? "蓝色" : "绿色")}
              onClick={() => setColor(color === c ? null : c)}
            ></button>
          ))}
        </span>
        <button type="button" className="btn btn-primary" disabled={!text.trim()} style={{ opacity: text.trim() ? 1 : 0.45 }} onClick={publish}>
          发布
        </button>
      </div>
    </div>
  );
}

// ---------- 笔记卡片 ----------

// 菜单结构与现有 post-menu.tsx 保持一致：
// 颜色标记行 → 编辑 / 引用 / 查看详情 → 导出 Markdown → 分享 / 删除 → 字数 · 更新时间
function MemoMenu({ memo, inTrash, onAction }) {
  const { open, setOpen, ref } = usePop();
  const act = (key, arg) => {
    setOpen(false);
    onAction(key, arg);
  };
  const item = (key, icon, label, danger, arg) => (
    <button
      type="button"
      key={key}
      className={"menu-item" + (danger ? " danger" : "")}
      onClick={() => act(key, arg)}
    >
      {React.createElement(Ic[icon], { size: 14 })}
      {label}
    </button>
  );
  const words = stripHtml(memo.content).replace(/\s+/g, "").length;
  return (
    <span className="pop-wrap" ref={ref}>
      <button
        type="button"
        className={"icon-btn sm memo-menu-btn" + (open ? " open" : "")}
        aria-label="更多操作"
        onClick={() => setOpen(!open)}
      >
        <Ic.more size={16}></Ic.more>
      </button>
      {open && (
        <div className="menu" role="menu" style={{ minWidth: 172 }}>
          {inTrash ? (
            <React.Fragment>
              {item("restore", "restore", "恢复")}
              {item("purge", "trash", "彻底删除", true)}
            </React.Fragment>
          ) : (
            <React.Fragment>
              <div className="menu-colors" role="group" aria-label="标记颜色">
                {["red", "blue", "green"].map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={"cdot " + c + (memo.color === c ? " on" : "")}
                    title={"标记" + (c === "red" ? "红色" : c === "blue" ? "蓝色" : "绿色")}
                    onClick={() => act("color", memo.color === c ? null : c)}
                  ></button>
                ))}
              </div>
              {item("edit", "pencil", "编辑")}
              {item("quote", "quote", "引用")}
              {item("detail", "eye", "查看详情")}
              <hr className="menu-sep" />
              {item("export", "download", "导出 Markdown")}
              <hr className="menu-sep" />
              {item("share", memo.shared ? "x" : "share", memo.shared ? "取消分享" : "分享")}
              {item("delete", "trash", "删除", true)}
              <div className="menu-foot">
                字数：{words}
                {memo.updatedLabel && (
                  <React.Fragment>
                    <br />
                    更新时间：{memo.updatedLabel}
                  </React.Fragment>
                )}
              </div>
            </React.Fragment>
          )}
        </div>
      )}
    </span>
  );
}

function MemoCard({ memo, inTrash, onTagClick, onAction, style }) {
  return (
    <article className={"memo" + (memo.fresh ? " fresh" : "") + (memo.removing ? " removing" : "")} style={style}>
      <header className="memo-head">
        <time className="memo-time">{memo.time}</time>
        {memo.color && <i className={"memo-mark " + memo.color} title={"标记：" + memo.color}></i>}
        {memo.comments > 0 && (
          <span className="memo-badge" title={`${memo.comments} 条回应`}>
            <Ic.comment size={12}></Ic.comment>
            {memo.comments}
          </span>
        )}
        {memo.shared && (
          <span className="memo-badge" title="已分享为博客">
            <Ic.share size={12}></Ic.share>
          </span>
        )}
        <span className="sp"></span>
        <MemoMenu memo={memo} inTrash={inTrash} onAction={(k, arg) => onAction(k, memo, arg)}></MemoMenu>
      </header>
      <div
        className="memo-prose"
        onClick={(e) => {
          const chip = e.target.closest(".tagchip");
          if (chip) onTagClick(chip.dataset.tag);
        }}
        dangerouslySetInnerHTML={{ __html: memo.content }}
      ></div>
      {memo.imgs && (
        <div className="memo-imgs">
          {memo.imgs.map((im, i) => (
            <div key={i} className="memo-img" title={im.label}>
              <PhImg h1={im.h1} h2={im.h2} s={im.s}></PhImg>
            </div>
          ))}
        </div>
      )}
      {memo.quote && (
        <button type="button" className="memo-quote" title="查看引用的笔记">
          <Ic.quote size={13}></Ic.quote>
          <span>{memo.quote}</span>
        </button>
      )}
    </article>
  );
}

// ---------- 笔记页主组件 ----------

const FILTER_TITLES = {
  all: "全部笔记",
  shared: "已分享",
  trash: "回收站",
};

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 把纯文本草稿转成受限 HTML（#标签 → chip；空行分段）
function draftToHtml(text) {
  const paras = text.split(/\n{2,}/).map((p) =>
    escapeHtml(p)
      .replace(/\n/g, "<br/>")
      .replace(/#([^\s#<]+)/g, (m, t) => `<button class="tagchip" data-tag="${t}">#${t}</button>`)
  );
  return paras.map((p) => `<p>${p}</p>`).join("");
}

// 在标签树中按名字更新/删除一个节点（fn 返回 null 表示删除）
function mapTagTree(list, name, fn) {
  const out = [];
  for (const t of list) {
    if (t.name === name) {
      const r = fn(t);
      if (r) out.push(r);
    } else if (t.children) {
      out.push({ ...t, children: mapTagTree(t.children, name, fn) });
    } else {
      out.push(t);
    }
  }
  return out;
}

function NotesApp({ compact, mode, setMode, gotoDrive, toast }) {
  const [memos, setMemos] = useState(MOTE.MEMOS);
  const [trashed, setTrashed] = useState(MOTE.TRASHED_MEMOS);
  const [tags, setTags] = useState(MOTE.TAGS);
  const [renamingTag, setRenamingTag] = useState(null);
  const [filter, setFilter] = useState({ kind: "all" });
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);

  const onTagAction = (action, tag) => {
    if (action === "pin") {
      setTags((ts) => {
        const next = mapTagTree(ts, tag.name, (t) => ({ ...t, pinned: !t.pinned }));
        return [...next].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      });
      toast(tag.pinned ? "已取消置顶" : `已置顶 #${tag.name}`);
    } else if (action === "rename") {
      setRenamingTag(tag);
    } else if (action === "delete") {
      setTags((ts) => mapTagTree(ts, tag.name, () => null));
      if (filter.kind === "tag" && (filter.tag === tag.name || filter.tag.startsWith(tag.name + "/"))) {
        setFilter({ kind: "all" });
      }
      toast(`已删除标签「${tag.name}」，笔记本身不受影响`);
    }
  };

  const renameTag = (newShort) => {
    const old = renamingTag.name;
    const newName = old.includes("/") ? old.slice(0, old.lastIndexOf("/") + 1) + newShort : newShort;
    setTags((ts) => mapTagTree(ts, old, (t) => ({ ...t, name: newName })));
    if (filter.kind === "tag" && filter.tag === old) setFilter({ kind: "tag", tag: newName });
    setRenamingTag(null);
    toast(`已重命名为 #${newName}`);
  };

  const list = filter.kind === "trash" ? trashed : memos;
  const filtered = useMemo(() => {
    let r = list;
    if (filter.kind === "shared") r = r.filter((m) => m.shared);
    if (filter.kind === "color") r = r.filter((m) => m.color === filter.color);
    if (filter.kind === "tag")
      r = r.filter((m) => m.tags && m.tags.some((t) => t === filter.tag || t.startsWith(filter.tag + "/")));
    const q = query.trim();
    if (q) r = r.filter((m) => stripHtml(m.content).toLowerCase().includes(q.toLowerCase()));
    return r;
  }, [list, filter, query]);

  // 按天分组（保持原顺序）
  const groups = useMemo(() => {
    const g = [];
    filtered.forEach((m) => {
      const last = g[g.length - 1];
      if (last && last.day === m.day) last.items.push(m);
      else g.push({ day: m.day, dayLabel: m.dayLabel, items: [m] });
    });
    return g;
  }, [filtered]);

  const title =
    filter.kind === "tag"
      ? "#" + filter.tag
      : filter.kind === "color"
        ? { red: "红色标记", blue: "蓝色标记", green: "绿色标记" }[filter.color]
        : FILTER_TITLES[filter.kind];

  const publish = (text, color) => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const memo = {
      id: now.getTime(),
      day: "今天",
      dayLabel: "7月15日 周三",
      time: `${hh}:${mm}`,
      color,
      shared: false,
      comments: 0,
      tags: (text.match(/#([^\s#]+)/g) || []).map((t) => t.slice(1)),
      content: draftToHtml(text),
      fresh: true,
    };
    setMemos((ms) => [memo, ...ms]);
    setSheet(false);
    if (filter.kind !== "all") setFilter({ kind: "all" });
    toast("已发布");
  };

  const onAction = (key, memo, arg) => {
    if (key === "color") {
      setMemos((ms) => ms.map((m) => (m.id === memo.id ? { ...m, color: arg } : m)));
      toast(arg ? "已标记" + { red: "红色", blue: "蓝色", green: "绿色" }[arg] : "已清除标记");
    } else if (key === "export") {
      toast("已导出为 Markdown（演示）");
    } else if (key === "detail") {
      toast("原型演示：查看详情");
    } else if (key === "delete") {
      setMemos((ms) => ms.map((m) => (m.id === memo.id ? { ...m, removing: true } : m)));
      setTimeout(() => {
        setMemos((ms) => ms.filter((m) => m.id !== memo.id));
        setTrashed((ts) => [{ ...memo, removing: false, fresh: false, deleted: true }, ...ts]);
      }, 280);
      toast("已移入回收站");
    } else if (key === "restore") {
      setTrashed((ts) => ts.filter((m) => m.id !== memo.id));
      setMemos((ms) => [...ms, { ...memo, deleted: false }]);
      toast("已恢复");
    } else if (key === "purge") {
      setTrashed((ts) => ts.map((m) => (m.id === memo.id ? { ...m, removing: true } : m)));
      setTimeout(() => setTrashed((ts) => ts.filter((m) => m.id !== memo.id)), 280);
      toast("已彻底删除");
    } else if (key === "share") {
      setMemos((ms) => ms.map((m) => (m.id === memo.id ? { ...m, shared: !m.shared } : m)));
      toast(memo.shared ? "已取消分享" : "已分享为博客");
    } else {
      toast("原型演示：" + { edit: "编辑", quote: "引用" }[key]);
    }
  };

  const sidebarProps = {
    tags,
    onTagAction,
    filter,
    setFilter,
    onNavigate: () => setDrawer(false),
    gotoDrive,
    mode,
    setMode,
    toast,
  };

  let idx = 0;

  return (
    <div className="nb">
      {!compact && (
        <aside className="nb-side">
          <SidebarContent {...sidebarProps}></SidebarContent>
        </aside>
      )}
      <div className="nb-main">
        {compact && (
          <div className="nb-appbar">
            <button type="button" className="icon-btn" aria-label="打开侧栏" onClick={() => setDrawer(true)}>
              <Ic.menu size={18}></Ic.menu>
            </button>
            <Brand></Brand>
            <span style={{ flex: 1 }}></span>
            <button
              type="button"
              className="icon-btn"
              aria-label="切换明暗"
              onClick={() => setMode(mode === "dark" ? "light" : "dark")}
            >
              {mode === "dark" ? <Ic.sun size={16}></Ic.sun> : <Ic.moon size={16}></Ic.moon>}
            </button>
          </div>
        )}
        <div className="nb-top">
          <div className="nb-title">
            <h1>{title}</h1>
            <span className="count">{filtered.length} 条</span>
          </div>
          <span className="sp"></span>
          <label className="field nb-search">
            <Ic.search size={14}></Ic.search>
            <input
              value={query}
              placeholder="搜索笔记…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button type="button" className="icon-btn sm" style={{ margin: "-4px -6px" }} onClick={() => setQuery("")}>
                <Ic.x size={13}></Ic.x>
              </button>
            )}
          </label>
        </div>
        {filter.kind === "trash" ? (
          <div className="alert">
            <Ic.alert size={16}></Ic.alert>
            <span>回收站的笔记保留 30 天后自动清除</span>
            <span className="sp"></span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ height: 28, padding: "0 10px", fontSize: 12.5 }}
              onClick={() => {
                setTrashed([]);
                toast("回收站已清空");
              }}
            >
              清空
            </button>
          </div>
        ) : (
          !compact && <Composer onPublish={publish} toast={toast}></Composer>
        )}
        <div className="feed">
          {groups.length === 0 && (
            <div className="empty">
              <Ic.inbox size={44} strokeWidth={1.3}></Ic.inbox>
              <span>{query ? `没有找到与「${query}」相关的笔记` : "这里空空如也"}</span>
            </div>
          )}
          {groups.map((g) => (
            <React.Fragment key={g.day + g.items[0].id}>
              <div className="day-row">
                <span className="day-label">{g.day === "今天" || g.day === "昨天" ? `${g.day} · ${g.dayLabel}` : g.dayLabel}</span>
                <i className="day-rule"></i>
              </div>
              {g.items.map((m) => (
                <MemoCard
                  key={m.id}
                  memo={m}
                  inTrash={filter.kind === "trash"}
                  onTagClick={(t) => setFilter({ kind: "tag", tag: t })}
                  onAction={onAction}
                  style={{ "--d": Math.min(idx++, 8) * 45 + "ms" }}
                ></MemoCard>
              ))}
            </React.Fragment>
          ))}
          {groups.length > 0 && (
            <div className="feed-end"><i></i><i></i><i></i></div>
          )}
        </div>
      </div>

      {compact && filter.kind !== "trash" && (
        <button type="button" className="fab" aria-label="写笔记" onClick={() => setSheet(true)}>
          <Ic.plus size={24} strokeWidth={2.2}></Ic.plus>
        </button>
      )}
      {compact && drawer && (
        <React.Fragment>
          <div className="drawer-overlay" onClick={() => setDrawer(false)}></div>
          <div className="drawer">
            <aside className="nb-side">
              <SidebarContent {...sidebarProps}></SidebarContent>
            </aside>
          </div>
        </React.Fragment>
      )}
      {compact && sheet && (
        <React.Fragment>
          <div className="sheet-overlay" onClick={() => setSheet(false)}></div>
          <div className="sheet">
            <div className="sheet-grip"></div>
            <Composer onPublish={publish} autoFocus toast={toast}></Composer>
          </div>
        </React.Fragment>
      )}
      {renamingTag && (
        <RenameTagDialog
          tag={renamingTag}
          onClose={() => setRenamingTag(null)}
          onSubmit={renameTag}
        ></RenameTagDialog>
      )}
    </div>
  );
}

Object.assign(window, { usePop, Checkbox, PhImg, Brand, NotesApp });
