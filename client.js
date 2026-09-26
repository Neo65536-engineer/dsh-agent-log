/**
 * dsh-agent-log —— 客户端（浏览器侧）插件。
 *
 * 在右侧 Sidebar 里加一个「Agent 工作报告」页签。
 *
 * 契约要点（逐条对照 0.1.7-rc.1 的真实实现确认）：
 *  - 浏览器侧产物必须自注册进 window.__ModuleLoader__，id 等于包名，
 *    React 由 factory 作用域的 require('react') 提供。
 *  - 两阶段注册：先 sidebarRightTabs.register（静态声明，guide 条目必须带 id），
 *    再 slots.register 到 'sidebar.right.pane.tab'（正文），key = 定义的 id。
 *  - 样式只用主题 token（dsw 别名变量），不写字面色值。
 *  - 不 require 任何 @deepseek-ai/* 客户端包。
 *
 * ⚠️ 数据路径：路由返回 { sessionId, title, totals, diagnostics, record }，
 *    **轮次在 `record.turns`，不在顶层**。这里用 `unwrap()` 兼容两种形状，
 *    并且 test/panel-data-check.mjs 会用真实 payload 断言各页签非空 ——
 *    这个 bug 曾经让「失败」「轮次」两个页签恒为空。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-log',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ID = 'dsh-agent-log'
    const KIND = 'worklog'
    const ROUTE = '/plugins/dsh-agent-log/report'

    // ------------------------------------------------------------ 样式
    const CSS = `
.worklog-root{display:flex;flex-direction:column;height:100%;min-height:0;
  font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:var(--dsw-font-xxs-12-line-height,1.5);
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);}
.worklog-bar{display:flex;align-items:center;gap:4px;flex:0 0 auto;flex-wrap:wrap;
  padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);}
/* 操作栏：品牌色描边 + 图标，刻意与下面的页签栏区分开（用户要求"更显眼"） */
.worklog-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap;
  padding:6px 8px;background:var(--dsw-alias-bg-layer-1);
  border-bottom:1px solid var(--dsw-alias-border-l3);}
.worklog-act{appearance:none;display:inline-flex;align-items:center;gap:4px;
  font:inherit;font-weight:600;cursor:pointer;white-space:nowrap;
  border:1px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-corner-shape,4px);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-brand-primary);
  padding:3px 9px;}
.worklog-act:hover{background:var(--dsw-alias-interactive-bg-hover);}
.worklog-act[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.worklog-act:disabled{opacity:.45;cursor:default;}
.worklog-ico{font-size:1.05em;line-height:1;font-weight:400;}
.worklog-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border-radius:var(--dsw-corner-shape,4px);padding:2px 7px;font:inherit;cursor:pointer;
  white-space:nowrap;}
.worklog-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.worklog-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active);
  border-color:var(--dsw-alias-border-l3);}
.worklog-body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px;}
.worklog-h{font-weight:600;margin:12px 0 4px;color:var(--dsw-alias-label-primary);}
.worklog-h:first-child{margin-top:0;}
.worklog-grid{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:2px 8px;margin:0 0 10px;}
.worklog-grid dt{color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.worklog-grid dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}
.worklog-row{display:flex;align-items:baseline;gap:6px;padding:3px 0;
  border-bottom:1px solid var(--dsw-alias-border-l2);}
.worklog-row:last-child{border-bottom:none;}
.worklog-name{flex:0 0 auto;min-width:56px;
  font-family:var(--dsw-font-markdown-code-font-family,monospace);}
.worklog-main{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}
.worklog-num{flex:0 0 auto;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary);}
.worklog-time{flex:0 0 auto;font-variant-numeric:tabular-nums;font-size:.92em;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.worklog-bar-track{flex:0 0 48px;height:6px;border-radius:3px;
  background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.worklog-bar-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);opacity:.55;}
.worklog-ok{color:var(--dsw-alias-state-success-primary);}
.worklog-bad{color:var(--dsw-alias-state-error-primary);}
.worklog-warn{color:var(--dsw-alias-state-warn-primary);}
.worklog-item{padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l2);}
.worklog-item:last-child{border-bottom:none;}
.worklog-meta{color:var(--dsw-alias-label-secondary);}
.worklog-code{display:block;font-family:var(--dsw-font-markdown-code-font-family,monospace);
  background:var(--dsw-alias-markdown-inline-code);border-radius:3px;padding:2px 5px;
  margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere;}
.worklog-path{font-family:var(--dsw-font-markdown-code-font-family,monospace);
  overflow-wrap:anywhere;word-break:break-all;}
.worklog-empty{padding:16px 8px;text-align:center;color:var(--dsw-alias-label-secondary);}
.worklog-err{padding:8px;border-radius:var(--dsw-corner-shape,4px);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);
  overflow-wrap:anywhere;}
.worklog-sub{display:flex;gap:4px;padding:0 0 6px;}
.worklog-sub .worklog-btn{font-size:.95em;padding:1px 6px;}
.worklog-note{padding:6px 8px;margin:0 0 8px;border-radius:var(--dsw-corner-shape,4px);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  overflow-wrap:anywhere;}
.worklog-stale{padding:6px 8px;margin:0 0 8px;border-radius:var(--dsw-corner-shape,4px);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warn-primary);
  overflow-wrap:anywhere;}
.worklog-task{padding:6px 8px;margin:0 0 8px;border-radius:var(--dsw-corner-shape,4px);
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  white-space:pre-wrap;overflow-wrap:anywhere;}
.worklog-sel{flex:1 1 120px;min-width:0;max-width:100%;font:inherit;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-corner-shape,4px);
  padding:2px 4px;}
/* ⚠️ 必须是 flex:0 0 auto —— 曾经写成 flex:1 1 100%，在竖排 flex 容器里它会撑满剩余高度，
   把页签栏一路挤到底部、中间留出一大片空白（真机截图上立刻可见）。 */
.worklog-who{flex:0 0 auto;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;
  padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.worklog-dl{flex:0 0 auto;color:var(--dsw-alias-state-success-primary);
  padding:3px 8px;overflow-wrap:anywhere;} 
`

    function StyleOnce() {
      return h('style', { 'data-dsh-agent-log': '' }, CSS)
    }

    // ------------------------------------------------------------ 工具函数
    const fmt = (x) => (x ?? 0).toLocaleString('en-US')
    /** session-3b21b705-… → 3b21b705（直接 slice(0,8) 只会得到 "session-"） */
    const shortId = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 8) || '未知'
    /** 多行命令压成一行，便于辨认到底跑的是什么（宿主 core/collect.mjs 里同规则） */
    const flattenCommand = (cmd, width = 120) => {
      const s = String(cmd ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ; ')
      return s.length > width ? `${s.slice(0, width)}…` : s
    }
    /** 判定依据的中文说明：让用户知道「通过」是怎么得出来的 */
    const basisLabel = (b) =>
      b === 'output-fail' ? '依据：输出里的失败标记'
      : b === 'output-pass' ? '依据：输出里的通过汇总'
      : b === 'exit-code' ? '依据：命令退出码'
      : '依据：无（无法判定）'
    const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')
    const ms = (v) => {
      if (!v) return '0s'
      const s = Math.round(v / 1000)
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m}m${s % 60}s`
      return `${Math.floor(m / 60)}h${m % 60}m`
    }
    /** 时间戳 → HH:MM:SS（本地） */
    const hms = (t) => {
      if (typeof t !== 'number') return '—'
      const d = new Date(t)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    /** 时间戳 → MM-DD HH:MM */
    const mdhm = (t) => {
      if (typeof t !== 'number') return '—'
      const d = new Date(t)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    /**
     * 兼容两种 payload 形状：顶层直接给 turns，或嵌在 record 里。
     * 路由目前是后者 —— 读错路径会让页签恒为空。
     */
    function unwrap(d) {
      if (!d) {
        return { totals: null, turns: [], title: null, sessionId: null, resolvedBy: null, diagnostics: null }
      }
      return {
        totals: d.totals ?? null,
        turns: d.turns ?? d.record?.turns ?? [],
        title: d.title ?? null,
        sessionId: d.sessionId ?? null,
        resolvedBy: d.resolvedBy ?? d.diagnostics?.resolvedBy ?? null,
        diagnostics: d.diagnostics ?? null,
        scope: d.scope ?? d.record?.scope ?? null,
      }
    }

    // ------------------------------------------------------------ 通用小件
    function StatRow({ name, value, max, extra, at }) {
      return h('div', { className: 'worklog-row' }, [
        h('span', { className: 'worklog-name', key: 'n' }, name),
        h('span', { className: 'worklog-bar-track', key: 't' },
          h('span', { className: 'worklog-bar-fill',
            style: { width: max > 0 ? `${Math.min(100, (value / max) * 100)}%` : '0%' } })),
        h('span', { className: 'worklog-num', key: 'v' }, fmt(value)),
        extra ? h('span', { className: 'worklog-meta', key: 'e' }, extra) : null,
        at ? h('span', { className: 'worklog-time', key: 'a' }, at) : null,
      ])
    }

    function Dl({ pairs }) {
      const kids = []
      pairs.forEach(([k, v], i) => {
        kids.push(h('dt', { key: `k${i}` }, k))
        kids.push(h('dd', { key: `v${i}` }, v))
      })
      return h('dl', { className: 'worklog-grid' }, kids)
    }

    /**
     * 动态生成一份可下载的《本次 Agent 工作报告》。
     *
     * 文档由宿主侧生成（core/html.mjs / render.mjs），前端只负责"取回来 + 存盘"：
     * 这样离线、面板、工具三条路径拿到的报告永远是同一份，不会两边渲染规则漂移。
     * kind: 'html'（自包含、可直接打开或打印成 PDF）| 'markdown'
     */
    function downloadReport(sessionId, kind) {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        return Promise.reject(new Error('当前环境不支持下载（没有 DOM）'))
      }
      const q = [`format=${kind}`]
      if (sessionId) q.push(`sessionId=${encodeURIComponent(sessionId)}`)
      return fetch(`${ROUTE}?${q.join('&')}`).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = await r.text()
        // 文件名里的时间戳必须是**本地**时间：早先用 toISOString()（UTC），
        // 用户在 20:30 下载到的文件却叫 ...T1230，和自己的时钟对不上。
        const stamp = (() => {
          const d = new Date()
          const p = (n) => String(n).padStart(2, '0')
          return (
            `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T` +
            `${p(d.getHours())}${p(d.getMinutes())}`
          )
        })()
        const ext = kind === 'html' ? 'html' : 'md'
        const name = `本次Agent工作报告-${shortId(sessionId)}-${stamp}.${ext}`
        const blob = new Blob([body], {
          type: kind === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
        return name
      })
    }

    // ------------------------------------------------------------ 面板
    function WorklogPanel(props) {
      /**
       * 框架把「会话标准工具包」当 props 传进来（与已发布的文件面板同一个约定：
       * `function FilesBody({ useTabInfo, sessionId, ... })`）。
       * **必须带上它请求数据**：路由在不给 sessionId 时会退回「最近被改动的会话」，
       * 并发会话（子代理 / 另一个窗口）会让面板显示成别人的会话 —— 实测踩过。
       */
      const ownSessionId = props?.sessionId ?? null

      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [tab, setTab] = React.useState('overview')
      const [fileTab, setFileTab] = React.useState('modified')
      const [nonce, setNonce] = React.useState(0)
      const [pick, setPick] = React.useState('')
      const [sessions, setSessions] = React.useState([])
      const [auto, setAuto] = React.useState(true)
      const [dl, setDl] = React.useState('')

      const target = pick || ownSessionId

      const onDownload = (kind) => {
        setDl('生成中…')
        downloadReport(target, kind)
          .then((name) => {
            setDl(`✓ 已下载 ${name}`)
            // 只是一条操作反馈，自动消失，避免长驻在标题下面（用户反馈过）
            if (typeof document !== 'undefined') setTimeout(() => setDl(''), 4000)
          })
          .catch((e) => setDl(`下载失败：${String(e?.message ?? e)}`))
      }

      React.useEffect(() => {
        let alive = true
        const ac = new AbortController()
        setState((s) => ({ ...s, status: 'loading' }))
        const q = target ? `?format=json&sessionId=${encodeURIComponent(target)}` : '?format=json'
        fetch(`${ROUTE}${q}`, { signal: ac.signal })
          .then(async (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json()
          })
          .then((data) => { if (alive) setState({ status: 'ready', data, error: null }) })
          .catch((e) => {
            if (alive && e?.name !== 'AbortError') {
              setState({ status: 'error', data: null, error: String(e?.message ?? e) })
            }
          })
        return () => { alive = false; ac.abort() }
      }, [nonce, target])

      // 会话选择器：拉一次最近会话列表（失败不影响主视图）
      React.useEffect(() => {
        let alive = true
        const ac = new AbortController()
        fetch(`${ROUTE}?list=1`, { signal: ac.signal })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (alive && d?.sessions) setSessions(d.sessions) })
          .catch(() => {})
        return () => { alive = false; ac.abort() }
      }, [nonce])

      // 自动刷新：报告是「边写边读」的快照，面板开着不动会一直停在旧数据上。
      // 只在真实浏览器环境里轮询：非 DOM 环境（离线渲染/测试替身）不装定时器，
      // 否则会拖住宿主进程退出。
      React.useEffect(() => {
        if (!auto) return undefined
        if (typeof document === 'undefined' || typeof document.visibilityState !== 'string') return undefined
        const t = setInterval(() => {
          if (document.visibilityState === 'visible') setNonce((n) => n + 1)
        }, 15000)
        return () => clearInterval(t)
      }, [auto])

      const view = unwrap(state.data)
      const T = view.totals
      const stale = view.diagnostics?.freshness?.stale ? view.diagnostics.freshness : null

      // 顶部是「操作栏」，和下面的「页签栏」刻意做成两种视觉：
      // 操作栏 = 品牌色描边的图标按钮（强调"动作"），页签栏 = 中性 pill（强调"位置"）。
      const header = h('div', { className: 'worklog-actions', key: 'hdr' }, [
        h('button', {
          key: 'r', className: 'worklog-act',
          onClick: () => setNonce((n) => n + 1),
          title: '重新读取会话日志',
        }, [h('span', { key: 'i', className: 'worklog-ico' }, '↻'), '刷新']),
        h('button', {
          key: 'a', className: 'worklog-act',
          'aria-pressed': auto ? 'true' : 'false',
          onClick: () => setAuto((v) => !v),
          title: '每 15 秒自动刷新（报告是快照，会随对话继续变化）',
        }, [h('span', { key: 'i', className: 'worklog-ico' }, auto ? '❙❙' : '▶'), auto ? '自动' : '手动']),
        h('button', {
          key: 'dh', className: 'worklog-act',
          disabled: state.status === 'loading' && !state.data,
          onClick: () => onDownload('html'),
          title: '把这份报告存成自包含 HTML 文档（可直接打开、可打印成 PDF）',
        }, [h('span', { key: 'i', className: 'worklog-ico' }, '⤓'), 'HTML']),
        h('button', {
          key: 'dm', className: 'worklog-act',
          disabled: state.status === 'loading' && !state.data,
          onClick: () => onDownload('markdown'),
          title: '把这份报告存成 Markdown 文件',
        }, [h('span', { key: 'i', className: 'worklog-ico' }, '⤓'), 'MD']),
        h('select', {
          key: 'sel', className: 'worklog-sel',
          value: pick || ownSessionId || '',
          onChange: (e) => setPick(e.target.value),
          title: '选择要复盘的会话',
        }, [
          ownSessionId
            ? h('option', { key: 'own', value: ownSessionId }, `本会话 ${shortId(ownSessionId)}`)
            : h('option', { key: 'none', value: '' }, '（未指定会话）'),
          ...sessions
            .filter((s) => s.sessionId !== ownSessionId)
            .map((s) => h('option', { key: s.sessionId, value: s.sessionId },
              `${shortId(s.sessionId)} · ${String(s.title ?? '(无标题)').slice(0, 18)}`)),
        ]),
      ])

      // 只显示对话名（标题），不显示 session id —— 用户明确要求。
      // 「未指定会话」这种真需要注意的情况仍然显式标出来。
      const who = view.sessionId
        ? h('div', { className: 'worklog-who', key: 'who' }, [
            h('span', { key: 't' }, view.title ? String(view.title) : '(无标题会话)'),
            h('span', { key: 'r' }, view.resolvedBy === 'newest' ? ' · ⚠️ 未指定会话，按「最近活跃」选取' : ''),
          ].filter(Boolean))
        : null

      const staleBar = stale
        ? h('div', { className: 'worklog-stale', key: 'stale' },
            `⚠️ 宿主加载的是旧版插件模块（${new Date(stale.loadedAt).toLocaleTimeString()}），` +
            `磁盘上更新的文件：${(stale.newer ?? []).map((n) => n.file).join('、')}。` +
            `这会让「工具 / 命令 / 文件」页签恒为空。请重启 DSH。`)
        : null

      const dlNote = dl ? h('div', { className: 'worklog-dl', key: 'dl' }, dl) : null

      if (state.status === 'loading' && !T) {
        return h('div', { className: 'worklog-root' }, [h(StyleOnce, { key: 's' }), header, who, dlNote,
          h('div', { className: 'worklog-empty', key: 'b' }, '正在解析会话日志…')])
      }
      if (state.status === 'error') {
        return h('div', { className: 'worklog-root' }, [h(StyleOnce, { key: 's' }), header, who, dlNote,
          h('div', { className: 'worklog-body', key: 'b' },
            h('div', { className: 'worklog-err' }, `读取失败：${state.error}`))])
      }
      if (!T) {
        return h('div', { className: 'worklog-root' }, [h(StyleOnce, { key: 's' }), header, who, dlNote,
          h('div', { className: 'worklog-empty', key: 'b' }, '这个会话还没有可复盘的内容。')])
      }
      const TABS = [
        ['overview', '总览'],
        ['tools', `工具 ${(T.toolDetail ?? []).length}`],
        ['commands', `命令 ${T.commands}`],
        ['files', `文件 ${T.uniqueFilesTouched}`],
        ['tests', `测试 ${T.tests}`],
        ['fails', `失败 ${T.failures}`],
        ['turns', `轮次 ${T.turns}`],
      ]
      const tabBar = h('div', { className: 'worklog-bar', key: 'tabs' },
        TABS.map(([k, label]) =>
          h('button', {
            key: k, className: 'worklog-btn',
            'aria-pressed': tab === k ? 'true' : 'false',
            onClick: () => setTab(k),
          }, label)))

      let bodyEl
      if (tab === 'tools') bodyEl = Tools(T)
      else if (tab === 'commands') bodyEl = Commands(T)
      else if (tab === 'files') bodyEl = Files(T, fileTab, setFileTab)
      else if (tab === 'tests') bodyEl = Tests(T)
      else if (tab === 'fails') bodyEl = Fails(view)
      else if (tab === 'turns') bodyEl = Turns(view)
      else bodyEl = Overview(T, view)

      return h('div', { className: 'worklog-root' }, [
        h(StyleOnce, { key: 's' }),
        header,
        who,
        staleBar,
        dlNote,
        tabBar,
        h('div', { className: 'worklog-body', key: 'b' }, bodyEl),
      ])
    }

    // ------------------------------------------------------------ 总览
    function Overview(T, view) {
      const done = T.completed + T.aborted + T.interrupted
      const first = view.turns[0]?.startedAt
      const last = view.turns[view.turns.length - 1]?.endedAt
      const inProgress = view.turns.some((t) => !t.endedAt)
      const task = String(view.turns[0]?.prompt ?? '').trim()
      return h(React.Fragment, null, [
        h('div', { className: 'worklog-h', key: 'h' }, '本次任务'),
        task ? h('div', { className: 'worklog-task', key: 'task' },
          task.length > 800 ? `${task.slice(0, 800)}…` : task) : null,
        view.scope
          ? h('div', { className: 'worklog-warn', key: 'scope' },
              `⚠️ 本报告只统计最近 ${view.scope.shown} 轮（会话共 ${view.scope.total} 轮）：` +
              `总览与各页签都按这 ${view.scope.shown} 轮重算。`)
          : null,
        h('div', { className: 'worklog-note', key: 'idx' },
          '九项速查：任务（本页）· 用了哪些工具（工具页）· 读了哪些文件 / 改了哪些文件（文件页的两个子页签）· ' +
          '运行了哪些命令（命令页）· 测试是否通过（测试页）· 失败过几次（失败页）· Token 与「最终有没有完成」（本页）'),
        h(Dl, {
          key: 'dl',
          pairs: [
            ['结论', T.turns === 0
              ? h('span', { className: 'worklog-warn' }, '还没有任务轮次')
              : T.finished
                ? h('span', { className: 'worklog-ok' }, '全部完成')
                : h('span', { className: 'worklog-warn' }, inProgress ? '有未完成轮次（进行中）' : '有未完成轮次')],
            ['起止', `${mdhm(first)} → ${inProgress ? '进行中' : mdhm(last)}`],
            ['任务轮次', fmt(T.turns)],
            ['执行步数', fmt(T.steps)],
            ['工具调用', fmt(T.toolCalls)],
            ['命令执行', fmt(T.commands)],
            ['失败次数', h('span', { className: T.failures ? 'worklog-bad' : 'worklog-ok' }, fmt(T.failures))],
            ['疑似失败', fmt(T.suspects)],
            ['测试', `${T.tests}（通过 ${T.testsPassed} / 失败 ${T.testsFailed}）`],
            ['读文件', fmt(T.filesRead)],
            ['写/改文件', `${T.filesWritten} + ${T.filesEdited}`],
            ['输入 Token（未缓存）', fmt(T.inputTokens)],
            ['输出 Token', fmt(T.outputTokens)],
            ['缓存读取 Token', fmt(T.cacheReadTokens)],
            ['推理 Token', fmt(T.reasoningTokens)],
            ['累计墙钟', inProgress ? `${ms(T.durationMs)}（进行中）` : ms(T.durationMs)],
            ['完成/中止/中断', inProgress
              ? `${T.completed} / ${T.aborted} / ${T.interrupted}（进行中不计入）`
              : `${T.completed} / ${T.aborted} / ${T.interrupted}`],
          ],
        }),
        h('div', { className: 'worklog-h', key: 'h2' }, '成功率'),
        h('div', { className: 'worklog-row', key: 'r1' }, [
          h('span', { className: 'worklog-name', key: 'a' }, '工具'),
          h('span', { className: 'worklog-num', key: 'b' }, pct(T.toolCalls - T.failures, T.toolCalls)),
        ]),
        h('div', { className: 'worklog-row', key: 'r2' }, [
          h('span', { className: 'worklog-name', key: 'a' }, '轮次'),
          h('span', { className: 'worklog-num', key: 'b' }, pct(T.completed, done)),
        ]),
      ])
    }

    // ------------------------------------------------------------ 工具（DSH 的 agent 工具）
    function Tools(T) {
      const detail = T.toolDetail ?? []
      if (!detail.length) return h('div', { className: 'worklog-empty' }, '没有工具调用记录。')
      const max = detail[0].count
      return h(React.Fragment, null, [
        h('div', { className: 'worklog-h', key: 'h' },
          `Agent 工具（共 ${fmt(T.toolCalls)} 次调用，${detail.length} 种）`),
        ...detail.map((t, i) =>
          h('div', { className: 'worklog-item', key: i }, [
            h('div', { className: 'worklog-row', key: 'r' }, [
              h('span', { className: 'worklog-name', key: 'n' }, t.name),
              h('span', { className: 'worklog-bar-track', key: 't' },
                h('span', { className: 'worklog-bar-fill',
                  style: { width: max > 0 ? `${(t.count / max) * 100}%` : '0%' } })),
              h('span', { className: 'worklog-num', key: 'c' }, `${fmt(t.count)} 次`),
              h('span', { className: 'worklog-meta', key: 'p' }, pct(t.count, T.toolCalls)),
            ]),
            h('div', { className: 'worklog-meta', key: 'm' },
              `失败 ${t.failures}` +
              (t.totalMs ? ` · 耗时 ${ms(t.totalMs)}` : '') +
              ` · 轮次 ${t.turns?.join(',') ?? '-'}` +
              ` · ${hms(t.firstAt)} → ${hms(t.lastAt)}`),
          ])),
      ])
    }

    // ------------------------------------------------------------ 命令（独立视图）
    function Commands(T) {
      const cmds = T.allCommands ?? []
      if (!cmds.length) return h('div', { className: 'worklog-empty' }, '没有命令执行记录。')
      const failed = cmds.filter((c) => c.ok === false).length
      return h(React.Fragment, null, [
        h('div', { className: 'worklog-h', key: 'h' },
          `Shell 命令（${cmds.length} 条，失败 ${failed} 条）`),
        h('div', { className: 'worklog-meta', key: 'tip' },
          '这是实际执行的命令行，与上面的「工具」是两回事。'),
        ...cmds.map((c, i) =>
          h('div', { className: 'worklog-item', key: i }, [
            h('div', { key: 'hd' }, [
              h('span', { className: 'worklog-time', key: 't' }, hms(c.at)),
              h('span', { className: 'worklog-meta', key: 'tn' }, ` 轮${c.turn} `),
              h('span', {
                key: 'ok',
                className: c.ok === true ? 'worklog-ok' : c.ok === false ? 'worklog-bad' : 'worklog-meta',
              }, c.ok === true ? '✓ 0' : c.ok === false ? '✗ 非0' : '? 未知'),
              c.durationMs ? h('span', { className: 'worklog-meta', key: 'd' }, ` · ${ms(c.durationMs)}`) : null,
              c.description ? h('span', { className: 'worklog-meta', key: 'de' }, ` · ${c.description}`) : null,
            ]),
            h('code', { className: 'worklog-code', key: 'c' }, String(c.command).slice(0, 400)),
          ])),
      ])
    }

    // ------------------------------------------------------------ 文件（修改/读取 可切换）
    function Files(T, fileTab, setFileTab) {
      const all = T.fileDetail ?? []
      const modified = all.filter((f) => f.ops.includes('write') || f.ops.includes('edit'))
      const readOnly = all.filter((f) => f.ops.includes('read') && !f.ops.includes('write') && !f.ops.includes('edit'))
      const list = fileTab === 'modified' ? modified : readOnly

      const subBar = h('div', { className: 'worklog-sub', key: 'sub' }, [
        h('button', {
          key: 'm', className: 'worklog-btn',
          'aria-pressed': fileTab === 'modified' ? 'true' : 'false',
          onClick: () => setFileTab('modified'),
        }, `修改 ${modified.length}`),
        h('button', {
          key: 'r', className: 'worklog-btn',
          'aria-pressed': fileTab === 'read' ? 'true' : 'false',
          onClick: () => setFileTab('read'),
        }, `读取 ${readOnly.length}`),
      ])

      const opLabel = (ops) => {
        if (ops.includes('write') && ops.includes('edit')) return '写+改'
        if (ops.includes('write')) return '写入'
        if (ops.includes('edit')) return '修改'
        return '读取'
      }

      return h(React.Fragment, null, [
        subBar,
        list.length === 0
          ? h('div', { className: 'worklog-empty', key: 'e' },
              fileTab === 'modified' ? '没有文件被修改。' : '没有只读的文件记录。')
          : h(React.Fragment, { key: 'l' }, list.map((f, i) =>
              h('div', { className: 'worklog-item', key: i }, [
                h('div', { key: 'hd' }, [
                  h('span', {
                    key: 'op',
                    className: opLabel(f.ops) === '读取' ? 'worklog-meta' : 'worklog-ok',
                  }, opLabel(f.ops)),
                  h('span', { className: 'worklog-meta', key: 'c' }, ` · ${f.count} 次`),
                  h('span', { className: 'worklog-meta', key: 't' }, ` · ${hms(f.lastAt)}`),
                  h('span', { className: 'worklog-meta', key: 'tn' }, ` · 轮${f.turns?.join(',') ?? '-'}`),
                ]),
                // 完整路径（用户要求：要包含完整目录，不能只有文件名）
                h('div', { className: 'worklog-path', key: 'p' }, f.path),
              ]))),
      ])
    }

    // ------------------------------------------------------------ 测试
    function Tests(T) {
      const tests = T.allTests ?? []
      if (!tests.length) {
        return h(React.Fragment, null, [
          h('div', { className: 'worklog-h', key: 'h' }, '测试'),
          h('div', { className: 'worklog-empty', key: 'e' }, '这个会话里没有识别到测试运行。'),
          h('div', { className: 'worklog-meta', key: 'n' },
            '判据：命令里调用了测试运行器 —— npm/pnpm/yarn test（含 test:xxx、check、lint、verify）、' +
            'node --test、vitest、jest、mocha、playwright test、pytest、go test、cargo test、dotnet test 等。' +
            '普通的 Get-ChildItem、pnpm install 之类不算。'),
          h('div', { className: 'worklog-meta', key: 'n2' },
            '结论优先看测试运行器自己打印的汇总；只有在退出码**能归因到测试命令**时才用它兜底，' +
            '两个都不确定就标「未判定」——宁可说不知道，也不谎报通过。'),
        ])
      }
      const pass = tests.filter((t) => t.passed === true).length
      const failN = tests.filter((t) => t.passed === false).length
      const unknown = tests.filter((t) => t.passed == null).length
      return h(React.Fragment, null, [
        h('div', { className: 'worklog-h', key: 'h' },
          `测试（${tests.length} 次，通过 ${pass} / 失败 ${failN}${unknown ? ` / 未判定 ${unknown}` : ''}）`),
        ...tests.map((t, i) =>
          h('div', { className: 'worklog-item', key: i }, [
            h('div', { key: 'hd' }, [
              h('span', { className: 'worklog-time', key: 'a' }, hms(t.at)),
              h('span', { className: 'worklog-meta', key: 'k' }, ` 轮${t.turn} · ${t.kind} `),
              h('span', {
                key: 'p',
                className: t.passed === true ? 'worklog-ok' : t.passed === false ? 'worklog-bad' : 'worklog-warn',
              }, t.passed === true ? '✓ 通过' : t.passed === false ? '✗ 未通过' : '? 未判定'),
              t.basis ? h('span', { className: 'worklog-meta', key: 'b' }, ` · ${basisLabel(t.basis)}`) : null,
              t.durationMs ? h('span', { className: 'worklog-meta', key: 'd' }, ` · ${ms(t.durationMs)}`) : null,
            ]),
            // 多行脚本压成一行：只显示第一行会变成 "cd xxx"，根本认不出跑的是什么测试
            h('code', { className: 'worklog-code', key: 'c' }, flattenCommand(t.command, 240)),
            t.note ? h('div', { className: 'worklog-warn', key: 'n' }, t.note) : null,
          ])),
      ])
    }

    // ------------------------------------------------------------ 失败
    function Fails(view) {
      const hard = []
      const soft = []
      for (const t of view.turns) {
        for (const f of t.failures ?? []) hard.push({ turn: t.turn, ...f })
        for (const f of t.suspects ?? []) soft.push({ turn: t.turn, ...f })
      }
      if (!hard.length && !soft.length) {
        return h('div', { className: 'worklog-empty' }, '没有记录到工具层失败。')
      }
      return h(React.Fragment, null, [
        // ⚠️ key 必须唯一且不能和条目的 key 撞车。
        // 这里曾经把标题写成 key:'h1'、条目写成 key:`h${i}` —— 第 2 条失败正好也叫 'h1'，
        // 疑似标题 'h2' 也和第 3 条撞。React 按 key 复用节点，撞车会留下陈旧节点，
        // 真机表现为「切换页签后，总览上方凭空多出两行『失败 8 · 疑似 2』」。
        // 计数已经在页签标签上了，这里不再重复渲染标题。
        ...hard.map((f, i) =>
          h('div', { className: 'worklog-item', key: `fail-${i}` }, [
            h('div', { key: 'hd' }, [
              h('span', { className: 'worklog-time', key: 't' }, hms(f.at)),
              h('span', { className: 'worklog-bad', key: 'b' }, ` 轮${f.turn} ${f.tool}`),
              h('span', { className: 'worklog-meta', key: 'k' }, ` · ${f.kind}`),
              f.durationMs ? h('span', { className: 'worklog-meta', key: 'd' }, ` · ${ms(f.durationMs)}`) : null,
            ]),
            f.file ? h('div', { className: 'worklog-path', key: 'f' }, f.file) : null,
            f.command ? h('code', { className: 'worklog-code', key: 'c' }, String(f.command).slice(0, 240)) : null,
            f.message ? h('div', { className: 'worklog-meta', key: 'm' },
              String(f.message).slice(0, 200)) : null,
          ])),
        soft.length
          ? h(React.Fragment, { key: 'soft' }, [
              h('div', { className: 'worklog-h', key: 'suspect-head' },
                `疑似 ${soft.length} 次（非 0 退出但可能已成功，未计入失败总数）`),
              ...soft.map((f, i) =>
                h('div', { className: 'worklog-item', key: `suspect-${i}` },
                  h('div', null, [
                    h('span', { className: 'worklog-time', key: 't' }, hms(f.at)),
                    h('span', { className: 'worklog-warn', key: 'b' }, ` 轮${f.turn} ${f.tool}`),
                    h('span', { className: 'worklog-meta', key: 'k' }, ` · ${f.kind}`),
                  ]))),
            ])
          : null,
      ])
    }

    // ------------------------------------------------------------ 轮次
    function Turns(view) {
      const turns = view.turns
      if (!turns.length) return h('div', { className: 'worklog-empty' }, '没有轮次记录。')
      return h(React.Fragment, null, turns.map((t, i) => {
        const mark = t.reason?.kind === 'completed' ? ['✓', 'worklog-ok']
          : t.reason?.kind === 'aborted' ? ['✕', 'worklog-bad']
          : t.reason?.kind === 'interrupted' ? ['!', 'worklog-warn']
          : ['?', 'worklog-meta']
        const prompt = String(t.prompt ?? '').split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '(无)'
        return h('div', { className: 'worklog-item', key: t.turn ?? i }, [
          h('div', { key: 'a' }, [
            h('span', { className: 'worklog-time', key: 't' }, hms(t.startedAt)),
            h('span', { className: mark[1], key: 'm' }, ` ${mark[0]} 轮次 ${t.turn} `),
            h('span', { key: 'p' }, prompt.slice(0, 70)),
          ]),
          h('div', { className: 'worklog-meta', key: 'b' },
            `工具 ${t.toolCalls?.length ?? 0} · 失败 ${t.failures?.length ?? 0} · ` +
            `命令 ${t.commands?.length ?? 0} · 测试 ${t.tests?.length ?? 0} · ` +
            `读/写/改 ${t.filesRead?.length ?? 0}/${t.filesWritten?.length ?? 0}/${t.filesEdited?.length ?? 0} · ` +
            `输出 ${fmt(t.usage?.outputTokens)} tok · ${ms(t.durationMs)}`),
          (t.commands?.length ?? 0) > 0
            ? h('div', { className: 'worklog-meta', key: 'c' },
                `命令时间 ${hms(t.commands[0].at)} → ${hms(t.commands[t.commands.length - 1].at)}`)
            : null,
        ])
      }))
    }

    // ------------------------------------------------------------ 插件定义
    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            title: () => '工作报告',
            guide: [
              {
                // 0.1.7-rc.1 的 registry 按 id 查重（重复抛错），渲染时用作 React key
                id: 'report',
                order: 30,
                title: () => 'Agent 工作报告',
                description: () => '复盘本次任务：工具、命令、文件、测试、失败、Token、完成度',
              },
            ],
          }),
        'dsh-agent-log: tab type',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, WorklogPanel),
          ),
        'dsh-agent-log: tab body',
      )
    }

    return { inject, apply }
  },
})
