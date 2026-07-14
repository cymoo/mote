// icons.jsx — 线性图标集（lucide 风格，stroke=currentColor）
// 用法：<Ic.search size={16} />；全部挂在 window.Ic 上。

function mkIcon(children) {
  return function Icon({ size = 18, strokeWidth = 1.9, className, style }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
        aria-hidden="true"
      >
        {children}
      </svg>
    );
  };
}

const Ic = {
  search: mkIcon(<g><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></g>),
  sun: mkIcon(<g><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></g>),
  moon: mkIcon(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>),
  logout: mkIcon(<g><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="m16 17 5-5-5-5"></path><path d="M21 12H9"></path></g>),
  grid2: mkIcon(<g><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></g>),
  share: mkIcon(<g><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.59 13.51 6.83 3.98"></path><path d="m15.41 6.51-6.82 3.98"></path></g>),
  chart: mkIcon(<g><path d="M3 3v16a2 2 0 0 0 2 2h16"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-3"></path></g>),
  cloud: mkIcon(<g><path d="M4.4 15.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.1 8.5"></path><path d="M12 12v9"></path><path d="m8 17 4-4 4 4"></path></g>),
  sliders: mkIcon(<g><line x1="21" x2="14" y1="4" y2="4"></line><line x1="10" x2="3" y1="4" y2="4"></line><line x1="21" x2="12" y1="12" y2="12"></line><line x1="8" x2="3" y1="12" y2="12"></line><line x1="21" x2="16" y1="20" y2="20"></line><line x1="12" x2="3" y1="20" y2="20"></line><line x1="14" x2="14" y1="2" y2="6"></line><line x1="8" x2="8" y1="10" y2="14"></line><line x1="16" x2="16" y1="18" y2="22"></line></g>),
  trash: mkIcon(<g><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" x2="10" y1="11" y2="17"></line><line x1="14" x2="14" y1="11" y2="17"></line></g>),
  pin: mkIcon(<g><path d="M12 17v5"></path><path d="M9 3h6l-.7 6.2 2.9 2.9a1 1 0 0 1-.7 1.9H7.5a1 1 0 0 1-.7-1.9l2.9-2.9L9 3Z"></path></g>),
  hash: mkIcon(<g><line x1="4" x2="20" y1="9" y2="9"></line><line x1="4" x2="20" y1="15" y2="15"></line><line x1="10" x2="8" y1="3" y2="21"></line><line x1="16" x2="14" y1="3" y2="21"></line></g>),
  chevR: mkIcon(<path d="m9 18 6-6-6-6"></path>),
  chevD: mkIcon(<path d="m6 9 6 6 6-6"></path>),
  chevL: mkIcon(<path d="m15 18-6-6 6-6"></path>),
  more: mkIcon(<g><circle cx="12" cy="12" r="0.9"></circle><circle cx="5" cy="12" r="0.9"></circle><circle cx="19" cy="12" r="0.9"></circle></g>),
  comment: mkIcon(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path>),
  image: mkIcon(<g><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path></g>),
  checksq: mkIcon(<g><path d="m9 11 3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></g>),
  code: mkIcon(<g><path d="m16 18 6-6-6-6"></path><path d="m8 6-6 6 6 6"></path></g>),
  x: mkIcon(<g><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></g>),
  plus: mkIcon(<g><path d="M5 12h14"></path><path d="M12 5v14"></path></g>),
  folder: mkIcon(<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>),
  folderPlus: mkIcon(<g><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path><path d="M12 10v6"></path><path d="M9 13h6"></path></g>),
  upload: mkIcon(<g><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 8 5-5 5 5"></path><path d="M12 3v12"></path></g>),
  download: mkIcon(<g><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path><path d="M12 15V3"></path></g>),
  file: mkIcon(<g><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></g>),
  fileText: mkIcon(<g><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M16 13H8"></path><path d="M16 17H8"></path><path d="M10 9H8"></path></g>),
  film: mkIcon(<g><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M7 3v18"></path><path d="M3 7.5h4"></path><path d="M3 12h18"></path><path d="M3 16.5h4"></path><path d="M17 3v18"></path><path d="M17 7.5h4"></path><path d="M17 16.5h4"></path></g>),
  music: mkIcon(<g><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></g>),
  zip: mkIcon(<g><rect x="2" y="3" width="20" height="5" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></g>),
  link: mkIcon(<g><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></g>),
  key: mkIcon(<g><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"></path></g>),
  restore: mkIcon(<g><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></g>),
  home: mkIcon(<g><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M9 22V12h6v10"></path></g>),
  list: mkIcon(<g><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path></g>),
  arrowUp: mkIcon(<g><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></g>),
  arrowDown: mkIcon(<g><path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path></g>),
  eye: mkIcon(<g><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></g>),
  pencil: mkIcon(<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>),
  move: mkIcon(<g><path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"></path><path d="M2 13h10"></path><path d="m9 16 3-3-3-3"></path></g>),
  check: mkIcon(<path d="M20 6 9 17l-5-5"></path>),
  menu: mkIcon(<g><line x1="4" x2="20" y1="6" y2="6"></line><line x1="4" x2="20" y1="12" y2="12"></line><line x1="4" x2="20" y1="18" y2="18"></line></g>),
  monitor: mkIcon(<g><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" x2="16" y1="21" y2="21"></line><line x1="12" x2="12" y1="17" y2="21"></line></g>),
  phone: mkIcon(<g><rect x="5" y="2" width="14" height="20" rx="2"></rect><path d="M12 18h.01"></path></g>),
  external: mkIcon(<g><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></g>),
  clock: mkIcon(<g><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></g>),
  alert: mkIcon(<g><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></g>),
  layoutGrid: mkIcon(<g><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect></g>),
  quote: mkIcon(<g><path d="M17 6.1H3"></path><path d="M21 12.1H3"></path><path d="M15.1 18H3"></path></g>),
  copy: mkIcon(<g><rect x="8" y="8" width="14" height="14" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></g>),
  settings: mkIcon(<g><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></g>),
  inbox: mkIcon(<g><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></g>),
  sparkle: mkIcon(<path d="M12 3l1.9 5.7a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"></path>),
};

window.Ic = Ic;
