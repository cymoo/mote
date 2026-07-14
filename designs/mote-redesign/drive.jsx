// drive.jsx — 迷你云盘页
// 依赖：window.Ic、window.MOTE、notes.jsx 导出的 usePop / Checkbox / PhImg / Brand。

const {
  useState: useSt,
  useEffect: useEf,
  useRef: useRf,
  useMemo: useMm,
  useCallback: useCb,
} = React;

// ---------- 文件图标 ----------
function FileIcon({ node, lg }) {
  const st = MOTE.KIND_STYLE[node.kind] || MOTE.KIND_STYLE.generic;
  const Icon = Ic[st.icon];
  const isImg = (node.kind === "image" || node.kind === "video") && node.h1 != null;
  return (
    <span
      className={"fico" + (lg ? " lg" : "")}
      style={{ "--fh": st.hue, "--fs": st.sat + "%" }}
    >
      {isImg && <PhImg h1={node.h1} h2={node.h2} s={node.s}></PhImg>}
      <Icon
        size={lg ? 22 : 17}
        strokeWidth={1.8}
        style={isImg ? { color: "hsl(0 0% 100% / 0.92)" } : undefined}
      ></Icon>
    </span>
  );
}

// ---------- 行菜单 ----------
function RowMenu({ node, inTrash, onAction }) {
  const { open, setOpen, ref } = usePop();
  const items = inTrash
    ? [
        { key: "restore", icon: "restore", label: "恢复" },
        { key: "purge", icon: "trash", label: "彻底删除", danger: true },
      ]
    : [
        { key: "download", icon: "download", label: node.kind === "folder" ? "打包下载" : "下载" },
        { key: "share", icon: "link", label: "创建分享链接" },
        { key: "rename", icon: "pencil", label: "重命名" },
        { key: "move", icon: "move", label: "移动到…" },
        { key: "sep" },
        { key: "delete", icon: "trash", label: "删除", danger: true },
      ];
  return (
    <span className="pop-wrap" ref={ref} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={"icon-btn sm row-menu" + (open ? " open" : "")}
        aria-label="更多操作"
        onClick={() => setOpen(!open)}
      >
        <Ic.more size={15}></Ic.more>
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it, i) =>
            it.key === "sep" ? (
              <hr key={i} className="menu-sep" />
            ) : (
              <button
                type="button"
                key={it.key}
                className={"menu-item" + (it.danger ? " danger" : "")}
                onClick={() => {
                  setOpen(false);
                  onAction(it.key, node);
                }}
              >
                {React.createElement(Ic[it.icon], { size: 14 })}
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </span>
  );
}

// ---------- 排序菜单 ----------
const SORT_LABELS = { name: "名称", size: "大小", ts: "修改时间" };

function SortMenu({ sort, setSort }) {
  const { open, setOpen, ref } = usePop();
  return (
    <span className="pop-wrap" ref={ref}>
      <button type="button" className="icon-btn" title="排序" onClick={() => setOpen(!open)}>
        {sort.dir === "asc" ? <Ic.arrowUp size={15}></Ic.arrowUp> : <Ic.arrowDown size={15}></Ic.arrowDown>}
      </button>
      {open && (
        <div className="menu" role="menu" style={{ minWidth: 132 }}>
          {Object.keys(SORT_LABELS).map((k) => (
            <button
              type="button"
              key={k}
              className="menu-item"
              onClick={() => {
                setSort((s) => ({ key: k, dir: s.key === k && s.dir === "asc" ? "desc" : "asc" }));
              }}
            >
              <span style={{ width: 14, display: "inline-flex" }}>
                {sort.key === k &&
                  (sort.dir === "asc" ? <Ic.arrowUp size={13}></Ic.arrowUp> : <Ic.arrowDown size={13}></Ic.arrowDown>)}
              </span>
              {SORT_LABELS[k]}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// ---------- 分享对话框 ----------
function ShareDialog({ node, onClose, onCreate }) {
  const [pwd, setPwd] = useSt(false);
  const [expire, setExpire] = useSt("永久");
  const link = "https://mote.app/s/8f3k2n";
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>分享「{node.name}」</h3>
        <p className="sub">获得链接的人可以查看{node.kind === "folder" ? "并打包下载此文件夹" : "此文件"}</p>
        <div className="field" style={{ marginBottom: 12 }}>
          <Ic.link size={14}></Ic.link>
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button
            type="button"
            className="icon-btn sm"
            title="复制链接"
            style={{ margin: "-4px -6px" }}
            onClick={() => onCreate("链接已复制")}
          >
            <Ic.copy size={14}></Ic.copy>
          </button>
        </div>
        <div className="share-opt">
          <span className="lbl"><Ic.key size={14}></Ic.key>密码保护</span>
          <span className="sp"></span>
          {pwd && <code className="pwd-code">4821</code>}
          <button
            type="button"
            role="switch"
            aria-checked={pwd}
            className={"switch" + (pwd ? " on" : "")}
            onClick={() => setPwd(!pwd)}
          >
            <i></i>
          </button>
        </div>
        <div className="share-opt">
          <span className="lbl"><Ic.clock size={14}></Ic.clock>有效期</span>
          <span className="sp"></span>
          <span className="seg">
            {["永久", "7 天", "24 小时"].map((e) => (
              <button type="button" key={e} className={"seg-btn" + (expire === e ? " active" : "")} onClick={() => setExpire(e)}>
                {e}
              </button>
            ))}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button type="button" className="btn btn-soft" style={{ flex: 1 }} onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={() => onCreate("分享链接已创建" + (pwd ? " · 密码 4821" : ""), { pwd, expire })}
          >
            创建分享链接
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 新建文件夹 ----------
function NameDialog({ onClose, onSubmit }) {
  const [name, setName] = useSt("");
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(340px, 100%)" }}>
        <h3>新建文件夹</h3>
        <p className="sub">在当前位置创建</p>
        <div className="field">
          <Ic.folder size={14}></Ic.folder>
          <input
            autoFocus
            value={name}
            placeholder="文件夹名称"
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
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 预览层 ----------
function Preview({ items, index, onClose, onNav, toast }) {
  const node = items[index];
  useEf(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onNav(-1);
      if (e.key === "ArrowRight") onNav(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onNav]);
  if (!node) return null;
  const isImg = node.kind === "image" && node.h1 != null;
  return (
    <div className="preview">
      <div className="preview-top">
        <FileIcon node={node}></FileIcon>
        <span className="nm">{node.name}</span>
        <span className="meta">{MOTE.fmtSize(node.size)}</span>
        <span className="sp"></span>
        <button type="button" className="icon-btn" title="下载" onClick={() => toast("开始下载（演示）")}>
          <Ic.download size={16}></Ic.download>
        </button>
        <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
          <Ic.x size={16}></Ic.x>
        </button>
      </div>
      <div className="preview-stage">
        {index > 0 && (
          <button type="button" className="preview-nav prev" aria-label="上一个" onClick={() => onNav(-1)}>
            <Ic.chevL size={19}></Ic.chevL>
          </button>
        )}
        {isImg ? (
          <div className="preview-img" key={node.id}>
            <PhImg h1={node.h1} h2={node.h2} s={node.s}></PhImg>
          </div>
        ) : (
          <div className="preview-file" key={node.id}>
            <FileIcon node={node} lg></FileIcon>
            <span>{node.kind === "video" ? "视频播放（原型演示）" : node.kind === "audio" ? "音频播放（原型演示）" : "此类型暂以下载方式查看"}</span>
            <button type="button" className="btn btn-primary" onClick={() => toast("开始下载（演示）")}>
              <Ic.download size={14}></Ic.download>下载文件
            </button>
          </div>
        )}
        {index < items.length - 1 && (
          <button type="button" className="preview-nav next" aria-label="下一个" onClick={() => onNav(1)}>
            <Ic.chevR size={19}></Ic.chevR>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- 云盘主组件 ----------
let uploadSeq = 5000;

function DriveApp({ compact, gotoNotes, toast }) {
  const [nodes, setNodes] = useSt(MOTE.DRIVE_NODES);
  const [shares, setShares] = useSt(MOTE.DRIVE_SHARES);
  const [trash, setTrash] = useSt(MOTE.DRIVE_TRASH);
  const [tab, setTab] = useSt("drive");
  const [cwd, setCwd] = useSt(null);
  const [view, setView] = useSt("list");
  const [sort, setSort] = useSt({ key: "name", dir: "asc" });
  const [query, setQuery] = useSt("");
  const [sel, setSel] = useSt(() => new Set());
  const [uploads, setUploads] = useSt([]);
  const [dockOpen, setDockOpen] = useSt(true);
  const [preview, setPreview] = useSt(null); // index into files
  const [dragOver, setDragOver] = useSt(false);
  const [shareNode, setShareNode] = useSt(null);
  const [naming, setNaming] = useSt(false);
  const dragDepth = useRf(0);

  const cwdNode = nodes.find((n) => n.id === cwd);

  const items = useMm(() => {
    let r;
    const q = query.trim().toLowerCase();
    if (q) r = nodes.filter((n) => n.name.toLowerCase().includes(q));
    else r = nodes.filter((n) => (n.parent ?? null) === cwd);
    const dir = sort.dir === "asc" ? 1 : -1;
    r = [...r].sort((a, b) => {
      // 文件夹永远置顶
      if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
      if (sort.key === "name") return dir * a.name.localeCompare(b.name, "zh");
      return dir * ((a[sort.key] || 0) - (b[sort.key] || 0));
    });
    return r;
  }, [nodes, cwd, query, sort]);

  const files = useMm(() => items.filter((n) => n.kind !== "folder"), [items]);

  const clearSel = useCb(() => setSel(new Set()), []);
  useEf(() => { clearSel(); }, [cwd, tab, query, clearSel]);

  const toggle = (id) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSel((s) => (s.size === items.length ? new Set() : new Set(items.map((n) => n.id))));

  const open = (node) => {
    if (node.kind === "folder") {
      if (query) setQuery("");
      setCwd(node.id);
    } else {
      const idx = files.findIndex((f) => f.id === node.id);
      if (idx >= 0) setPreview(idx);
    }
  };

  const removeNodes = (ids) => {
    const idSet = new Set(ids);
    const victims = nodes.filter((n) => idSet.has(n.id));
    setNodes((ns) => ns.filter((n) => !idSet.has(n.id) && !idSet.has(n.parent)));
    setTrash((ts) => [
      ...victims.map((v) => ({ ...v, dtime: "刚刚删除 · 剩 30 天" })),
      ...ts,
    ]);
    clearSel();
    toast(`已移入回收站 · ${victims.length} 项`);
  };

  const onAction = (key, node) => {
    if (key === "delete") removeNodes([node.id]);
    else if (key === "share") setShareNode(node);
    else if (key === "download") toast("开始下载（演示）");
    else if (key === "restore") {
      setTrash((ts) => ts.filter((t) => t.id !== node.id));
      setNodes((ns) => [...ns, { ...node, parent: null, mtime: "刚刚", ts: 999 }]);
      toast("已恢复到「我的云盘」");
    } else if (key === "purge") {
      setTrash((ts) => ts.filter((t) => t.id !== node.id));
      toast("已彻底删除");
    } else toast("原型演示：" + { rename: "重命名", move: "移动" }[key]);
  };

  // ---- 上传模拟 ----
  const simulateUpload = (names) => {
    const list = names.map((name) => ({ id: ++uploadSeq, name, pct: 0, done: false }));
    setUploads((u) => [...u, ...list]);
    setDockOpen(true);
    list.forEach((item, k) => {
      const step = () => {
        setUploads((u) =>
          u.map((x) => {
            if (x.id !== item.id || x.done) return x;
            const pct = Math.min(100, x.pct + 7 + Math.random() * 16);
            return { ...x, pct, done: pct >= 100 };
          })
        );
      };
      const iv = setInterval(() => {
        step();
        setUploads((u) => {
          const me = u.find((x) => x.id === item.id);
          if (me && me.done) {
            clearInterval(iv);
            const ext = (me.name.split(".").pop() || "").toLowerCase();
            const kind = ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)
              ? "image"
              : ["mp4", "mov", "webm"].includes(ext)
                ? "video"
                : ["mp3", "m4a", "wav"].includes(ext)
                  ? "audio"
                  : ["pdf"].includes(ext)
                    ? "pdf"
                    : ["zip", "rar", "7z"].includes(ext)
                      ? "zip"
                      : ["md", "txt", "doc", "docx"].includes(ext)
                        ? "doc"
                        : "generic";
            const extra = kind === "image" ? { h1: 30 + ((me.name.length * 37) % 300), h2: 60 + ((me.name.length * 53) % 260), s: 45 } : {};
            setNodes((ns) =>
              ns.some((n) => n.id === item.id)
                ? ns
                : [
                    ...ns,
                    {
                      id: item.id,
                      parent: cwd,
                      kind,
                      name: me.name,
                      size: 1048576 * (2 + ((me.name.length * 13) % 40)),
                      mtime: "刚刚",
                      ts: 999,
                      ...extra,
                    },
                  ]
            );
          }
          return u;
        });
      }, 220 + k * 60);
    });
  };

  const demoUpload = () => simulateUpload(["黄山-云海.jpg", "灵感-手稿.pdf"]);

  // ---- 拖拽 ----
  const onDragEnter = (e) => {
    e.preventDefault();
    dragDepth.current += 1;
    if (tab === "drive") setDragOver(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (tab !== "drive") return;
    const names = Array.from(e.dataTransfer.files || [])
      .map((f) => f.name)
      .slice(0, 5);
    simulateUpload(names.length ? names : ["拖入的文件.png"]);
  };

  const crumbs = [
    { id: null, name: "我的云盘" },
    ...(cwdNode ? [{ id: cwdNode.id, name: cwdNode.name }] : []),
  ];

  const activeUploads = uploads.filter((u) => !u.done).length;

  // ---- 子视图 ----
  const listBody = (
    <React.Fragment>
      <div className="lhead">
        <span style={{ paddingLeft: 10 }}>
          <Checkbox
            on={items.length > 0 && sel.size === items.length}
            semi={sel.size > 0 && sel.size < items.length}
            onChange={toggleAll}
            title="全选"
          ></Checkbox>
        </span>
        <span></span>
        <button type="button" className={"lsort" + (sort.key === "name" ? " active" : "")} onClick={() => setSort((s) => ({ key: "name", dir: s.key === "name" && s.dir === "asc" ? "desc" : "asc" }))}>
          名称
          {sort.key === "name" && (sort.dir === "asc" ? <Ic.arrowUp size={11}></Ic.arrowUp> : <Ic.arrowDown size={11}></Ic.arrowDown>)}
        </button>
        <button type="button" className={"lsort col-size" + (sort.key === "size" ? " active" : "")} onClick={() => setSort((s) => ({ key: "size", dir: s.key === "size" && s.dir === "asc" ? "desc" : "asc" }))}>
          大小
          {sort.key === "size" && (sort.dir === "asc" ? <Ic.arrowUp size={11}></Ic.arrowUp> : <Ic.arrowDown size={11}></Ic.arrowDown>)}
        </button>
        <button type="button" className={"lsort col-time" + (sort.key === "ts" ? " active" : "")} onClick={() => setSort((s) => ({ key: "ts", dir: s.key === "ts" && s.dir === "asc" ? "desc" : "asc" }))}>
          修改时间
          {sort.key === "ts" && (sort.dir === "asc" ? <Ic.arrowUp size={11}></Ic.arrowUp> : <Ic.arrowDown size={11}></Ic.arrowDown>)}
        </button>
        <span></span>
      </div>
      <div className="lrows">
        {items.map((n) => (
          <div
            key={n.id}
            className={"lrow" + (sel.has(n.id) ? " sel" : "")}
            onClick={(e) => {
              // 打开是高频操作：单击即打开；⌘/Ctrl/Shift + 单击为多选
              if (e.shiftKey || e.metaKey || e.ctrlKey) toggle(n.id);
              else open(n);
            }}
          >
            <span>
              <Checkbox on={sel.has(n.id)} onChange={() => toggle(n.id)} title={n.name}></Checkbox>
            </span>
            <FileIcon node={n}></FileIcon>
            <span className="lname">
              <button
                type="button"
                className="nm"
                title={n.kind === "folder" ? "打开文件夹" : "预览"}
                onClick={(e) => {
                  e.stopPropagation();
                  open(n);
                }}
              >
                {n.name}
              </button>
              {!!n.shares && (
                <span className="share-badge" title={`${n.shares} 个分享链接`}>
                  <Ic.link size={9} strokeWidth={2.4}></Ic.link>
                  {n.shares}
                </span>
              )}
              <span className="lsub">
                {n.kind === "folder" ? `${n.items} 项` : MOTE.fmtSize(n.size)} · {n.mtime}
              </span>
            </span>
            <span className="lmeta">{n.kind === "folder" ? `${n.items} 项` : MOTE.fmtSize(n.size)}</span>
            <span className="lmeta">{n.mtime}</span>
            <RowMenu node={n} onAction={onAction}></RowMenu>
          </div>
        ))}
      </div>
    </React.Fragment>
  );

  const gridBody = (
    <div className={"gwrap" + (sel.size > 0 ? " selecting" : "")}>
      {items.map((n, i) => (
        <div
          key={n.id}
          className={"gcard" + (sel.has(n.id) ? " sel" : "")}
          style={{ animationDelay: Math.min(i, 12) * 22 + "ms" }}
          onClick={(e) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) toggle(n.id);
            else open(n);
          }}
          title={n.name}
        >
          <div className="gthumb">
            {(n.kind === "image" || n.kind === "video") && n.h1 != null ? (
              <PhImg h1={n.h1} h2={n.h2} s={n.s}></PhImg>
            ) : (
              <FileIcon node={n} lg></FileIcon>
            )}
            {!!n.shares && (
              <span className="share-badge gbadge">
                <Ic.link size={9} strokeWidth={2.4}></Ic.link>
                {n.shares}
              </span>
            )}
          </div>
          <div className="gname">{n.name}</div>
          <div className="gsize">{n.kind === "folder" ? `${n.items} 项` : MOTE.fmtSize(n.size)}</div>
          <Checkbox on={sel.has(n.id)} onChange={() => toggle(n.id)} title={n.name}></Checkbox>
          <RowMenu node={n} onAction={onAction}></RowMenu>
        </div>
      ))}
    </div>
  );

  const sharedBody = (
    <div className="srows">
      {shares.map((s) => (
        <div key={s.id} className="srow">
          <FileIcon node={s}></FileIcon>
          <div className="mid">
            <div className="ttl">
              <span>{s.name}</span>
              {s.password && (
                <span className="chip-key" title="密码保护">
                  <Ic.key size={11}></Ic.key>
                </span>
              )}
            </div>
            <div className="sub">
              <button type="button" className="loc" title="打开所在位置" onClick={() => { setTab("drive"); setCwd(s.path.includes("›") ? 1 : null); }}>
                <Ic.folder size={11}></Ic.folder>
                <span>{s.path}</span>
              </button>
              <span>·</span>
              <span style={{ whiteSpace: "nowrap" }}>{s.expire}</span>
            </div>
          </div>
          <div className="acts">
            <button type="button" className="btn btn-ghost" style={{ height: 30, padding: "0 10px", fontSize: 12.5 }} onClick={() => toast("原型演示：打开分享页")}>
              <Ic.external size={13}></Ic.external>
              {!compact && "打开"}
            </button>
            <button
              type="button"
              className="btn btn-danger-ghost"
              style={{ height: 30, padding: "0 10px", fontSize: 12.5 }}
              onClick={() => {
                setShares((ss) => ss.filter((x) => x.id !== s.id));
                toast("已撤销分享");
              }}
            >
              <Ic.x size={13}></Ic.x>
              {!compact && "撤销"}
            </button>
          </div>
        </div>
      ))}
      {shares.length === 0 && (
        <div className="empty" style={{ paddingTop: 120 }}>
          <Ic.share size={40} strokeWidth={1.3}></Ic.share>
          <span>暂无有效的分享链接</span>
        </div>
      )}
    </div>
  );

  const trashBody = (
    <div className="srows">
      {trash.map((t) => (
        <div key={t.id} className="srow">
          <FileIcon node={t}></FileIcon>
          <div className="mid">
            <div className="ttl"><span>{t.name}</span></div>
            <div className="sub"><span>{t.dtime}</span></div>
          </div>
          <div className="acts">
            <button type="button" className="btn btn-ghost" style={{ height: 30, padding: "0 10px", fontSize: 12.5 }} onClick={() => onAction("restore", t)}>
              <Ic.restore size={13}></Ic.restore>
              {!compact && "恢复"}
            </button>
            <button type="button" className="btn btn-danger-ghost" style={{ height: 30, padding: "0 10px", fontSize: 12.5 }} onClick={() => onAction("purge", t)}>
              <Ic.trash size={13}></Ic.trash>
              {!compact && "删除"}
            </button>
          </div>
        </div>
      ))}
      {trash.length === 0 && (
        <div className="empty" style={{ paddingTop: 120 }}>
          <Ic.trash size={40} strokeWidth={1.3}></Ic.trash>
          <span>回收站是空的</span>
        </div>
      )}
    </div>
  );

  const railNav = [
    { key: "drive", icon: "cloud", label: "我的云盘", count: nodes.filter((n) => n.parent == null).length },
    { key: "shared", icon: "link", label: "我的分享", count: shares.length },
    { key: "trash", icon: "trash", label: "回收站", count: trash.length },
  ];

  return (
    <div className="dv">
      {!compact && (
        <aside className="dv-rail">
          <button type="button" className="rail-back" onClick={gotoNotes}>
            <Ic.chevL size={14}></Ic.chevL>返回笔记
          </button>
          <Brand></Brand>
          <div style={{ height: 18 }}></div>
          <nav aria-label="云盘导航" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {railNav.map((r) => (
              <button
                type="button"
                key={r.key}
                className={"nav-item" + (tab === r.key ? " active" : "")}
                onClick={() => setTab(r.key)}
              >
                {React.createElement(Ic[r.icon], { size: 16 })}
                {r.label}
                <span className="aux" style={{ fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>{r.count}</span>
              </button>
            ))}
          </nav>
          <p className="rail-note">
            拖拽文件到列表即可上传。
            <br />
            分块断点续传，单文件最大 4 GB。
          </p>
        </aside>
      )}

      <section
        className="dv-canvas"
        onDragEnter={onDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="dv-toolbar">
          {compact && (
            <button type="button" className="icon-btn" aria-label="返回笔记" onClick={gotoNotes}>
              <Ic.chevL size={17}></Ic.chevL>
            </button>
          )}
          {tab === "drive" ? (
            <nav className="crumbs" aria-label="路径">
              {query.trim() ? (
                <span className="crumb here">搜索「{query.trim()}」 · {items.length} 项</span>
              ) : (
                crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <React.Fragment key={String(c.id)}>
                      {i > 0 && <span className="crumb-sep"><Ic.chevR size={13}></Ic.chevR></span>}
                      <button type="button" className={"crumb" + (last ? " here" : "")} disabled={last} onClick={() => setCwd(c.id)}>
                        {c.name}
                      </button>
                    </React.Fragment>
                  );
                })
              )}
            </nav>
          ) : (
            <span className="crumb here">{tab === "shared" ? "我的分享" : "回收站"}</span>
          )}
          <span className="sp"></span>
          {tab === "drive" && (
            <React.Fragment>
              <label className="field dv-search">
                <Ic.search size={14}></Ic.search>
                <input value={query} placeholder="搜索全部文件…" onChange={(e) => setQuery(e.target.value)} />
                {query && (
                  <button type="button" className="icon-btn sm" style={{ margin: "-4px -6px" }} onClick={() => setQuery("")}>
                    <Ic.x size={13}></Ic.x>
                  </button>
                )}
              </label>
              {!compact && (
                <React.Fragment>
                  <SortMenu sort={sort} setSort={setSort}></SortMenu>
                  <span className="seg" role="tablist" aria-label="视图">
                    <button type="button" className={"seg-btn" + (view === "list" ? " active" : "")} title="列表视图" onClick={() => setView("list")}>
                      <Ic.list size={14}></Ic.list>
                    </button>
                    <button type="button" className={"seg-btn" + (view === "grid" ? " active" : "")} title="网格视图" onClick={() => setView("grid")}>
                      <Ic.layoutGrid size={14}></Ic.layoutGrid>
                    </button>
                  </span>
                  <button type="button" className="btn btn-outline" onClick={() => setNaming(true)}>
                    <Ic.folderPlus size={14}></Ic.folderPlus>新建
                  </button>
                  <button type="button" className="btn btn-primary" onClick={demoUpload}>
                    <Ic.upload size={14}></Ic.upload>上传
                  </button>
                </React.Fragment>
              )}
            </React.Fragment>
          )}
        </div>

        {compact && (
          <div className="dv-mobilebar">
            <span className="seg">
              {railNav.map((r) => (
                <button type="button" key={r.key} className={"seg-btn" + (tab === r.key ? " active" : "")} onClick={() => setTab(r.key)}>
                  {React.createElement(Ic[r.icon], { size: 13 })}
                  {r.label.replace("我的", "")}
                </button>
              ))}
            </span>
            {tab === "drive" && (
              <React.Fragment>
                <SortMenu sort={sort} setSort={setSort}></SortMenu>
                <button type="button" className="icon-btn" title="切换视图" onClick={() => setView(view === "list" ? "grid" : "list")}>
                  {view === "list" ? <Ic.layoutGrid size={15}></Ic.layoutGrid> : <Ic.list size={15}></Ic.list>}
                </button>
              </React.Fragment>
            )}
          </div>
        )}

        <div className={"dv-body" + (sel.size > 0 ? " selecting" : "")}>
          {tab === "drive" &&
            (items.length === 0 ? (
              <div className="empty" style={{ paddingTop: 110 }}>
                {query.trim() ? (
                  <React.Fragment>
                    <Ic.search size={40} strokeWidth={1.3}></Ic.search>
                    <span>没有找到与「{query.trim()}」匹配的文件</span>
                  </React.Fragment>
                ) : (
                  <React.Fragment>
                    <Ic.upload size={40} strokeWidth={1.3}></Ic.upload>
                    <span>{compact ? "点击右下角上传文件" : "拖拽文件到这里上传"}</span>
                  </React.Fragment>
                )}
              </div>
            ) : view === "list" ? (
              listBody
            ) : (
              gridBody
            ))}
          {tab === "shared" && sharedBody}
          {tab === "trash" && trashBody}
        </div>

        {dragOver && (
          <div className="dropzone">
            <Ic.upload size={34} strokeWidth={1.6}></Ic.upload>
            <span>松手上传到「{cwdNode ? cwdNode.name : "我的云盘"}」</span>
          </div>
        )}

        {sel.size > 0 && tab === "drive" && (
          <div className="selbar">
            <span className="cnt">已选 {sel.size} 项</span>
            <button type="button" className="icon-btn" title="下载" onClick={() => toast("打包下载（演示）")}>
              <Ic.download size={16}></Ic.download>
            </button>
            <button type="button" className="icon-btn" title="移动到…" onClick={() => toast("原型演示：移动")}>
              <Ic.move size={16}></Ic.move>
            </button>
            <button type="button" className="icon-btn" title="删除" style={{ color: "var(--destructive)" }} onClick={() => removeNodes([...sel])}>
              <Ic.trash size={16}></Ic.trash>
            </button>
            <span className="div"></span>
            <button type="button" className="icon-btn" title="取消选择" onClick={clearSel}>
              <Ic.x size={16}></Ic.x>
            </button>
          </div>
        )}

        {compact && tab === "drive" && (
          <button type="button" className="fab-upload" aria-label="上传" onClick={demoUpload}>
            <Ic.upload size={22}></Ic.upload>
          </button>
        )}

        {uploads.length > 0 && (
          <div className="dock">
            <div className="dock-head">
              {activeUploads > 0 ? `正在上传 ${activeUploads} 个文件…` : "上传完成"}
              <span className="sp"></span>
              <button type="button" className="icon-btn sm" onClick={() => setDockOpen(!dockOpen)}>
                {dockOpen ? <Ic.chevD size={14}></Ic.chevD> : <Ic.chevR size={14} style={{ transform: "rotate(-90deg)" }}></Ic.chevR>}
              </button>
              <button type="button" className="icon-btn sm" onClick={() => setUploads([])}>
                <Ic.x size={14}></Ic.x>
              </button>
            </div>
            {dockOpen && (
              <div className="dock-rows">
                {uploads.map((u) => (
                  <div key={u.id} className="dock-row">
                    <Ic.file size={15} className="dim"></Ic.file>
                    <span className="nm">
                      {u.name}
                      {!u.done && <span className="bar"><i style={{ width: u.pct + "%" }}></i></span>}
                    </span>
                    {u.done ? (
                      <span className="done-ico"><Ic.check size={15} strokeWidth={2.4}></Ic.check></span>
                    ) : (
                      <span className="pct">{Math.round(u.pct)}%</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </section>

      {/* 全屏灯箱：挂在页面根部，覆盖含侧栏在内的整个应用区域 */}
      {preview != null && files[preview] && (
        <Preview
          items={files}
          index={preview}
          onClose={() => setPreview(null)}
          onNav={(d) => setPreview((p) => Math.max(0, Math.min(files.length - 1, p + d)))}
          toast={toast}
        ></Preview>
      )}

      {shareNode && (
        <ShareDialog
          node={shareNode}
          onClose={() => setShareNode(null)}
          onCreate={(msg, opts) => {
            if (opts) {
              setShares((ss) => [
                {
                  id: Date.now(),
                  nodeId: shareNode.id,
                  kind: shareNode.kind,
                  name: shareNode.name,
                  password: opts.pwd,
                  expire: opts.expire === "永久" ? "永久有效" : opts.expire + "后过期",
                  path: cwdNode ? `我的云盘 › ${cwdNode.name}` : "我的云盘",
                  h1: shareNode.h1,
                  h2: shareNode.h2,
                  s: shareNode.s,
                },
                ...ss,
              ]);
              setNodes((ns) => ns.map((n) => (n.id === shareNode.id ? { ...n, shares: (n.shares || 0) + 1 } : n)));
              setShareNode(null);
            }
            toast(msg);
          }}
        ></ShareDialog>
      )}
      {naming && (
        <NameDialog
          onClose={() => setNaming(false)}
          onSubmit={(name) => {
            setNodes((ns) => [
              ...ns,
              { id: Date.now(), parent: cwd, kind: "folder", name, items: 0, size: 0, mtime: "刚刚", ts: 999, shares: 0 },
            ]);
            setNaming(false);
            toast(`已创建「${name}」`);
          }}
        ></NameDialog>
      )}
    </div>
  );
}

Object.assign(window, { DriveApp, FileIcon });
