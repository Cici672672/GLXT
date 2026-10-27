/* =========================================================
   格砺学堂 · 前端应用
   ---------------------------------------------------------
   数据流：云端原始行 → applyRaw 转内存模型 → 渲染层只认内存模型
   写入后统一 await refresh()，保证跨用户一致
   本文件不直接持有凭据，一切云端调用走 cloud.js
   ========================================================= */
(function (global) {
  'use strict';

  const CloudAuth = global.CloudAuth;
  const CloudData = global.CloudData;
  const CloudAI = global.CloudAI;

  /* =========================================================
     0. 工具
     ========================================================= */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* 书签图标（收藏用）：默认空心描边，父级带 .on 时由 CSS 填成实心。
     —— 之前用 ★ / ☆ 字符，用户要求换成书签形状，且「收藏后变实心、收藏前空心」 */
  function favIco() {
    return '<svg class="fav-ico" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M5.8 3.6h8.4a1 1 0 011 1v11.9l-5.2-3.8-5.2 3.8V4.6a1 1 0 011-1z"/>' +
    '</svg>';
  }

  let toastTimer = null;
  /* 浏览器原生网络错误（Safari 的 "TypeError: Load failed"、Chrome 的 "Failed to fetch"）
     对用户没有任何意义，统一翻成人话再显示 */
  function humanize(msg) {
    const s = String(msg == null ? '' : msg);
    if (/Load failed|Failed to fetch|NetworkError|network connection was lost|The network connection|fetch failed/i.test(s)) {
      return '网络请求失败，请检查网络后刷新页面重试（也可换个浏览器，或关掉拦截类插件）。';
    }
    return s;
  }

  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = humanize(msg);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!t) return '';
    const diff = Date.now() - t;
    const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    if (diff < MIN) return '刚刚';
    if (diff < HOUR) return Math.floor(diff / MIN) + ' 分钟前';
    if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前';
    if (diff < 2 * DAY) return '昨天更新';
    if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' 天前';
    const d = new Date(t);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function fmtSize(bytes) {
    const b = Number(bytes) || 0;
    if (b <= 0) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  const EXT_KIND = {
    pdf: 'pdf', doc: 'doc', docx: 'doc', ppt: 'ppt', pptx: 'ppt',
    xls: 'xls', xlsx: 'xls', csv: 'xls',
    zip: 'zip', rar: 'zip', '7z': 'zip',
    png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img'
  };
  const CODE_EXT = ['c', 'cpp', 'h', 'java', 'py', 'js', 'ts', 'go', 'rs', 'sql', 'md', 'txt', 'json'];

  function extOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    return i > 0 ? s.slice(i + 1).toLowerCase() : '';
  }
  function kindOf(name) {
    const e = extOf(name);
    if (!e) return 'doc';
    if (EXT_KIND[e]) return EXT_KIND[e];
    if (CODE_EXT.indexOf(e) >= 0) return 'code';
    return 'doc';
  }

  /* =========================================================
     附件选择 —— AI 助手 / 发起提问 共用
     ---------------------------------------------------------
     视觉与「上传学习资料」的文件框一致：左侧文件名 + 右侧选择按钮。
     文本类文件由前端直接读取正文，二进制文件只记录元信息。
     ========================================================= */

  const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h',
    'go', 'rs', 'sql', 'html', 'htm', 'css', 'xml', 'yml', 'yaml', 'tex', 'log', 'ipynb'];

  function attachBoxHtml(key, opts) {
    opts = opts || {};
    return '<div class="file-drop attach-drop" id="att-' + key + '">' +
      '<div class="file-drop-info">' +
        '<div class="file-drop-name" id="attName-' + key + '">还没有选择文件</div>' +
        '<div class="file-drop-size" id="attSize-' + key + '">' +
          (opts.hint || '支持 pdf / 图片 / 代码，单个不超过 20 MB') + '</div>' +
      '</div>' +
      '<label class="file-pick">选择文件' +
        '<input type="file" id="attInput-' + key + '"></label>' +
      '<button type="button" class="file-clear" id="attClear-' + key + '" hidden>移除</button>' +
    '</div>';
  }

  /* 绑定选择行为；选中文件通过 onChange(file) 交回调用方保管 */
  function bindAttach(key, onChange) {
    const input = $('#attInput-' + key);
    if (!input) return;
    const drop = $('#att-' + key);
    const nameEl = $('#attName-' + key);
    const sizeEl = $('#attSize-' + key);
    const clearBtn = $('#attClear-' + key);
    const emptyHint = sizeEl ? sizeEl.textContent : '';

    function paint(file) {
      if (!file) {
        nameEl.textContent = '还没有选择文件';
        sizeEl.textContent = emptyHint;
        drop.classList.remove('has-file');
        clearBtn.hidden = true;
        return;
      }
      nameEl.textContent = file.name;
      sizeEl.textContent = attachStatus(file);
      drop.classList.add('has-file');
      clearBtn.hidden = false;

      // PDF / Office 需要真解析一遍，成功后把「正在解析」换成实际读到的内容量
      if (isPdfFile(file) || isOfficeFile(file)) {
        extractAttach(file).then(function (res) {
          if (!input.files || input.files[0] !== file) return;
          sizeEl.textContent = fmtSize(file.size) + ' · ' + (
            res.kind === 'image'
              ? '扫描版 PDF，按图片识别（共 ' + res.pages + ' 页）'
              : '已读取 ' + String(res.text || '').replace(/\s/g, '').length + ' 字' +
                (res.pages ? '（共 ' + res.pages + ' 页）' : '')
          );
        }).catch(function (err) {
          if (!input.files || input.files[0] !== file) return;
          sizeEl.textContent = fmtSize(file.size) + ' · ' + (err.message || '读取失败');
        });
      }
    }

    input.addEventListener('change', function (e) {
      const f = (e.target.files && e.target.files[0]) || null;
      if (f) {
        const bad = CloudData.validateFile(f);
        if (bad) {
          toast(bad);
          input.value = '';
          onChange(null);
          paint(null);
          return;
        }
      }
      onChange(f);
      paint(f);
    });

    clearBtn.addEventListener('click', function () {
      input.value = '';
      onChange(null);
      paint(null);
    });

    paint(null);
  }

  function isTextFile(file) {
    return !!file && TEXT_EXT.indexOf(extOf(file.name)) >= 0;
  }

  /* 图片：交给视觉模型直接看，不再走「无法读取正文」的兜底文案 */
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
  const OFFICE_EXT = ['docx', 'docm', 'pptx', 'pptm', 'xlsx', 'xlsm'];
  const ATT_TEXT_LIMIT = 16000;
  const attachCache = new WeakMap();

  function isImageFile(file) {
    if (!file) return false;
    if (IMAGE_EXT.indexOf(extOf(file.name)) >= 0) return true;
    // 有些截图 / 粘贴进来的图片没有扩展名，只有 MIME
    return !!(file.type && file.type.indexOf('image/') === 0);
  }

  function isPdfFile(file) { return !!file && extOf(file.name) === 'pdf'; }
  function isOfficeFile(file) { return !!file && OFFICE_EXT.indexOf(extOf(file.name)) >= 0; }

  /* 压缩到最长边 1400px 的 JPEG data URL：省 token，也避开网关的体积限制 */
  function prepareImage(file, maxSide) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const img = new Image();
        img.onload = function () {
          try {
            const max = maxSide || 1400;
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            const scale = Math.min(1, max / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#ffffff';   // 透明背景铺白，避免识别时发黑
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL('image/jpeg', 0.86));
          } catch (e) {
            reject(new Error('图片处理失败，请换一张图片试试。'));
          }
        };
        img.onerror = function () { reject(new Error('这张图片无法识别，请换成 JPG / PNG 试试。')); };
        img.src = String(reader.result || '');
      };
      reader.onerror = function () { reject(new Error('读取图片失败，请重试。')); };
      reader.readAsDataURL(file);
    });
  }

  /* ---------------------------------------------------------
     附件正文提取
     - PDF：用 pdf.js 抽文字层；纯扫描版没有文字层时，把前两页渲染成图片交给视觉模型
     - Word / PPT / Excel：本质是 zip，解开后抽 XML 里的文字（浏览器自带解压，无需依赖库）
     - 图片：压缩后交给视觉模型
     结果按 File 对象缓存，选文件时解析一次，点生成时直接复用
     --------------------------------------------------------- */
  let pdfLibPromise = null;

  function loadPdfLib() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfLibPromise) return pdfLibPromise;

    const urls = [
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
      'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
    ];

    pdfLibPromise = new Promise(function (resolve, reject) {
      let i = 0;
      function tryNext() {
        if (i >= urls.length) {
          pdfLibPromise = null;
          reject(new Error('PDF 解析组件加载失败，请检查网络后重试。'));
          return;
        }
        const url = urls[i++];
        const s = document.createElement('script');
        s.src = url;
        s.onload = function () {
          if (!global.pdfjsLib) { tryNext(); return; }
          try {
            global.pdfjsLib.GlobalWorkerOptions.workerSrc = url.replace('pdf.min.js', 'pdf.worker.min.js');
          } catch (e) { /* 老版本没有该字段也不影响 */ }
          resolve(global.pdfjsLib);
        };
        s.onerror = function () { s.remove(); tryNext(); };
        document.head.appendChild(s);
      }
      tryNext();
    });
    return pdfLibPromise;
  }

  async function readPdfFile(file) {
    const lib = await loadPdfLib();
    const buf = await file.arrayBuffer();
    const doc = await lib.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      disableFontFace: false
    }).promise;

    let text = '';
    const maxPages = Math.min(doc.numPages, 40);
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const line = (tc.items || []).map(function (it) { return it.str || ''; })
        .join(' ').replace(/\s+/g, ' ').trim();
      if (line) text += (text ? '\n' : '') + line;
      if (text.length >= ATT_TEXT_LIMIT) break;
    }

    if (text.trim().length >= 60) {
      return { kind: 'text', text: text.slice(0, ATT_TEXT_LIMIT), pages: doc.numPages };
    }

    // 扫描版 / 图片型 PDF：渲染成图片走视觉模型
    const images = [];
    const n = Math.min(doc.numPages, 2);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.7 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.84));
    }
    return { kind: 'image', images: images, pages: doc.numPages, scanned: true };
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持解压 Office 文档，请把里面的文字直接粘贴进来。'));
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  /* 极简 ZIP 解析：只读中央目录，够抽 Office XML 用 */
  function readZip(file) {
    return file.arrayBuffer().then(function (buf) {
      const bytes = new Uint8Array(buf);
      const dv = new DataView(bytes.buffer);
      let eocd = -1;
      const floor = Math.max(0, bytes.length - 66000);
      for (let i = bytes.length - 22; i >= floor; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('这个文件不是标准的 Office 文档，无法读取。');

      const total = dv.getUint16(eocd + 10, true);
      let off = dv.getUint32(eocd + 16, true);
      const entries = [];
      for (let i = 0; i < total; i++) {
        if (off + 46 > bytes.length || dv.getUint32(off, true) !== 0x02014b50) break;
        const method = dv.getUint16(off + 10, true);
        const compSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const cmtLen = dv.getUint16(off + 32, true);
        const local = dv.getUint32(off + 42, true);
        const name = new TextDecoder('utf-8').decode(bytes.subarray(off + 46, off + 46 + nameLen));
        entries.push({ name: name, method: method, size: compSize, local: local });
        off += 46 + nameLen + extraLen + cmtLen;
      }

      function readEntry(entry) {
        const lo = entry.local;
        if (lo + 30 > bytes.length || dv.getUint32(lo, true) !== 0x04034b50) {
          return Promise.resolve(new Uint8Array(0));
        }
        const nl = dv.getUint16(lo + 26, true);
        const el = dv.getUint16(lo + 28, true);
        const start = lo + 30 + nl + el;
        const data = bytes.subarray(start, start + entry.size);
        if (entry.method === 0) return Promise.resolve(data);
        return inflateRaw(data);
      }

      return { entries: entries, readEntry: readEntry };
    });
  }

  function xmlToText(xml) {
    return String(xml || '')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function readOfficeText(file) {
    const zip = await readZip(file);
    const ext = extOf(file.name);
    const dec = new TextDecoder('utf-8');
    const parts = [];

    if (ext === 'docx' || ext === 'docm') {
      const doc = zip.entries.find(function (x) { return x.name === 'word/document.xml'; });
      if (!doc) throw new Error('这个 Word 文档里没有找到正文。');
      parts.push(xmlToText(dec.decode(await zip.readEntry(doc))));
    } else if (ext === 'pptx' || ext === 'pptm') {
      const slides = zip.entries
        .filter(function (x) { return /^ppt\/slides\/slide\d+\.xml$/.test(x.name); })
        .sort(function (a, b) {
          return Number(a.name.replace(/\D/g, '')) - Number(b.name.replace(/\D/g, ''));
        });
      for (let i = 0; i < slides.length; i++) {
        const t = xmlToText(dec.decode(await zip.readEntry(slides[i])));
        if (t) parts.push('第 ' + (i + 1) + ' 页\n' + t);
      }
    } else {
      const shared = zip.entries.find(function (x) { return x.name === 'xl/sharedStrings.xml'; });
      if (shared) {
        const xml = dec.decode(await zip.readEntry(shared));
        const cells = xml.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [];
        parts.push(cells.map(function (c) { return c.replace(/<[^>]+>/g, ''); }).join('\n'));
      }
      const sheets = zip.entries.filter(function (x) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(x.name); });
      for (let i = 0; i < sheets.length && i < 3; i++) {
        const xml = dec.decode(await zip.readEntry(sheets[i]));
        const inline = xml.match(/<is>[\s\S]*?<\/is>/g) || [];
        if (inline.length) parts.push(inline.map(xmlToText).join('\n'));
      }
    }

    const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('这个文档里没有可提取的文字，可能是纯图片或扫描件。');
    return text;
  }

  /* 统一入口：返回 { kind:'text'|'image', text, images, pages } */
  function extractAttach(file) {
    if (!file) return Promise.resolve({ kind: 'none' });
    if (attachCache.has(file)) return attachCache.get(file);

    const job = (function () {
      try {
        if (isImageFile(file)) {
          if (file.size > 12 * 1024 * 1024) throw new Error('图片太大（超过 12 MB），请压缩后再试。');
          return prepareImage(file).then(function (url) {
            return { kind: 'image', images: [url], pages: 1 };
          });
        }
        if (isPdfFile(file)) return readPdfFile(file);
        if (isOfficeFile(file)) {
          return readOfficeText(file).then(function (t) { return { kind: 'text', text: t }; });
        }
        if (isTextFile(file)) {
          return readAttachText(file, ATT_TEXT_LIMIT).then(function (t) {
            return { kind: 'text', text: t };
          });
        }
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.reject(new Error(
        '「.' + (extOf(file.name) || '未知') + '」这种格式暂时读不了，请上传 PDF / Word / PPT / Excel / 图片 / 代码文件，或把文字直接粘贴进来。'));
    })();

    attachCache.set(file, job);
    job.catch(function () { attachCache.delete(file); });
    return job;
  }

  /* 选中文件后立即给一句状态，别让用户以为没生效 */
  function attachStatus(file) {
    if (!file) return '';
    if (isImageFile(file)) return fmtSize(file.size) + ' · 图片，AI 会直接看';
    if (isPdfFile(file)) return fmtSize(file.size) + ' · 正在解析 PDF…';
    if (isOfficeFile(file)) return fmtSize(file.size) + ' · 正在解析文档…';
    if (isTextFile(file)) return fmtSize(file.size) + ' · 读取正文';
    return fmtSize(file.size) + ' · 该格式可能无法读取';
  }


  function readAttachText(file, limit) {
    return new Promise(function (resolve) {
      const r = new FileReader();
      const max = limit || 12000;
      r.onload = function () {
        const t = String(r.result || '');
        resolve(t.length > max ? t.slice(0, max) + '\n…（附件过长，后续内容已截断）' : t);
      };
      r.onerror = function () { resolve(''); };
      r.readAsText(file);
    });
  }
  function kindLabel(name) {
    const k = kindOf(name);
    if (k === 'code') return extOf(name).toUpperCase() || 'TXT';
    if (k === 'img') return 'IMG';
    return k.toUpperCase();
  }

  /** 学期与周次（秋季 9 月开学 / 春季 2 月下旬开学） */
  function termInfo() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    let label, start;
    if (m >= 7) { label = y + ' 秋季学期'; start = new Date(y, 8, 1); }
    else if (m === 0) { label = (y - 1) + ' 秋季学期'; start = new Date(y - 1, 8, 1); }
    else { label = y + ' 春季学期'; start = new Date(y, 1, 24); }
    const weeks = Math.max(1, Math.floor((now - start) / (7 * 86400000)) + 1);
    return label + ' · 第 ' + weeks + ' 周';
  }

  /* =========================================================
     1. 数据模型
     ========================================================= */

  const db = {
    courses: [],
    questions: [],
    answers: [],
    resources: [],
    favorites: [],   // { targetType, targetId }
    follows: [],     // courseId[]
    votes: [],       // 我点过赞的 answerId[]
    notifications: [], // 别人回答我问题的通知
    profile: { nickname: '华师同学', college: '', campus: '' },
    userId: null,
    hasProfile: false,
    loaded: false
  };

  const RECENT_KEY = 'scnu-gezhi.recent';
  let recentIds = [];
  try {
    recentIds = JSON.parse(global.localStorage.getItem(RECENT_KEY) || '[]') || [];
  } catch (e) { recentIds = []; }

  /* 界面偏好：只存在本机，不改动任何云端数据 */
  const PREF = {
    qaBadge: 'scnu-gezhi.pref.qaBadge',   // 侧边栏「课程问答」数字：'1' 显示 / '0' 隐藏
    recent:  'scnu-gezhi.pref.recent'     // 最近浏览：'1' 记录 / '0' 不记录
  };

  const prefCache = {};
  function getPref(key, dflt) {
    if (Object.prototype.hasOwnProperty.call(prefCache, key)) return prefCache[key];
    try {
      const v = global.localStorage.getItem(key);
      return v == null ? dflt : v;
    } catch (e) { return dflt; }
  }
  function setPref(key, val) {
    prefCache[key] = String(val);
    try { global.localStorage.setItem(key, String(val)); } catch (e) { /* 忽略 */ }
  }
  function prefOn(key) { return getPref(key, '1') !== '0'; }

  function pushRecent(id) {
    if (!prefOn(PREF.recent)) return;
    const n = Number(id);
    recentIds = [n].concat(recentIds.filter(function (x) { return x !== n; })).slice(0, 30);
    try { global.localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds)); } catch (e) { /* 忽略 */ }
  }

  function clearRecent() {
    recentIds = [];
    try { global.localStorage.removeItem(RECENT_KEY); } catch (e) { /* 忽略 */ }
  }

  function mapCourse(row) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      college: row.college || '',
      icon: row.icon || '◍'
    };
  }

  function mapQuestion(row) {
    return {
      id: row.id,
      ownerId: row.owner_id,
      author: row.author || '华师同学',
      title: row.title || '',
      body: row.body || '',
      course: row.course || '',
      courseId: row.course_id,
      tags: row.tags || [],
      views: row.views || 0,
      hot: !!row.hot,
      filePath: row.file_path || null,
      fileName: row.file_name || '',
      fileSize: row.file_size || 0,
      createdAt: row.created_at,
      acceptedAnswerId: row.accepted_answer_id,
      answers: []
    };
  }

  function mapAnswer(row) {
    return {
      id: row.id,
      ownerId: row.owner_id,
      questionId: row.question_id,
      parentId: row.parent_id == null ? null : Number(row.parent_id),
      author: row.author || '华师同学',
      body: row.body || '',
      votes: row.votes || 0,
      createdAt: row.created_at
    };
  }

  function mapNotification(row) {
    return {
      id: row.id,
      type: row.type || 'answer',
      questionId: row.question_id,
      answerId: row.answer_id,
      questionTitle: row.question_title || '',
      actorName: row.actor_name || '华师同学',
      preview: row.preview || '',
      readAt: row.read_at || null,
      createdAt: row.created_at
    };
  }

  function mapResource(row) {
    const fileName = row.file_name || '';    return {
      id: row.id,
      ownerId: row.owner_id,
      author: row.author || '华师同学',
      title: row.title || '',
      course: row.course || '',
      courseId: row.course_id,
      type: row.type || '',
      category: row.category || '精选推荐',
      description: row.description || '',
      filePath: row.file_path,
      fileName: fileName,
      size: row.file_size || 0,
      downloads: row.downloads || 0,
      rating: row.rating,
      pageCount: row.page_count,
      summary: row.summary || '',
      aiReady: !!row.ai_ready,
      original: !!row.original,
      createdAt: row.created_at,
      kind: kindOf(fileName || row.title),
      kindLabel: kindLabel(fileName || row.title)
    };
  }

  function applyRaw(raw) {
    db.questions = (raw.questions || []).map(mapQuestion);
    db.resources = (raw.resources || []).map(mapResource);    db.courses = (raw.courses || []).map(mapCourse);
    db.favorites = (raw.favorites || []).map(function (r) {
      return { targetType: r.target_type, targetId: r.target_id };
    });
    db.follows = (raw.follows || []).map(function (r) { return r.course_id; });
    db.votes = (raw.votes || []).map(function (r) { return Number(r.answer_id); });

    const byId = {};
    db.questions.forEach(function (q) { byId[q.id] = q; });
    (raw.answers || []).map(mapAnswer).forEach(function (a) {
      const q = byId[a.questionId];
      if (q) q.answers.push(a);
    });

    // 回答按时间升序：楼中楼（回复）依赖这个顺序；顶层的展示顺序在渲染时再算
    db.questions.forEach(function (q) {
      q.answers.sort(function (x, y) {
        const tx = new Date(x.createdAt).getTime();
        const ty = new Date(y.createdAt).getTime();
        if (tx !== ty) return tx - ty;
        return Number(x.id) - Number(y.id);
      });
    });

    // 课程计数
    const qCount = {}, rCount = {};
    db.questions.forEach(function (q) { if (q.courseId) qCount[q.courseId] = (qCount[q.courseId] || 0) + 1; });
    db.resources.forEach(function (r) { if (r.courseId) rCount[r.courseId] = (rCount[r.courseId] || 0) + 1; });
    db.courses.forEach(function (c) {
      c.questions = qCount[c.id] || 0;
      c.resources = rCount[c.id] || 0;
    });

    // 后端 course 字段存的是 ds / calc1 这类课程代码，展示时统一换成课程中文名
    const nameById = {};
    db.courses.forEach(function (c) { nameById[c.id] = c.name; });
    [db.questions, db.resources].forEach(function (list) {
      list.forEach(function (item) {
        if (item.courseId && nameById[item.courseId]) item.course = nameById[item.courseId];
      });
    });

    db.hasProfile = db.profile && db.profile.nickname && raw.hasProfile;
    applyNavBadge();
  }

  async function refresh() {
    if (!db.userId) {
      const raw = await CloudData.fetchAll(null);
      // 未登录：不带个人数据
      applyRaw(raw);
      db.profile = { nickname: '华师同学' };
      db.notifications = [];
      db.loaded = true;
      return;
    }
    const raw = await CloudData.fetchAll(db.userId);
    applyRaw(raw);

    const p = (raw.profiles || [])[0];
    if (p) {
      db.profile = {
        nickname: p.nickname || defaultNickname(),
        college: p.college || '',
        campus: p.campus || '',
        avatar: p.avatar_url || ''
      };
      db.hasProfile = true;
    } else {
      db.profile = { nickname: defaultNickname(), college: '', campus: '', avatar: '' };
      db.hasProfile = false;
    }
    db.loaded = true;
    loadNotifications();   // 不 await：通知晚到不该拖慢首屏
  }

  /* =========================================================
     回答通知
     ---------------------------------------------------------
     写入由数据库触发器完成，前端只负责：拉自己的通知 → 侧栏 / 铃铛红点
     → 进入「我的提问」后标记已读、红点消失。
     ========================================================= */

  async function loadNotifications() {
    if (!db.userId) {
      db.notifications = [];
      applyNavBadge();
      return;
    }
    const rows = await CloudData.fetchNotifications(db.userId);
    db.notifications = (rows || []).map(mapNotification);
    applyNavBadge();
  }

  let markingRead = false;

  /** 把当前未读通知标为已读；红点先乐观消失，失败再还原 */
  async function markAnswerNoticesRead(onlyIds) {
    if (markingRead) return;
    let unread = Store.unreadNotifications();
    if (onlyIds && onlyIds.length) {
      const keep = {};
      onlyIds.forEach(function (id) { keep[Number(id)] = 1; });
      unread = unread.filter(function (n) { return keep[Number(n.id)]; });
    }
    if (!unread.length) return;

    markingRead = true;
    const ids = unread.map(function (n) { return n.id; });
    unread.forEach(function (n) { n.readAt = new Date().toISOString(); });
    applyNavBadge();

    try {
      await CloudData.markNotificationsRead(ids);
    } catch (e) {
      unread.forEach(function (n) { n.readAt = null; });
      applyNavBadge();
    } finally {
      markingRead = false;
    }
  }

  /** 渲染「我的提问」用：先快照未读数，否则标记已读后标签会立刻消失 */
  function unreadAnswerMap() {
    const map = {};
    Store.unreadNotifications().forEach(function (n) {
      const qid = Number(n.questionId);
      map[qid] = (map[qid] || 0) + 1;
    });
    return map;
  }

  /* 只读访问器：渲染层统一从这里取数据 */
  const Store = {
    signedIn: function () { return !!db.userId; },
    userId: function () { return db.userId; },
    nickname: function () { return (db.profile && db.profile.nickname) || '华师同学'; },
    avatar: function () { return (db.profile && db.profile.avatar) || ''; },
    courses: function () { return db.courses; },
    course: function (id) {
      return db.courses.filter(function (c) { return c.id === Number(id); })[0] || null;
    },
    questions: function () { return db.questions; },
    question: function (id) {
      return db.questions.filter(function (q) { return q.id === Number(id); })[0] || null;
    },
    resources: function () { return db.resources; },
    resource: function (id) {
      return db.resources.filter(function (r) { return r.id === Number(id); })[0] || null;
    },
    isMine: function (row) { return !!db.userId && row && row.ownerId === db.userId; },
    hasFavorite: function (type, id) {
      const t = String(type), n = Number(id);
      return db.favorites.some(function (f) { return f.targetType === t && f.targetId === n; });
    },
    isFollowing: function (courseId) {
      return db.follows.indexOf(Number(courseId)) >= 0;
    },
    followedCourses: function () {
      return db.courses.filter(function (c) { return Store.isFollowing(c.id); });
    },
    myQuestions: function () {
      return db.questions.filter(function (q) { return Store.isMine(q); });
    },
    myResources: function () {
      return db.resources.filter(function (r) { return Store.isMine(r); });
    },
    myFavorites: function () {
      const out = [];
      db.favorites.forEach(function (f) {
        if (f.targetType === 'question') {
          const q = Store.question(f.targetId);
          if (q) out.push({ type: 'question', item: q });
        } else {
          const r = Store.resource(f.targetId);
          if (r) out.push({ type: 'resource', item: r });
        }
      });
      return out;
    },
    recentQuestions: function () {
      return recentIds.map(function (id) { return Store.question(id); }).filter(Boolean);
    },

    /* ---- 回答通知 ---- */
    notifications: function () { return db.notifications; },
    unreadNotifications: function () {
      return db.notifications.filter(function (n) { return !n.readAt; });
    },
    unreadCount: function () { return Store.unreadNotifications().length; },
    /** 某个问题上有多少条还没看过的回答 */
    newAnswerCount: function (questionId) {
      const qid = Number(questionId);
      return db.notifications.filter(function (n) {
        return !n.readAt && Number(n.questionId) === qid;
      }).length;
    },
    unsolved: function () {
      return db.questions.filter(function (q) { return !q.acceptedAnswerId; });
    },
    stats: function () {
      const total = db.questions.length;
      const solved = db.questions.filter(function (q) { return !!q.acceptedAnswerId; }).length;
      return {
        questions: total,
        solved: solved,
        resources: db.resources.length,
        courses: db.courses.length,
        rate: total ? Math.round((solved / total) * 100) : 0,
        answers: db.questions.reduce(function (n, q) { return n + q.answers.length; }, 0)
      };
    }
  };

  /* =========================================================
     2. 路由
     ========================================================= */

  const PAGES = ['square', 'qa', 'detail', 'resources', 'resource', 'file', 'search', 'ai',
                 'favorites', 'myquestions', 'myuploads', 'recent', 'settings', 'admin'];

  function ensurePage(name) {
    let el = document.getElementById('page-' + name);
    if (!el) {
      el = document.createElement('section');
      el.className = 'page';
      el.id = 'page-' + name;
      $('#main').appendChild(el);
    }
    return el;
  }

  let currentRoute = { page: 'square', param: null };

  function parseHash() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const page = parts[0] || 'square';
    if (PAGES.indexOf(page) < 0) return { page: 'square', param: null };
    let param = parts[1] || null;
    if (param) {
      try { param = decodeURIComponent(param); } catch (e) { /* 解码失败就按原样用 */ }
    }
    return { page: page, param: param };
  }

  function go(hash) {
    if (location.hash === hash) { applyRoute(true); return; }
    location.hash = hash;
  }

  /* 记住上一次渲染的路由：点赞 / 回复 / 采纳都会「重新渲染同一页」，
     那种情况下不能把滚动条拉回顶部，否则读者会被弹回页面开头。 */
  let lastRouteKey = null;

  function applyRoute(forceScroll) {
    const route = parseHash();
    currentRoute = route;
    const routeKey = route.page + '/' + (route.param || '');
    const sameRoute = routeKey === lastRouteKey;
    lastRouteKey = routeKey;

    // 离开附件页后，回头再看同一个附件要重新计一次浏览
    if (route.page !== 'file') lastFilePage = null;

    // #/qa/course-<id>：从首页课程卡进来时，自动按该课程筛选
    if (route.page === 'qa') {
      const m = /^course-(\d+)$/.exec(route.param || '');
      qaFilter.courseId = m ? Number(m[1]) : null;
    }

    $$('.nav-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-page') === route.page);
    });

    // 配色：只有「学习广场」首页用白底那套，其余页面沿用渐变侧栏那套
    document.documentElement.classList.toggle('square-page', route.page === 'square');

    PAGES.forEach(function (p) {
      const el = ensurePage(p);
      el.hidden = p !== route.page;
    });

    const render = {
      square: renderSquare,
      qa: renderQa,
      detail: function () { renderDetail(route.param); },
      resources: renderResources,
      resource: function () { renderResource(route.param); },
      file: function () { renderFilePage(route.param); },
      search: function () { renderSearch(route.param); },
      ai: renderAi,
      favorites: function () { renderFavorites(); },
      myquestions: function () { renderCodeList('questions'); },
      myuploads: function () { renderCodeList('uploads'); },
      recent: function () { renderCodeList('recent'); },
      settings: renderSettings,
      admin: renderAdmin
    }[route.page];

    if (render) render();
    if (route.page === 'qa') markQaSeen();
    refreshAdminState();
    closeMobileNav();
    // 同一页面内的局部刷新（点赞/回复/采纳）保留当前位置；真正切换页面才回到顶部
    if (forceScroll || !sameRoute) {
      $('#main').scrollTop = 0;
      global.scrollTo(0, 0);
    }
  }

  /* 移动端抽屉导航：桌面端有常驻侧栏，这套开关不会生效 */
  function closeMobileNav() {
    if (!document.body.classList.contains('nav-open')) return;
    document.body.classList.remove('nav-open');
    const btn = $('#navToggle');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  /* 手机上搜索框收成一个图标，点开后铺满顶栏 */
  function initMobileSearch() {
    const box = document.querySelector('.topsearch');
    const input = $('#globalSearch');
    if (!box || !input) return;
    box.addEventListener('click', function () {
      if (document.body.classList.contains('searching')) return;
      document.body.classList.add('searching');
      // 展开后 input 才 display:block，下一帧再聚焦
      setTimeout(function () { input.focus(); }, 0);
    });
    input.addEventListener('blur', function () {
      document.body.classList.remove('searching');
    });
    const cancel = box.querySelector('.search-cancel');
    if (cancel) {
      // 先拦住指针按下，避免输入框 blur 先把搜索条收起来，导致按钮点不中
      cancel.addEventListener('pointerdown', function (e) { e.preventDefault(); });
      cancel.addEventListener('click', function (e) {
        e.stopPropagation();
        document.body.classList.remove('searching');
        input.blur();
      });
    }
  }

  /* 通知轮询：省额度优先 —— 5 分钟一次（页面隐藏时跳过），
     切回标签页 / 进入我的提问时仍会立刻拉一次，实际感知不慢 */
  const NOTICE_POLL_MS = 300000;
  let noticeTimer = null;
  function startNoticePolling() {
    if (noticeTimer) return;
    noticeTimer = setInterval(function () {
      if (document.hidden || !db.userId) return;
      loadNotifications();
    }, NOTICE_POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && db.userId) loadNotifications();
    });
  }

  function initMobileNav() {
    const btn = $('#navToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const open = document.body.classList.toggle('nav-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    const scrim = $('#navScrim');
    if (scrim) scrim.addEventListener('click', closeMobileNav);
    // 点导航项后自动收起（路由器已在 applyRoute 里再收一次）
    document.addEventListener('click', function (e) {
      if (e.target.closest('.sidebar .nav-item')) closeMobileNav();
    });
  }

  /* =========================================================
     3. 账号
     ========================================================= */

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^1\d{10}$/;

  const authState = {
    intent: 'auth',            // auth（登录/注册）| nickname（改昵称）| reset（重置或设置密码）
    hint: '',                  // 弹窗顶部提示语（随模式变化）
    baseHint: '',              // 打开弹窗时传入的提示语，非重置模式沿用
    method: 'email',           // email | phone
    mode: 'login',             // login | signup | confirm | reset
    purpose: 'login',          // confirm 页确认后要做什么：login（验证码登录）| signup（验证码注册）
    codeSent: false,           // confirm 页是否已经发过验证码
    pendingEmail: null,
    pendingPhone: null,
    pendingName: null,         // 注册时填写的用户名，登录成功后写入昵称
    pendingPassword: null,     // 注册时填写的密码，确认验证码时一并提交
    verificationId: null,      // sendOtp 返回，verifyOtp 必须回传
    resetHandle: null,
    countdown: 0,
    timer: null
  };

  function defaultNickname() {
    const s = sessionUser();
    if (!s) return '华师同学';
    const id = String(s.id || '');
    if (id.indexOf('@') > 0) return id.split('@')[0];
    if (PHONE_RE.test(id)) return '同学' + id.slice(-4);
    return '华师同学';
  }

  function sessionUser() {
    return authState.session ? authState.session.user : null;
  }

  function maskEmail(email) {
    const p = String(email || '').split('@');
    if (p.length < 2) return String(email || '');
    return p[0].slice(0, 2) + '***@' + p[1];
  }

  function maskPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    const tail = digits.slice(-11);
    return tail.length === 11 ? tail.slice(0, 3) + '****' + tail.slice(-4) : String(phone || '');
  }

  function maskedAccount() {
    // 平台返回的会话 id 是内部数字，真正的登录名要从 getUser 拿
    if (accountProfile && accountProfile.email) return maskEmail(accountProfile.email);
    if (accountProfile && accountProfile.phone) return maskPhone(accountProfile.phone);

    const s = sessionUser();
    if (!s) return '';
    const id = String(s.id || '');
    if (id.indexOf('@') > 0) return maskEmail(id);
    if (PHONE_RE.test(id)) return maskPhone(id);
    return '已登录';
  }

  /* 头像：有自定义图就用图，没有就退回昵称首字。
     cls 决定尺寸（user-avatar / set-avatar / avatar-lg） */
  function avatarHtml(cls) {
    const klass = cls || 'user-avatar';
    const av = Store.avatar();
    const nick = Store.nickname();
    if (av) {
      return '<span class="' + klass + ' has-img">' +
        '<img src="' + esc(av) + '" alt="' + esc(nick) + '的头像">' +
      '</span>';
    }
    return '<span class="' + klass + '">' + esc(nick.slice(0, 1) || '同') + '</span>';
  }

  function renderAuthArea() {
    const box = $('#authArea');
    if (!box) return;

    if (Store.signedIn()) {
      const nick = Store.nickname();
      box.innerHTML =
        '<button class="user-chip" id="userChip">' +
          avatarHtml('user-avatar') +
          '<span class="user-name">' + esc(nick) + '</span>' +
          '<span class="user-caret">▾</span>' +
        '</button>';
      $('#userChip').addEventListener('click', function (e) {
        e.stopPropagation();
        openUserMenu($('#userChip'));
      });
    } else {
      box.innerHTML = '<button class="btn-ghost" id="btnLogin">登录 / 注册</button>';
      $('#btnLogin').addEventListener('click', function () { openAuthModal('登录后即可提问、上传和收藏。'); });
    }
  }

  let scrollCloser = null;

  function openUserMenu(anchor) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.id = 'floatingMenu';
    menu.innerHTML =
      '<div style="padding:8px 11px 6px;font-size:12px;color:#93a3b8">' + esc(maskedAccount()) + '</div>' +
      '<div class="sep"></div>' +
      '<button data-act="settings">设置</button>' +
      '<div class="sep"></div>' +
      '<button data-act="signout" class="danger">退出登录</button>';

    document.body.appendChild(menu);

    // .menu 是 position:fixed，坐标按视口算：跟着头像按钮走，页面滚动时不会漂
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = global.innerWidth || document.documentElement.clientWidth;
    const vh = global.innerHeight || document.documentElement.clientHeight;

    let top = r.bottom + 8;
    if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 8);   // 下方放不下就往上翻
    menu.style.top = top + 'px';
    menu.style.left = Math.max(8, Math.min(r.right - mw, vw - mw - 8)) + 'px';

    // 页面一滚动就收起，避免菜单悬在原地挡住内容
    scrollCloser = function () { closeMenu(); };
    document.addEventListener('scroll', scrollCloser, true);

    menu.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      closeMenu();
      if (act === 'signout') { doSignOut(); return; }
      go('#/' + act);
    });

    setTimeout(function () {
      document.addEventListener('click', closeMenu, { once: true });
    }, 0);
  }

  function closeMenu() {
    const m = $('#floatingMenu');
    if (m) m.remove();
    if (scrollCloser) {
      document.removeEventListener('scroll', scrollCloser, true);
      scrollCloser = null;
    }
  }

  /* ---------- 登录 / 注册弹窗 ---------- */

  function openAuthModal(hint, opts) {
    opts = opts || {};
    const root = $('#modalRoot');
    root.hidden = false;

    // 每次打开都回到登录首页，避免上次的确认页状态残留
    authState.intent = opts.intent || 'auth';
    authState.baseHint = hint || '';
    authState.hint = authState.baseHint;
    authState.mode = opts.mode || 'login';
    authState.purpose = 'login';
    authState.codeSent = false;
    authState.verificationId = null;
    authState.pendingPassword = null;
    stopCountdown();

    function draw() {
      const signed = Store.signedIn();

      // 设置密码模式：提示语跟着当前选的是邮箱还是手机号走
      if (authState.mode === 'reset') {
        authState.hint = '用' + (authState.method === 'email' ? '邮箱验证码' : '手机短信验证码') +
          '确认身份，验证后即可设置新的登录密码' +
          (signed ? '，设置成功后本机仍保持登录。' : '。');
      } else {
        authState.hint = authState.baseHint;
      }

      // Confirm 页有自己的验证码提示，不再叠加通用提示条
      const showHint = authState.hint && !(authState.mode === 'confirm' && authState.codeSent);
      root.innerHTML =
        '<div class="modal narrow' + (signed ? '' : ' auth-modal') + '">' +
          '<button class="modal-close" data-close="1" aria-label="关闭">✕</button>' +
          '<div class="modal-body">' +
            (showHint ? '<p class="auth-hint">' + esc(authState.hint) + '</p>' : '') +
            authBodyHtml() +
          '</div>' +
        '</div>';

      bindAuth();
    }

    root.addEventListener('click', function (e) {
      if (e.target === root || e.target.closest('[data-close]')) closeModal();
    });
    draw();
    global.__redrawAuth = draw;
  }

  function authBodyHtml() {
    // 只有「改昵称」这个入口才在看已登录时显示昵称表单；
    // 其余入口（登录、找回/设置密码）即使用户已登录也必须显示对应的表单
    if (Store.signedIn() && authState.intent === 'nickname') {
      return '<div class="auth-logo" style="margin:6px auto 18px">学</div>' +
        '<p class="hint" style="text-align:center">已登录：' + esc(maskedAccount()) + '</p>' +
        '<label class="label">昵称</label>' +
        '<input class="field" id="nickInput" value="' + esc(Store.nickname()) + '" maxlength="16" placeholder="设置一个昵称">' +
        '<button class="btn btn-block" style="margin-top:16px" data-act="saveNick">保存昵称</button>';
    }

    // 输入验证码页只有标志 + 验证码 + 确认，不再显示账号形式切换
    const showTabs = !(authState.mode === 'confirm' && authState.codeSent);
    const tabs = showTabs
      ? '<div class="auth-tabs">' +
          '<button class="auth-tab' + (authState.method === 'email' ? ' on' : '') + '" data-method="email">邮箱</button>' +
          '<button class="auth-tab' + (authState.method === 'phone' ? ' on' : '') + '" data-method="phone">手机号</button>' +
        '</div>'
      : '';

    return tabs +
      '<div class="auth-logo" aria-hidden="true">学</div>' +
      '<div id="authFormBox">' + formHtml() + '</div>';
  }

  /* 品牌标：与设计稿一致 —— 圆角方块 + 白色书法「学」 */
  function brandSvg() {
    return '<svg viewBox="0 0 64 64" aria-hidden="true">' +
      '<rect x="0" y="0" width="64" height="64" rx="17" fill="#90abd8"/>' +
      '<text x="32" y="34" text-anchor="middle" dominant-baseline="central" ' +
      'fill="#ffffff" font-size="42" ' +
      'font-family="Xingkai SC, STXingkai, 华文行楷, Kaiti SC, STKaiti, cursive">学</text></svg>';
  }

  /* 胶囊输入框：中文标签 + 英文小字，输入后自动让位 */
  function pillField(id, zh, en, o) {
    o = o || {};
    return '<div class="pill' + (o.btn ? ' send' : '') + (o.code ? ' code' : '') + '">' +
      '<input id="' + id + '"' +
        (o.type ? ' type="' + o.type + '"' : '') +
        (o.mode ? ' inputmode="' + o.mode + '"' : '') +
        (o.max ? ' maxlength="' + o.max + '"' : '') +
        (o.ac ? ' autocomplete="' + o.ac + '"' : '') +
        (o.value ? ' value="' + esc(o.value) + '"' : '') +
        ' placeholder=" ">' +
      '<span class="pill-ph"><b>' + esc(zh) + '</b><i>' + esc(en) + '</i></span>' +
      (o.btn ? '<button class="pill-send" data-act="' + o.btn + '">' + esc(o.btnLabel) + '</button>' : '') +
    '</div>';
  }

  /* 收件人输入框：邮箱或手机号，注册 / 验证码登录时内嵌「发送验证码」 */
  function recipientField(isEmail, o) {
    o = o || {};
    if (isEmail) {
      return pillField('authEmail', '邮箱', 'Email', {
        type: 'email', ac: 'username', value: authState.pendingEmail,
        btn: o.send ? 'sendEmailCode' : '', btnLabel: '发送验证码'
      });
    }
    return pillField('authPhone', '手机号', 'Phone number', {
      mode: 'numeric', max: 11, value: authState.pendingPhone,
      btn: o.send ? 'sendPhoneCode' : '', btnLabel: '发送验证码'
    });
  }

  /* 表单渲染：method（邮箱 / 手机号）× mode（登录 / 注册 / 确认 / 找回） */
  function formHtml() {
    const isEmail = authState.method === 'email';
    const m = authState.mode;

    /* ---- Confirm：输入验证码 ---- */
    if (m === 'confirm') {
      if (!authState.codeSent) {
        return recipientField(isEmail, { send: true }) +
          '<div id="authError"></div>' +
          '<button class="pill-btn" data-act="submitAuth">发送验证码 Send code</button>' +
          '<div class="auth-foot">' +
            '<button class="foot-link" data-act="cancelConfirm"><b>取消</b><i>Cancel</i></button>' +
            '<button class="foot-link right" data-act="toLogin"><b>密码登录</b><i>Password</i></button>' +
          '</div>';
      }
      return pillField('authCode', '验证码', 'verification code', {
          mode: 'numeric', max: 6, code: true
        }) +
        '<div id="authError"></div>' +
        '<button class="pill-btn" data-act="submitAuth">确认 Confirm</button>' +
        '<div class="auth-foot">' +
          '<button class="foot-link" data-act="cancelConfirm"><b>取消</b><i>Cancel</i></button>' +
        '</div>';
    }

    /* ---- 找回 / 设置密码：邮箱或手机号都可以验证 ---- */
    if (m === 'reset') {
      const signedNow = Store.signedIn();
      return recipientField(isEmail, { send: true }) +
        pillField('authCode', '验证码', 'verification code', { mode: 'numeric', max: 6, code: true }) +
        pillField('authPassword', '新密码', 'New Password', { type: 'password', ac: 'new-password' }) +
        '<div id="authError"></div>' +
        '<button class="pill-btn" data-act="submitAuth">确认 Confirm</button>' +
        '<div class="auth-foot">' +
          '<button class="foot-link" data-act="toLogin"><b>取消</b><i>Cancel</i></button>' +
          (signedNow ? '' : '<button class="foot-link right" data-act="toLogin"><b>返回登录</b><i>Log in</i></button>') +
        '</div>';
    }

    /* ---- 注册：用户名 + 账号（发码）+ 密码 + 确认密码 ---- */
    if (m === 'signup') {
      return pillField('authName', '用户名', 'user name', {
          max: 16, ac: 'nickname', value: authState.pendingName
        }) +
        recipientField(isEmail, { send: true }) +
        pillField('authPassword', '密码', 'Password', {
          type: 'password', ac: 'new-password', value: authState.pendingPassword
        }) +
        pillField('authPassword2', '确认密码', 'Confirm Password', {
          type: 'password', ac: 'new-password', value: authState.pendingPassword
        }) +
        '<div id="authError"></div>' +
        '<button class="pill-btn" data-act="submitAuth">注册 Register</button>' +
        '<div class="auth-foot">' +
          '<button class="foot-link" data-act="toLogin"><b>登录</b><i>Log in</i></button>' +
          '<button class="foot-link right" data-act="toReset"><b>忘记密码？</b><i>Forgot Password</i></button>' +
        '</div>';
    }

    /* ---- 登录：账号 + 密码 ---- */
    return recipientField(isEmail, {}) +
      pillField('authPassword', '密码', 'Password', { type: 'password', ac: 'current-password' }) +
      '<div id="authError"></div>' +
      '<button class="pill-btn" data-act="submitAuth">登录 Sign in</button>' +
      '<p class="auth-alt">也可以用 <button data-act="toCode">验证码登录</button></p>' +
      '<div class="auth-foot">' +
        '<button class="foot-link" data-act="toSignup"><b>注册</b><i>Register</i></button>' +
        '<button class="foot-link right" data-act="toReset"><b>忘记密码？</b><i>Forgot Password</i></button>' +
      '</div>';
  }

  function setFormError(msg) {
    const box = $('#authError');
    if (!box) return;
    box.innerHTML = msg ? '<div class="form-error">' + esc(msg) + '</div>' : '';
  }

  function setAuthBusy(busy, label) {
    $$('#modalRoot button').forEach(function (b) { b.disabled = !!busy; });
    if (busy && label) toast(label);
  }

  function startCountdown(sec) {
    stopCountdown();
    authState.countdown = sec;
    const tick = function () {
      const btns = $$('#modalRoot [data-act="sendEmailCode"], #modalRoot [data-act="sendPhoneCode"]');
      btns.forEach(function (b) {
        if (authState.countdown > 0) {
          b.disabled = true;
          b.textContent = authState.countdown + ' 秒后可重发';
        } else {
          b.disabled = false;
          b.textContent = '发送验证码';
          stopCountdown();
        }
      });
      if (authState.countdown > 0) authState.countdown -= 1;
    };
    tick();
    authState.timer = setInterval(tick, 1000);
  }

  function stopCountdown() {
    if (authState.timer) { clearInterval(authState.timer); authState.timer = null; }
    authState.countdown = 0;
  }

  function readVal(sel) {
    const el = $(sel);
    return ((el && el.value) || '').trim();
  }

  /* 发送验证码：注册 / 验证码登录 / 找回密码 共用；成功后进入 Confirm 页 */
  async function sendCode(which) {
    const isEmail = which === 'email';
    const value = isEmail ? readVal('#authEmail') : readVal('#authPhone');

    if (isEmail && !EMAIL_RE.test(value)) { setFormError('请输入正确的邮箱地址。'); return; }
    if (!isEmail && !PHONE_RE.test(value)) { setFormError('请输入正确的 11 位手机号。'); return; }

    // 重置 / 设置密码：平台的重置接口自己会发码，不能再走 sendOtp，
    // 否则会连发两封不同的验证码，用户填哪一封都可能报错
    if (authState.mode === 'reset') {
      setFormError('');
      setAuthBusy(true);
      const rh = await CloudAuth.startPasswordReset(isEmail ? { email: value } : { phone: value });
      setAuthBusy(false);
      if (!rh.ok) { setFormError(rh.message); return; }
      authState.method = which;
      if (isEmail) { authState.pendingEmail = value; authState.pendingPhone = null; }
      else { authState.pendingPhone = value; authState.pendingEmail = null; }
      authState.resetHandle = rh.handle;
      startCountdown(60);
      toast(isEmail ? '验证码已发送，请查收邮箱。' : '验证码已发送，请查看短信。');
      return;
    }

    if (authState.mode === 'signup') {
      // 注册态：先把用户名 / 密码校验并存好，确认验证码时一起提交
      const name = readVal('#authName');
      const pwd = ($('#authPassword') || {}).value || '';
      const pwd2 = ($('#authPassword2') || {}).value || '';
      if (!name) { setFormError('请先填写用户名。'); return; }
      if (pwd.length < 6) { setFormError('密码至少 6 位。'); return; }
      if (pwd !== pwd2) { setFormError('两次输入的密码不一致。'); return; }
      authState.pendingName = name;
      authState.pendingPassword = pwd;
      authState.purpose = 'signup';
    } else {
      authState.purpose = 'login';
    }

    authState.method = which;
    setFormError('');
    setAuthBusy(true);
    const res = await CloudAuth.sendOtp(isEmail
      ? { email: value, type: 'email' }
      : { phone: value, type: 'sms' });
    setAuthBusy(false);
    if (!res.ok) { setFormError(res.message); return; }

    if (isEmail) authState.pendingEmail = value;
    else authState.pendingPhone = value;
    authState.verificationId = res.verificationId || null;

    // 注册 / 验证码登录：发送成功后进入 Confirm 确认页
    authState.mode = 'confirm';
    authState.codeSent = true;
    if (global.__redrawAuth) global.__redrawAuth();
    startCountdown(60);
    toast(isEmail ? '验证码已发送，请查收邮箱。' : '验证码已发送，请查看短信。');
  }

  function sendEmailCode() { return sendCode('email'); }
  function sendPhoneCode() { return sendCode('phone'); }

  /* 主按钮：按当前 mode 分发 */
  async function submitAuth() {
    const m = authState.mode;
    if (m === 'signup') { sendCode(authState.method); return; }
    if (m === 'confirm') {
      if (!authState.codeSent) { sendCode(authState.method); return; }
      return verifyCode();
    }
    if (m === 'reset') return submitReset();
    return signIn(authState.method);
  }

  /* 密码登录：邮箱 / 手机号都走 signInWithPassword */
  async function signIn(which) {
    const isEmail = which === 'email';
    const pwd = ($('#authPassword') || {}).value || '';
    const account = isEmail ? readVal('#authEmail') : readVal('#authPhone');

    if (isEmail && !EMAIL_RE.test(account)) { setFormError('请输入正确的邮箱地址。'); return; }
    if (!isEmail && !PHONE_RE.test(account)) { setFormError('请输入正确的 11 位手机号。'); return; }
    if (!pwd) { setFormError('请输入密码。'); return; }

    setAuthBusy(true, '正在登录…');
    const res = await CloudAuth.signInWithPassword(
      isEmail ? account : { phone: account }, pwd);
    setAuthBusy(false);
    if (!res.ok) {
      setFormError(isEmail
        ? res.message
        : '手机号或密码不正确。若这个手机号还没设置密码，可以登录后用验证码补一个，或直接用「验证码登录」。');
      return;
    }
    await finishSignIn(res.session);
  }

  /* Confirm 页：校验验证码 → 注册 or 验证码登录 */
  async function verifyCode() {
    const code = readVal('#authCode');
    if (!/^\d{6}$/.test(code)) { setFormError('请输入 6 位验证码。'); return; }

    const isEmail = authState.method === 'email';
    const isSignup = authState.purpose === 'signup';
    const target = isEmail ? authState.pendingEmail : authState.pendingPhone;

    if (!target || !authState.verificationId) { setFormError('验证码已失效，请取消后重新发送。'); return; }
    if (isSignup && !authState.pendingPassword) { setFormError('注册信息已失效，请返回重新填写。'); return; }

    const payload = {
      token: code,
      verificationId: authState.verificationId,
      isExistingUser: !isSignup
    };
    if (isEmail) { payload.email = target; payload.type = 'email'; }
    else { payload.phone = target; payload.type = 'sms'; }
    if (isSignup) payload.password = authState.pendingPassword;

    setAuthBusy(true, isSignup ? '正在注册…' : '正在验证…');
    const res = await CloudAuth.verifyOtp(payload);
    setAuthBusy(false);
    if (!res.ok) { setFormError(res.message); return; }
    await finishSignIn(res.session);
  }

  /* 找回 / 设置密码：邮箱或手机号 + 验证码 + 新密码 */
  async function submitReset() {
    const isEmail = authState.method === 'email';
    const typed = isEmail ? readVal('#authEmail') : readVal('#authPhone');
    const target = typed || (isEmail ? authState.pendingEmail : authState.pendingPhone) || '';
    const code = readVal('#authCode');
    const pwd = ($('#authPassword') || {}).value || '';

    if (isEmail && !EMAIL_RE.test(target)) { setFormError('请输入正确的邮箱地址。'); return; }
    if (!isEmail && !PHONE_RE.test(target)) { setFormError('请输入正确的 11 位手机号。'); return; }
    if (!code) { setFormError('请输入验证码。'); return; }
    if (pwd.length < 6) { setFormError('新密码至少 6 位。'); return; }
    if (!authState.resetHandle) { setFormError('请先点击「发送验证码」。'); return; }

    // 发码后又改了账号：旧验证码不属于新账号，必须重发
    const sentTo = isEmail ? authState.pendingEmail : authState.pendingPhone;
    if (sentTo && target !== sentTo) {
      setFormError('账号已修改，请重新点击「发送验证码」。');
      return;
    }

    setAuthBusy(true, '正在保存…');
    const res = await CloudAuth.finishPasswordReset(authState.resetHandle, code, pwd);
    setAuthBusy(false);
    if (!res.ok) { setFormError(res.message); return; }

    authState.resetHandle = null;
    authState.pendingPassword = null;

    // 已登录时这个流程是「给账号补一个密码」，会话不会失效，不需要重新登录
    if (Store.signedIn()) {
      authState.mode = 'login';
      authState.intent = 'auth';
      closeModal();
      await loadAccountProfile();
      if (currentRoute.page === 'settings') renderSettings();
      toast(isEmail
        ? '密码已设置，之后可以用「邮箱 + 密码」登录。'
        : '密码已设置，之后可以用「手机号 + 密码」登录。');
      return;
    }

    // 未登录场景：邮箱 / 手机号流程都会顺带建立会话
    if (res.session) { await finishSignIn(res.session, { silent: true }); return; }

    authState.mode = 'login';
    toast('密码已重置，请用新密码登录。');
    if (global.__redrawAuth) global.__redrawAuth();
  }

  async function finishSignIn(session, opts) {
    authState.session = session;
    db.userId = session && session.user ? session.user.id : null;
    stopCountdown();

    const wantName = authState.pendingName;
    try {
      await refresh();
      if (db.userId && (!db.hasProfile || wantName)) {
        await CloudData.saveNickname(db.userId, wantName || Store.nickname() || defaultNickname());
        authState.pendingName = null;
        await refresh();
      }
    } catch (e) {
      toast(e.message || '数据加载失败。');
    }

    await loadAccountProfile();
    closeModal();
    renderAuthArea();
    applyRoute();
    if (!(opts && opts.silent)) toast('欢迎回来，' + Store.nickname() + '。');
  }

  async function doSignOut() {
    await CloudAuth.signOut();
    authState.session = null;
    accountProfile = null;
    db.userId = null;
    db.profile = { nickname: '华师同学', college: '', campus: '' };
    db.favorites = [];
    db.follows = [];
    await refresh().catch(function () {});
    renderAuthArea();
    applyRoute();
    toast('已退出登录。');
  }

  /* ---------------- 注销账号 ---------------- */

  function openDeleteAccountModal() {
    if (!Store.signedIn()) { openAuthModal('登录后才能注销账号。'); return; }

    const myQ = Store.myQuestions().length;
    const myR = Store.myResources().length;
    const myA = Store.questions().reduce(function (n, q) {
      return n + q.answers.filter(function (a) { return Store.isMine(a); }).length;
    }, 0);

    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal narrow">' +
        '<div class="modal-head">' +
          '<div>' +
            '<h3 class="modal-title">注销账号</h3>' +
            '<p class="modal-sub">此操作不可撤销，删除后无法恢复</p>' +
          '</div>' +
          '<button class="modal-close" data-close="1" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div class="danger-box">' +
            '<b>注销后会发生什么</b>' +
            '<ul class="danger-list">' +
              '<li>你的 ' + myQ + ' 条提问、' + myA + ' 条回答、' + myR + ' 份资料会被永久删除</li>' +
              '<li>收藏、关注的课程、消息通知也会一并清除</li>' +
              '<li>这个邮箱 / 手机号将无法再登录，需要重新注册一个全新账号</li>' +
              '<li>别人回答问题给你的通知会消失，你回答过的问题下也不再有你的名字</li>' +
            '</ul>' +
          '</div>' +
          '<label class="label" style="margin-top:14px">确认注销请输入「注销」两个字</label>' +
          '<input class="field" id="deleteConfirm" autocomplete="off" placeholder="注销">' +
          '<div id="deleteError"></div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-danger solid" data-act="delete-confirm" disabled>永久注销</button>' +
          '<button class="btn btn-line" data-close="1">我再想想</button>' +
        '</div>' +
      '</div>';

    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }
      if (e.target.closest('[data-act="delete-confirm"]')) { submitDeleteAccount(); return; }
    };

    const input = $('#deleteConfirm');
    if (input) {
      input.addEventListener('input', function () {
        const btn = $('[data-act="delete-confirm"]');
        if (btn) btn.disabled = String(input.value || '').trim() !== '注销';
      });
      input.focus();
    }
  }

  async function submitDeleteAccount() {
    const input = $('#deleteConfirm');
    const word = String((input && input.value) || '').trim();
    const errBox = $('#deleteError');
    if (word !== '注销') {
      if (errBox) errBox.innerHTML = '<div class="form-error">请输入「注销」两个字再确认。</div>';
      return;
    }

    const btn = $('[data-act="delete-confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在注销…'; }

    const res = await CloudData.deleteAccount(word);
    if (!res.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '永久注销'; }
      if (errBox) errBox.innerHTML = '<div class="form-error">' + esc(res.message) + '</div>';
      return;
    }

    /* 账号行已经没了，先把本地会话彻底清掉，再回到广场 */
    try { await CloudAuth.signOut(); } catch (e) { /* 已经注销，忽略退出失败 */ }
    authState.session = null;
    accountProfile = null;
    db.userId = null;
    db.profile = { nickname: '华师同学', college: '', campus: '', avatar: '' };
    db.favorites = [];
    db.follows = [];
    db.notifications = [];
    clearRecent();
    closeModal();
    await refresh().catch(function () {});
    renderAuthArea();
    go('#/square');
    toast('账号已注销，期待下次再见。');
  }

  function requireLogin(actionText) {
    if (Store.signedIn()) return true;
    openAuthModal('登录后即可' + (actionText || '继续操作') + '。');
    return false;
  }

  function bindAuth() {
    const root = $('#modalRoot');
    if (!root) return;

    root.onclick = function (e) {
      const tab = e.target.closest('.auth-tab');
      if (tab) {
        const next = tab.getAttribute('data-method');
        if (next !== authState.method) {
          authState.method = next;
          // 登录 / 注册 / 验证码登录 / 设置密码之间切换账号形式时保持当前模式；其余情况回到登录
          const cur = authState.mode;
          const keep = cur === 'signup' ? 'signup'
            : cur === 'reset' ? 'reset'
            : (cur === 'confirm' && !authState.codeSent ? 'confirm' : 'login');
          authState.mode = keep;
          authState.purpose = keep === 'signup' ? 'signup' : 'login';
          authState.codeSent = false;
          authState.verificationId = null;
          authState.resetHandle = null;
          stopCountdown();
        }
        if (global.__redrawAuth) global.__redrawAuth();
        return;
      }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');

      if (act === 'sendEmailCode') { sendEmailCode(); return; }
      if (act === 'sendPhoneCode') { sendPhoneCode(); return; }
      if (act === 'submitAuth') { submitAuth(); return; }

      // 登录 / 注册 / 验证码登录 / 找回密码 互切
      if (act === 'toLogin') {
        // 已登录时这里是从「设置密码」进来的，取消就关掉弹窗，不要回落到登录表单
        if (Store.signedIn() && authState.intent === 'reset') { closeModal(); return; }
        authState.mode = 'login';
        authState.codeSent = false;
        authState.purpose = 'login';
        authState.verificationId = null;
        stopCountdown();
        global.__redrawAuth();
        return;
      }
      if (act === 'toSignup') {
        authState.mode = 'signup';
        authState.codeSent = false;
        authState.purpose = 'signup';
        authState.verificationId = null;
        stopCountdown();
        global.__redrawAuth();
        return;
      }
      if (act === 'toCode') {
        authState.mode = 'confirm';
        authState.codeSent = false;
        authState.purpose = 'login';
        authState.verificationId = null;
        stopCountdown();
        global.__redrawAuth();
        return;
      }
      if (act === 'cancelConfirm') {
        authState.mode = authState.purpose === 'signup' ? 'signup' : 'login';
        authState.codeSent = false;
        authState.verificationId = null;
        stopCountdown();
        global.__redrawAuth();
        return;
      }
      if (act === 'toReset') {
        // 邮箱和手机号都能找回 / 设置密码，保留当前选中的账号形式与已填内容
        const typed = authState.method === 'email' ? readVal('#authEmail') : readVal('#authPhone');
        if (typed) {
          if (authState.method === 'email') authState.pendingEmail = typed;
          else authState.pendingPhone = typed;
        }
        authState.mode = 'reset';
        authState.codeSent = false;
        authState.resetHandle = null;
        authState.verificationId = null;
        stopCountdown();
        global.__redrawAuth();
        return;
      }
      if (act === 'saveNick') {
        const v = (($('#nickInput') || {}).value || '').trim();
        if (!v) { toast('昵称不能为空。'); return; }
        const uid = db.userId;
        CloudData.saveNickname(uid, v).then(function () {
          return refresh();
        }).then(function () {
          renderAuthArea();
          applyRoute();
          toast('昵称已更新。');
        }).catch(function (err) { toast(err.message || '保存失败。'); });
        return;
      }
    };

    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      if (authState.mode === 'confirm' && authState.codeSent) { verifyCode(); return; }
      submitAuth();
    });
  }

  /* =========================================================
     4. 通用渲染片段
     ========================================================= */

  function pageHead(title, sub, crumb) {
    return '<div class="page-head">' +
      (crumb ? '<div class="crumb">' + crumb + '</div>' : '') +
      '<h1 class="page-title">' + esc(title) + '</h1>' +
      (sub ? '<p class="page-sub">' + esc(sub) + '</p>' : '') +
      '</div>';
  }

  /* ---------------------------------------------------------
     侧边栏「课程问答」数字 = 上次看过之后新增的问题数
     · 有新问题才冒数字，点一下就把数字清掉（不是永久关闭）
     · 「设置 · 显示偏好」里可以彻底关掉这个提醒
     用 document 捕获阶段做事件委托：不依赖 init 是否顺利跑完，
     也不会被外层 <a href="#/qa"> 的默认跳转抢走。
     --------------------------------------------------------- */
  const QA_SEEN_KEY = 'scnu-gezhi.qa.seenAt';

  function qaSeenAt() {
    const v = Number(getPref(QA_SEEN_KEY, '0'));
    return isFinite(v) ? v : 0;
  }

  function markQaSeen() {
    setPref(QA_SEEN_KEY, String(Date.now()));
    applyNavBadge();
    if (currentRoute && currentRoute.page === 'settings') renderSettings();
  }

  /** 别人发的、上次查看之后新增的问题 */
  function newQaCount() {
    const since = qaSeenAt();
    if (!since) return 0;
    return Store.questions().filter(function (q) {
      return !Store.isMine(q) && new Date(q.createdAt).getTime() > since;
    }).length;
  }

  function applyNavBadge() {
    const badge = $('#navQaCount');
    if (!badge) return;

    // 第一次进站只记一个基线，不把历史问题全算成「新」
    if (!qaSeenAt()) setPref(QA_SEEN_KEY, String(Date.now()));

    const n = newQaCount();
    const show = prefOn(PREF.qaBadge) && n > 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = !show;
    badge.style.display = show ? '' : 'none';   // 双保险：有的环境会忽略 hidden
    badge.title = show ? n + ' 个新问题，点一下标记已读' : '';
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    applyNoticeDot();
  }

  /** 未读红点：侧栏「我的提问」只算回答/回复，顶栏铃铛连公告一起算 */
  function applyNoticeDot() {
    const all = Store.signedIn() ? Store.unreadNotifications() : [];
    const n = all.filter(function (x) { return x.type !== 'notice'; }).length;
    const bellN = all.length;
    const qDot = $('#navMyQDot');
    if (qDot) {
      qDot.textContent = n > 99 ? '99+' : String(n);
      qDot.hidden = n <= 0;
      qDot.style.display = n > 0 ? '' : 'none';
      qDot.title = n > 0 ? n + ' 条新消息还没看' : '';
    }
    const bellDot = $('#noticeDot');
    if (bellDot) {
      bellDot.hidden = bellN <= 0;
      bellDot.style.display = bellN > 0 ? '' : 'none';
    }
    const bell = $('#btnNotice');
    if (bell) bell.title = bellN > 0 ? bellN + ' 条新消息' : '消息通知';
  }

  function dismissQaBadge() {
    if (newQaCount() <= 0) return;
    markQaSeen();
    toast('已标记为已读，之后有新问题还会再提醒。');
  }

  document.addEventListener('click', function (e) {
    const badge = e.target && e.target.closest ? e.target.closest('#navQaCount') : null;
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    dismissQaBadge();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target || e.target.id !== 'navQaCount') return;
    e.preventDefault();
    e.stopPropagation();
    dismissQaBadge();
  }, true);

  function questionCard(q, newCount) {
    const solved = !!q.acceptedAnswerId;
    const mine = Store.isMine(q);
    const tags = (q.tags || []).slice(0, 3).map(function (t) {
      return '<span class="tag">' + esc(t) + '</span>';
    }).join('');
    return '<article class="q-item" data-qid="' + q.id + '">' +
      '<div class="q-item-top">' +
        (solved ? '<span class="tag tag-ok">✓ 已解决</span>' : '<span class="tag tag-warn">待解答</span>') +
        (q.hot ? '<span class="tag tag-soft">本周热议</span>' : '') +
        (q.course ? '<span class="q-course">' + esc(q.course) + '</span>' : '') +
        tags +
        (q.fileName ? '<span class="tag">📎 附件</span>' : '') +
        (mine ? '<span class="tag tag-mine">我的</span>' : '') +
        (newCount ? '<span class="tag tag-new">💬 新回答 ' + newCount + '</span>' : '') +
      '</div>' +
      '<h3 class="q-item-title">' + esc(q.title) + '</h3>' +
      '<p class="q-item-body">' + esc(q.body) + '</p>' +
      '<div class="q-item-foot">' +
        '<span>' + esc(q.author) + '</span>' +
        '<span>' + fmtTime(q.createdAt) + '</span>' +
        '<span class="spacer"></span>' +
        '<span>' + q.answers.length + ' 个回答</span>' +
        '<span>' + q.views + ' 次浏览</span>' +
      '</div>' +
    '</article>';
  }

  function resourceCard(r) {
    const faved = Store.hasFavorite('resource', r.id);
    const meta = [
      r.pageCount ? r.pageCount + ' 页' : null,
      r.size ? fmtSize(r.size) : null,
      fmtTime(r.createdAt)
    ].filter(Boolean).join(' · ');
    return '<article class="res-card" data-rid="' + r.id + '">' +
      '<div class="res-top">' +
        '<div class="res-file ' + r.kind + '">' + esc(r.kindLabel) + '</div>' +
        '<button class="bookmark' + (faved ? ' on' : '') + '" data-fav="resource" data-id="' + r.id + '" title="' +
          (faved ? '取消收藏' : '收藏') + '">' + favIco() +
        '</button>' +
      '</div>' +
      '<h3 class="res-title">' + esc(r.title) + '</h3>' +
      (r.course ? '<div class="res-course">' + esc(r.course) + '</div>' : '') +
      '<div class="res-meta">' + esc(meta) + '</div>' +
      (r.description ? '<p class="res-desc">' + esc(r.description) + '</p>'
                     : '<p class="res-desc res-desc-empty">暂无简介</p>') +
      '<div class="res-foot">' +
        '<span class="res-by" title="上传者：' + esc(r.author) + '">👤 ' + esc(r.author) + '</span>' +
        '<span>👁 ' + r.downloads + ' 次浏览</span>' +
        '<span class="res-ai' + (r.aiReady ? ' ready' : '') + '">✧ ' +
          (r.aiReady ? 'AI 摘要可读' : '暂无摘要') + '</span>' +
      '</div>' +
    '</article>';
  }

  function emptyBox(title, sub, btn) {
    return '<div class="empty"><strong>' + esc(title) + '</strong>' +
      (sub ? '<span class="empty-sub">' + esc(sub) + '</span>' : '') +
      (btn || '') + '</div>';
  }

  /* =========================================================
     5. 页面：学习广场
     ========================================================= */

  function renderSquare() {
    const el = ensurePage('square');
    const st = Store.stats();
    const courses = Store.courses();
    const hot = Store.questions().slice()
      .sort(function (a, b) { return (b.views + b.answers.length * 6) - (a.views + a.answers.length * 6); })
      .slice(0, 3);
    const newRes = Store.resources().slice(0, 3);

    el.innerHTML =
      '<div class="hero">' +
        '<div class="hero-week">' + esc(termInfo()) + '</div>' +
        '<div class="hero-main">' +
          '<div class="hero-kicker">◈ 同一门课，一起找到答案。</div>' +
          '<h1 class="hero-title">让每一个学习难题，都有回应。</h1>' +
          '<p class="hero-desc">告别刷不完的群消息与散落的复习资料，按课程找到同伴、沉淀知识，' +
            '让 AI 陪你理清思路，让好答案随时可查。</p>' +
          '<div class="hero-actions">' +
            '<button class="btn" data-act="ask">＋ 发布问题</button>' +
            '<button class="btn btn-line" data-act="upload">⬆ 分享学习资料</button>' +
            '<span class="hero-badge">✓ 华师同学，互相成就</span>' +
          '</div>' +
        '</div>' +
        '<div class="hero-art">' + heroArt() + '</div>' +
      '</div>' +

      '<div class="ai-banner">' +
        '<div class="ai-banner-icon">✦</div>' +
        '<div class="ai-banner-main">' +
          '<strong>你的 AI 学习搭子</strong>' +
          '<span>随时在线，不错过每一个答案。题目解析、知识点提炼、资料摘要，一次搞定。</span>' +
        '</div>' +
        '<a class="btn" href="#/ai">进入 AI 学习工作台 ↗</a>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section-head">' +
          '<div><h2 class="section-title">按课程探索</h2>' +
          '<p class="section-sub">问题与资料，终于有了共同的目录</p></div>' +
          '<a class="section-more" href="#/resources">全部课程 ›</a>' +
        '</div>' +
        '<div class="course-grid" id="courseGrid">' +
          (courses.length
            ? courses.map(function (c) {
                return '<button class="course-card" data-course="' + c.id + '">' +
                  '<span class="course-icon">' + esc(c.icon) + '</span>' +
                  '<span class="course-meta">' +
                    '<span class="course-name">' + esc(c.name) + '</span>' +
                    '<span class="course-info">' + c.questions + ' 个问题 · ' + c.resources + ' 份资料</span>' +
                  '</span>' +
                '</button>';
              }).join('')
            : '<div class="empty">还没有课程数据</div>') +
        '</div>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section-head">' +
          '<div><h2 class="section-title">正在热议</h2>' +
          '<p class="section-sub">同学们最关心的问题</p></div>' +
          '<a class="section-more" href="#/qa">去问答区 ›</a>' +
        '</div>' +
        '<div class="q-list">' + (hot.length ? hot.map(function (q) { return questionCard(q); }).join('') : emptyBox('还没有问题', '来发布第一个问题吧')) + '</div>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section-head">' +
          '<div><h2 class="section-title">值得收藏的学习资料</h2>' +
          '<p class="section-sub">同学们上传整理的复习材料</p></div>' +
          '<a class="section-more" href="#/resources">查看全部 ›</a>' +
        '</div>' +
        '<div class="res-grid">' + (newRes.length ? newRes.map(resourceCard).join('') : emptyBox('还没有资料', '来分享第一份资料吧')) + '</div>' +
        '<div class="notice-explain">尊重原创，分享有据可循。资料仅供学习交流，请勿用于商业用途。</div>' +
      '</div>' +

      '<div class="section">' +
        '<h2 class="section-title" style="margin-bottom:12px">平台数据</h2>' +
        '<div class="stats">' +
          '<div class="stat"><div class="stat-num">' + st.questions + '</div><div class="stat-label">累计提问</div></div>' +
          '<div class="stat"><div class="stat-num">' + st.rate + '%</div><div class="stat-label">问题获得回应</div></div>' +
          '<div class="stat"><div class="stat-num">' + st.resources + '</div><div class="stat-label">共享资料</div></div>' +
          '<div class="stat"><div class="stat-num">' + st.answers + '</div><div class="stat-label">同学回答</div></div>' +
        '</div>' +
      '</div>';

    el.onclick = function (e) {
      const ask = e.target.closest('[data-act="ask"]');
      if (ask) { openAskModal(); return; }
      const up = e.target.closest('[data-act="upload"]');
      if (up) { openUploadModal(); return; }
      const cc = e.target.closest('[data-course]');
      if (cc) { go('#/qa/course-' + cc.getAttribute('data-course')); return; }
      bindCommonClicks(e);
    };
  }

  function heroArt() {
    return '<svg viewBox="0 0 240 170" aria-hidden="true">' +
      '<rect x="0" y="0" width="240" height="170" rx="18" fill="#c3d9ee"/>' +
      '<circle cx="196" cy="34" r="26" fill="#aecbe8"/>' +
      '<rect x="28" y="96" width="184" height="52" rx="14" fill="#ffffff" opacity=".85"/>' +
      '<rect x="42" y="110" width="86" height="8" rx="4" fill="#9db9d6"/>' +
      '<rect x="42" y="126" width="58" height="8" rx="4" fill="#c3d5e6"/>' +
      '<circle cx="70" cy="62" r="18" fill="#2f4f7a"/>' +
      '<path d="M52 78c4-7 12-10 18-10s14 3 18 10z" fill="#4a6b96"/>' +
      '<circle cx="122" cy="52" r="15" fill="#e8a33d"/>' +
      '<path d="M107 66c3-6 9-9 15-9s12 3 15 9z" fill="#d98f26"/>' +
      '<circle cx="168" cy="70" r="14" fill="#3f7fc4"/>' +
      '<path d="M154 83c3-5 8-8 14-8s11 3 14 8z" fill="#2f68a8"/>' +
      '<path d="M118 30l14-6-5 14 12-3-16 16 3-12-12 3z" fill="#fff8e2" stroke="#c9a04a" stroke-width="1.4"/>' +
      '</svg>';
  }

  /* =========================================================
     6. 页面：课程问答
     ========================================================= */

  /* ---------------------------------------------------------
     6.5 南海校区：板块 / 课程类别 / 课程 三级分类
     依据南海校区各学院培养方案整理：
       板块（全校区 6 个）→ 课程类别（每板块 2–5 类）→ 具体课程
     同一门课可能被多个板块共用（如「机器学习」），
     所以用关键词包含匹配，不做「一门课只属于一个板块」的硬绑定。
     公共课板块额外兜底：没有被任何专业板块认领的课程也归到公共课。
     --------------------------------------------------------- */
  const CAMPUS = [
    {
      key: 'general', name: '公共课与通识教育', short: '公共课',
      desc: '全校通用 · 数学、思政、写作、数字媒体与实践环节',
      groups: [
        {
          name: '数学与基础科学',
          courses: ['高等数学', '高数', '微积分', '线性代数', '线代', '概率论与数理统计',
            '概率论', '复变函数', '离散数学', '离散结构', '随机过程', '数学建模',
            '运筹学', '管理运筹学', '大学物理', '工程制图', '电子工艺',
            '机械基础导论', '电子信息导论']
        },
        {
          name: '思政与通识教育',
          courses: ['马克思主义基本原理', '毛泽东思想和中国特色社会主义理论体系概论',
            '思想道德与法治', '中国近现代史纲要', '形势与政策', '习近平经济思想概论',
            '经济法', '交叉学科融合应用专题', '模块项目', '思想引领', '创新创业',
            '全球学习', '朋辈教育', '社会学导论', '社会学', '国际卓越课程',
            '军事理论', '劳动教育', '安全教育']
        },
        {
          name: '学术写作与研究方法',
          courses: ['金融学术写作', '文献阅读与学术写作', '社会科学研究方法',
            '商业研究方法', '学术写作']
        },
        {
          name: '数字媒体与文化',
          courses: ['数字文化概论', '数字美学概论', '数字美术基础', '文化资源概论',
            '游戏经济与互动叙事', 'IP 角色形象及数字衍生设计', '动画与游戏设计',
            '数字技术与文化生产']
        },
        {
          name: '实践与毕业环节',
          courses: ['专业实习', '毕业实习', '毕业论文', '毕业设计', '课程设计',
            '学科竞赛', '双创实践', '电子设计实践', '金工实习', '课程实验',
            '各类课程实验', '生产实习', '课程大作业']
        },
        {
          name: '其他公共必修',
          courses: ['大学英语', '大学体育', '计算机基础', '大学生职业发展与就业指导',
            '教育心理学', '现代教育技术']
        }
      ]
    },
    {
      key: 'business', name: '国际商学院', short: '国际商学院',
      desc: '经济、金融、财会统计与管理',
      groups: [
        {
          name: '经济基础类',
          courses: ['微观经济学', '宏观经济学', '经济学原理', '财政学', '平台经济学',
            '文化与创意经济学', '数字经济概论']
        },
        {
          name: '金融核心类',
          courses: ['金融学概论', '数字金融', '商业银行业务与经营', '金融市场与监管',
            '公司金融', '公司治理与职业道德', '绿色与可持续金融', '国际金融',
            '金融衍生工具', '资产定价', '固定收益证券', '证券投资技术分析',
            '金融风险管理', '金融科技', '金融区块链实践', '供应链金融',
            '大数据智能风控', '行为金融学', '保险学', '个人理财', '中国金融学',
            '房地产金融与投资']
        },
        {
          name: '财会与统计类',
          courses: ['会计学原理', '会计与财务基础', '财务分析', '统计学', '计量经济学',
            '高级计量经济学', '回归分析', '回归分析与多元统计', '回归和方差分析',
            '多元统计分析', '面板数据分析', '统计软件高阶应用']
        },
        {
          name: '管理类',
          courses: ['管理学原理', '现代企业管理', '数字化与企业管理', '组织管理',
            '市场营销', '管理信息系统', '企业计算和业务', '业务战略',
            '商业伦理与企业社会责任', '信息资源管理', '数字营销与品牌管理',
            '数字资产管理', '管理预测与决策方法', '数智供应链管理',
            '大数据与新媒体运营', '创客教育的理念与实践', '信息检索', '信息组织',
            'ERP 原理']
        }
      ]
    },
    {
      key: 'ee', name: '电子科学与工程学院（微电子学院）', short: '电子科学',
      desc: '电路、信号与通信、集成电路与半导体',
      groups: [
        {
          name: '电子电路类',
          courses: ['电路分析基础', '电路分析', '模拟电子电路', '模拟电子技术',
            '数字电子技术', '数字系统与逻辑设计', '电磁场与电磁波', '检测与转换技术',
            '电子测量', '可编程逻辑电路设计', '控制工程', '数字系统设计']
        },
        {
          name: '信号与通信类',
          courses: ['信号与系统', '通信电子电路', '通信电子线路', '通信原理',
            '数字信号处理', '微波技术与天线', '移动通信', '信息论与编码',
            '交换技术与通信网', '物联网技术与应用', '随机信号处理', '光信息处理',
            '光电技术与光纤基础']
        },
        {
          name: '集成电路与半导体类',
          courses: ['集成电路导论', '半导体物理与器件', '模拟集成电路',
            '模拟集成电路设计', '数字集成电路', '微电子封装和测试技术',
            '集成电路设计基础', '单片机原理及应用', '集成电路']
        }
      ]
    },
    {
      key: 'ai', name: '人工智能学院', short: '人工智能',
      desc: '编程语言、数据结构与算法、系统网络、软件工程、AI 核心',
      groups: [
        {
          name: '编程语言类',
          courses: ['Python 程序设计', 'Python', 'Java 语言程序设计', 'Java',
            '面向对象程序设计', '高级程序设计', '计算机语言与可计算化',
            'C 语言程序设计', 'C语言程序设计', 'C/Python']
        },
        {
          name: '数据结构与算法类',
          courses: ['数据结构', '数据结构与算法', '算法设计与分析', '算法设计', '算法']
        },
        {
          name: '计算机系统与网络',
          courses: ['计算机网络', '计算机体系结构', '计算机组成原理', '操作系统原理',
            '操作系统', '分布式系统', '微机原理与接口技术', '嵌入式系统', 'Linux 系统',
            '计算机科学技术导论', '网络安全技术', '数据库原理与应用',
            '数据库系统原理与实践', '数据库原理', '数据库']
        },
        {
          name: '软件工程类',
          courses: ['软件工程导论', '软件测试与质量', '软件过程与管理', '软件构造',
            '软件系统设计与体系结构', 'Web 应用程序开发', '软件工程', '软件测试',
            '软件项目管理', 'Web 开发']
        },
        {
          name: '人工智能与机器学习类',
          courses: ['人工智能基础', '人工智能导论', '机器学习', '深度学习与神经网络',
            '神经网络与深度学习', '自然语言处理', '计算智能', '机器人技术',
            '知识表示', '模式识别与机器学习', '计算机视觉与模式识别', '计算机视觉',
            '数字图像处理', '智能软件实作', '深度学习']
        }
      ]
    },
    {
      key: 'aberdeen', name: '阿伯丁数据科学与人工智能学院', short: '阿伯丁',
      desc: '大数据、AI 高阶与国际化课程',
      groups: [
        {
          name: '大数据与数据科学类',
          courses: ['大数据与商业智能概论', '大数据技术基础', '数据治理',
            '大数据可视化分析', '数据挖掘与可视化', '知识图谱', '数据科学前沿讲座',
            '大数据伦理与法律', '数字经济法与合规实务', '数据治理与数字伦理',
            '数字版权与知识产权经济', '数据挖掘', '大数据技术', '数据科学']
        },
        {
          name: '人工智能高阶类',
          courses: ['大语言模型与商业智能', '多模态 AI 与智能商业分析',
            '生成式 AI 与商业应用', '大语言模型', '生成式 AI', '多模态']
        },
        {
          name: '编程与算法类',
          courses: ['R 语言程序设计', 'R语言']
        },
        {
          name: '国际类课程',
          courses: ['国际商务与跨文化交流', '跨境电商案例研究', '跨文化交流', '跨境电商']
        }
      ]
    },
    {
      key: 'rennes', name: '雷恩数智商学院', short: '雷恩数智',
      desc: '数字化商业、金融与交叉管理',
      groups: [
        {
          name: '数字化商业与金融',
          courses: ['大数据金融', '商业应用程序开发', 'AI 编程', '商业应用开发']
        },
        {
          name: '交叉管理类',
          courses: ['数据挖掘', '知识图谱', '管理学原理', '管理信息系统', '市场营销',
            '数字营销与品牌管理', '数字资产管理', '数智供应链管理', '大数据分析']
        }
      ]
    }
  ];

  /** 板块课程池 = 各课程类别课程并集（按归一化名去重，保留第一次出现的写法） */
  CAMPUS.forEach(function (c) {
    const seen = Object.create(null);
    (c.groups || []).forEach(function (g) {
      (g.courses || []).forEach(function (n) {
        const k = normCourse(n);
        if (k && !seen[k]) seen[k] = n;
      });
    });
    c.courses = Object.keys(seen).map(function (k) { return seen[k]; });
  });

  /* 校区：目前只有南海校区录入了板块与课程，其余三个校区先留空 */
  const CAMPUSES = [
    { key: 'nanhai', name: '南海校区', short: '南海', desc: '佛山南海 · 已开放 6 个板块', boards: CAMPUS },
    { key: 'daxuecheng', name: '大学城校区', short: '大学城', desc: '广州大学城 · 分类整理中', boards: [] },
    { key: 'shipai', name: '石牌校区', short: '石牌', desc: '广州石牌 · 分类整理中', boards: [] },
    { key: 'shanwei', name: '汕尾校区', short: '汕尾', desc: '汕尾 · 分类整理中', boards: [] }
  ];

  function campusByKey(key) {
    return CAMPUSES.filter(function (c) { return c.key === key; })[0] || null;
  }

  /** 当前校区下的板块；「全部校区」= 所有校区板块并集 */
  function boardsOf(campusKey) {
    const cp = campusByKey(campusKey);
    if (!cp) return CAMPUS;
    return cp.boards || [];
  }

  function boardByKey(key, campusKey) {
    const boards = boardsOf(campusKey);
    return boards.filter(function (c) { return c.key === key; })[0] || null;
  }

  /** 课程名归一：去空格、去括号内容、去 A/B/C 尾巴、转小写 */
  function normCourse(s) {
    return String(s || '')
      .replace(/（[^）]*）|\([^)]*\)/g, '')
      .replace(/\s+/g, '')
      .replace(/[A-Ca-c]$/, '')
      .toLowerCase();
  }

  function collegeByKey(key) {
    return CAMPUS.filter(function (c) { return c.key === key; })[0] || null;
  }

  /** 课程名是否落在某个关键词表里（双向包含，长度≥2 才算，避免「C」这种误伤） */
  function nameHits(name, keywords) {
    const n = normCourse(name);
    if (!n) return false;
    return keywords.some(function (kw) {
      const k = normCourse(kw);
      if (k.length < 2) return false;
      return n.indexOf(k) >= 0 || k.indexOf(n) >= 0;
    });
  }

  /** 取一条问题/资料的课程名：优先用课程表里的规范名 */
  function itemCourseName(item) {
    if (!item) return '';
    if (item.courseId) {
      const c = Store.course(item.courseId);
      if (c) return c.name;
    }
    return item.course || '';
  }

  /** 这门课是否已被某个专业板块认领（公共课本身不参与认领） */
  function claimedByCollege(name) {
    return CAMPUS.some(function (c) {
      if (c.key === 'general') return false;
      return nameHits(name, c.courses);
    });
  }

  function itemInCollege(item, college) {
    if (!college) return true;
    const name = itemCourseName(item);
    if (college.key === 'general') {
      // 公共课：命中公共课课程池；没填课程的也算；没被任何专业板块认领的也算
      if (!name) return true;
      return nameHits(name, college.courses) || !claimedByCollege(name);
    }
    return nameHits(name, college.courses);
  }

  /** 是否落在某个课程类别里 */
  function itemInGroup(item, group) {
    if (!group) return true;
    const name = itemCourseName(item);
    if (!name) return false;
    return nameHits(name, group.courses);
  }

  function groupByName(col, name) {
    if (!col || !name || name === 'all') return null;
    return (col.groups || []).filter(function (g) { return g.name === name; })[0] || null;
  }

  /** 校区 / 板块 / 课程类别 筛选条，两个页面共用 */
  function filterRows(state) {
    const campus = campusByKey(state.campus);
    const campusChips =
      '<div class="filter-line">' +
        '<span class="filter-label">所属校区</span>' +
        '<button class="chip' + (!campus ? ' on' : '') + '" data-campus="all">全部校区</button>' +
        CAMPUSES.map(function (c) {
          return '<button class="chip' + (campus && campus.key === c.key ? ' on' : '') + '" data-campus="' + c.key +
            '" title="' + esc(c.name + ' · ' + c.desc) + '">' + esc(c.short) + '</button>';
        }).join('') +
      '</div>';

    const boards = boardsOf(state.campus);
    if (!boards.length) return campusChips;

    const col = boardByKey(state.col, state.campus);
    const colChips =
      '<div class="filter-line">' +
        '<span class="filter-label">所属板块</span>' +
        '<button class="chip' + (state.col === 'all' ? ' on' : '') + '" data-col="all">全部板块</button>' +
        boards.map(function (c) {
          return '<button class="chip' + (state.col === c.key ? ' on' : '') + '" data-col="' + c.key +
            '" title="' + esc(c.name + ' · ' + c.desc) + '">' + esc(c.short) + '</button>';
        }).join('') +
      '</div>';

    let catChips = '';
    if (col && col.groups && col.groups.length > 1) {
      catChips =
        '<div class="filter-line">' +
          '<span class="filter-label">课程类别</span>' +
          '<button class="chip' + (state.cat === 'all' ? ' on' : '') + '" data-cat="all">全部类别</button>' +
          col.groups.map(function (g) {
            return '<button class="chip' + (state.cat === g.name ? ' on' : '') + '" data-cat="' + esc(g.name) + '">' +
              esc(g.name) + '</button>';
          }).join('') +
        '</div>';
    }
    return campusChips + colChips + catChips;
  }

  /** 该校区是否还没录内容（大学城 / 石牌 / 汕尾） */
  function campusEmpty(campusKey) {
    const cp = campusByKey(campusKey);
    return !!cp && !(cp.boards || []).length;
  }

  /** 未开放校区的占位说明 */
  function campusEmptyNote(campusKey) {
    const cp = campusByKey(campusKey);
    if (!cp) return '';
    return '<div class="filter-scope">' + esc(cp.name) + '的板块与课程正在整理中，' +
      '暂时可以先看南海校区的内容。' + '</div>';
  }

  /** 筛选区底部的「当前范围」说明 */
  function scopeLine(campusKey, col, cat) {
    if (campusEmpty(campusKey)) return campusEmptyNote(campusKey);
    if (col) return scopeNote(col, cat);
    const cp = campusByKey(campusKey);
    if (cp) return '<div class="filter-scope">当前范围：' + esc(cp.name) + ' · 全部板块</div>';
    return '';
  }

  /** 当前范围的文字说明（板块 · 课程类别） */
  function scopeNote(col, cat) {
    if (!col) return '';
    return '<div class="filter-scope">当前范围：' + esc(col.name) + ' · ' +
      (cat ? esc(cat.name) : esc(col.desc)) + '</div>';
  }

  const qaFilter = { campus: 'all', col: 'all', cat: 'all', courseId: null, status: 'all' };

  /** 本次会话已经计过浏览量的题目，避免每次重渲染都 +1 */
  const viewBumped = {};

  /** 当前板块下、库里真实存在的课程（用来生成课程筛选 chip） */
  function coursesInCollege(colKey) {
    const all = Store.courses();
    const col = collegeByKey(colKey);
    if (!col) return all;
    return all.filter(function (c) {
      if (nameHits(c.name, col.courses)) return true;
      return col.key === 'general' && !claimedByCollege(c.name);
    });
  }

  function renderQa() {
    const el = ensurePage('qa');
    const empty = campusEmpty(qaFilter.campus);
    const col = empty ? null : boardByKey(qaFilter.col, qaFilter.campus);
    const cat = groupByName(col, qaFilter.cat);
    const courses = empty ? [] : (cat
      ? coursesInCollege(qaFilter.col).filter(function (c) { return nameHits(c.name, cat.courses); })
      : coursesInCollege(qaFilter.col));
    const total = Store.questions().length;

    let list = Store.questions();
    if (empty) list = [];
    else {
      if (col) list = list.filter(function (q) { return itemInCollege(q, col); });
      if (cat) list = list.filter(function (q) { return itemInGroup(q, cat); });
    }
    if (qaFilter.courseId) list = list.filter(function (q) { return q.courseId === qaFilter.courseId; });
    if (qaFilter.status === 'open') list = list.filter(function (q) { return !q.acceptedAnswerId; });
    if (qaFilter.status === 'solved') list = list.filter(function (q) { return !!q.acceptedAnswerId; });

    const courseRow = courses.length
      ? '<div class="filter-line">' +
          '<span class="filter-label">课程</span>' +
          '<button class="chip' + (qaFilter.courseId ? '' : ' on') + '" data-fc="all">全部课程</button>' +
          courses.map(function (c) {
            return '<button class="chip' + (qaFilter.courseId === c.id ? ' on' : '') + '" data-fc="' + c.id + '">' +
              esc(c.name) + '</button>';
          }).join('') +
        '</div>'
      : '';

    el.innerHTML =
      '<div class="row-between" style="margin-bottom:16px">' +
        '<div class="page-head" style="margin:0">' +
          '<h1 class="page-title">课程问答</h1>' +
          '<p class="page-sub">提出你的疑问，也让你的答案成为他人的灵感。</p>' +
        '</div>' +
        '<button class="btn" data-act="ask">＋ 发布问题</button>' +
      '</div>' +

      '<div class="filters">' +
        filterRows(qaFilter) +
        courseRow +
        (empty ? '' :
        '<div class="filter-line">' +
          '<span class="filter-label">解决状态</span>' +
          '<button class="chip' + (qaFilter.status === 'all' ? ' on' : '') + '" data-fs="all">全部</button>' +
          '<button class="chip' + (qaFilter.status === 'open' ? ' on' : '') + '" data-fs="open">待解答</button>' +
          '<button class="chip' + (qaFilter.status === 'solved' ? ' on' : '') + '" data-fs="solved">已解决</button>' +
          '<span class="filter-count">共 ' + list.length + ' / ' + total + ' 个问题</span>' +
        '</div>') +
        scopeLine(qaFilter.campus, col, cat) +
      '</div>' +

      '<div class="q-list">' +
        (list.length ? list.map(function (q) { return questionCard(q); }).join('')
                     : (empty
                         ? emptyBox(campusByKey(qaFilter.campus).name + '还没有开放内容',
                             '这个校区的板块与课程正在整理中，可以先切回南海校区逛逛',
                             '<button class="btn btn-sm btn-line" data-campus="nanhai">去看南海校区内容</button>')
                         : emptyBox('这里还没有问题', '换个筛选条件，或者发布第一个问题',
                             '<button class="btn" data-act="ask">＋ 发布问题</button>'))) +
      '</div>';

    el.onclick = function (e) {
      const bp = e.target.closest('[data-campus]');
      if (bp) {
        qaFilter.campus = bp.getAttribute('data-campus');
        qaFilter.col = 'all';
        qaFilter.cat = 'all';
        qaFilter.courseId = null;
        renderQa();
        return;
      }
      const bc = e.target.closest('[data-col]');
      if (bc) {
        qaFilter.col = bc.getAttribute('data-col');
        qaFilter.cat = 'all';
        qaFilter.courseId = null;
        renderQa();
        return;
      }
      const bm = e.target.closest('[data-cat]');
      if (bm) {
        qaFilter.cat = bm.getAttribute('data-cat');
        qaFilter.courseId = null;
        renderQa();
        return;
      }
      const fc = e.target.closest('[data-fc]');
      if (fc) {
        const v = fc.getAttribute('data-fc');
        qaFilter.courseId = v === 'all' ? null : Number(v);
        renderQa();
        return;
      }
      const fs = e.target.closest('[data-fs]');
      if (fs) { qaFilter.status = fs.getAttribute('data-fs'); renderQa(); return; }
      const ask = e.target.closest('[data-act="ask"]');
      if (ask) { openAskModal(); return; }
      bindCommonClicks(e);
    };
  }

  /* =========================================================
     7. 页面：问题详情
     ========================================================= */

  function renderDetail(id) {
    const el = ensurePage('detail');
    const q = Store.question(id);
    if (!q) {
      el.innerHTML = pageHead('问题不存在', '它可能已被作者删除') +
        '<a class="btn btn-line" href="#/qa">返回问答区</a>';
      el.onclick = null;
      return;
    }

    pushRecent(q.id);
    // 同一次浏览只记一次浏览量：刷新/点赞/回复都会重渲染，不能重复计数
    if (!viewBumped[q.id]) {
      viewBumped[q.id] = true;
      CloudData.bumpQuestionView(q.id).catch(function () {});
    }

    const mine = Store.isMine(q);
    const faved = Store.hasFavorite('question', q.id);
    const tags = (q.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
    const signed = Store.signedIn();
    const thread = answerThread(q);

    el.innerHTML =
      '<a class="detail-back" href="#/qa">‹ 返回问答区</a>' +

      '<div class="card detail-head">' +
        '<div class="q-item-top">' +
          (q.acceptedAnswerId ? '<span class="tag tag-ok">✓ 已解决</span>' : '<span class="tag tag-warn">待解答</span>') +
          (q.course ? '<span class="q-course">' + esc(q.course) + '</span>' : '') +
          tags +
        '</div>' +
        '<h1 class="detail-title">' + esc(q.title) + '</h1>' +
        '<div class="detail-body">' + esc(q.body) + '</div>' +
        (q.fileName
          ? '<div class="attach-card">' +
              '<div class="attach-ico" aria-hidden="true">📎</div>' +
              '<div class="attach-meta">' +
                '<b>' + esc(q.fileName) + '</b>' +
                '<span>' + ((extOf(q.fileName) || '文件').toUpperCase()) + ' · ' + fmtSize(q.fileSize) + '</span>' +
              '</div>' +
              '<button class="btn btn-sm" data-act="dl-qfile">⬇ 下载附件</button>' +
            '</div>'
          : '') +
        '<div class="detail-meta">' +
          '<span>' + esc(q.author) + '</span>' +
          '<span>' + fmtTime(q.createdAt) + '</span>' +
          '<span>' + q.views + ' 次浏览</span>' +
          '<span class="spacer" style="margin-left:auto"></span>' +
          '<button class="vote-btn' + (faved ? ' on' : '') + '" data-fav="question" data-id="' + q.id + '">' +
            favIco() + (faved ? '已收藏' : '收藏') + '</button>' +
          (mine ? '<button class="vote-btn" data-act="del-q" data-id="' + q.id + '">删除问题</button>' : '') +
        '</div>' +
      '</div>' +

      '<h2 class="section-title" style="margin:24px 0 12px">' + q.answers.length + ' 条回答</h2>' +
      '<div class="answer-list">' +
        (thread.length ? thread.map(function (t) { return answerCard(q, t); }).join('')
                       : emptyBox('还没有人回答', '你可以先说说自己的思路')) +
      '</div>' +

      '<div class="card answer-form' + (signed ? '' : ' locked') + '">' +
        (signed
          ? '<label class="label" style="margin-top:0">写下你的回答</label>' +
            '<textarea class="field" id="answerText" placeholder="分享你的思路、步骤或参考资料…"></textarea>' +
            '<div style="display:flex;gap:10px;align-items:center;margin-top:14px">' +
              '<button class="btn" data-act="submit-answer" data-id="' + q.id + '">发布回答</button>' +
              '<span class="hint" style="margin:0">认真回答会被提问者采纳</span>' +
            '</div>'
          : '<div>登录后即可回答这个问题</div>' +
            '<button class="btn btn-sm" style="margin-top:12px" data-act="login">登录 / 注册</button>') +
      '</div>';

    el.onclick = async function (e) {
      const dl = e.target.closest('[data-act="dl-qfile"]');
      if (dl) {
        if (!q.filePath) { toast('这条问题没有附件。'); return; }
        try {
          const url = await CloudData.getDownloadUrl(q.filePath, 600);
          if (!url) { toast('无法生成下载链接，请稍后重试。'); return; }
          await saveFile(url, q.fileName || '附件');
        } catch (err) {
          toast(err.message || '下载失败。');
        }
        return;
      }
      const login = e.target.closest('[data-act="login"]');
      if (login) { openAuthModal('登录后即可回答。'); return; }
      bindCommonClicks(e);
    };
  }

  /* 把扁平的回答整理成「楼层 + 楼中楼」：
     顶层 = 直接回答问题的；其下所有 parent_id 指向它是回复（回复的回复也归同一楼） */
  function answerThread(q) {
    const byId = {};
    q.answers.forEach(function (a) { byId[a.id] = a; });

    const tops = [];
    const kids = {};

    q.answers.forEach(function (a) {
      if (!a.parentId || !byId[a.parentId]) { tops.push(a); return; }

      // 往上追到顶层楼层，避免无限深缩进
      let root = a, guard = 0;
      while (root.parentId && byId[root.parentId] && guard++ < 30) root = byId[root.parentId];
      if (!root || root.id === a.id) { tops.push(a); return; }

      const parent = byId[a.parentId];
      (kids[root.id] = kids[root.id] || []).push({
        reply: a,
        to: parent && parent.id !== root.id ? parent.author : ''
      });
    });

    // 顶层：采纳优先 → 点赞多 → 时间早
    tops.sort(function (x, y) {
      const ax = x.id === q.acceptedAnswerId ? 0 : 1;
      const ay = y.id === q.acceptedAnswerId ? 0 : 1;
      if (ax !== ay) return ax - ay;
      if ((y.votes || 0) !== (x.votes || 0)) return (y.votes || 0) - (x.votes || 0);
      return new Date(x.createdAt) - new Date(y.createdAt);
    });

    return tops.map(function (t) {
      return { top: t, replies: kids[t.id] || [] };
    });
  }

  /** 点赞图标（大拇指） */
  function thumbSvg() {
    return '<svg class="vote-ico" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M6.4 9.3 9.1 3.9a1.1 1.1 0 0 1 2 .5v3.1h3.3a1.7 1.7 0 0 1 1.7 2l-.8 4.4a1.7 1.7 0 0 1-1.7 1.4H6.4" ' +
        'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<rect x="3" y="9" width="2.7" height="6.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '</svg>';
  }

  function voteBtnHtml(answer, voted, extra) {
    const n = answer.votes || 0;
    return '<button class="vote-btn' + (voted ? ' on' : '') + '" data-act="vote" data-id="' + answer.id + '"' +
      ' title="' + (voted ? '取消点赞' : '点赞') + '">' +
      thumbSvg() + '<span>赞</span>' + (n ? '<b class="vote-num">' + n + '</b>' : '') +
      '</button>' + (extra || '');
  }

  function replyBtnHtml(qid, answer, toName) {
    return '<button class="vote-btn" data-act="reply" data-qid="' + qid + '"' +
      ' data-parent="' + answer.id + '" data-to="' + esc(answer.author) + '"' +
      (toName ? ' data-mention="' + esc(toName) + '"' : '') + '>回复</button>';
  }

  function answerCard(q, t) {
    const a = t.top;
    const accepted = a.id === q.acceptedAnswerId;
    const mine = Store.isMine(a);
    const qMine = Store.isMine(q);
    const voted = db_voted(a.id);

    const replies = t.replies.map(function (item) {
      const r = item.reply;
      const rMine = Store.isMine(r);
      return '<div class="reply" data-aid="' + r.id + '">' +
        '<div class="reply-head">' +
          '<span class="reply-author">' + esc(r.author) + '</span>' +
          (item.to ? '<span class="reply-to">回复 <b>' + esc(item.to) + '</b></span>' : '') +
          '<span class="reply-time">' + fmtTime(r.createdAt) + '</span>' +
        '</div>' +
        '<div class="reply-body">' + esc(r.body) + '</div>' +
        '<div class="reply-foot">' +
          voteBtnHtml(r, db_voted(r.id), replyBtnHtml(q.id, r, '')) +
          (rMine ? '<button class="vote-btn" data-act="del-a" data-id="' + r.id + '">删除</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    return '<article class="answer' + (accepted ? ' accepted' : '') + '" data-aid="' + a.id + '">' +
      '<div class="answer-top">' +
        (accepted ? '<span class="tag tag-ok">✓ 已采纳</span>' : '') +
        '<span class="answer-author">' + esc(a.author) + '</span>' +
        '<span>' + fmtTime(a.createdAt) + '</span>' +
      '</div>' +
      '<div class="answer-body">' + esc(a.body) + '</div>' +
      '<div class="answer-foot">' +
        voteBtnHtml(a, voted,
          replyBtnHtml(q.id, a, '') +
          (qMine ? '<button class="vote-btn" data-act="accept" data-qid="' + q.id + '" data-id="' + a.id + '">' +
            (accepted ? '取消采纳' : '采纳此回答') + '</button>' : '') +
          (mine ? '<button class="vote-btn" data-act="del-a" data-id="' + a.id + '">删除</button>' : '')) +
      '</div>' +
      (replies ? '<div class="reply-list">' + replies + '</div>' : '') +
      '<div class="reply-slot" data-for="' + a.id + '"></div>' +
    '</article>';
  }

  /** 在楼层底部展开「回复」输入框；同一个楼层再点一次收起 */
  function openReplyComposer(slot, qid, parentId, mention) {
    if (!slot) return;
    const opened = slot.getAttribute('data-open') === '1';
    document.querySelectorAll('.reply-slot[data-open="1"]').forEach(function (s) {
      s.removeAttribute('data-open');
      s.innerHTML = '';
    });
    if (opened) return;

    slot.setAttribute('data-open', '1');
    slot.innerHTML =
      '<div class="reply-composer">' +
        '<textarea class="field rep-text" rows="2" placeholder="' +
          (mention ? '回复 @' + esc(mention) + '…' : '写下你的回复…') + '"></textarea>' +
        '<div class="rep-foot">' +
          '<button class="btn btn-sm" data-act="send-reply" data-qid="' + qid + '" data-parent="' + parentId + '">发布回复</button>' +
          '<button class="btn btn-sm btn-line" data-act="cancel-reply">取消</button>' +
          '<span class="hint rep-hint">回复会显示在这一楼下面</span>' +
        '</div>' +
      '</div>';
    const ta = slot.querySelector('.rep-text');
    if (ta) ta.focus();
  }

  async function submitReply(btn) {
    if (!requireLogin('回复')) return;
    const qid = Number(btn.getAttribute('data-qid'));
    const parentId = Number(btn.getAttribute('data-parent'));
    const box = btn.closest('.reply-composer');
    const ta = box && box.querySelector('.rep-text');
    const body = (ta && ta.value || '').trim();
    if (!body) { toast('请先写下回复内容。'); return; }

    btn.disabled = true;
    try {
      await CloudData.insertAnswer({
        question_id: qid, parent_id: parentId, body: body, author: Store.nickname()
      });
      await refresh();
      applyRoute();
      toast('回复已发布。');
    } catch (err) {
      btn.disabled = false;
      toast(err.message || '回复失败，请稍后重试。');
    }
  }

  function db_voted(answerId) {
    const n = Number(answerId);
    return (db.votes || []).indexOf(n) >= 0;
  }

  /* =========================================================
     8. 页面：资源共享
     ========================================================= */

  const RES_TABS = ['精选推荐', '最新发布', '复习笔记', '课程课件', '习题解析'];
  const RES_CATS = ['复习笔记', '课程课件', '习题解析'];
  let resTab = '精选推荐';
  let resQuery = '';
  const resFilter = { campus: 'all', col: 'all', cat: 'all' };

  function renderResources() {
    const el = ensurePage('resources');
    const empty = campusEmpty(resFilter.campus);
    const col = empty ? null : boardByKey(resFilter.col, resFilter.campus);
    const cat = groupByName(col, resFilter.cat);

    let list = Store.resources().slice();

    if (resTab === '精选推荐') {
      list.sort(function (a, b) { return b.downloads - a.downloads; });
    } else if (resTab === '最新发布') {
      list.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    } else {
      list = list.filter(function (r) { return r.category === resTab; });
    }

    if (empty) list = [];
    else {
      if (col) list = list.filter(function (r) { return itemInCollege(r, col); });
      if (cat) list = list.filter(function (r) { return itemInGroup(r, cat); });
    }

    if (resQuery) {
      const kw = resQuery.trim().toLowerCase();
      list = list.filter(function (r) {
        return (r.title + ' ' + r.course + ' ' + r.category + ' ' + r.author)
          .toLowerCase().indexOf(kw) >= 0;
      });
    }

    const baseCount = Store.resources().length;

    el.innerHTML =
      '<div class="row-between" style="margin-bottom:16px">' +
        '<div class="page-head" style="margin:0">' +
          '<h1 class="page-title">资源共享</h1>' +
          '<p class="page-sub">同学整理的笔记、课件与真题，按课程归档。</p>' +
        '</div>' +
        '<button class="btn" data-act="upload">⬆ 上传资料</button>' +
      '</div>' +

      '<div class="res-search">' +
        '<input id="resSearch" placeholder="搜索资料名称、课程或上传者" value="' + esc(resQuery) + '">' +
      '</div>' +

      '<div class="filters">' +
        filterRows(resFilter) +
        scopeLine(resFilter.campus, col, cat) +
      '</div>' +

      '<div class="chips res-tabs" style="margin-bottom:16px">' +
        RES_TABS.map(function (t) {
          return '<button class="chip' + (resTab === t ? ' on' : '') + '" data-tab="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('') +
        '<span class="filter-count">共 ' + list.length + ' / ' + baseCount + ' 份</span>' +
      '</div>' +

      '<div class="res-grid">' +
        (list.length ? list.map(resourceCard).join('')
                     : (empty
                         ? emptyBox(campusByKey(resFilter.campus).name + '还没有开放内容',
                             '这个校区的板块与课程正在整理中，可以先切回南海校区逛逛',
                             '<button class="btn btn-sm btn-line" data-campus="nanhai">去看南海校区内容</button>')
                         : emptyBox('没有找到相关资料', '换个关键词或分类试试，也可以上传一份'))) +
      '</div>' +

      '<div class="notice-explain">尊重原创，分享有据可循。资料仅供学习交流，请勿用于商业用途。</div>';

    const search = $('#resSearch');
    if (search) {
      search.oninput = function () {
        resQuery = search.value;
        renderResources();
        const again = $('#resSearch');
        if (again) {
          again.focus();
          again.setSelectionRange(again.value.length, again.value.length);
        }
      };
    }

    el.onclick = function (e) {
      const bp = e.target.closest('[data-campus]');
      if (bp) {
        resFilter.campus = bp.getAttribute('data-campus');
        resFilter.col = 'all';
        resFilter.cat = 'all';
        renderResources();
        return;
      }
      const bc = e.target.closest('[data-col]');
      if (bc) {
        resFilter.col = bc.getAttribute('data-col');
        resFilter.cat = 'all';
        renderResources();
        return;
      }
      const bm = e.target.closest('[data-cat]');
      if (bm) { resFilter.cat = bm.getAttribute('data-cat'); renderResources(); return; }
      const tab = e.target.closest('[data-tab]');
      if (tab) { resTab = tab.getAttribute('data-tab'); renderResources(); return; }
      const up = e.target.closest('[data-act="upload"]');
      if (up) { openUploadModal(); return; }
      bindCommonClicks(e);
    };
  }

  /* =========================================================
     8.5 页面：资料详情
     ========================================================= */

  /* 生成 / 重新生成 AI 摘要（供详情页与弹窗共用） */
  /* 规范化模型输出：保证「要点：」「建议：」各自独立成段 */
  function normalizeSummary(t) {
    return String(t || '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/([^\n])\s*(要点[:：])/g, '$1\n\n$2')
      .replace(/([^\n])\s*(建议[:：])/g, '$1\n\n$2')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function regenSummary(r, boxSel) {
    const box = $(boxSel || '#resSummary');
    if (!box) return;
    box.classList.add('gen');
    box.textContent = 'AI 正在阅读这份资料…';
    try {
      const prompt = [
        '资料标题：' + r.title,
        '所属课程：' + (r.course || '通识'),
        '资料分类：' + r.category,
        r.description ? '上传者说明：' + r.description : '上传者未填写说明',
        r.size ? '文件大小：' + fmtSize(r.size) : ''
      ].filter(Boolean).join('\n');

      const raw = await CloudAI.summarize(prompt, function (chunk, full) { box.textContent = full; });
      const text = normalizeSummary(raw);
      box.textContent = text;

      let persisted = false;
      try {
        await CloudData.updateResourceSummary(r.id, text);
        persisted = true;
      } catch (e) { /* 非上传者：仅本地展示 */ }

      if (persisted) {
        await refresh();
        toast('AI 摘要已更新。');
      } else {
        toast('摘要已生成（仅本次可见，资料上传者可保存）。');
      }
      return text;
    } catch (err) {
      box.textContent = '生成失败：' + (err.message || '请稍后重试');
      toast(err.message || '生成失败。');
      return null;
    }
  }

  function renderResource(id) {
    const el = ensurePage('resource');
    const r = Store.resource(Number(id));

    if (!r) {
      el.innerHTML = emptyBox('资料不存在或已被删除', '回到资料库看看其他内容',
        '<a class="btn" href="#/resources">返回资料库</a>');
      el.onclick = bindCommonClicks;
      return;
    }

    const faved = Store.hasFavorite('resource', r.id);
    const meta = [r.pageCount ? r.pageCount + ' 页' : null, r.size ? fmtSize(r.size) : null]
      .filter(Boolean).join(' · ');
    const sameCourse = Store.resources()
      .filter(function (x) { return x.id !== r.id && x.course === r.course; })
      .slice(0, 3);

    el.innerHTML =
      '<div class="crumb"><a href="#/resources">资源共享</a><span>/</span><span>资料详情</span></div>' +

      '<div class="res-hero">' +
        '<div class="res-file xl ' + r.kind + '">' + esc(r.kindLabel) + '</div>' +
        '<div class="res-hero-main">' +
          '<h1 class="res-hero-title">' + esc(r.title) + '</h1>' +
          '<div class="res-hero-tags">' +
            (r.course ? '<span class="tag">' + esc(r.course) + '</span>' : '') +
            '<span class="tag tag-soft">' + esc(r.category) + '</span>' +
            (r.aiReady ? '<span class="tag tag-ok">✦ AI 摘要可读</span>' : '') +
          '</div>' +
          '<p class="res-hero-meta">' +
            (r.author ? '<span class="res-hero-by" title="上传者">👤 ' + esc(r.author) + '</span>' : '') +
            esc([meta, fmtTime(r.createdAt), r.downloads + ' 次浏览']
              .filter(Boolean).join(' · ')) +
          '</p>' +
        '</div>' +
        '<div class="res-hero-actions">' +
          (r.filePath
            ? '<button class="btn" data-act="open-file" data-id="' + r.id + '">打开附件</button>'
            : '<button class="btn" disabled title="这是一条示例资料，未关联可下载文件">示例资料 · 无附件</button>') +
          '<button class="btn btn-line' + (faved ? ' on' : '') + '" data-fav="resource" data-id="' + r.id + '">' +
            favIco() + (faved ? '已收藏' : '收藏') + '</button>' +
        '</div>' +
      '</div>' +

      '<div class="detail-grid">' +
        '<div class="detail-main">' +
          '<section class="card ai-card">' +
            '<div class="card-head">' +
              '<h2 class="card-title">✧ AI 摘要</h2>' +
              '<button class="btn btn-line btn-sm" data-act="regen" data-id="' + r.id + '">' +
                (r.aiReady ? '重新生成' : '生成摘要') + '</button>' +
            '</div>' +
            '<div class="ai-summary' + (r.aiReady ? ' gen' : '') + '" id="resSummary">' +
              (r.summary ? esc(normalizeSummary(r.summary))
                : (r.filePath ? '这份资料还没有 AI 摘要，点右上角生成。'
                              : '这是一条示例记录，没有关联文件，暂无法生成摘要。')) +
            '</div>' +
            '<p class="ai-note">AI 摘要由模型根据资料信息自动生成，仅供参考，请以原文为准。</p>' +
          '</section>' +

          '<section class="card">' +
            '<h2 class="card-title">资料说明</h2>' +
            '<p class="res-desc-lg">' + (r.description ? esc(r.description) : '上传者没有填写说明。') + '</p>' +
          '</section>' +

          (sameCourse.length
            ? '<section class="card">' +
                '<div class="card-head">' +
                  '<h2 class="card-title">同课程的其他资料</h2>' +
                  '<a class="section-more" href="#/resources">全部 ›</a>' +
                '</div>' +
                '<div class="res-grid">' + sameCourse.map(resourceCard).join('') + '</div>' +
              '</section>'
            : '') +
        '</div>' +

        '<aside class="detail-side">' +
          '<section class="card">' +
            '<h2 class="card-title">文件信息</h2>' +
            '<dl class="info-list">' +
              '<div><dt>文件名</dt><dd>' + esc(r.fileName || (r.filePath ? '—' : '示例资料，无附件')) + '</dd></div>' +
              '<div><dt>大小</dt><dd>' + (r.size ? fmtSize(r.size) : '—') + '</dd></div>' +
              '<div><dt>页数</dt><dd>' + (r.pageCount || '—') + '</dd></div>' +
              '<div><dt>上传者</dt><dd>' + esc(r.author) + '</dd></div>' +
              '<div><dt>上传时间</dt><dd>' + esc(fmtTime(r.createdAt)) + '</dd></div>' +
              '<div><dt>浏览次数</dt><dd>' + r.downloads + '</dd></div>' +
            '</dl>' +
          '</section>' +
          '<section class="card">' +
            '<h2 class="card-title">相关操作</h2>' +
            '<div class="side-actions">' +
              '<button class="btn btn-line btn-block' + (faved ? ' on' : '') + '" data-fav="resource" data-id="' + r.id + '">' +
                favIco() + (faved ? '取消收藏' : '收藏资料') + '</button>' +
              '<a class="btn btn-line btn-block" href="#/resources">返回资料库</a>' +
            '</div>' +
          '</section>' +
        '</aside>' +
      '</div>';

    el.onclick = async function (e) {
      const openFile = e.target.closest('[data-act="open-file"]');
      if (openFile) {
        if (!r.filePath) { toast('这条资料没有附件。'); return; }
        go('#/file/' + r.id);
        return;
      }
      if (e.target.closest('[data-act="regen"]')) {
        if (!requireLogin('生成摘要')) return;
        await regenSummary(r);
        return;
      }
      bindCommonClicks(e);
    };
  }

  /* =========================================================
     8.6 页面：附件查看 / 下载
     ---------------------------------------------------------
     不管什么类型的附件都先跳到这个页面：
     · 打开这个页面就算一次浏览（resources.downloads 记的就是浏览次数）
     · pdf / 图片 / 文本这类浏览器能直接读的，额外给「在浏览器中打开」
     · .cpp / .docx / .zip 浏览器读不了，只给「下载文件」，避免打开一片空白
     ========================================================= */

  const PREVIEWABLE = ['pdf', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  let lastFilePage = null;

  /** 真正落到本地：先把文件取成 blob 再用 download 存盘。
      直接给 <a download> 没用 —— 存储返回的是 Content-Disposition: inline，
      .cpp / .txt 这类会被浏览器当成网页直接显示出来（这就是「.cpp 不行」的原因）。 */
  async function saveFile(url, name) {
    const fallback = function () {
      const a = document.createElement('a');
      a.href = url;
      if (name) a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 0);
    };

    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const size = Number(res.headers.get('content-length') || 0);
      if (size > 40 * 1024 * 1024) { fallback(); return; }   // 太大就别读进内存

      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = name || 'file';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(objUrl); }, 10000);
    } catch (e) {
      fallback();
    }
  }

  function renderFilePage(id) {
    const el = ensurePage('file');
    const r = Store.resource(Number(id));

    if (!r) {
      el.innerHTML = pageHead('资料不存在', '它可能已被上传者删除') +
        '<a class="btn btn-line" href="#/resources">返回资料库</a>';
      el.onclick = null;
      return;
    }

    if (!r.filePath) {
      el.innerHTML = pageHead(r.title, '这份资料没有关联可下载的文件') +
        '<a class="btn btn-line" href="#/resource/' + r.id + '">返回资料详情</a>';
      el.onclick = null;
      return;
    }

    const ext = String(extOf(r.fileName || r.title) || '').toLowerCase();
    const canPreview = PREVIEWABLE.indexOf(ext) >= 0;
    const extLabel = (ext || '文件').toUpperCase();

    // 进入页面即记一次浏览；同一次停留不重复计数
    if (lastFilePage !== r.id) {
      lastFilePage = r.id;
      CloudData.bumpResourceDownload(r.id).then(function (n) {
        if (typeof n === 'number') {
          r.downloads = n;
          const v = $('#fileViews');
          if (v) v.textContent = n;
        }
      }).catch(function () { /* 未登录或统计失败都不挡着看文件 */ });
    }

    el.innerHTML =
      '<div class="crumb"><a href="#/resources">资源共享</a><span>/</span>' +
        '<a href="#/resource/' + r.id + '">' + esc(r.title) + '</a><span>/</span><span>附件</span></div>' +

      '<div class="card file-page">' +
        '<div class="file-head">' +
          '<div class="res-file xl ' + r.kind + '">' + esc(r.kindLabel) + '</div>' +
          '<div class="file-head-main">' +
            '<h1 class="file-title">' + esc(r.fileName || r.title) + '</h1>' +
            '<p class="file-meta">' +
              esc([extLabel, r.size ? fmtSize(r.size) : null, r.course || null, r.author]
                .filter(Boolean).join(' · ')) +
              ' · 👁 <span id="fileViews">' + r.downloads + '</span> 次浏览' +
            '</p>' +
          '</div>' +
        '</div>' +

        '<div class="file-actions">' +
          '<button class="btn" data-act="download-file">⬇ 下载文件</button>' +
          (canPreview ? '<button class="btn btn-line" data-act="open-ext">↗ 在浏览器中打开</button>' : '') +
        '</div>' +

        '<p class="file-tip">' +
          (canPreview
            ? '浏览器可以直接打开 ' + extLabel + ' 文件；想存到本地就点「下载文件」。'
            : extLabel + ' 文件浏览器读不了，点「下载文件」保存后再用本地软件打开。') +
        '</p>' +
      '</div>';

    el.onclick = async function (e) {
      const dl = e.target.closest('[data-act="download-file"]');
      const ext2 = e.target.closest('[data-act="open-ext"]');
      if (!dl && !ext2) return;
      if (!requireLogin('下载资料')) return;
      const btn = dl || ext2;
      btn.disabled = true;
      try {
        const url = await CloudData.getDownloadUrl(r.filePath, 600);
        if (!url) { toast('无法生成下载链接，请稍后重试。'); btn.disabled = false; return; }
        if (dl) {
          await saveFile(url, r.fileName || r.title);
          toast('已开始下载。');
        } else {
          global.open(url, '_blank', 'noopener');
        }
      } catch (err) {
        toast(err.message || '下载失败。');
      }
      btn.disabled = false;
    };
  }

  /* =========================================================
     9. 页面：AI 学习助手
     ========================================================= */

  const AI_TOOLS = {
    solve: { label: '解题助手', tip: '贴题目进来，AI 会指出考查点、给出完整解答；编程题直接给可运行代码。',
             ph: '例如：用 Python 写一个函数，判断字符串里的括号是否匹配，要求 O(n)…' },
    extract: { label: '知识点提炼', tip: '粘贴一段课程内容或笔记，AI 会提炼出核心知识点。',
             ph: '把课件、笔记或教材段落粘贴到这里…' },
    summarize: { label: '文档摘要', tip: '给出资料的基本信息，AI 会生成摘要与要点。',
             ph: '例如：《数据结构期中复习笔记》，48 页，涵盖树、图、排序算法的定义与复杂度分析…' }
  };
  let aiTool = 'solve';
  let aiBusy = false;
  let aiHistory = [];
  let aiFile = null;

  function renderAi() {
    const el = ensurePage('ai');
    const st = Store.stats();
    const avail = CloudAI && CloudAI.ready();
    aiFile = null; // 重绘后附件框为空，避免残留看不到的旧文件

    el.innerHTML =
      pageHead('AI 学习助手', '把你卡住的地方说清楚，剩下的交给 AI。') +

      '<div class="ai-tabs">' +
        Object.keys(AI_TOOLS).map(function (k) {
          return '<button class="chip' + (aiTool === k ? ' on' : '') + '" data-tool="' + k + '">' +
            AI_TOOLS[k].label + '</button>';
        }).join('') +
      '</div>' +

      '<div class="ai-grid">' +
        '<div class="ai-main">' +
        '<div class="card ai-panel">' +
          '<p class="ai-tips">' + esc(AI_TOOLS[aiTool].tip) + '</p>' +
          '<textarea class="field" id="aiPrompt" placeholder="' + esc(AI_TOOLS[aiTool].ph) + '"></textarea>' +
          attachBoxHtml('ai', {
            hint: '支持 PDF / Word / PPT / Excel / 代码 / 图片，选中后自动读取内容，单个 ≤ 20 MB'
          }) +
          '<div style="display:flex;gap:10px;align-items:center;margin-top:14px">' +
            '<button class="btn" id="aiRun"' + (aiBusy ? ' disabled' : '') + '>' +
              (aiBusy ? '正在生成…' : '开始生成') + '</button>' +
            '<button class="btn btn-line" id="aiClear">清空</button>' +
            '<span class="hint" style="margin:0">' + (avail ? '由云端大模型提供' : '模型通道未就绪') + '</span>' +
          '</div>' +
          '<div class="ai-out" id="aiOut"></div>' +
        '</div>' +

        '<div class="card ai-howto">' +
          '<h3 class="side-title">三步用好它</h3>' +
          '<ol class="howto-list">' +
            '<li><b>选一个工具</b>解题、提炼知识点、写摘要，各自对口的提示词已经写好。</li>' +
            '<li><b>把原始材料贴进来</b>题目原文、笔记段落、资料信息越完整，回答越贴近你的问题。</li>' +
            '<li><b>拿到答案后自己再写一遍</b>合上答案独立重做一次，能复述出每步为什么，才算真的学会。</li>' +
          '</ol>' +
          '<p class="howto-note">AI 生成的内容仅供参考，重要结论请以教材与老师讲解为准。</p>' +
        '</div>' +
        '</div>' +

        '<aside class="ai-side">' +
          '<div class="card side-card">' +
            '<h3 class="side-title">最近生成</h3>' +
            '<div class="side-list" id="aiHist">' +
              (aiHistory.length
                ? aiHistory.slice(0, 5).map(function (h) {
                    return '<div class="side-item"><b>' + esc(h.label) + '</b>' + esc(h.preview) + '</div>';
                  }).join('')
                : '<div class="side-item">还没有生成记录</div>') +
            '</div>' +
          '</div>' +
          '<div class="card side-card">' +
            '<h3 class="side-title">学习统计</h3>' +
            '<div class="side-list">' +
              '<div class="side-item"><b>我的提问</b>' + Store.myQuestions().length + ' 个</div>' +
              '<div class="side-item"><b>我的上传</b>' + Store.myResources().length + ' 份</div>' +
              '<div class="side-item"><b>平台已解决</b>' + st.rate + '% 的问题</div>' +
            '</div>' +
            '<div class="bar" style="margin-top:12px"><i style="width:' + st.rate + '%"></i></div>' +
          '</div>' +
        '</aside>' +
      '</div>';

    bindAttach('ai', function (f) { aiFile = f; });

    el.onclick = function (e) {
      const tool = e.target.closest('[data-tool]');
      if (tool) {
        if (tool.getAttribute('data-tool') !== aiTool) aiFile = null;
        aiTool = tool.getAttribute('data-tool');
        renderAi();
        return;
      }
      if (e.target.closest('#aiClear')) {
        aiFile = null;
        $('#aiPrompt').value = '';
        $('#aiOut').textContent = '';
        renderAi();
        return;
      }
      if (e.target.closest('#aiRun')) { runAi(); return; }
    };
  }

  /* 有附件时的额外系统约束：避免模型绕开附件空谈「怎么读文件」 */
  const ATTACH_RULE = '\n\n用户这次附带了文件，附件就是本次任务的主要材料：先用一句话说明附件是什么，'
    + '再完整读取附件内容并按【我的要求】作答。不要说「我无法读取文件」，也不要把「怎么读文件」当成答案。'
    + '只有附件确实空白或无法解析时，才简短说明原因，并请用户把关键文字粘贴过来。';

  /* 把「文字说明 + 附件」拼成一次请求的正文 */
  async function buildAiInput(prompt) {
    if (!aiFile) return prompt;
    const tail = prompt || '请先完整读一遍附件，再说明它讲了什么。';
    const info = await extractAttach(aiFile);
    const head = '【附件：' + aiFile.name + '（' + fmtSize(aiFile.size) + '）】\n';

    if (info.kind === 'image') {
      return head + (info.scanned
        ? '这是扫描版 PDF 的前 ' + info.images.length + ' 页（共 ' + info.pages + ' 页），已作为图片随消息发送。'
          + '请先看清图片里的文字，再按要求处理；看不清就直说，不要编造。\n\n'
        : '这张图片已随消息发送。请先看清图片里的内容（题目、板书、截图或手写笔记），再按要求处理；'
          + '看不清就直说，不要编造。\n\n')
        + '【我的要求】\n' + tail;
    }

    if (info.kind === 'text') {
      const body = String(info.text || '').trim();
      if (!body) return head + '文件里没有提取到文字。\n\n【我的要求】\n' + tail;
      return head + body + '\n\n【我的要求】\n' + tail;
    }

    return head + '这个格式读不了。\n\n【我的要求】\n' + tail;
  }

  async function runAi() {
    if (aiBusy) return;
    const prompt = (($('#aiPrompt') || {}).value || '').trim();
    const out = $('#aiOut');
    if (!prompt && !aiFile) { toast('请先输入内容，或选择一个文件。'); return; }
    if (!CloudAI || !CloudAI.ready()) { toast('云端模型通道未就绪，请刷新页面重试。'); return; }

    aiBusy = true;
    const runBtn = $('#aiRun');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = aiFile ? '正在读取附件…' : '正在生成…';
    }
    out.textContent = '';
    out.classList.remove('rich');
    out.classList.add('streaming');

    const label = AI_TOOLS[aiTool].label;
    let useImage = false;
    try {
      // 先把附件读成「文字」或「图片」，读不出来就在这里明确报错，不把空内容丢给模型
      const info = aiFile ? await extractAttach(aiFile) : { kind: 'none' };
      const userText = await buildAiInput(prompt);
      let text;
      if (info.kind === 'image') {
        useImage = true;
        if (runBtn) runBtn.textContent = '正在识别图片…';
        text = await CloudAI.chatWithImage({
          system: aiSystemFor(aiTool) + ATTACH_RULE,
          user: userText,
          images: info.images,
          temperature: 0.6,
          onDelta: function (chunk, full) { out.textContent = full; }
        });
      } else {
        if (runBtn) runBtn.textContent = info.kind === 'text' ? '正在读附件…' : '正在生成…';
        text = await CloudAI.chat({
          system: aiSystemFor(aiTool) + (aiFile ? ATTACH_RULE : ''),
          user: userText,
          temperature: 0.6,
          onDelta: function (chunk, full) { out.textContent = full; }
        });
      }
      // 流式阶段用纯文本，收尾再转排版：代码块才不会边生成边跳
      out.innerHTML = renderAiHtml(text);
      out.classList.add('rich');
      out.classList.remove('streaming');
      aiHistory.unshift({ label: label + (useImage ? '（含图片）' : aiFile ? '（含附件）' : ''), preview: text.slice(0, 40) + '…' });
      CloudData.saveAiSession({ tool: aiTool, prompt: userText.slice(0, 2000), output: text.slice(0, 4000) })
        .catch(function () {});
    } catch (e) {
      out.textContent = '';
      toast(e.message || 'AI 调用失败。');
    } finally {
      out.classList.remove('streaming');
      aiBusy = false;
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = '开始生成'; }
      const hist = $('#aiHist');
      if (hist) {
        hist.innerHTML = aiHistory.slice(0, 5).map(function (h) {
          return '<div class="side-item"><b>' + esc(h.label) + '</b>' + esc(h.preview) + '</div>';
        }).join('') || '<div class="side-item">还没有生成记录</div>';
      }
    }
  }

  /** AI 输出的轻量排版：代码块 / 行内代码 / 粗体 / 列表 / 段落 */
  function renderAiHtml(md) {
    const blocks = [];
    const tables = [];
    const stash = function (m, lang, code) {
      blocks.push(String(code || '').replace(/\s+$/, ''));
      return '\n\n@@CODE' + (blocks.length - 1) + '@@\n\n';
    };
    let text = String(md || '')
      .replace(/```([a-zA-Z0-9#+\-]*)[ \t]*\r?\n([\s\S]*?)```/g, stash);
    // 模型偶尔漏掉收尾的 ```，把剩下的整段也当代码
    text = text.replace(/```([a-zA-Z0-9#+\-]*)[ \t]*\r?\n([\s\S]*)$/, stash);

    text = esc(text);

    /* 模型经常夹 LaTeX（\(O(n)\)、\log、\times），页面上会显示成满屏反斜杠，先还原成人能读的写法 */
    const MATH_WORD = /^(sum|prod|int|iint|oint|partial|nabla|lim|max|min|sup|inf|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|lg|exp|det|gcd|deg|dim|quad|qquad|space|displaystyle|limits|subset|supset|subseteq|supseteq|in|notin|cup|cap|emptyset|varnothing|forall|exists|neg|land|lor|because|therefore|angle|perp|parallel|ast|star|circ|bullet|ldots|dots|cdots)$/;
    text = String(text)
      .replace(/\\\[([\s\S]*?)\\\]/g, function (m, x) { return '\n\n' + x + '\n\n'; })
      .replace(/\\\(([\s\S]*?)\\\)/g, function (m, x) { return ' ' + x + ' '; })
      .replace(/\\begin\{[a-z*]+\}/g, '\n').replace(/\\end\{[a-z*]+\}/g, '\n')
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
      .replace(/\\(?:text|mathrm|mathbf|mathit|mathcal|mathbb)\{([^{}]*)\}/g, '$1')
      .replace(/\\left|\\right/g, '')
      .replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\div/g, '÷')
      .replace(/\\leq|\\le(?![a-z])/g, '≤').replace(/\\geq|\\ge(?![a-z])/g, '≥')
      .replace(/\\neq|\\ne(?![a-z])/g, '≠').replace(/\\approx/g, '≈')
      .replace(/\\infty/g, '∞').replace(/\\pm/g, '±').replace(/\\to/g, '→')
      .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\gamma/g, 'γ')
      .replace(/\\delta/g, 'δ').replace(/\\theta/g, 'θ').replace(/\\lambda/g, 'λ')
      .replace(/\\mu/g, 'μ').replace(/\\pi/g, 'π').replace(/\\sigma/g, 'σ')
      .replace(/\\Theta/g, 'Θ').replace(/\\Omega/g, 'Ω').replace(/\\Sigma/g, 'Σ')
      .replace(/\\Delta/g, 'Δ').replace(/\\Lambda/g, 'Λ').replace(/\\Gamma/g, 'Γ')
      .replace(/\\Phi/g, 'Φ').replace(/\\Psi/g, 'Ψ')
      .replace(/\\[,;:! ]/g, ' ')
      .replace(/\\\\/g, '\n')
      .replace(/\\\{/g, '{').replace(/\\\}/g, '}')
      /* 只去掉「数学命令」的斜杠，别把 C:\Users 这类路径也吃掉；前面补空格，n\log n 才读成 n log n */
      .replace(/\\([a-zA-Z]+)/g, function (m, name) { return MATH_WORD.test(name) ? ' ' + name : m; });

    /* 上标：O(n^2) 读起来比原文舒服（下标只处理 a_{1} 这种带花括号的，避免误伤变量名） */
    text = text
      .replace(/\^\{([^{}\n]+)\}/g, '<sup>$1</sup>')
      .replace(/\^(\d+)/g, '<sup>$1</sup>')
      .replace(/\^([A-Za-z+\-])/g, '<sup>$1</sup>')
      .replace(/_\{([^{}\n]+)\}/g, '<sub>$1</sub>')
      .replace(/[ \t]{2,}/g, ' ');

    /* 表格：把「| a | b |」+「|---|---|」这组行整体抽出来，避免整段变成一堆竖线 */
    const inlineFmt = function (s) {
      return String(s)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    };
    const tableCells = function (line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return inlineFmt(c.trim()); });
    };
    const isTableSep = function (line) {
      const t = String(line || '').trim();
      if (!t || t.indexOf('|') < 0) return false;
      return /^[|\s:-]+$/.test(t) && /-/.test(t);
    };

    const lines = text.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = tableCells(line);
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].indexOf('|') >= 0) {
          rows.push(tableCells(lines[j]));
          j++;
        }
        tables.push({ head: head, rows: rows });
        kept.push('', '@@TABLE' + (tables.length - 1) + '@@', '');
        i = j - 1;
        continue;
      }
      kept.push(line);
    }
    text = kept.join('\n');

    text = text
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,4}\s*(.+)$/gm, '<div class="md-h">$1</div>')
      .replace(/^\s*[-*]\s+(.+)$/gm, '<div class="md-li">· $1</div>')
      .replace(/^\s*(\d+)[.、]\s+(.+)$/gm, '<div class="md-li"><b>$1.</b> $2</div>');

    const html = text.split(/\n{2,}/).map(function (part) {
      const t = part.trim();
      if (!t) return '';
      if (/^@@(CODE|TABLE)\d+@@$/.test(t)) return t;
      if (/^<div class="md-(h|li)">/.test(t)) return t.replace(/\n/g, '');
      return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
    }).join('');

    return html
      .replace(/@@CODE(\d+)@@/g, function (m, i) {
        return '<pre class="md-code"><code>' + esc(blocks[Number(i)] || '') + '</code></pre>';
      })
      .replace(/@@TABLE(\d+)@@/g, function (m, i) {
        const t = tables[Number(i)];
        if (!t) return '';
        const head = '<tr>' + t.head.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
        const body = t.rows.map(function (r) {
          const tds = [];
          for (let k = 0; k < t.head.length; k++) tds.push('<td>' + (r[k] == null ? '' : r[k]) + '</td>');
          return '<tr>' + tds.join('') + '</tr>';
        }).join('');
        return '<div class="md-table-wrap"><table class="md-table">' +
          '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
      });
  }

  function aiSystemFor(tool) {
    if (tool === 'solve') {
      return '你是华南师范大学的学业互助学习助手，面向大学生答疑。按下面的结构作答：\n'
        + '1. 先用一句话点明这道题考查的知识点。\n'
        + '2. 然后必须给出完整、可直接使用的答案：编程题写出完整可运行代码（用 Markdown 代码块并标注语言，关键步骤写注释），'
        + '并说明时间复杂度和空间复杂度；数学 / 计算题给出完整推导过程和最终结果；概念题给出明确定义与结论。\n'
        + '3. 最后用一到两句话点出易错点或值得延伸的地方。\n'
        + '不要只给方向、提示或「你可以试试」就停下，也不要让用户自己去补完关键步骤——'
        + '除非用户明确说「只要提示」。\n'
        + '如果题目信息不足，先按最合理的假设给出答案，并在开头写明你假设了什么。\n'
        + '用中文，条理清晰。';
    }
    if (tool === 'extract') {
      return '你是知识点提炼助手。把用户给出的课程内容整理成结构化知识点：'
        + '先用一句话概括主题，再用 1. 2. 3. 列出 4-6 条核心知识点，每条不超过 24 字。用中文。';
    }
    return '你是学习资料摘要助手。只依据用户给出的信息作答，绝不编造。'
      + '第一行写一段不超过 80 字的摘要，随后换行写「要点：」，再用 1. 2. 3. 列出 3 条要点，每条不超过 20 字。用中文。';
  }

  /* =========================================================
     10. 页面：我的收藏 / 提问 / 上传 / 最近浏览 / 待解决
     ========================================================= */

  function renderFavorites() {
    const el = ensurePage('favorites');
    const favs = Store.myFavorites();

    if (!Store.signedIn()) {
      el.innerHTML = pageHead('我的收藏', '登录后可以收藏问题和资料') +
        emptyBox('还没有登录', '登录后你的收藏会云端保存，换设备也在',
          '<button class="btn" data-act="login">登录 / 注册</button>');
      el.onclick = function (e) { if (e.target.closest('[data-act="login"]')) openAuthModal('登录后即可收藏。'); };
      return;
    }

    const qs = favs.filter(function (f) { return f.type === 'question'; });
    const rs = favs.filter(function (f) { return f.type === 'resource'; });

    el.innerHTML = pageHead('我的收藏', '共 ' + favs.length + ' 项') +
      (favs.length
        ? (qs.length ? '<h2 class="section-title" style="margin:6px 0 12px">问题 · ' + qs.length + '</h2><div class="q-list">' +
            qs.map(function (f) { return questionCard(f.item); }).join('') + '</div>' : '') +
          (rs.length ? '<h2 class="section-title" style="margin:26px 0 12px">资料 · ' + rs.length + '</h2><div class="res-grid">' +
            rs.map(function (f) { return resourceCard(f.item); }).join('') + '</div>' : '')
        : emptyBox('还没有收藏', '在问题或资料上点收藏图标就能收藏'));

    el.onclick = bindCommonClicks;
  }

  function renderCodeList(kind) {
    const map = {
      questions: { page: 'myquestions', title: '我的提问', sub: '你发布过的问题' },
      uploads: { page: 'myuploads', title: '我的上传', sub: '你分享过的资料' },
      recent: { page: 'recent', title: '最近浏览', sub: '你最近看过的问题' }
    };
    const meta = map[kind] || map.questions;
    const el = ensurePage(meta.page);

    if ((kind === 'questions' || kind === 'uploads') && !Store.signedIn()) {
      el.innerHTML = pageHead(meta.title, meta.sub) +
        emptyBox('还没有登录', '登录后这里会显示你的内容',
          '<button class="btn" data-act="login">登录 / 注册</button>');
      el.onclick = function (e) { if (e.target.closest('[data-act="login"]')) openAuthModal('登录后即可查看。'); };
      return;
    }

    let html;
    if (kind === 'questions') {
      const list = Store.myQuestions();
      // 先快照未读：下面会把红点标记掉，但本次页面上要保留「新回答」标签
      const unreadMap = unreadAnswerMap();
      const hasUnread = list.some(function (q) { return unreadMap[q.id]; });
      html = (hasUnread
        ? '<p class="new-hint">💬 有 ' + Object.keys(unreadMap).reduce(function (n, k) { return n + unreadMap[k]; }, 0) +
          ' 条新回答，已用「新回答」标出，点开问题即可查看。</p>'
        : '') +
        '<div class="q-list">' + (list.length
          ? list.map(function (q) { return questionCard(q, unreadMap[q.id] || 0); }).join('')
          : emptyBox('还没有提过问题', '有疑问就来发一条吧', '<button class="btn" data-act="ask">＋ 发布问题</button>')) + '</div>';
    } else if (kind === 'uploads') {
      const list = Store.myResources();
      html = '<div class="res-grid">' + (list.length ? list.map(function (r) { return resourceCard(r); }).join('')
        : emptyBox('还没有上传资料', '把你的笔记分享给同学吧', '<button class="btn" data-act="upload">⬆ 上传资料</button>')) + '</div>';
    } else if (kind === 'recent') {
      const list = Store.recentQuestions();
      html = '<div class="q-list">' + (list.length ? list.map(function (q) { return questionCard(q); }).join('')
        : emptyBox('还没有浏览记录', '去问答区看看同学们的问题')) + '</div>';
    } else {
      html = emptyBox('没有内容', '换个页面看看吧');
    }

    el.innerHTML = pageHead(meta.title, meta.sub) + html;
    el.onclick = bindCommonClicks;

    // 进来看过了：清掉侧栏和铃铛的红点
    if (kind === 'questions') markAnswerNoticesRead();
  }

  /* =========================================================
     10.2 页面：搜索结果（问答 + 资料一起搜）
     ========================================================= */

  function searchAll(kw) {
    const k = String(kw || '').trim().toLowerCase();
    if (!k) return { questions: [], resources: [] };

    return {
      questions: Store.questions().filter(function (q) {
        return [q.title, q.body, q.course, (q.tags || []).join(' '), q.author]
          .join(' ').toLowerCase().indexOf(k) >= 0;
      }),
      resources: Store.resources().filter(function (r) {
        return [r.title, r.course, r.category, r.author, r.description, r.fileName]
          .join(' ').toLowerCase().indexOf(k) >= 0;
      })
    };
  }

  function renderSearch(kw) {
    const el = ensurePage('search');
    const q = String(kw || '').trim();
    const input = $('#globalSearch');
    if (input) input.value = q;

    const hit = searchAll(q);
    const total = hit.questions.length + hit.resources.length;

    el.innerHTML =
      '<div class="page-head">' +
        '<h1 class="page-title">搜索「' + esc(q) + '」</h1>' +
        '<p class="page-sub">问答 ' + hit.questions.length + ' 条 · 资料 ' + hit.resources.length + ' 份</p>' +
      '</div>' +
      (total
        ? (hit.questions.length
            ? '<h2 class="section-title" style="margin:6px 0 12px">相关问答 · ' + hit.questions.length + '</h2>' +
              '<div class="q-list">' + hit.questions.map(function (x) { return questionCard(x); }).join('') + '</div>'
            : '') +
          (hit.resources.length
            ? '<h2 class="section-title" style="margin:26px 0 12px">相关资料 · ' + hit.resources.length + '</h2>' +
              '<div class="res-grid">' + hit.resources.map(resourceCard).join('') + '</div>'
            : '')
        : emptyBox('没有找到「' + q + '」', '换个关键词试试，比如课程名、算法名或文件名',
            '<a class="btn btn-line" href="#/qa">去问答区看看</a>'));

    el.onclick = bindCommonClicks;
  }

  /* =========================================================
     10.5 页面：设置
     ---------------------------------------------------------
     头像菜单只有一个「设置」入口：账号资料 / 显示偏好 / 学习数据
     ========================================================= */

  function accountInfo() {
    if (!Store.signedIn()) return { account: '', method: '' };
    if (accountProfile && (accountProfile.email || accountProfile.phone)) {
      return { account: maskedAccount(), method: accountProfile.email ? '邮箱登录' : '手机号登录' };
    }
    const s = sessionUser();
    const id = s ? String(s.id || '') : '';
    if (id.indexOf('@') > 0) return { account: maskedAccount(), method: '邮箱登录' };
    if (PHONE_RE.test(id)) return { account: maskedAccount(), method: '手机号登录' };
    return { account: '', method: '已登录' };
  }

  function setSwitchHtml(key, on, label) {
    return '<button type="button" class="switch' + (on ? ' on' : '') + '"' +
      ' data-switch="' + key + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '"' +
      ' aria-label="' + esc(label) + '"></button>';
  }

  /* 当前账号的真实资料（邮箱 / 手机号 / 是否有密码），由 CloudAuth.getUser 拉取 */
  let accountProfile = null;

  async function loadAccountProfile() {
    if (!Store.signedIn()) { accountProfile = null; return; }
    let email = '';
    let phone = '';
    let hasPassword = null;

    /* 数据库里的 auth 记录最准：邮箱、手机号可能同时存在 */
    try {
      const mine = await CloudAuth.getMyContacts();
      if (mine && mine.ok) {
        email = mine.email || '';
        phone = mine.phone || '';
        hasPassword = mine.hasPassword;
      }
    } catch (e) { /* 读取失败就退回 SDK 结果 */ }

    try {
      const res = await CloudAuth.getUser();
      if (res && res.ok && res.user) {
        const raw = res.user.raw || res.user || {};
        email = email || res.user.email || raw.email || '';
        phone = phone || res.user.phone || raw.phone || raw.phone_number || '';
        if (hasPassword === null) hasPassword = raw.password === 'SET';
      }
    } catch (e) { /* 读不到就退回基础展示 */ }

    accountProfile = { email: email, phone: phone, hasPassword: hasPassword };
  }

  /* 当前账号绑定了哪些登录方式（邮箱 / 手机号可以同时存在） */
  function loginIdentity() {
    if (accountProfile && (accountProfile.email || accountProfile.phone)) {
      return {
        email: accountProfile.email ? maskEmail(accountProfile.email) : '',
        phone: accountProfile.phone ? maskPhone(accountProfile.phone) : '',
        rawEmail: accountProfile.email || '',
        rawPhone: accountProfile.phone || '',
        hasPassword: accountProfile.hasPassword,
        count: (accountProfile.email ? 1 : 0) + (accountProfile.phone ? 1 : 0),
        method: accountProfile.email && accountProfile.phone ? '邮箱 + 手机号'
          : (accountProfile.email ? '邮箱' : '手机号')
      };
    }
    const s = sessionUser();
    const id = s ? String(s.id || '') : '';
    if (id.indexOf('@') > 0) {
      return { email: maskEmail(id), phone: '', rawEmail: id, rawPhone: '', hasPassword: null, count: 1, method: '邮箱' };
    }
    if (PHONE_RE.test(id)) {
      return { email: '', phone: maskPhone(id), rawEmail: '', rawPhone: id, hasPassword: null, count: 1, method: '手机号' };
    }
    return { email: '', phone: '', rawEmail: '', rawPhone: '', hasPassword: null, count: 0, method: '已登录' };
  }

  function renderSettings() {
    const el = ensurePage('settings');
    const signed = Store.signedIn();
    const nick = Store.nickname();
    const acc = accountInfo();
    const badgeOn = prefOn(PREF.qaBadge);
    const recentOn = prefOn(PREF.recent);

    const qaNew = newQaCount();
    const myQ = Store.myQuestions().length;
    const myR = Store.myResources().length;
    const myF = Store.myFavorites().length;
    const myA = Store.questions().reduce(function (n, q) {
      return n + q.answers.filter(function (a) { return Store.isMine(a); }).length;
    }, 0);
    const recentTotal = recentIds.length;
    const ident = loginIdentity();

    const securityCard = signed
      ? '<div class="set-card">' +
          '<h2 class="set-h">账号安全</h2>' +
          '<p class="set-sub">同一个账号可以同时绑定邮箱和手机号，两种方式登录进来看到的是同一份数据。</p>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>登录邮箱</b>' +
              '<span>' + (ident.email
                ? '可用「邮箱 + 密码」登录，也能接收找回密码的验证码。'
                : '还没绑定。绑定后也能用邮箱登录这个账号。') + '</span>' +
            '</div>' +
            '<div class="set-ctl">' +
              (ident.email
                ? '<span class="set-val">' + esc(ident.email) + '</span>' +
                  '<span class="tag tag-ok">已绑定</span>' +
                  '<button class="btn btn-sm btn-line" data-act="bind-email">更换</button>'
                : '<span class="set-val muted">未绑定</span>' +
                  '<button class="btn btn-sm btn-line" data-act="bind-email">绑定邮箱</button>') +
            '</div>' +
          '</div>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>登录手机号</b>' +
              '<span>' + (ident.phone
                ? '可用「手机号 + 密码」或短信验证码登录，也能用来重置密码。'
                : '还没绑定。绑定后也能用手机号登录这个账号。') + '</span>' +
            '</div>' +
            '<div class="set-ctl">' +
              (ident.phone
                ? '<span class="set-val">' + esc(ident.phone) + '</span>' +
                  '<span class="tag tag-ok">已绑定</span>' +
                  '<button class="btn btn-sm btn-line" data-act="bind-phone">更换</button>'
                : '<span class="set-val muted">未绑定</span>' +
                  '<button class="btn btn-sm btn-line" data-act="bind-phone">绑定手机号</button>') +
            '</div>' +
          '</div>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>登录密码</b>' +
              '<span>' + (ident.hasPassword === false
                ? (ident.email || ident.phone
                    ? '当前账号还没有设置密码。用' + (ident.email ? '邮箱' : '手机号') + '验证码设置一个，之后就能用「' +
                      (ident.email ? '邮箱' : '手机号') + ' + 密码」登录。'
                    : '当前为微信授权登录，凭微信身份直接进入，不需要单独设置密码。')
                : '修改后本机仍保持登录，下次登录请使用新密码。') + '</span>' +
            '</div>' +
            '<div class="set-ctl">' +
              (ident.hasPassword === false
                ? ((ident.email || ident.phone)
                    ? '<button class="btn btn-sm btn-line" data-act="set-pwd">设置密码</button>'
                    : '<span class="set-val muted">无需密码</span>')
                : '<button class="btn btn-sm btn-line" data-act="change-pwd">修改密码</button>') +
            '</div>' +
          '</div>' +
          '<p class="set-note">绑定邮箱或手机号后，任意一种都能登录同一个账号，提问、回答、收藏都会记在一起。' +
            (ident.count >= 2 ? '' : '设置密码后，两种登录方式都能直接用密码进入。') + '</p>' +
        '</div>'
      : '';

    const accountCard = signed
      ? '<div class="set-card">' +
          '<h2 class="set-h">账号资料</h2>' +
          '<p class="set-sub">用邮箱或手机号验证码登录，昵称会显示在你的提问、回答与资料上。</p>' +
          '<div class="set-account">' +
            '<button type="button" class="set-avatar-btn" data-act="pick-avatar" title="更换头像">' +
              avatarHtml('set-avatar') +
              '<span class="set-avatar-hint">更换</span>' +
            '</button>' +
            '<div class="set-id">' +
              '<b>' + esc(nick) + '</b>' +
              '<span>' + esc(acc.account) + ' · ' + esc(acc.method) + '</span>' +
            '</div>' +
            '<span class="tag tag-soft">已登录</span>' +
          '</div>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>头像</b>' +
              '<span>支持 jpg / png / webp，会自动裁成正方形并压缩后保存，换设备登录也会保留。</span>' +
            '</div>' +
            '<div class="set-ctl">' +
              '<button class="btn btn-sm btn-line" data-act="pick-avatar">' + (Store.avatar() ? '更换头像' : '上传头像') + '</button>' +
              (Store.avatar() ? '<button class="btn btn-sm btn-line" data-act="remove-avatar">移除</button>' : '') +
            '</div>' +
          '</div>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>昵称</b>' +
              '<span>最多 16 个字。保存后，你发布过的内容作者名会一起更新。</span>' +
            '</div>' +
            '<div class="set-ctl">' +
              '<input class="field set-field" id="setNickInput" maxlength="16" value="' + esc(nick) + '" placeholder="设置一个昵称">' +
              '<button class="btn btn-sm" data-act="save-nick">保存</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      : '<div class="set-card">' +
          '<h2 class="set-h">账号资料</h2>' +
          '<p class="set-sub">登录后可以设置昵称，并同步收藏、提问和上传记录。</p>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>还没有登录</b>' +
              '<span>用邮箱或手机号验证码即可登录 / 注册。</span>' +
            '</div>' +
            '<div class="set-ctl"><button class="btn btn-sm" data-act="login">登录 / 注册</button></div>' +
          '</div>' +
        '</div>';

    const adminCard = !signed ? '' : (adminState.is
      ? '<div class="set-card">' +
          '<h2 class="set-h">管理</h2>' +
          '<p class="set-sub">这个账号拥有管理员权限，可以查看全站数据、删除违规内容和发布公告。</p>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>管理后台</b>' +
              '<span>数据概览 / 内容管理 / 用户管理 / 通知公告</span>' +
            '</div>' +
            '<div class="set-ctl"><button class="btn btn-sm" data-act="open-admin">进入管理后台</button></div>' +
          '</div>' +
        '</div>'
      : '<div class="set-card">' +
          '<h2 class="set-h">管理</h2>' +
          '<p class="set-sub">如果这个账号要负责站点管理，输入管理员邀请码即可启用后台。</p>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>管理员邀请码</b>' +
              '<span>启用后，侧边栏会出现「管理后台」入口，只有这个账号能看到。</span>' +
            '</div>' +
            '<div class="set-ctl">' +
              '<input class="field set-field" id="setAdminCode" placeholder="输入邀请码" autocomplete="off">' +
              '<button class="btn btn-sm" data-act="claim-admin">启用</button>' +
            '</div>' +
          '</div>' +
        '</div>');

    el.innerHTML = pageHead('设置', '账号资料、界面显示偏好与本机数据') +
      '<div class="settings-wrap">' +
        accountCard +
        securityCard +
        adminCard +

        '<div class="set-card">' +
          '<h2 class="set-h">显示偏好</h2>' +
          '<p class="set-sub">只影响这台设备的界面显示，不会改动任何云端数据。</p>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>课程问答数字提醒</b>' +
              '<span>有同学发了新问题时，侧边栏「课程问答」后面会冒出数字，点一下就能标记已读。' +
                (qaNew ? '现在有 ' + qaNew + ' 条新问题。' : '现在没有新问题。') +
                '关掉后不再提醒。</span>' +
            '</div>' +
            '<div class="set-ctl">' + setSwitchHtml('qaBadge', badgeOn, '课程问答数字提醒') + '</div>' +
          '</div>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>记录最近浏览</b>' +
              '<span>打开过的问题会自动记一笔，方便在「最近浏览」里找回；关掉后不再新增。</span>' +
            '</div>' +
            '<div class="set-ctl">' + setSwitchHtml('recent', recentOn, '记录最近浏览') + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="set-card">' +
          '<h2 class="set-h">学习数据</h2>' +
          '<p class="set-sub">' +
            (signed ? '账号内的内容保存在云端，换设备登录后依然在。'
                    : '登录后可以在这里看到自己的学习数据。') +
          '</p>' +
          '<div class="stat-chips">' +
            '<span class="stat-chip">提问 <b>' + myQ + '</b></span>' +
            '<span class="stat-chip">回答 <b>' + myA + '</b></span>' +
            '<span class="stat-chip">收藏 <b>' + myF + '</b></span>' +
            '<span class="stat-chip">上传 <b>' + myR + '</b></span>' +
            '<span class="stat-chip">最近浏览 <b>' + recentTotal + '</b></span>' +
          '</div>' +
          '<div class="set-row">' +
            '<div class="set-label">' +
              '<b>本机浏览记录</b>' +
              '<span>共 ' + recentTotal + ' 条，只存在这台设备，不会上传。</span>' +
            '</div>' +
            '<div class="set-ctl">' +
              '<button class="btn btn-sm btn-line" data-act="clear-recent"' +
                (recentTotal ? '' : ' disabled') + '>清除记录</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        (signed
          ? '<div class="set-card">' +
              '<h2 class="set-h">账号操作</h2>' +
              '<p class="set-sub">退出后需要重新验证邮箱或手机号，才能继续提问和上传。</p>' +
              '<div class="set-actions">' +
                '<button class="btn btn-sm btn-danger" data-act="signout">退出登录</button>' +
              '</div>' +
              '<div class="set-row" style="border-top:1px dashed var(--border);margin-top:12px">' +
                '<div class="set-label">' +
                  '<b>注销账号</b>' +
                  '<span>永久删除账号，以及你发布的提问、回答、资料、收藏和通知。删除后无法恢复，也不能再用这个邮箱或手机号登录。</span>' +
                '</div>' +
                '<div class="set-ctl">' +
                  '<button class="btn btn-sm btn-line btn-warn" data-act="delete-account">注销账号</button>' +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
      '</div>';

    el.onclick = function (e) {
      if (e.target.closest('[data-act="login"]')) {
        openAuthModal('登录后即可提问、上传和收藏。');
        return;
      }

      if (e.target.closest('[data-act="open-admin"]')) { go('#/admin'); return; }

      if (e.target.closest('[data-act="claim-admin"]')) {
        const input = $('#setAdminCode');
        const code = (input && input.value || '').trim();
        if (!code) { toast('请先输入邀请码。'); if (input) input.focus(); return; }
        const btn = e.target.closest('[data-act="claim-admin"]');
        btn.disabled = true;
        CloudAdmin.claim(code).then(function () {
          adminState.is = true;
          adminState.known = true;
          adminState.uid = db.userId || '';
          applyAdminEntry();
          toast('已启用管理后台。');
          renderSettings();
        }).catch(function (err) {
          btn.disabled = false;
          toast(err.message || '启用失败。');
        });
        return;
      }

      const sw = e.target.closest('[data-switch]');
      if (sw) {
        const isBadge = sw.getAttribute('data-switch') === 'qaBadge';
        const key = isBadge ? PREF.qaBadge : PREF.recent;
        const next = !prefOn(key);
        setPref(key, next ? '1' : '0');
        applyNavBadge();
        renderSettings();
        toast(next
          ? (isBadge ? '已显示课程问答数字。' : '已开启最近浏览记录。')
          : (isBadge ? '已隐藏课程问答数字。' : '已关闭最近浏览记录。'));
        return;
      }

      if (e.target.closest('[data-act="save-nick"]')) { saveNickname(); return; }
      if (e.target.closest('[data-act="pick-avatar"]')) { openAvatarModal(); return; }
      if (e.target.closest('[data-act="remove-avatar"]')) { removeAvatar(); return; }

      if (e.target.closest('[data-act="change-pwd"]')) { openPasswordModal(); return; }
      if (e.target.closest('[data-act="set-pwd"]')) { openResetPassword(); return; }
      if (e.target.closest('[data-act="bind-email"]')) { openBindContact('email'); return; }
      if (e.target.closest('[data-act="bind-phone"]')) { openBindContact('phone'); return; }

      if (e.target.closest('[data-act="clear-recent"]')) {
        clearRecent();
        renderSettings();
        toast('已清除本机浏览记录。');
        return;
      }

      if (e.target.closest('[data-act="signout"]')) { doSignOut(); return; }
      if (e.target.closest('[data-act="delete-account"]')) { openDeleteAccountModal(); return; }
    };

    const nickInput = $('#setNickInput');
    if (nickInput) {
      nickInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveNickname(); }
      });
    }
  }

  async function saveNickname() {
    if (!Store.signedIn()) { openAuthModal('登录后即可修改昵称。'); return; }
    const input = $('#setNickInput');
    if (!input) return;
    const name = String(input.value || '').trim();
    if (!name) { toast('昵称不能为空。'); input.focus(); return; }
    if (name === Store.nickname()) { toast('昵称没有变化。'); return; }

    const btn = $('[data-act="save-nick"]');
    if (btn) btn.disabled = true;
    try {
      await CloudData.saveNickname(db.userId, name);
      await refresh();
      renderAuthArea();
      renderSettings();
      toast('昵称已保存。');
    } catch (err) {
      if (btn) btn.disabled = false;
      toast((err && err.message) || '保存失败，请稍后再试。');
    }
  }

  /* ---------------- 换头像 ---------------- */

  /* 把选中的图片裁成正方形并压到 240×240 的 JPEG，
     典型体积 10~20 KB，存成 data URL 直接进 profiles.avatar_url */
  function avatarFromFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) {
        reject(new Error('请选择 jpg / png / webp 等图片文件。'));
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        reject(new Error('图片超过 8 MB，请换一张小一点的照片。'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取图片失败，请重试。')); };
      reader.onload = function () {
        const img = new Image();
        img.onerror = function () { reject(new Error('这张图片无法解析，请换一张试试。')); };
        img.onload = function () {
          const size = 240;
          const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
          if (!side) { reject(new Error('这张图片无法解析，请换一张试试。')); return; }
          const sx = ((img.naturalWidth || img.width) - side) / 2;
          const sy = ((img.naturalHeight || img.height) - side) / 2;
          const cv = document.createElement('canvas');
          cv.width = size;
          cv.height = size;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  let avatarDraft = null;          // 待保存的头像（data URL）
  let avatarDraftTouched = false;  // 用户是否真的动过

  function avatarPreviewHtml() {
    const src = avatarDraftTouched ? avatarDraft : Store.avatar();
    const nick = Store.nickname();
    if (src) return '<span class="avatar-lg has-img"><img src="' + esc(src) + '" alt=""></span>';
    return '<span class="avatar-lg">' + esc(nick.slice(0, 1) || '同') + '</span>';
  }

  function paintAvatarPreview() {
    const box = $('#avatarPreview');
    if (box) box.innerHTML = avatarPreviewHtml();
    const hint = $('#avatarHint');
    if (hint) {
      hint.textContent = avatarDraftTouched
        ? (avatarDraft ? '已选好，点「保存头像」生效。' : '将换回默认首字头像，点「保存头像」生效。')
        : '还没有选图片，当前显示的是已保存的头像。';
    }
    const save = $('[data-act="avatar-save"]');
    if (save) save.disabled = !avatarDraftTouched;
  }

  function openAvatarModal() {
    if (!Store.signedIn()) { openAuthModal('登录后即可设置头像。'); return; }
    avatarDraft = null;
    avatarDraftTouched = false;

    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal narrow">' +
        '<div class="modal-head">' +
          '<div>' +
            '<h3 class="modal-title">更换头像</h3>' +
            '<p class="modal-sub">会自动裁成正方形并压缩，圆形展示</p>' +
          '</div>' +
          '<button class="modal-close" data-close="1" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div class="avatar-pick">' +
            '<div id="avatarPreview">' + avatarPreviewHtml() + '</div>' +
            '<div class="avatar-pick-side">' +
              '<button class="btn btn-line btn-sm" data-act="avatar-choose">选择图片</button>' +
              '<p class="hint" id="avatarHint">还没有选图片，当前显示的是已保存的头像。</p>' +
              '<input type="file" id="avatarFile" accept="image/*" hidden>' +
            '</div>' +
          '</div>' +
          '<div id="avatarError"></div>' +
          '<p class="hint" style="margin:14px 0 0">只在你的设备上裁剪，图片会被压到约 240×240 再上传，' +
            '原始大图不会存到服务器。</p>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="avatar-save" disabled>保存头像</button>' +
          (Store.avatar() ? '<button class="btn btn-line" data-act="avatar-clear">移除头像</button>' : '') +
          '<button class="btn btn-line" data-close="1">取消</button>' +
        '</div>' +
      '</div>';

    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }
      if (e.target.closest('[data-act="avatar-choose"]')) { $('#avatarFile').click(); return; }
      if (e.target.closest('[data-act="avatar-clear"]')) {
        avatarDraft = null;
        avatarDraftTouched = true;
        paintAvatarPreview();
        return;
      }
      if (e.target.closest('[data-act="avatar-save"]')) { saveAvatar(); return; }
    };

    const fileInput = $('#avatarFile');
    if (fileInput) {
      fileInput.addEventListener('change', async function () {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        const errBox = $('#avatarError');
        if (errBox) errBox.innerHTML = '';
        try {
          avatarDraft = await avatarFromFile(f);
          avatarDraftTouched = true;
          paintAvatarPreview();
        } catch (err) {
          if (errBox) errBox.innerHTML = '<div class="form-error">' + esc(err.message) + '</div>';
        } finally {
          fileInput.value = '';
        }
      });
    }
  }

  async function saveAvatar() {
    if (!avatarDraftTouched) return;
    const btn = $('[data-act="avatar-save"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在保存…'; }
    try {
      await CloudData.saveAvatar(db.userId, avatarDraft, Store.nickname());
      db.profile.avatar = avatarDraft || '';
      closeModal();
      renderAuthArea();
      if (currentRoute.page === 'settings') renderSettings();
      toast(avatarDraft ? '头像已更新。' : '已换回默认头像。');
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '保存头像'; }
      const errBox = $('#avatarError');
      if (errBox) errBox.innerHTML = '<div class="form-error">' +
        esc((err && err.message) || '保存失败，请稍后重试。') + '</div>';
    }
  }

  async function removeAvatar() {
    if (!Store.avatar()) { toast('当前已经是默认头像。'); return; }
    if (!global.confirm('确定移除头像，换回昵称首字吗？')) return;
    try {
      await CloudData.saveAvatar(db.userId, null, Store.nickname());
      db.profile.avatar = '';
      renderAuthArea();
      renderSettings();
      toast('已换回默认头像。');
    } catch (err) {
      toast((err && err.message) || '移除失败，请稍后重试。');
    }
  }

  /* ---------------- 修改密码 ---------------- */

  /* 把 "+86 138xxxxxxxx" / "0086138..." 还原成 11 位，用于表单预填 */
  function localPhoneOf(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    const m = digits.match(/(1\d{10})$/);
    return m ? m[1] : '';
  }

  /* 打开登录弹窗里的「忘记密码 / 设置密码」流程。
     邮箱和手机号都支持，默认选中当前账号实际使用的那种登录方式。 */
  function openResetPassword() {
    const email = (accountProfile && accountProfile.email) || '';
    const phone = localPhoneOf(accountProfile && accountProfile.phone);
    const method = email ? 'email' : (phone ? 'phone' : 'email');

    // 微信授权账号没有可验证的登录名，设置密码无从校验，也不影响登录
    if (Store.signedIn() && !email && !phone) {
      toast('当前账号是微信授权登录，没有可验证的邮箱或手机号，不需要单独设置密码。');
      return;
    }

    const hint = email
      ? '验证邮箱后设置登录密码；设置成功后本机仍保持登录。'
      : (phone
          ? '验证手机号后设置登录密码；设置成功后本机仍保持登录。'
          : '验证邮箱或手机号后设置登录密码；设置成功后本机仍保持登录。');

    // 关键：带上 intent / mode，否则已登录时会被渲染成「改昵称」表单
    openAuthModal(hint, { intent: 'reset', mode: 'reset' });
    authState.method = method;
    authState.codeSent = false;
    authState.verificationId = null;
    authState.resetHandle = null;
    authState.pendingEmail = email || null;
    authState.pendingPhone = phone || null;

    // 极少数情况 accountProfile 没拉到：退回会话里能看到的登录名
    if (!email && !phone) {
      const sid = sessionUser() ? String(sessionUser().id || '') : '';
      if (sid.indexOf('@') > 0) authState.pendingEmail = sid;
      else if (PHONE_RE.test(sid)) authState.pendingPhone = sid;
    }
    if (global.__redrawAuth) global.__redrawAuth();
  }

  /* ---------------- 绑定第二种登录方式（邮箱 / 手机号） ---------------- */

  let bindState = { kind: 'phone', sentTo: '', verificationId: null, countdown: 0, timer: null };

  function bindError(msg) {
    const box = $('#bindError');
    if (box) box.innerHTML = msg ? '<div class="form-error">' + esc(msg) + '</div>' : '';
  }

  function stopBindCountdown() {
    if (bindState.timer) { clearInterval(bindState.timer); bindState.timer = null; }
    bindState.countdown = 0;
  }

  function startBindCountdown(sec) {
    stopBindCountdown();
    bindState.countdown = sec;
    const btn = $('[data-act="bind-send"]');
    const tick = function () {
      if (!btn) return;
      if (bindState.countdown > 0) {
        btn.disabled = true;
        btn.textContent = bindState.countdown + ' 秒后可重发';
        bindState.countdown -= 1;
      } else {
        btn.disabled = false;
        btn.textContent = '发送验证码';
        stopBindCountdown();
      }
    };
    tick();
    bindState.timer = setInterval(tick, 1000);
  }

  function openBindContact(kind) {
    if (!requireLogin('绑定登录方式')) return;
    const isPhone = kind !== 'email';
    const label = isPhone ? '手机号' : '邮箱';

    bindState.kind = isPhone ? 'phone' : 'email';
    bindState.verificationId = null;
    bindState.sentTo = '';
    stopBindCountdown();

    const boundVal = (accountProfile && (isPhone ? accountProfile.phone : accountProfile.email)) || '';

    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal narrow">' +
        '<div class="modal-head">' +
          '<div>' +
            '<h3 class="modal-title">绑定登录' + label + '</h3>' +
            '<p class="modal-sub">验证之后，' + label + '和现在的方式都能登录同一个账号</p>' +
          '</div>' +
          '<button class="modal-close" data-close="1" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<label class="label">' + label + '</label>' +
          '<div class="bind-line">' +
            '<input class="field" id="bindValue" ' +
              (isPhone
                ? 'inputmode="numeric" maxlength="11" placeholder="11 位手机号"'
                : 'type="email" autocomplete="email" placeholder="you@example.com"') + '>' +
            '<button class="btn btn-line btn-sm" data-act="bind-send">发送验证码</button>' +
          '</div>' +
          '<label class="label">验证码</label>' +
          '<input class="field" id="bindCode" inputmode="numeric" maxlength="6" placeholder="6 位数字验证码">' +
          '<div id="bindError"></div>' +
          '<p class="hint" style="margin:12px 0 0">验证码会发送到这个' + label + '，用来确认它属于你。' +
            '绑定后提问、回答、收藏仍记在同一个账号下，不会分成两份。' +
            (isPhone ? '同一手机号每分钟只能发一次。' : '') + '</p>' +
          (boundVal
            ? '<p class="hint" style="margin:10px 0 0">' +
                '<button class="foot-link" data-act="bind-unbind"><b>解除当前绑定的' + label + '</b><i>Unbind</i></button>' +
              '</p>'
            : '') +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="bind-save">确认绑定</button>' +
          '<button class="btn btn-line" data-close="1">取消</button>' +
        '</div>' +
      '</div>';

    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { stopBindCountdown(); closeModal(); return; }
      if (e.target.closest('[data-act="bind-send"]')) { bindSendCode(); return; }
      if (e.target.closest('[data-act="bind-save"]')) { bindSaveContact(); return; }
      if (e.target.closest('[data-act="bind-unbind"]')) {
        stopBindCountdown();
        unbindContact(bindState.kind, true);
        return;
      }
    };
    root.onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!$('#bindCode') || !$('#bindCode').value) bindSendCode();
      else bindSaveContact();
    };

    const first = $('#bindValue');
    if (first) first.focus();
  }

  async function bindSendCode() {
    const isPhone = bindState.kind === 'phone';
    const value = readVal('#bindValue');
    if (isPhone && !PHONE_RE.test(value)) { bindError('请输入正确的 11 位手机号。'); return; }
    if (!isPhone && !EMAIL_RE.test(value)) { bindError('请输入正确的邮箱地址。'); return; }

    bindError('');
    const btn = $('[data-act="bind-send"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在发送…'; }

    const res = await CloudAuth.sendOtp(isPhone
      ? { phone: value, type: 'sms' }
      : { email: value, type: 'email' });

    if (!res.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '发送验证码'; }
      bindError(res.message);
      return;
    }

    bindState.verificationId = res.verificationId || null;
    bindState.sentTo = value;
    toast(isPhone ? '验证码已发送，请查看短信。' : '验证码已发送，请查收邮箱。');
    startBindCountdown(60);
  }

  async function bindSaveContact() {
    const isPhone = bindState.kind === 'phone';
    const label = isPhone ? '手机号' : '邮箱';
    const value = readVal('#bindValue');
    const code = readVal('#bindCode');

    if (isPhone && !PHONE_RE.test(value)) { bindError('请输入正确的 11 位手机号。'); return; }
    if (!isPhone && !EMAIL_RE.test(value)) { bindError('请输入正确的邮箱地址。'); return; }
    if (!bindState.verificationId) { bindError('请先点击「发送验证码」。'); return; }
    if (bindState.sentTo && bindState.sentTo !== value) {
      bindError('填写的内容和发验证码时不一致，请重新发送。');
      return;
    }
    if (!/^\d{6}$/.test(code)) { bindError('请输入 6 位验证码。'); return; }

    const btn = $('[data-act="bind-save"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在绑定…'; }

    const checked = await CloudAuth.verifyCodeOnly(bindState.verificationId, code);
    if (!checked.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '确认绑定'; }
      bindError(checked.message);
      return;
    }

    const res = await CloudAuth.bindContact(bindState.kind, value);
    if (!res.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '确认绑定'; }
      bindError(res.message);
      return;
    }

    stopBindCountdown();
    closeModal();
    await loadAccountProfile();
    if (currentRoute.page === 'settings') renderSettings();
    else applyRoute();
    toast(label + '已绑定，现在可以用它登录同一个账号。');
  }

  async function unbindContact(kind, fromModal) {
    const label = kind === 'phone' ? '手机号' : '邮箱';
    if (!global.confirm('确定解绑' + label + '吗？解绑后就不能再用它登录了。')) return;
    const res = await CloudAuth.unbindContact(kind);
    if (!res.ok) { toast(res.message); return; }
    if (fromModal) closeModal();
    await loadAccountProfile();
    renderSettings();
    toast(label + '已解绑。');
  }

  function openPasswordModal() {
    if (!requireLogin('修改密码')) return;
    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal narrow">' +
        '<div class="modal-head">' +
          '<div>' +
            '<h3 class="modal-title">修改密码</h3>' +
            '<p class="modal-sub">为了账号安全，请先验证当前密码</p>' +
          '</div>' +
          '<button class="modal-close" data-close="1" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<label class="label">当前密码</label>' +
          '<input class="field" id="pwdOld" type="password" autocomplete="current-password" placeholder="输入现在使用的密码">' +
          '<label class="label">新密码</label>' +
          '<input class="field" id="pwdNew" type="password" autocomplete="new-password" placeholder="至少 6 位">' +
          '<label class="label">确认新密码</label>' +
          '<input class="field" id="pwdNew2" type="password" autocomplete="new-password" placeholder="再输入一次新密码">' +
          '<div id="pwdError"></div>' +
          '<p class="hint" style="margin:12px 0 0">忘记当前密码？可以退出后在登录页用「忘记密码」，通过邮箱或手机验证码重置。</p>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="save-pwd">保存新密码</button>' +
          '<button class="btn btn-line" data-close="1">取消</button>' +
        '</div>' +
      '</div>';

    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }
      if (e.target.closest('[data-act="save-pwd"]')) { savePassword(); return; }
    };
    root.onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      savePassword();
    };

    const first = $('#pwdOld');
    if (first) first.focus();
  }

  function pwdError(msg) {
    const box = $('#pwdError');
    if (box) box.innerHTML = msg ? '<div class="form-error">' + esc(msg) + '</div>' : '';
  }

  async function savePassword() {
    if (!Store.signedIn()) { closeModal(); openAuthModal('登录后即可修改密码。'); return; }
    const oldPwd = (($('#pwdOld') || {}).value || '');
    const newPwd = (($('#pwdNew') || {}).value || '');
    const newPwd2 = (($('#pwdNew2') || {}).value || '');

    if (!oldPwd) { pwdError('请输入当前密码。'); return; }
    if (newPwd.length < 6) { pwdError('新密码至少 6 位。'); return; }
    if (newPwd !== newPwd2) { pwdError('两次输入的新密码不一致。'); return; }
    if (newPwd === oldPwd) { pwdError('新密码不能和当前密码相同。'); return; }

    const btn = $('[data-act="save-pwd"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在保存…'; }

    try {
      const res = await CloudAuth.changePassword(oldPwd, newPwd);
      if (!res.ok) {
        pwdError(res.message || '修改失败，请稍后再试。');
        if (btn) { btn.disabled = false; btn.textContent = '保存新密码'; }
        return;
      }
      closeModal();
      await loadAccountProfile();
      toast('密码已修改，下次登录请使用新密码。');
    } catch (err) {
      pwdError((err && err.message) || '修改失败，请稍后再试。');
      if (btn) { btn.disabled = false; btn.textContent = '保存新密码'; }
    }
  }

  /* =========================================================
     10.8 页面：管理后台（仅管理员）
     ---------------------------------------------------------
     判定：admins 白名单 + 数据库 SECURITY DEFINER 函数二次校验。
     前端即使伪造路由，也只能看到「没有权限」，拿不到数据。
     ========================================================= */

  const adminState = { uid: null, is: false, known: false };
  const ADMIN_TABS = [
    { key: 'overview', label: '数据概览' },
    { key: 'content', label: '内容管理' },
    { key: 'users', label: '用户管理' },
    { key: 'notice', label: '通知公告' }
  ];
  let adminTab = 'overview';
  const adminUI = { kind: 'question', q: '', usersQ: '', busy: false };

  function applyAdminEntry() {
    const show = !!adminState.is;
    ['navAdminGroup', 'navAdminNav'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.hidden = !show;
    });
  }

  function refreshAdminState() {
    const uid = db.userId || '';
    if (adminState.known && adminState.uid === uid) { applyAdminEntry(); return; }
    adminState.uid = uid;
    if (!uid) {
      adminState.is = false;
      adminState.known = true;
      applyAdminEntry();
      return;
    }
    CloudAdmin.isAdmin().then(function (ok) {
      adminState.is = !!ok;
      adminState.known = true;
      applyAdminEntry();
      if (currentRoute.page === 'admin') renderAdmin();
      if (currentRoute.page === 'settings') renderSettings();
    }).catch(function () {
      adminState.is = false;
      adminState.known = true;
      applyAdminEntry();
    });
  }

  function adminAvatar(u) {
    if (u.avatar_url) {
      return '<span class="adm-avatar has-img"><img src="' + esc(u.avatar_url) + '" alt=""></span>';
    }
    return '<span class="adm-avatar">' + esc(String(u.nickname || '华师同学').slice(0, 1)) + '</span>';
  }

  function adminStatCard(label, value, sub) {
    return '<div class="adm-stat">' +
      '<span class="adm-stat-label">' + esc(label) + '</span>' +
      '<b class="adm-stat-value">' + value + '</b>' +
      (sub ? '<span class="adm-stat-sub">' + esc(sub) + '</span>' : '') +
    '</div>';
  }

  function adminOverviewHtml(d) {
    const days = d.days || [];
    let max = 1;
    days.forEach(function (x) { max = Math.max(max, (x.q || 0) + (x.a || 0) + (x.r || 0)); });

    const bars = days.map(function (x) {
      const total = (x.q || 0) + (x.a || 0) + (x.r || 0);
      const px = total ? Math.max(6, Math.round(total / max * 108)) : 2;
      const seg = function (n, cls) {
        return total && n ? '<i class="' + cls + '" style="height:' + Math.round(n / total * 100) + '%"></i>' : '';
      };
      return '<div class="adm-col" title="' + esc(x.d) + '：问题 ' + (x.q || 0) + ' 条 · 回答 ' + (x.a || 0) + ' 条 · 资料 ' + (x.r || 0) + ' 份">' +
        '<div class="adm-col-bar" style="height:' + px + 'px">' + seg(x.q, 'q') + seg(x.a, 'a') + seg(x.r, 'r') + '</div>' +
        '<span class="adm-col-n">' + total + '</span>' +
        '<span class="adm-col-x">' + esc(x.d) + '</span>' +
      '</div>';
    }).join('');

    const topQ = (d.top_questions || []).map(function (q, i) {
      return '<li><a href="#/detail/' + q.id + '">' +
        '<span class="adm-rank">' + (i + 1) + '</span>' +
        '<span class="adm-top-t">' + esc(q.title) + '</span>' +
        '<span class="adm-top-n">' + q.views + ' 浏览 · ' + q.answers + ' 回答</span></a></li>';
    }).join('');

    const topR = (d.top_resources || []).map(function (r, i) {
      return '<li><a href="#/resource/' + r.id + '">' +
        '<span class="adm-rank">' + (i + 1) + '</span>' +
        '<span class="adm-top-t">' + esc(r.title) + '</span>' +
        '<span class="adm-top-n">' + r.downloads + ' 次浏览</span></a></li>';
    }).join('');

    return '<div class="adm-stats">' +
        adminStatCard('注册用户', d.users, '今日 +' + d.today_users) +
        adminStatCard('问题', d.questions, '今日 +' + d.today_questions) +
        adminStatCard('回答', d.answers, '今日 +' + d.today_answers) +
        adminStatCard('资料', d.resources, '今日 +' + d.today_resources) +
        adminStatCard('已解决', d.solved, '占问题 ' + (d.questions ? Math.round(d.solved / d.questions * 100) : 0) + '%') +
        adminStatCard('未读通知', d.unread, '全站待读') +
      '</div>' +

      '<div class="adm-card">' +
        '<div class="adm-card-head"><h2 class="set-h" style="margin:0">近 7 天新增</h2>' +
          '<span class="adm-legend"><i class="q"></i>问题<i class="a"></i>回答<i class="r"></i>资料</span></div>' +
        (days.length ? '<div class="adm-chart">' + bars + '</div>' : emptyBox('暂无数据', '有内容后这里会出现趋势')) +
      '</div>' +

      '<div class="adm-two">' +
        '<div class="adm-card"><div class="adm-card-head"><h2 class="set-h" style="margin:0">热门问题</h2></div>' +
          (topQ ? '<ol class="adm-top">' + topQ + '</ol>' : emptyBox('还没有问题', '')) + '</div>' +
        '<div class="adm-card"><div class="adm-card-head"><h2 class="set-h" style="margin:0">热门资料</h2></div>' +
          (topR ? '<ol class="adm-top">' + topR + '</ol>' : emptyBox('还没有资料', '')) + '</div>' +
      '</div>';
  }

  function adminContentRow(kind, row) {
    if (kind === 'answer') {
      return '<div class="adm-row">' +
        '<div class="adm-main">' +
          '<div class="adm-row-title adm-clamp">' + esc(row.body || '') + '</div>' +
          '<div class="adm-row-sub">' + esc(row.author || '华师同学') + ' · 属于《' + esc(row.question_title || '问题已删除') + '》 · ' +
            esc(fmtTime(row.created_at)) + (row.parent_id ? ' · 楼中楼回复' : '') + '</div>' +
        '</div>' +
        '<div class="adm-row-nums"><span>' + (row.votes || 0) + ' 赞</span></div>' +
        '<div class="adm-row-ops">' +
          '<a class="btn btn-sm btn-line" href="#/detail/' + row.question_id + '">查看</a>' +
          '<button class="btn btn-sm btn-line btn-warn" data-act="adm-del" data-kind="answer" data-id="' + row.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }
    if (kind === 'resource') {
      return '<div class="adm-row">' +
        '<div class="adm-main">' +
          '<div class="adm-row-title">' + esc(row.title || '') + '</div>' +
          '<div class="adm-row-sub">' + esc(row.author || '华师同学') + ' · ' + esc(row.course || '未分类') + ' · ' +
            esc(row.category || '') + ' · ' + esc(fmtTime(row.created_at)) + '</div>' +
        '</div>' +
        '<div class="adm-row-nums"><span>' + (row.downloads || 0) + ' 浏览</span>' +
          '<span>' + esc(row.file_name || '无附件') + '</span></div>' +
        '<div class="adm-row-ops">' +
          '<a class="btn btn-sm btn-line" href="#/resource/' + row.id + '">查看</a>' +
          '<button class="btn btn-sm btn-line btn-warn" data-act="adm-del" data-kind="resource" data-id="' + row.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }
    return '<div class="adm-row">' +
      '<div class="adm-main">' +
        '<div class="adm-row-title">' + esc(row.title || '') + '</div>' +
        '<div class="adm-row-sub">' + esc(row.author || '华师同学') + ' · ' + esc(row.course || '未分类') + ' · ' +
          esc(fmtTime(row.created_at)) + (row.solved ? ' · <span class="adm-ok">已解决</span>' : '') + '</div>' +
      '</div>' +
      '<div class="adm-row-nums"><span>' + (row.views || 0) + ' 浏览</span><span>' + (row.answers || 0) + ' 回答</span>' +
        (row.hot ? '<span class="adm-hot">热议中</span>' : '') + '</div>' +
      '<div class="adm-row-ops">' +
        '<button class="btn btn-sm btn-line" data-act="adm-hot" data-id="' + row.id + '">' + (row.hot ? '取消热议' : '设为热议') + '</button>' +
        '<a class="btn btn-sm btn-line" href="#/detail/' + row.id + '">查看</a>' +
        '<button class="btn btn-sm btn-line btn-warn" data-act="adm-del" data-kind="question" data-id="' + row.id + '">删除</button>' +
      '</div>' +
    '</div>';
  }

  function adminContentHtml(d) {
    const rows = d.rows || [];
    const kinds = [['question', '问题'], ['answer', '回答'], ['resource', '资料']];
    return '<div class="adm-toolbar">' +
        '<div class="adm-seg">' + kinds.map(function (k) {
          return '<button class="chip' + (adminUI.kind === k[0] ? ' on' : '') + '" data-akind="' + k[0] + '">' + k[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="adm-search-box">' +
          '<input class="field" id="admContentQ" placeholder="搜标题、正文或作者" value="' + esc(adminUI.q) + '">' +
          '<button class="btn btn-sm" data-act="adm-search-content">搜索</button>' +
        '</div>' +
        '<span class="adm-total">共 ' + d.total + ' 条</span>' +
      '</div>' +
      '<div class="adm-list">' +
        (rows.length ? rows.map(function (r) { return adminContentRow(adminUI.kind, r); }).join('')
          : emptyBox('没有找到内容', '换个关键词，或切换上面的类型')) +
      '</div>';
  }

  function adminUsersHtml(d) {
    const rows = d.rows || [];
    return '<div class="adm-toolbar">' +
        '<div class="adm-search-box">' +
          '<input class="field" id="admUsersQ" placeholder="搜昵称、邮箱、学院或用户 ID" value="' + esc(adminUI.usersQ) + '">' +
          '<button class="btn btn-sm" data-act="adm-search-users">搜索</button>' +
        '</div>' +
        '<span class="adm-total">共 ' + d.total + ' 位用户</span>' +
      '</div>' +
      '<div class="adm-list">' +
        (rows.length ? rows.map(function (u) {
          const active = u.last_active && String(u.last_active).indexOf('1970') < 0 ? fmtTime(u.last_active) : '暂无活动';
          return '<div class="adm-row adm-user-row">' +
            adminAvatar(u) +
            '<div class="adm-main">' +
              '<div class="adm-row-title">' + esc(u.nickname || '华师同学') +
                (u.verified ? ' <span class="tag tag-ok">已验证</span>' : '') + '</div>' +
              '<div class="adm-row-sub">' + esc(u.email || ('ID ' + u.owner_id)) +
                (u.college ? ' · ' + esc(u.college) : '') + (u.campus ? ' · ' + esc(u.campus) : '') + '</div>' +
            '</div>' +
            '<div class="adm-row-nums"><span>提问 ' + (u.q_count || 0) + '</span>' +
              '<span>回答 ' + (u.a_count || 0) + '</span>' +
              '<span>资料 ' + (u.r_count || 0) + '</span>' +
              '<span>最近 ' + esc(active) + '</span></div>' +
            '<div class="adm-row-ops">' +
              '<button class="btn btn-sm btn-line btn-warn" data-act="adm-deluser" data-uid="' + esc(u.owner_id) + '"' +
                ' data-name="' + esc(u.nickname || '') + '">删除账号</button>' +
            '</div>' +
          '</div>';
        }).join('') : emptyBox('没有匹配的用户', '换个关键词试试')) +
      '</div>';
  }

  function adminNoticeHtml(list) {
    const hist = (list || []).map(function (n) {
      return '<div class="adm-row">' +
        '<div class="adm-main">' +
          '<div class="adm-row-title">' + esc(n.title || '(无标题)') + '</div>' +
          '<div class="adm-row-sub">' + esc(n.body || '') + '</div>' +
        '</div>' +
        '<div class="adm-row-nums"><span>送达 ' + (n.receivers || 0) + ' 人</span><span>' + esc(fmtTime(n.created_at)) + '</span></div>' +
      '</div>';
    }).join('');

    return '<div class="adm-card">' +
        '<div class="adm-card-head"><h2 class="set-h" style="margin:0">发布全站公告</h2></div>' +
        '<p class="adm-hint">发布后，所有已注册用户都会在右上角铃铛里收到一条未读消息。</p>' +
        '<input class="field" id="admNoticeTitle" maxlength="60" placeholder="公告标题，例如：期中复习资料已上线">' +
        '<textarea class="field" id="admNoticeBody" rows="4" maxlength="300" placeholder="公告内容，简单说明即可（最多 300 字）"></textarea>' +
        '<div class="adm-send-row">' +
          '<button class="btn" data-act="adm-send">发布公告</button>' +
          '<span class="adm-hint" style="margin:0">只发文字通知，不发邮件 / 短信</span>' +
        '</div>' +
      '</div>' +
      '<div class="adm-card">' +
        '<div class="adm-card-head"><h2 class="set-h" style="margin:0">已发布</h2>' +
          '<span class="adm-total">最近 20 条</span></div>' +
        '<div class="adm-list">' + (hist || emptyBox('还没有发过公告', '')) + '</div>' +
      '</div>';
  }

  function confirmDanger(opts) {
    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal narrow">' +
        '<div class="modal-head"><div>' +
          '<h3 class="modal-title">' + esc(opts.title) + '</h3>' +
          '<p class="modal-sub">' + esc(opts.sub || '此操作不可撤销') + '</p>' +
        '</div><button class="modal-close" data-close="1" aria-label="关闭">✕</button></div>' +
        '<div class="modal-body">' +
          (opts.desc ? '<div class="danger-box">' + esc(opts.desc) + '</div>' : '') +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-line" data-close="1">取消</button>' +
          '<button class="btn btn-danger solid" data-ok="1">' + esc(opts.ok || '确认') + '</button>' +
        '</div>' +
      '</div>';
    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }
      if (e.target.closest('[data-ok]')) { closeModal(); if (opts.onOk) opts.onOk(); }
    };
  }

  function adminClaimCard() {
    return '<div class="set-card adm-claim">' +
      '<h2 class="set-h">需要管理员权限</h2>' +
      '<p class="set-sub">这是站点的管理入口。如果你拿到了管理员邀请码，输入后即可把当前账号设为管理员，侧边栏会出现「管理后台」。</p>' +
      '<div class="adm-claim-row">' +
        '<input class="field" id="adminCode" placeholder="管理员邀请码" autocomplete="off">' +
        '<button class="btn" data-act="adm-claim">启用管理后台</button>' +
      '</div>' +
      '<p class="set-note">当前账号：' + esc(Store.nickname()) + '（' + esc(db.userId || '未登录') + '）</p>' +
    '</div>';
  }

  async function loadAdminBody() {
    const box = $('#adminBody');
    if (!box) return;
    box.innerHTML = '<div class="adm-loading">加载中…</div>';
    try {
      if (adminTab === 'overview') {
        box.innerHTML = adminOverviewHtml(await CloudAdmin.overview());
      } else if (adminTab === 'content') {
        box.innerHTML = adminContentHtml(await CloudAdmin.content(adminUI.kind, adminUI.q, 60, 0));
      } else if (adminTab === 'users') {
        box.innerHTML = adminUsersHtml(await CloudAdmin.users(adminUI.usersQ, 60, 0));
      } else {
        box.innerHTML = adminNoticeHtml(await CloudAdmin.notices());
      }
    } catch (e) {
      box.innerHTML = '<div class="adm-error">' + esc(e.message || '加载失败，请稍后重试。') + '</div>';
    }
  }

  function renderAdmin() {
    const el = ensurePage('admin');

    if (!Store.signedIn()) {
      el.innerHTML = pageHead('管理后台', '仅管理员可访问') +
        emptyBox('请先登录', '用管理员账号登录后才能进入后台',
          '<button class="btn" data-act="adm-login">登录 / 注册</button>');
      el.onclick = function (e) {
        if (e.target.closest('[data-act="adm-login"]')) openAuthModal('登录后进入管理后台。');
      };
      return;
    }

    if (!adminState.known) {
      el.innerHTML = pageHead('管理后台', '正在校验权限') +
        '<div class="adm-loading">正在校验管理权限…</div>';
      refreshAdminState();
      return;
    }

    if (!adminState.is) {
      el.innerHTML = pageHead('管理后台', '仅管理员可访问') + adminClaimCard();
      el.onclick = function (e) {
        if (!e.target.closest('[data-act="adm-claim"]')) return;
        const input = $('#adminCode');
        const code = (input && input.value || '').trim();
        if (!code) { toast('请先输入邀请码。'); return; }
        e.target.closest('[data-act="adm-claim"]').disabled = true;
        CloudAdmin.claim(code).then(function () {
          adminState.is = true;
          adminState.known = true;
          adminState.uid = db.userId || '';
          applyAdminEntry();
          toast('已启用管理后台。');
          renderAdmin();
        }).catch(function (err) {
          const btn = el.querySelector('[data-act="adm-claim"]');
          if (btn) btn.disabled = false;
          toast(err.message || '启用失败。');
        });
      };
      return;
    }

    el.innerHTML = pageHead('管理后台', '数据概览、内容审核、用户管理与通知公告') +
      '<div class="adm-tabs">' + ADMIN_TABS.map(function (t) {
        return '<button class="adm-tab' + (adminTab === t.key ? ' on' : '') + '" data-adt="' + t.key + '">' + t.label + '</button>';
      }).join('') + '</div>' +
      '<div class="adm-body" id="adminBody"><div class="adm-loading">加载中…</div></div>';

    el.onclick = function (e) {
      const tab = e.target.closest('[data-adt]');
      if (tab) { adminTab = tab.getAttribute('data-adt'); renderAdmin(); return; }

      const kind = e.target.closest('[data-akind]');
      if (kind) {
        adminUI.kind = kind.getAttribute('data-akind');
        adminUI.q = '';
        loadAdminBody();
        return;
      }

      if (e.target.closest('[data-act="adm-search-content"]')) {
        const q = $('#admContentQ');
        adminUI.q = (q && q.value || '').trim();
        loadAdminBody();
        return;
      }

      if (e.target.closest('[data-act="adm-search-users"]')) {
        const q = $('#admUsersQ');
        adminUI.usersQ = (q && q.value || '').trim();
        loadAdminBody();
        return;
      }

      const del = e.target.closest('[data-act="adm-del"]');
      if (del) {
        const kindName = del.getAttribute('data-kind');
        const id = del.getAttribute('data-id');
        const label = { question: '问题', answer: '回答', resource: '资料' }[kindName] || '内容';
        confirmDanger({
          title: '删除这条' + label,
          sub: '删除后无法恢复',
          desc: '删除后，与之相关的回答、点赞、收藏和通知会一并清除，其他用户也将看不到这条内容。',
          ok: '确认删除',
          onOk: function () {
            CloudAdmin.deleteContent(kindName, id).then(function () {
              toast('已删除。');
              loadAdminBody();
              refresh();
            }).catch(function (err) { toast(err.message || '删除失败。'); });
          }
        });
        return;
      }

      const hot = e.target.closest('[data-act="adm-hot"]');
      if (hot) {
        CloudAdmin.toggleHot(hot.getAttribute('data-id')).then(function () {
          toast('已更新热议状态。');
          loadAdminBody();
          refresh();
        }).catch(function (err) { toast(err.message || '操作失败。'); });
        return;
      }

      const du = e.target.closest('[data-act="adm-deluser"]');
      if (du) {
        const uid = du.getAttribute('data-uid');
        const name = du.getAttribute('data-name') || '该用户';
        confirmDanger({
          title: '删除账号「' + name + '」',
          sub: '会同时删除该用户的全部内容',
          desc: '该用户的提问、回答、资料、收藏、点赞和通知都会被永久删除，账号也无法再登录。',
          ok: '确认删除账号',
          onOk: function () {
            CloudAdmin.deleteUser(uid).then(function () {
              toast('账号已删除。');
              loadAdminBody();
              refresh();
            }).catch(function (err) { toast(err.message || '删除失败。'); });
          }
        });
        return;
      }

      if (e.target.closest('[data-act="adm-send"]')) {
        const t = $('#admNoticeTitle');
        const b = $('#admNoticeBody');
        const title = (t && t.value || '').trim();
        const body = (b && b.value || '').trim();
        if (!title) { toast('请填写公告标题。'); if (t) t.focus(); return; }
        confirmDanger({
          title: '发布全站公告',
          sub: '所有已注册用户都会收到',
          desc: '公告标题：' + title + (body ? '\n内容：' + body : ''),
          ok: '确认发布',
          onOk: function () {
            CloudAdmin.broadcast(title, body).then(function (r) {
              toast('已发送给 ' + ((r && r.sent) || 0) + ' 位用户。');
              loadAdminBody();
            }).catch(function (err) { toast(err.message || '发布失败。'); });
          }
        });
        return;
      }
    };

    el.onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      if (e.target && e.target.id === 'admContentQ') {
        adminUI.q = (e.target.value || '').trim();
        loadAdminBody();
      } else if (e.target && e.target.id === 'admUsersQ') {
        adminUI.usersQ = (e.target.value || '').trim();
        loadAdminBody();
      }
    };

    loadAdminBody();
  }

  /* =========================================================
     11. 通用点击绑定
     ========================================================= */

  function bindCommonClicks(e) {
    const login = e.target.closest('[data-act="login"]');
    if (login) { openAuthModal('登录后即可继续操作。'); return; }

    const ask = e.target.closest('[data-act="ask"]');
    if (ask) { openAskModal(); return; }

    const up = e.target.closest('[data-act="upload"]');
    if (up) { openUploadModal(); return; }

    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();
      const type = fav.getAttribute('data-fav');
      const id = Number(fav.getAttribute('data-id'));
      toggleFav(type, id);
      return;
    }

    const vote = e.target.closest('[data-act="vote"]');
    if (vote) { e.stopPropagation(); doVote(Number(vote.getAttribute('data-id'))); return; }

    const rep = e.target.closest('[data-act="reply"]');
    if (rep) {
      e.stopPropagation();
      if (!requireLogin('回复')) return;
      const art = rep.closest('.answer');
      const slot = art && art.querySelector('.reply-slot');
      openReplyComposer(
        slot,
        Number(rep.getAttribute('data-qid')),
        Number(rep.getAttribute('data-parent')),
        rep.getAttribute('data-to') || ''
      );
      return;
    }

    const sendRep = e.target.closest('[data-act="send-reply"]');
    if (sendRep) { e.stopPropagation(); submitReply(sendRep); return; }

    const cancelRep = e.target.closest('[data-act="cancel-reply"]');
    if (cancelRep) {
      e.stopPropagation();
      const slot = cancelRep.closest('.reply-slot');
      if (slot) { slot.removeAttribute('data-open'); slot.innerHTML = ''; }
      return;
    }

    const acc = e.target.closest('[data-act="accept"]');
    if (acc) {
      e.stopPropagation();
      doAccept(Number(acc.getAttribute('data-qid')), Number(acc.getAttribute('data-id')), acc.textContent.indexOf('取消') >= 0);
      return;
    }

    const delA = e.target.closest('[data-act="del-a"]');
    if (delA) {
      e.stopPropagation();
      if (global.confirm('确定删除这条回答吗？删除后无法恢复。')) doDeleteAnswer(Number(delA.getAttribute('data-id')));
      return;
    }

    const delQ = e.target.closest('[data-act="del-q"]');
    if (delQ) {
      e.stopPropagation();
      if (global.confirm('确定删除这个问题吗？其下的回答也会一并删除。')) doDeleteQuestion(Number(delQ.getAttribute('data-id')));
      return;
    }

    const sub = e.target.closest('[data-act="submit-answer"]');
    if (sub) { e.stopPropagation(); submitAnswer(Number(sub.getAttribute('data-id'))); return; }

    const card = e.target.closest('[data-qid]');
    if (card) { go('#/detail/' + card.getAttribute('data-qid')); return; }

    const rcard = e.target.closest('[data-rid]');
    if (rcard) { go('#/resource/' + rcard.getAttribute('data-rid')); return; }
  }

  async function toggleFav(type, id) {
    if (!requireLogin('收藏')) return;
    const on = !Store.hasFavorite(type, id);
    try {
      await CloudData.toggleFavorite(type, id, on);
      await refresh();
      applyRoute();
      toast(on ? '已加入收藏。' : '已取消收藏。');
    } catch (err) {
      toast(err.message || '操作失败。');
    }
  }

  async function doVote(answerId) {
    if (!requireLogin('点赞')) return;
    try {
      await CloudData.toggleVote(answerId);
      await refresh();
      applyRoute();
    } catch (err) {
      toast(err.message || '点赞失败。');
    }
  }

  async function doAccept(questionId, answerId, isCancel) {
    if (!requireLogin('采纳答案')) return;
    try {
      await CloudData.setAcceptedAnswer(questionId, isCancel ? null : answerId);
      await refresh();
      applyRoute();
      toast(isCancel ? '已取消采纳。' : '已采纳该回答。');
    } catch (err) {
      toast(err.message || '操作失败。');
    }
  }

  async function doDeleteAnswer(id) {
    try {
      await CloudData.deleteAnswer(id);
      await refresh();
      applyRoute();
      toast('回答已删除。');
    } catch (err) {
      toast(err.message || '删除失败。');
    }
  }

  async function doDeleteQuestion(id) {
    try {
      await CloudData.deleteQuestion(id);
      await refresh();
      go('#/qa');
      toast('问题已删除。');
    } catch (err) {
      toast(err.message || '删除失败。');
    }
  }

  async function submitAnswer(questionId) {
    if (!requireLogin('回答')) return;
    const ta = $('#answerText');
    const body = (ta && ta.value || '').trim();
    if (!body) { toast('请先写下你的回答。'); return; }
    try {
      await CloudData.insertAnswer({
        question_id: questionId, body: body, author: Store.nickname()
      });
      await refresh();
      applyRoute();
      toast('回答已发布。');
    } catch (err) {
      toast(err.message || '发布失败。');
    }
  }

  /* =========================================================
     12. 弹窗：发起提问 / 上传资料 / 资料详情
     ========================================================= */

  /* 消息通知面板：谁回答了我的哪个问题 */
  function openNoticeModal() {
    if (!Store.signedIn()) {
      toast('登录后即可接收回答提醒。');
      return;
    }
    const list = Store.notifications();
    const unread = Store.unreadCount();
    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal narrow">' +
        '<div class="modal-head">' +
          '<div><h3 class="modal-title">消息通知</h3>' +
          '<p class="modal-sub">' + (unread ? unread + ' 条新消息还没看' : '暂时没有未读消息') + '</p></div>' +
          '<button class="modal-close" data-close="1">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          (list.length
            ? '<div class="notice-list">' + list.map(function (n) {
                return '<button type="button" class="notice-item' + (n.readAt ? '' : ' unread') + '"' +
                  ' data-notice-id="' + n.id + '" data-notice-q="' + (n.questionId || '') + '">' +
                  '<span class="notice-dot" aria-hidden="true"></span>' +
                  '<span class="notice-main">' +
                    '<b>' + esc(n.actorName) +
                      (n.type === 'notice' ? ' 发布了公告' : (n.type === 'reply' ? ' 回复了你的回答' : ' 回答了你的问题')) + '</b>' +
                    '<span class="notice-title">' + esc(n.questionTitle || (n.type === 'notice' ? '' : '（该问题已删除）')) + '</span>' +
                    (n.preview ? '<span class="notice-preview">' + esc(n.preview) + '</span>' : '') +
                  '</span>' +
                  '<span class="notice-time">' + esc(fmtTime(n.createdAt)) + '</span>' +
                '</button>';
              }).join('') + '</div>'
            : emptyBox('还没有收到回答', '发布问题后，有人回答时这里会提醒你')) +
        '</div>' +
        '<div class="modal-foot">' +
          (unread ? '<button class="btn btn-line" data-act="notice-read">全部标为已读</button>' : '') +
          '<button class="btn" data-close="1">知道了</button>' +
        '</div>' +
      '</div>';

    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }

      const item = e.target.closest('[data-notice-q]');
      if (item) {
        const qid = item.getAttribute('data-notice-q');
        markAnswerNoticesRead([item.getAttribute('data-notice-id')]);
        closeModal();
        if (qid) go('#/detail/' + qid);
        return;
      }

      if (e.target.closest('[data-act="notice-read"]')) {
        markAnswerNoticesRead();
        closeModal();
        toast('已全部标为已读。');
      }
    };
  }

  let askFile = null;

  function openAskModal() {
    if (!requireLogin('发布问题')) return;
    const courses = Store.courses();
    askFile = null;
    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal">' +
        '<div class="modal-head">' +
          '<div><h3 class="modal-title">发起提问</h3>' +
          '<p class="modal-sub">选对课程，同专业的同学更容易看到你的问题</p></div>' +
          '<button class="modal-close" data-close="1">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<label class="label" style="margin-top:0">问题标题</label>' +
          '<input class="field" id="askTitle" maxlength="80" placeholder="一句话说清卡在哪里，例如：Dijkstra 算法为什么不能处理负权边？">' +
          '<div class="grid-2">' +
            '<div><label class="label">所属课程</label>' +
              '<select class="field" id="askCourse"><option value="">请选择课程</option>' +
              courses.map(function (c) {
                return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
              }).join('') + '</select></div>' +
            '<div><label class="label">标签（逗号分隔）</label>' +
              '<input class="field" id="askTags" placeholder="例如：算法, 图论"></div>' +
          '</div>' +
          '<label class="label">问题描述</label>' +
          '<textarea class="field" id="askBody" placeholder="把题目、你的尝试、以及具体卡住的步骤写出来，别人更容易帮到你"></textarea>' +
          '<label class="label">题目附件（可选）</label>' +
          attachBoxHtml('ask', {
            hint: '题干截图、PDF、Word、PPT、代码都可以，选中后自动读取内容，单个不超过 20 MB'
          }) +
          '<div id="askError"></div>' +
          '<div id="askHint" class="summary-box" hidden></div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="submit-ask">发布问题</button>' +
          '<button class="btn btn-line" data-act="ai-hint">✨ 先给个思路</button>' +
          '<span class="hint" style="margin:0 auto 0 4px">这里只提示思路，要完整答案去 AI 学习助手</span>' +
        '</div>' +
      '</div>';

    bindAttach('ask', function (f) { askFile = f; });

    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }
      if (e.target.closest('[data-act="submit-ask"]')) { submitQuestion(); return; }
      if (e.target.closest('[data-act="ai-hint"]')) { runAskHint(); return; }
    };
  }

  function askError(msg) {
    const box = $('#askError');
    if (box) box.innerHTML = msg ? '<div class="form-error">' + esc(msg) + '</div>' : '';
  }

  async function runAskHint() {
    const title = ($('#askTitle') || {}).value || '';
    const body = ($('#askBody') || {}).value || '';
    if (!title.trim() && !body.trim() && !askFile) { askError('先写下题目，AI 才能给提示。'); return; }

    const box = $('#askHint');
    box.hidden = false;
    box.classList.add('gen');
    box.textContent = 'AI 正在思考…';
    try {
      let text;
      const extra = (title + '\n' + body).trim();
      let info = { kind: 'none' };
      if (askFile) {
        box.textContent = 'AI 正在读取附件…';
        try {
          info = await extractAttach(askFile);
        } catch (e) {
          info = { kind: 'none', failed: e.message };
        }
      }

      if (info.kind === 'image') {
        box.textContent = 'AI 正在看图…';
        text = await CloudAI.chatWithImage({
          system: '你是大学生学习答疑助手。先看清题目图片，点明考查的知识点，再给 2-3 步思路提示，'
            + '不要直接给出完整答案。如果图片里没有题目、文字看不清或内容不全，就直接说明缺少什么，'
            + '不要自己编一道题。用中文，简洁，总长不超过 180 字。' + ATTACH_RULE,
          user: '【题目' + (info.scanned ? '（扫描版 PDF 前几页）' : '图片') + '：' + askFile.name + '】\n'
            + '【我的补充】\n' + (extra || '（没有额外补充，请直接看图）'),
          images: info.images,
          temperature: 0.6,
          onDelta: function (chunk, full) { box.textContent = full; }
        });
      } else {
        const head = askFile
          ? '【题目附件：' + askFile.name + '】\n' + (info.kind === 'text' && info.text
              ? String(info.text).trim()
              : '（' + (info.failed || '这个附件没有可用文字') + '）') + '\n\n'
          : '';
        text = await CloudAI.hint(head + '题目：' + title + '\n\n补充：' + body, function (chunk, full) {
          box.textContent = full;
        });
      }
      box.textContent = text;
      CloudData.saveAiSession({
        tool: 'chat',
        prompt: ((title + ' ' + body) || (askFile ? askFile.name : '')).slice(0, 2000),
        output: text.slice(0, 4000)
      })
        .catch(function () {});
    } catch (err) {
      box.textContent = '';
      box.hidden = true;
      askError(err.message || 'AI 提示失败。');
    }
  }

  async function submitQuestion() {
    const title = (($('#askTitle') || {}).value || '').trim();
    const body = (($('#askBody') || {}).value || '').trim();
    const courseId = Number((($('#askCourse') || {}).value || '0')) || null;
    const tagsRaw = (($('#askTags') || {}).value || '').trim();

    if (title.length < 5) { askError('标题至少 5 个字，说清卡在哪里。'); return; }
    if (body.length < 10) { askError('描述至少 10 个字，写清题目和你的尝试。'); return; }
    if (askFile) {
      const bad = CloudData.validateFile(askFile);
      if (bad) { askError(bad); return; }
    }

    const course = courseId ? Store.course(courseId) : null;
    const tags = tagsRaw ? tagsRaw.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 5) : [];

    const btn = document.querySelector('[data-act="submit-ask"]');
    const setBtn = function (text, disabled) {
      if (!btn) return;
      btn.textContent = text;
      btn.disabled = !!disabled;
    };

    try {
      const row = {
        title: title,
        body: body,
        course: course ? course.name : '通识',
        course_id: courseId,
        tags: tags,
        author: Store.nickname()
      };

      // 附件先传云端，再把路径写进问题记录；失败则不发布，避免半成品问题
      if (askFile) {
        setBtn('正在上传附件…', true);
        const path = CloudData.buildPath(db.userId, askFile.name, 'qa');
        await CloudData.uploadFile(path, askFile);
        row.file_path = path;
        row.file_name = askFile.name;
        row.file_size = askFile.size;
        setBtn('正在发布…', true);
      }

      await CloudData.insertQuestion(row);
      await refresh();
      closeModal();
      go('#/qa');
      toast(askFile ? '问题与附件已发布，等待同学回答。' : '问题已发布，等待同学回答。');
    } catch (err) {
      setBtn('发布问题', false);
      askError(err.message || '发布失败。');
    }
  }

  let uploadFile = null;

  function openUploadModal() {
    if (!requireLogin('上传资料')) return;
    const courses = Store.courses();
    uploadFile = null;

    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal">' +
        '<div class="modal-head">' +
          '<div><h3 class="modal-title">上传学习资料</h3>' +
          '<p class="modal-sub">支持 PDF、Word、PPT 等格式，单个文件不超过 20MB</p></div>' +
          '<button class="modal-close" data-close="1">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<label class="label" style="margin-top:0">资料标题</label>' +
          '<input class="field" id="upTitle" maxlength="80" placeholder="例如：高数 A · 极限与导数知识图谱">' +
          '<div class="grid-2">' +
            '<div><label class="label">所属课程</label>' +
              '<select class="field" id="upCourse"><option value="">请选择课程</option>' +
              courses.map(function (c) {
                return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
              }).join('') + '</select></div>' +
            '<div><label class="label">资料分类</label>' +
              '<select class="field" id="upCategory">' +
              RES_CATS.concat(['精选推荐']).map(function (t) {
                return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
              }).join('') + '</select></div>' +
          '</div>' +
          '<label class="label">选择文件</label>' +
          '<div class="file-drop" id="fileDrop">' +
            '<div class="file-drop-info">' +
              '<div class="file-drop-name" id="fileName">还没有选择文件</div>' +
              '<div class="file-drop-size" id="fileSize">支持 pdf / doc / ppt / xls / zip / 图片 / 代码</div>' +
            '</div>' +
            '<label class="file-pick">选择文件<input type="file" id="fileInput"></label>' +
          '</div>' +
          '<label class="label">资料简介</label>' +
          '<textarea class="field" id="upDesc" placeholder="简单说明资料内容、涵盖章节，AI 会据此生成摘要"></textarea>' +
          '<label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px">' +
            '<input type="checkbox" id="upAi" checked> 上传后自动生成 AI 摘要' +
          '</label>' +
          '<div id="upError"></div>' +
          '<div id="upSummary" class="summary-box" hidden></div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="submit-upload" id="upSubmit">提交</button>' +
          '<span class="hint" style="margin:0">文件会存到云端，同学可下载</span>' +
        '</div>' +
      '</div>';

    $('#fileInput').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      uploadFile = f || null;
      const drop = $('#fileDrop');
      if (!f) {
        $('#fileName').textContent = '还没有选择文件';
        $('#fileSize').textContent = '支持 pdf / doc / ppt / xls / zip / 图片 / 代码';
        drop.classList.remove('has-file');
        return;
      }
      $('#fileName').textContent = f.name;
      $('#fileSize').textContent = fmtSize(f.size);
      drop.classList.add('has-file');
      const t = $('#upTitle');
      if (t && !t.value.trim()) {
        t.value = f.name.replace(/\.[^.]+$/, '');
      }
    });

    root.onclick = function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }
      if (e.target.closest('[data-act="submit-upload"]')) submitUpload();
    };
  }

  function upError(msg) {
    const box = $('#upError');
    if (box) box.innerHTML = msg ? '<div class="form-error">' + esc(msg) + '</div>' : '';
  }

  async function submitUpload() {
    const title = (($('#upTitle') || {}).value || '').trim();
    const courseId = Number((($('#upCourse') || {}).value || '0')) || null;
    const category = (($('#upCategory') || {}).value || '精选推荐');
    const desc = (($('#upDesc') || {}).value || '').trim();
    const wantAi = ($('#upAi') || {}).checked;

    if (title.length < 3) { upError('资料标题至少 3 个字。'); return; }
    if (!uploadFile) { upError('请选择要上传的文件。'); return; }

    const bad = CloudData.validateFile(uploadFile);
    if (bad) { upError(bad); return; }

    const course = courseId ? Store.course(courseId) : null;
    const btn = $('#upSubmit');
    const summaryBox = $('#upSummary');

    try {
      btn.disabled = true;
      btn.textContent = '正在上传…';

      const path = CloudData.buildPath(db.userId, uploadFile.name);
      await CloudData.uploadFile(path, uploadFile);

      btn.textContent = '正在保存…';
      const row = {
        title: title,
        description: desc,
        course: course ? course.name : '通识',
        course_id: courseId,
        category: category,
        type: category,
        file_path: path,
        file_name: uploadFile.name,
        file_size: uploadFile.size,
        author: Store.nickname()
      };
      const saved = await CloudData.insertResource(row);

      // AI 摘要：上传成功后异步生成，失败不影响资料本身
      if (wantAi && CloudAI && CloudAI.ready()) {
        btn.textContent = '正在生成 AI 摘要…';
        summaryBox.hidden = false;
        summaryBox.classList.add('gen');
        summaryBox.textContent = 'AI 正在阅读这份资料…';
        try {
          const prompt = [
            '资料标题：' + title,
            '所属课程：' + (course ? course.name : '通识'),
            '资料分类：' + category,
            '文件格式：' + (extOf(uploadFile.name) || '未知').toUpperCase() + '，' + fmtSize(uploadFile.size),
            desc ? '上传者说明：' + desc : '上传者未填写说明'
          ].join('\n');
          const rawText = await CloudAI.summarize(prompt, function (chunk, full) {
            summaryBox.textContent = full;
          });
          const text = normalizeSummary(rawText);
          summaryBox.textContent = text;
          await CloudData.updateResourceSummary(saved.id, text);
        } catch (aiErr) {
          summaryBox.textContent = 'AI 摘要生成失败：' + (aiErr.message || '请稍后重试');
          summaryBox.classList.remove('gen');
        }
      }

      await refresh();
      closeModal();
      go('#/resources');
      toast('资料已上传' + (wantAi ? '，AI 摘要已生成。' : '。'));
    } catch (err) {
      upError(err.message || '上传失败。');
      btn.disabled = false;
      btn.textContent = '提交';
    }
  }

  function openResourceModal(id) {
    const r = Store.resource(id);
    if (!r) return;
    const faved = Store.hasFavorite('resource', r.id);
    const root = $('#modalRoot');
    root.hidden = false;

    const meta = [
      r.course || null,
      r.pageCount ? r.pageCount + ' 页' : null,
      r.size ? fmtSize(r.size) : null,
      r.downloads + ' 次浏览',
      fmtTime(r.createdAt)
    ].filter(Boolean).join(' · ');

    const hasFile = !!r.filePath;
    root.innerHTML =
      '<div class="modal">' +
        '<div class="modal-head">' +
          '<div><h3 class="modal-title">' + esc(r.title) + '</h3>' +
          '<p class="modal-sub">' + esc(meta) + '</p></div>' +
          '<button class="modal-close" data-close="1">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          (r.description ? '<p style="margin:0 0 12px;font-size:13.5px;color:#33445c">' + esc(r.description) + '</p>' : '') +
          '<div class="summary-box' + (r.aiReady ? ' gen' : '') + '" id="resSummary">' +
            (r.aiReady && r.summary ? esc(r.summary)
              : (hasFile ? '这份资料还没有 AI 摘要。' : '这是一条示例记录，没有关联文件。')) +
          '</div>' +
        '</div>' +
        '<div class="modal-foot">' +
          (hasFile
            ? '<button class="btn" data-act="download" data-id="' + r.id + '">⬇ 下载资料</button>'
            : '<button class="btn" disabled>暂无文件</button>') +
          (r.aiReady
            ? '<button class="btn btn-line" data-act="regen">重新生成摘要</button>'
            : '<button class="btn btn-line" data-act="regen">生成 AI 摘要</button>') +
          '<button class="btn btn-line' + (faved ? ' on' : '') + '" data-act="fav-res" data-id="' + r.id + '">' +
            favIco() + (faved ? '已收藏' : '收藏') + '</button>' +
        '</div>' +
      '</div>';

    root.onclick = async function (e) {
      if (e.target === root || e.target.closest('[data-close]')) { closeModal(); return; }

      if (e.target.closest('[data-act="fav-res"]')) { toggleFav('resource', r.id); return; }

      if (e.target.closest('[data-act="download"]')) {
        if (!requireLogin('下载资料')) return;
        try {
          const url = await CloudData.getDownloadUrl(r.filePath, 600);
          if (!url) { toast('无法生成下载链接，请稍后重试。'); return; }
          global.open(url, '_blank', 'noopener');
          await CloudData.bumpResourceDownload(r.id);
          await refresh();
          toast('已开始下载。');
        } catch (err) {
          toast(err.message || '下载失败。');
        }
        return;
      }

      if (e.target.closest('[data-act="regen"]')) {
        if (!requireLogin('生成摘要')) return;
        const box = $('#resSummary');
        box.classList.add('gen');
        box.textContent = 'AI 正在阅读这份资料…';
        try {
          const prompt = [
            '资料标题：' + r.title,
            '所属课程：' + (r.course || '通识'),
            '资料分类：' + r.category,
            r.description ? '上传者说明：' + r.description : '上传者未填写说明',
            r.size ? '文件大小：' + fmtSize(r.size) : ''
          ].filter(Boolean).join('\n');
          const text = await CloudAI.summarize(prompt, function (chunk, full) { box.textContent = full; });
          // 非上传者也能生成（只读展示），但只有上传者本人能写回
          let persisted = false;
          try {
            await CloudData.updateResourceSummary(r.id, text);
            persisted = true;
          } catch (e) { /* 忽略：留给本地展示 */ }
          box.textContent = text;
          if (persisted) {
            await refresh();
            box.classList.add('gen');
            toast('AI 摘要已更新。');
          } else {
            toast('摘要已生成（仅本次可见，资料上传者可保存）。');
          }
        } catch (err) {
          box.textContent = '生成失败：' + (err.message || '请稍后重试');
          toast(err.message || '生成失败。');
        }
        return;
      }
    };
  }

  function closeModal() {
    const root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
    root.onclick = null;
    root.onkeydown = null;
    stopCountdown();
    uploadFile = null;
  }

  /* =========================================================
     13. 初始化
     ========================================================= */

  function showCloudNotice(msg) {
    const el = $('#cloudNotice');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg ? humanize(msg) : '';
  }

  async function init() {
    // 微信回调必须最先处理，且要无条件调用
    let callback = { session: null, error: null };
    try {
      callback = await CloudAuth.handleWechatCallback();
    } catch (e) {
      callback = { session: null, error: '微信登录回调处理失败，请重新登录。' };
    }
    if (callback.error) toast(callback.error);
    if (callback.session) {
      history.replaceState(null, '', location.pathname + location.hash);
    }

    // cloud.js 一定已执行，真正能判断 SDK 是否可用的是 CloudAuth.enabled
    if (!global.CloudAuth || !global.CloudAuth.enabled) {
      showCloudNotice(
        (global.CloudAuth && global.CloudAuth.initError) ||
        '云端 SDK 未能加载，页面只展示本地缓存内容。请检查网络后刷新。'
      );
    }

    // 会话兜底
    let session = callback.session;
    if (!session) {
      const s = await CloudAuth.getSession();
      session = s.session;
    }

    authState.session = session || null;
    db.userId = session && session.user ? session.user.id : null;

    try {
      if (db.userId) {
        await refresh();
        if (!db.hasProfile) {
          await CloudData.saveNickname(db.userId, defaultNickname());
          await refresh();
        }
      } else {
        await refresh();
      }
    } catch (e) {
      showCloudNotice(e.message || '数据加载失败，请检查网络后刷新。');
    }

    if (db.userId) await loadAccountProfile();

    renderAuthArea();
    applyRoute();

    // 路由与全局事件
    global.addEventListener('hashchange', applyRoute);

    // 侧栏链接指向当前页时，hash 不变就不会触发 hashchange，
    // 这里手动重渲染一次，保证点「课程问答」能把筛选复位。
    document.addEventListener('click', function (e) {
      const link = e.target.closest('a[data-page]');
      if (!link) return;
      if (location.hash === '#/' + link.getAttribute('data-page')) {
        e.preventDefault();
        applyRoute();
      }
    });

    const notice = $('#btnNotice');
    if (notice) {
      notice.addEventListener('click', function () { openNoticeModal(); });
    }

    const search = $('#globalSearch');
    if (search) {
      search.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        const kw = String(search.value || '').trim();
        if (!kw) { go('#/qa'); return; }
        search.blur();
        go('#/search/' + encodeURIComponent(kw));
      });
      document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
          e.preventDefault();
          search.focus();
        }
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeModal();
        closeMenu();
        closeMobileNav();
        document.body.classList.remove('searching');
      }
    });

    // 导航计数：点击逻辑在模块加载时已委托到 document，这里只同步显示
    applyNavBadge();
    initMobileNav();
    initMobileSearch();
    startNoticePolling();
  }

  document.addEventListener('DOMContentLoaded', function () {
    init().catch(function (e) {
      toast('初始化失败：' + (e && e.message ? e.message : '未知原因'));
    });
  });

})(window);
