// app.jsx — 应用外壳：主题 / 明暗 / 设备切换、页面路由、Toast、Tweaks 面板
// 依赖：前序脚本导出的 Ic / MOTE / NotesApp / DriveApp / IOSDevice。

const {
  useState: useS,
  useEffect: useE,
  useRef: useR,
  useCallback: useC,
} = React;

// ---------- Toast ----------
let toastSeq = 1;

function Toaster({ toasts }) {
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={"toast" + (t.leaving ? " leaving" : "")}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ---------- Tweaks 面板（原型专用） ----------
function TweaksPanel({ theme, setTheme, mode, setMode, device, setDevice }) {
  const [open, setOpen] = useS(false);
  return (
    <React.Fragment>
      <button type="button" className="tw-fab" onClick={() => setOpen(!open)}>
        <Ic.sliders size={14}></Ic.sliders>
        调节
      </button>
      {open && (
        <div className="tw-panel">
          <div className="tw-row">
            <p className="tw-label">主题 · 精选 4 套</p>
            <div className="tw-themes">
              {MOTE.THEMES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={"tw-swatch" + (theme === t.id ? " on" : "")}
                  onClick={() => setTheme(t.id)}
                >
                  <i className="tw-ball" style={{ background: t.ball }}></i>
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="tw-row">
            <p className="tw-label">外观</p>
            <div className="tw-seg">
              <button type="button" className={mode === "light" ? "on" : ""} onClick={() => setMode("light")}>
                <Ic.sun size={13}></Ic.sun>亮色
              </button>
              <button type="button" className={mode === "dark" ? "on" : ""} onClick={() => setMode("dark")}>
                <Ic.moon size={13}></Ic.moon>暗色
              </button>
            </div>
          </div>
          <div className="tw-row">
            <p className="tw-label">设备</p>
            <div className="tw-seg">
              <button type="button" className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")}>
                <Ic.monitor size={13}></Ic.monitor>桌面
              </button>
              <button type="button" className={device === "phone" ? "on" : ""} onClick={() => setDevice("phone")}>
                <Ic.phone size={13}></Ic.phone>手机
              </button>
            </div>
          </div>
          <p className="tw-hint">页面切换在原型内完成：侧栏「云盘」进入云盘，云盘左上角返回笔记。</p>
        </div>
      )}
    </React.Fragment>
  );
}

// ---------- 应用外壳 ----------
function AppShell({ theme, mode, setMode, page, setPage, forceCompact, phoneInsets, toast }) {
  const ref = useR(null);
  const [compact, setCompact] = useS(!!forceCompact);

  useE(() => {
    if (forceCompact) {
      setCompact(true);
      return undefined;
    }
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) setCompact(en.contentRect.width <= 720);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [forceCompact]);

  const coarse =
    forceCompact ||
    (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);

  return (
    <div
      ref={ref}
      className={"app" + (coarse ? " coarse" : "")}
      data-color-theme={theme}
      data-theme={mode}
      style={
        phoneInsets
          ? { "--safe-top": "50px", "--safe-bottom": "26px" }
          : undefined
      }
    >
      {/* 两页常驻挂载，display 切换 —— 跨页保留各自状态（草稿、选择、上传进度） */}
      <div className="page" style={{ display: page === "notes" ? undefined : "none" }}>
        <NotesApp
          compact={compact}
          active={page === "notes"}
          mode={mode}
          setMode={setMode}
          gotoDrive={() => setPage("drive")}
          toast={toast}
        ></NotesApp>
      </div>
      <div className="page" style={{ display: page === "drive" ? undefined : "none" }}>
        <DriveApp compact={compact} gotoNotes={() => setPage("notes")} toast={toast}></DriveApp>
      </div>
      <Toaster toasts={window.__toasts || []}></Toaster>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useS("celadon");
  const [mode, setMode] = useS("light");
  const [device, setDevice] = useS("desktop");
  const [page, setPage] = useS("notes");
  const [toasts, setToasts] = useS([]);
  window.__toasts = toasts;

  const toast = useC((msg) => {
    const id = toastSeq++;
    setToasts((ts) => [...ts.slice(-2), { id, msg }]);
    setTimeout(() => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    }, 2100);
    setTimeout(() => {
      setToasts((ts) => ts.filter((t) => t.id !== id));
    }, 2320);
  }, []);

  useE(() => {
    document.documentElement.style.colorScheme = mode;
  }, [mode]);

  const shell = (phone) => (
    <AppShell
      theme={theme}
      mode={mode}
      setMode={setMode}
      page={page}
      setPage={setPage}
      forceCompact={phone}
      phoneInsets={phone}
      toast={toast}
    ></AppShell>
  );

  return (
    <React.Fragment>
      {device === "phone" ? (
        <div className="stage phone">
          <IOSDevice width={402} height={874} dark={mode === "dark"}>
            {shell(true)}
          </IOSDevice>
        </div>
      ) : (
        <div className="stage">{shell(false)}</div>
      )}
      <TweaksPanel
        theme={theme}
        setTheme={setTheme}
        mode={mode}
        setMode={setMode}
        device={device}
        setDevice={setDevice}
      ></TweaksPanel>
    </React.Fragment>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App></App>);
