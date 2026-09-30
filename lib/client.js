/**
 * dsh-taste-loop — client half（浏览器半区 = 口味闭环工作台）
 *
 * 形态（与 dsh-novel-craft 同一套公开约定，未复制其代码）：
 * - 侧栏入口：sidebar.footer.action（id=taste-loop）→ 开/关面板；
 * - 全屏浮层：shell.overlay（id=taste-loop）→ 面板本体；
 * - 数据走宿主半区的回环 HTTP API（/taste-loop/api/*），用 fetch 直接打；
 *   React 由模块加载器的 factory 注入（require('react')），不是全局变量。
 *
 * 四步：① 场景（训练材料）→ ② 句级点赞/踩 → ③ 提炼 → ④ 档案。
 * 作者只提供场景和判断，不提供成品文字 —— 这是这个插件成立的前提。
 *
 * 为什么标注到句子：整篇的"好/坏"太钝 —— 一篇里有好句子也有坏句子，
 * 整篇判好等于把坏句子也当成正面例子教给模型。句级标注才是干净的训练信号，
 * 回灌提示词时也能直接说"这句别再写"。
 *
 * 标注操作：
 *   鼠标：每句旁边 👍 / 👎 / ↺
 *   键盘：J / K 上下句（自动滚到视野内）、G 赞、B 踩、空格 清除
 *         —— 顺手、可连续标，这是能标下去的前提。
 *
 * 样式一律用内联 style：不依赖 CSS 注入时机，加载顺序变化也不会丢样式。
 */
window.__ModuleLoader__.load({
  id: 'dsh-taste-loop',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    /**
     * 宿主 API 的基址。网页版就是当前 origin；**桌面版（DSH Studio）页面是 file://**，
     * `location.origin` 会变成字符串 "null"，相对路径会被当成文件路径、请求全部打空。
     * 与 dsh 自带的 dsh-client-connection / dsh-client-file-upload 同一套做法：
     * 退回 `http://dsh.internal`，由桌面外壳转发给宿主。
     */
    const HOST_BASE = (() => {
      const loc = globalThis.location
      return loc !== undefined && loc !== null && typeof loc.origin === 'string' && loc.origin !== 'null' ? loc.origin : 'http://dsh.internal'
    })()
    const API = new URL('/taste-loop/api/', HOST_BASE).toString()

    const NS = 'dsh-taste-loop'

    // ── 内联样式 ───────────────────────────────────────────────────────────
    const S = {
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'flex-end',
        background: 'rgba(0,0,0,.34)',
      },
      panel: {
        width: 'min(880px, 96vw)',
        height: '100%',
        overflow: 'auto',
        background: 'var(--dsh-color-bg-primary, #fff)',
        color: 'var(--dsh-color-text-primary, #111)',
        borderLeft: '1px solid var(--dsh-color-border, rgba(0,0,0,.12))',
        display: 'flex',
        flexDirection: 'column',
      },
      head: {
        position: 'sticky',
        top: 0,
        zIndex: 3,
        background: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 16px',
        borderBottom: '1px solid var(--dsh-color-border, rgba(0,0,0,.12))',
      },
      title: { fontSize: 15, fontWeight: 600, flex: 1 },
      tabs: { display: 'flex', gap: 6, padding: '10px 16px 0', flexWrap: 'wrap' },
      body: { padding: '14px 16px 28px', display: 'flex', flexDirection: 'column', gap: 14 },
      card: {
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.12))',
        borderRadius: 10,
        padding: 12,
      },
      label: { fontSize: 12, fontWeight: 600, opacity: 0.72, marginBottom: 8, letterSpacing: '.02em' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.16))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      area: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.16))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 13,
        fontFamily: 'inherit',
        minHeight: 90,
        resize: 'vertical',
        lineHeight: 1.6,
      },
      select: {
        boxSizing: 'border-box',
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.16))',
        background: 'var(--dsh-color-bg-primary, #fff)',
        color: 'inherit',
        borderRadius: 8,
        padding: '6px 8px',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      btn: {
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.16))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      btnPrimary: {
        border: '1px solid transparent',
        background: 'var(--dsh-color-accent, #2f6feb)',
        color: '#fff',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      btnSm: { padding: '3px 8px', fontSize: 11 },
      scene: {
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.12))',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 10,
      },
      variants: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 10,
        paddingLeft: 10,
        borderLeft: '2px solid var(--dsh-color-border, rgba(0,0,0,.12))',
      },
      variant: {
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.12))',
        borderRadius: 8,
        padding: '8px 10px',
      },
      sentence: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '3px 6px',
        borderRadius: 6,
        cursor: 'text',
      },
      sentenceText: { flex: 1, fontSize: 14, lineHeight: 1.9, wordBreak: 'break-word' },
      sentenceBtns: { display: 'flex', gap: 3, flexShrink: 0, opacity: 0.55 },
      text: { fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      meta: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, opacity: 0.6, marginTop: 6 },
      hint: { fontSize: 12, opacity: 0.64, lineHeight: 1.6 },
      err: { fontSize: 12, color: '#d9534f', lineHeight: 1.6, whiteSpace: 'pre-wrap' },
      list: { fontSize: 12, lineHeight: 1.7, paddingLeft: 18, margin: '6px 0' },
      ruleRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsh-color-border, rgba(0,0,0,.12))',
        marginBottom: 6,
      },
      checkbox: { marginTop: 3, flexShrink: 0 },
      ruleInput: {
        flex: 1,
        boxSizing: 'border-box',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '2px 4px',
        fontSize: 13,
        fontFamily: 'inherit',
        minWidth: 120,
      },
    }

    const toneStyle = (rating) => {
      if (rating === 'good') return { ...S.variant, borderLeftWidth: 3, borderLeftColor: '#2f9e5f' }
      if (rating === 'bad') return { ...S.variant, borderLeftWidth: 3, borderLeftColor: '#d9534f' }
      return { ...S.variant, borderLeftWidth: 3, borderLeftColor: 'transparent' }
    }

    const sentenceStyle = (rating, active) => {
      const base = { ...S.sentence }
      if (rating === 'good') base.background = 'rgba(47,158,95,.16)'
      else if (rating === 'bad') base.background = 'rgba(217,83,79,.16)'
      base.outline = active ? '1px solid var(--dsh-color-accent, #2f6feb)' : 'none'
      base.outlineOffset = '-1px'
      return base
    }

    // ── 切句 ────────────────────────────────────────────────────────────────
    // 句末标点收尾；换行也算边界（模型有时不写标点、用换行分段）。
    // 只切一次，之后句子就是稳定单元 —— 标注按序号存，正文改了也不错位。
    const TERMINATORS = '。！？!?；;…'
    const CLOSERS = '”’」』）)》】'

    function splitSentences(text) {
      const source = String(text === undefined || text === null ? '' : text).replace(/\r\n/g, '\n')
      const out = []
      let start = 0
      let index = 0
      while (index < source.length) {
        const ch = source[index]
        if (TERMINATORS.indexOf(ch) !== -1) {
          let end = index + 1
          while (end < source.length && (CLOSERS.indexOf(source[end]) !== -1 || TERMINATORS.indexOf(source[end]) !== -1)) {
            end += 1
          }
          const piece = source.slice(start, end).trim()
          if (piece !== '') out.push(piece)
          start = end
          index = end
          continue
        }
        if (ch === '\n') {
          const piece = source.slice(start, index).trim()
          if (piece !== '') out.push(piece)
          start = index + 1
        }
        index += 1
      }
      const tail = source.slice(start).trim()
      if (tail !== '') out.push(tail)
      return out
    }

    const markOf = (variant, index) => {
      const marks = Array.isArray(variant.marks) ? variant.marks : []
      for (const mark of marks) {
        if (mark.index === index) return mark.rating
      }
      return ''
    }

    const withMark = (variant, index, text, rating) => {
      const marks = (Array.isArray(variant.marks) ? variant.marks : []).filter((mark) => mark.index !== index)
      if (rating === 'good' || rating === 'bad') marks.push({ index, text, rating })
      marks.sort((a, b) => a.index - b.index)
      return { ...variant, marks }
    }

    // ── 面板与侧栏按钮共享的状态 ────────────────────────────────────────────
    let state = {
      root: 'E:\\codex',
      scenes: [],
      profile: '',
      profiles: [],
      profileName: '',
      provider: '',
      model: '',
      variants: 3,
      busy: '',
      message: '',
      error: '',
      loaded: false,
      open: false,
      tab: 'scenes',
      active: null,
    }
    const listeners = new Set()
    const setState = (patch) => {
      state = { ...state, ...patch }
      for (const fn of [...listeners]) fn()
    }
    const subscribe = (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
    function useStore() {
      const [, force] = useState(0)
      useEffect(() => subscribe(() => force((n) => n + 1)), [])
      return state
    }

    /** 把「场景 → 候选 → 句子」摊平成一条线：键盘上下句就是在这条线上走。 */
    function walkLine(scenes) {
      const out = []
      for (const scene of scenes) {
        for (const variant of scene.variants) {
          const sentences = splitSentences(variant.text)
          sentences.forEach((text, index) => {
            out.push({
              key: variant.id + '#' + index,
              sceneId: scene.id,
              variantId: variant.id,
              index,
              text,
            })
          })
        }
      }
      return out
    }

    // ── 与宿主半区通信 ──────────────────────────────────────────────────────
    async function api(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) {
        const message = data !== null && typeof data.error === 'string' ? data.error : 'HTTP ' + response.status
        throw new Error(message)
      }
      if (data !== null && typeof data.error === 'string') throw new Error(data.error)
      return data
    }

    const errorText = (error) => (error instanceof Error ? error.message : String(error))
    const countChars = (text) => String(text).replace(/\s/g, '').length
    /** 规律文本的归一化：只用来判断「这条是不是已经采纳了」，不改写原文本。 */
    const normRule = (value) =>
      String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, '')
        .replace(/[。．.,，、；;：:!！?？"'“”‘’()（）[\]【】]/g, '')
        .trim()

    // ── 一篇候选：逐句标注 ──────────────────────────────────────────────────
    function VariantRow(props) {
      const variant = props.variant
      const sentences = splitSentences(variant.text)
      const goodCount = sentences.filter((_, index) => markOf(variant, index) === 'good').length
      const badCount = sentences.filter((_, index) => markOf(variant, index) === 'bad').length

      return h(
        'div',
        { style: toneStyle(variant.rating) },
        h(
          'div',
          { style: { ...S.row, marginBottom: 4 } },
          h('span', { style: { ...S.hint, fontWeight: 600 } }, String(variant.label || '')),
          h('span', { style: S.hint }, sentences.length + ' 句 · ' + countChars(variant.text) + ' 字'),
          goodCount > 0 ? h('span', { style: { ...S.hint, color: '#2f9e5f' } }, '👍 ' + goodCount) : null,
          badCount > 0 ? h('span', { style: { ...S.hint, color: '#d9534f' } }, '👎 ' + badCount) : null,
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { style: { ...S.btn, ...S.btnSm }, onClick: () => props.onRemove(props.sceneId, variant.id) },
            '删这篇',
          ),
        ),
        sentences.map((text, index) => {
          const rating = markOf(variant, index)
          const key = variant.id + '#' + index
          const active = props.active === key
          return h(
            'div',
            {
              key: key,
              // 键盘 J/K 换句时靠这个属性把当前句滚进视野
              'data-taste-key': key,
              style: sentenceStyle(rating, active),
              onClick: () => props.onActivate(key),
            },
            h('span', { style: S.sentenceText }, text),
            h(
              'span',
              { style: { ...S.sentenceBtns, opacity: rating === '' && !active ? 0.3 : 0.9 } },
              h(
                'button',
                {
                  style:
                    rating === 'good'
                      ? { ...S.btn, ...S.btnSm, ...S.btnPrimary }
                      : { ...S.btn, ...S.btnSm },
                  title: '这一句好（G）',
                  onClick: (event) => {
                    event.stopPropagation()
                    props.onMark(props.sceneId, variant.id, index, text, 'good')
                  },
                },
                '👍',
              ),
              h(
                'button',
                {
                  style:
                    rating === 'bad' ? { ...S.btn, ...S.btnSm, ...S.btnPrimary } : { ...S.btn, ...S.btnSm },
                  title: '这一句踩（B）',
                  onClick: (event) => {
                    event.stopPropagation()
                    props.onMark(props.sceneId, variant.id, index, text, 'bad')
                  },
                },
                '👎',
              ),
              rating !== ''
                ? h(
                    'button',
                    {
                      style: { ...S.btn, ...S.btnSm },
                      title: '清除（空格）',
                      onClick: (event) => {
                        event.stopPropagation()
                        props.onMark(props.sceneId, variant.id, index, text, '')
                      },
                    },
                    '↺',
                  )
                : null,
            ),
          )
        }),
      )
    }

    // 把两条来源的规律合起来：新提炼的（未采纳）放前面，档案里已有的按原样在后。
    // 同文本只留一条 —— 归一化后比较，避免「模型又输出了同一条」在界面上出现两遍。
    function mergeRules(existing, incoming) {
      const out = [...existing]
      const seen = new Set(out.map((item) => normRule(item.rule)))
      for (const item of incoming) {
        if (item === null || typeof item !== 'object') continue
        const rule = String(item.rule === undefined ? '' : item.rule).trim()
        if (rule === '') continue
        const key = normRule(rule)
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        out.push({
          id: item.id === undefined ? 'r' + out.length + '-' + Math.random().toString(36).slice(2, 7) : item.id,
          rule,
          kind: item.kind === 'disliked' ? 'disliked' : 'liked',
          adopted: item.adopted === true,
        })
      }
      return out
    }

    // ── 面板 ────────────────────────────────────────────────────────────────
    function Panel() {
      const s = useStore()
      const [sceneDraft, setSceneDraft] = useState('')
      const [rules, setRules] = useState([])
      const [profile, setProfile] = useState('')
      const [rulesLoaded, setRulesLoaded] = useState(false)
      const [profileDraft, setProfileDraft] = useState('')

      /** 把一份面板数据（state / create / rename / delete 都返回这个形状）装进界面。 */
      const applyPanel = useCallback((data, patch) => {
        const text = typeof data.profile === 'string' ? data.profile : ''
        const liked = Array.isArray(data.liked) ? data.liked : []
        const disliked = Array.isArray(data.disliked) ? data.disliked : []
        setState({
          scenes: Array.isArray(data.scenes) ? data.scenes : [],
          profiles: Array.isArray(data.profiles) && data.profiles.length > 0 ? data.profiles : [],
          profileName: typeof data.profileName === 'string' ? data.profileName : '',
          profile: text,
          loaded: true,
          error: '',
          ...(patch === undefined ? {} : patch),
        })
        setProfile(text)
        setRules([
          ...liked.map((rule, index) => ({
            id: 'p-l' + index + '-' + Math.random().toString(36).slice(2, 7),
            rule,
            kind: 'liked',
            adopted: true,
          })),
          ...disliked.map((rule, index) => ({
            id: 'p-d' + index + '-' + Math.random().toString(36).slice(2, 7),
            rule,
            kind: 'disliked',
            adopted: true,
          })),
        ])
        setRulesLoaded(true)
      }, [])

      const load = useCallback(async () => {
        try {
          const data = await api('state', { root: state.root, profile: state.profileName })
          applyPanel(data)
        } catch (error) {
          setState({ loaded: true, error: errorText(error) })
        }
      }, [applyPanel])

      useEffect(() => {
        if (!s.loaded) load()
      }, [s.loaded, load])

      /** 切档案：整块重载，场景与规律都换掉 —— 两份档案之间不该有任何串味。 */
      const switchProfile = async (name) => {
        setState({ busy: 'profile', error: '', message: '', active: null })
        try {
          const data = await api('state', { root: state.root, profile: name })
          applyPanel(data, { busy: '', tab: 'scenes', message: '切到档案「' + name + '」' })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      const createProfile = async () => {
        const name = profileDraft.trim()
        if (name === '') {
          setState({ error: '先写一个档案名（比如：短视频脚本 / 论文）' })
          return
        }
        setState({ busy: 'profile', error: '' })
        try {
          const data = await api('profile-create', { root: state.root, name })
          setProfileDraft('')
          applyPanel(data, { busy: '', tab: 'scenes', message: '建好档案「' + data.profileName + '」并切过去了' })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      const renameProfile = async () => {
        const to = profileDraft.trim()
        if (to === '') {
          setState({ error: '写一个新的档案名' })
          return
        }
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('把档案「' + s.profileName + '」改名为「' + to + '」？')) return
        }
        setState({ busy: 'profile', error: '' })
        try {
          const data = await api('profile-rename', { root: state.root, from: s.profileName, to })
          setProfileDraft('')
          applyPanel(data, { busy: '', message: '改名为「' + data.profileName + '」' })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      const deleteProfile = async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('删除档案「' + s.profileName + '」？\n它会被挪到 .dsh-taste/废纸篓/，不会真的丢掉。')) return
        }
        setState({ busy: 'profile', error: '' })
        try {
          const data = await api('profile-delete', { root: state.root, name: s.profileName })
          applyPanel(data, {
            busy: '',
            tab: 'scenes',
            message: '删掉了「' + data.deleted + '」，已挪到 ' + data.trash,
          })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      // 只存场景与候选。档案不再由这里整份覆盖 —— 它归「③ 提炼」逐条改。
      const persist = async (scenes) => {
        setState({ scenes, busy: 'save' })
        try {
          await api('save', { root: state.root, profile: state.profileName, scenes })
          setState({ busy: '', error: '' })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      const markSentence = async (sceneId, variantId, index, text, rating) => {
        const next = state.scenes.map((scene) => {
          if (scene.id !== sceneId) return scene
          return {
            ...scene,
            variants: scene.variants.map((variant) =>
              variant.id === variantId ? withMark(variant, index, text, rating) : variant,
            ),
          }
        })
        setState({ active: variantId + '#' + index })
        await persist(next)
      }

      const removeVariant = async (sceneId, variantId) => {
        const next = state.scenes.map((scene) => {
          if (scene.id !== sceneId) return scene
          return { ...scene, variants: scene.variants.filter((variant) => variant.id !== variantId) }
        })
        await persist(next)
      }

      // 键盘标注：J/K 走句子、G/B 标、空格清。焦点在输入框里时让位。
      useEffect(() => {
        if (!s.open || s.tab !== 'rate') return undefined
        const onKey = (event) => {
          const target = event.target
          const tag = String((target && target.tagName) || '').toLowerCase()
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return
          if (event.metaKey || event.ctrlKey || event.altKey) return
          const key = String(event.key || '')
          const lower = key.toLowerCase()
          const line = walkLine(state.scenes)
          if (line.length === 0) return
          const current = state.active === null ? -1 : line.findIndex((row) => row.key === state.active)
          const at = current === -1 ? 0 : current

          if (lower === 'j' || lower === 'k') {
            const next = lower === 'j' ? Math.min(line.length - 1, at + 1) : Math.max(0, at - 1)
            event.preventDefault()
            setState({ active: line[next].key })
            if (typeof document !== 'undefined' && document.querySelector) {
              const node = document.querySelector('[data-taste-key="' + line[next].key + '"]')
              if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' })
            }
            return
          }
          if (lower === 'g' || lower === 'b' || key === ' ') {
            const row = line[at]
            if (row === undefined) return
            event.preventDefault()
            const rating = lower === 'g' ? 'good' : lower === 'b' ? 'bad' : ''
            markSentence(row.sceneId, row.variantId, row.index, row.text, rating)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [s.open, s.tab, s.active, s.scenes])

      const addScenes = async () => {
        const text = sceneDraft.trim()
        if (text === '') {
          setState({ error: '先把场景写进框里' })
          return
        }
        const pieces = text.split(/\n{2,}/).map((x) => x.trim()).filter((x) => x !== '')
        const list = pieces.length > 0 ? pieces : [text]
        const stamp = Date.now()
        const added = list.map((item, index) => ({
          id: 's' + stamp + '-' + index,
          text: item.slice(0, 6000),
          variants: [],
          at: new Date().toISOString(),
        }))
        setSceneDraft('')
        await persist([...state.scenes, ...added])
        setState({ message: '加了 ' + added.length + ' 个场景（空行分隔）。点「按场景生成候选」。' })
      }

      const removeScene = async (sceneId) => {
        await persist(state.scenes.filter((scene) => scene.id !== sceneId))
      }

      const generate = async () => {
        if (state.scenes.length === 0) {
          setState({ error: '先加至少一个场景', tab: 'scenes' })
          return
        }
        setState({ busy: 'generate', error: '', message: '正在为这些场景生成候选…（每个场景一次调用）' })
        try {
          const data = await api('generate', {
            root: state.root,
            profile: state.profileName,
            scenes: state.scenes,
            profileText: state.profile,
            variants: state.variants,
            provider: state.provider,
            model: state.model,
          })
          setState({
            scenes: Array.isArray(data.scenes) ? data.scenes : state.scenes,
            profileName: typeof data.profileName === 'string' ? data.profileName : state.profileName,
            tab: 'rate',
            busy: '',
            active: null,
            message:
              '生了 ' + data.created + ' 篇候选' +
              (data.failed.length > 0 ? '，失败 ' + data.failed.length + ' 次' : '') +
              '（' + data.provider + '/' + data.model + '）',
          })
          // 新候选意味着旧提议过时了；档案仍在盘上，重新载入时会按档案重建勾选
          setRules([])
          setRulesLoaded(false)
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      const refreshProfile = async () => {
        const data = await api('get-profile', { root: state.root, profile: state.profileName })
        setProfile(typeof data.profile === 'string' ? data.profile : '')
        return data
      }

      /** 提炼只是**提议**：拿回条目列表，采纳与否由作者逐条点。 */
      const distill = async () => {
        setState({ busy: 'distill', error: '', message: '正在把句级点赞/踩提炼成规律…' })
        try {
          const data = await api('distill', {
            root: state.root,
            profile: state.profileName,
            scenes: state.scenes,
            provider: state.provider,
            model: state.model,
          })
          const incoming = (Array.isArray(data.rules) ? data.rules : []).map((item, index) => ({
            id: 'n' + Date.now() + '-' + index,
            rule: item.rule,
            kind: item.kind,
            adopted: false,
          }))
          setRules((prev) => mergeRules(prev, incoming))
          setRulesLoaded(true)
          setState({
            tab: 'rules',
            busy: '',
            message:
              data.provider + '/' + data.model + '：对比了 ' + data.sceneCount + ' 个场景里的 ' +
              data.goodCount + ' 个好句 / ' + data.badCount + ' 个坏句，提出 ' + incoming.length +
              ' 条规律 —— 逐条勾选要采纳的',
          })
        } catch (error) {
          setState({ busy: '', error: errorText(error), message: '' })
        }
      }

      /** 「更通用」：把还没采纳的规律往上抽一层，结果仍然逐条勾选。 */
      const refine = async () => {
        setState({ busy: 'refine', error: '', message: '正在把未采纳的规律抽得更一般…' })
        try {
          const data = await api('rules-refine', {
            root: state.root,
            profile: state.profileName,
            rules: rules,
            provider: state.provider,
            model: state.model,
          })
          const incoming = (Array.isArray(data.rules) ? data.rules : []).map((item, index) => ({
            id: 'r' + Date.now() + '-' + index,
            rule: item.rule,
            kind: item.kind,
            adopted: false,
          }))
          setRules((prev) => mergeRules(prev, incoming))
          setState({
            busy: '',
            message:
              '把 ' + data.inputCount + ' 条未采纳的规律抽成了 ' + incoming.length +
              ' 条更一般的说法（' + data.provider + '/' + data.model + '）—— 还是逐条勾选',
          })
        } catch (error) {
          setState({ busy: '', error: errorText(error), message: '' })
        }
      }

      /** 勾选 / 取消勾选：立即落到档案 —— 取消是从档案里删掉，不是只取消显示。 */
      const setRuleAdopted = async (id, adopted) => {
        const target = rules.find((item) => item.id === id)
        if (target === undefined) return
        setRules((prev) => prev.map((item) => (item.id === id ? { ...item, adopted } : item)))
        setState({ busy: 'rule' })
        try {
          await api(adopted ? 'rules-adopt' : 'rules-unadopt', {
            root: state.root,
            rule: target.rule,
            kind: target.kind,
          })
          await refreshProfile()
          setState({ busy: '', error: '' })
        } catch (error) {
          // 失败就回滚勾选状态，不然界面会显示一个档案里并不存在的"已采纳"
          setRules((prev) => prev.map((item) => (item.id === id ? { ...item, adopted: !adopted } : item)))
          setState({ busy: '', error: errorText(error) })
        }
      }

      /** 改规律文本：已采纳的先从档案删掉旧文本，再按新文本写回。 */
      const editRule = async (id, text) => {
        const target = rules.find((item) => item.id === id)
        if (target === undefined) return
        const next = String(text).slice(0, 80)
        setRules((prev) => prev.map((item) => (item.id === id ? { ...item, rule: next } : item)))
        if (!target.adopted || normRule(next) === normRule(target.rule)) return
        setState({ busy: 'rule' })
        try {
          await api('rules-unadopt', { root: state.root, profile: state.profileName, rule: target.rule, kind: target.kind })
          await api('rules-adopt', { root: state.root, profile: state.profileName, rule: next, kind: target.kind })
          await refreshProfile()
          setState({ busy: '', error: '' })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      /** 改类型（喜欢 ↔ 避免）：已采纳的要从一个小节搬到另一个小节。 */
      const changeRuleKind = async (id, kind) => {
        const target = rules.find((item) => item.id === id)
        if (target === undefined) return
        setRules((prev) => prev.map((item) => (item.id === id ? { ...item, kind } : item)))
        if (!target.adopted) return
        setState({ busy: 'rule' })
        try {
          await api('rules-unadopt', { root: state.root, profile: state.profileName, rule: target.rule, kind: target.kind })
          await api('rules-adopt', { root: state.root, profile: state.profileName, rule: target.rule, kind })
          await refreshProfile()
          setState({ busy: '', error: '' })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      /** 清掉界面上「未被采纳」的提议：它们不在档案里，清了也不丢东西。 */
      const clearPending = () => {
        setRules((prev) => prev.filter((item) => item.adopted))
        setState({ message: '已清掉未采纳的提议（档案没动）' })
      }

      const adoptAll = async () => {
        const pending = rules.filter((item) => !item.adopted)
        if (pending.length === 0) {
          setState({ message: '没有待采纳的规律' })
          return
        }
        setState({ busy: 'rule' })
        try {
          for (const item of pending) {
            await api('rules-adopt', { root: state.root, profile: state.profileName, rule: item.rule, kind: item.kind })
          }
          setRules((prev) => prev.map((item) => ({ ...item, adopted: true })))
          await refreshProfile()
          setState({ busy: '', message: '采纳了 ' + pending.length + ' 条', error: '' })
        } catch (error) {
          setState({ busy: '', error: errorText(error) })
        }
      }

      let sentenceTotal = 0
      let sentenceRated = 0
      for (const scene of state.scenes) {
        for (const variant of scene.variants) {
          const sentences = splitSentences(variant.text)
          sentenceTotal += sentences.length
          for (let index = 0; index < sentences.length; index += 1) {
            if (markOf(variant, index) !== '') sentenceRated += 1
          }
        }
      }

      const tabs = [
        { id: 'scenes', label: '① 场景 ' + state.scenes.length },
        { id: 'rate', label: '② 句级标注 ' + sentenceRated + '/' + sentenceTotal },
        { id: 'rules', label: '③ 提炼' },
        { id: 'profile', label: '④ 档案' },
      ]
      const btn = (extra) => ({ ...S.btn, ...(extra === undefined ? {} : extra) })
      const primary = (extra) => ({ ...S.btnPrimary, ...(extra === undefined ? {} : extra) })

      return h(
        'div',
        { style: S.overlay, onClick: () => setState({ open: false }) },
        h(
          'div',
          { style: S.panel, onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { style: S.head },
            h('span', { style: S.title }, '🎯 口味闭环'),
            h('button', { style: btn(), onClick: load, disabled: state.busy !== '' }, '重新载入'),
            h('button', { style: btn(), onClick: () => setState({ open: false }) }, '关闭'),
          ),
          // 档案＝一个场景类型（短视频脚本 / 论文 / 小说…）。规律互相不可见，
          // 否则写脚本会被论文的规范拖住、写论文会被脚本的钩子带偏。
          h(
            'div',
            { style: { ...S.row, padding: '10px 16px 0' } },
            h('span', { style: { ...S.label, marginBottom: 0 } }, '档案'),
            h(
              'select',
              {
                style: { ...S.select, width: 'auto', minWidth: 150, cursor: 'pointer' },
                value: state.profileName,
                disabled: state.busy !== '' || state.profiles.length === 0,
                onChange: (event) => switchProfile(event.target.value),
              },
              (state.profiles.length > 0 ? state.profiles : [state.profileName]).map((name) =>
                h('option', { key: name, value: name }, name),
              ),
            ),
            h('input', {
              style: { ...S.input, width: 150 },
              value: profileDraft,
              placeholder: '新档案名',
              onChange: (event) => setProfileDraft(event.target.value),
            }),
            h('button', { style: btn(), onClick: createProfile, disabled: state.busy !== '' }, '新建并切换'),
            h('button', { style: btn(), onClick: renameProfile, disabled: state.busy !== '' }, '改名'),
            h('button', { style: btn(), onClick: deleteProfile, disabled: state.busy !== '' }, '删除'),
          ),
          h(
            'div',
            { style: S.tabs },
            tabs.map((tab) =>
              h(
                'button',
                {
                  key: tab.id,
                  style: btn(state.tab === tab.id ? { ...S.btnPrimary, borderRadius: 999 } : { borderRadius: 999 }),
                  onClick: () => setState({ tab: tab.id }),
                },
                tab.label,
              ),
            ),
          ),
          h(
            'div',
            { style: S.body },

            h(
              'div',
              { style: S.card },
              h('div', { style: S.label }, '存储根目录（档案写到 <根>/.dsh-taste/profiles/<档案>/）'),
              h('input', {
                style: S.input,
                value: state.root,
                onChange: (event) =>
                  setState({ root: event.target.value, loaded: false, scenes: [], profile: '', error: '' }),
              }),
            ),

            state.tab === 'scenes'
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { style: S.card },
                    h('div', { style: S.label }, '场景 = 你的训练材料（只说“写什么”，不写成品）'),
                    h(
                      'div',
                      { style: { ...S.hint, marginBottom: 8 } },
                      '一个场景就是一次真实任务，空行分隔多个。模型按当前档案为每个场景写几篇候选，你只需逐句点好或踩 —— 这就是训练信号。',
                    ),
                    h('textarea', {
                      style: { ...S.area, minHeight: 110 },
                      value: sceneDraft,
                      placeholder:
                        '例：给新手解释什么是量化宽松，两百字，不要比喻。\n\n例：为一款降噪耳机写三条电商详情页标题。\n\n例：把下面这段结论改得更克制：……',
                      onChange: (event) => setSceneDraft(event.target.value),
                    }),
                    h(
                      'div',
                      { style: { ...S.row, marginTop: 8 } },
                      h('button', { style: primary(), onClick: addScenes, disabled: state.busy !== '' }, '加场景'),
                      h('span', { style: S.hint }, '每个场景'),
                      h('input', {
                        style: { ...S.input, width: 56 },
                        value: String(state.variants),
                        onChange: (event) =>
                          setState({ variants: Math.min(5, Math.max(1, Number(event.target.value) || 1)) }),
                      }),
                      h('span', { style: S.hint }, '篇候选'),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.card },
                    h('div', { style: S.label }, '场景列表 ' + state.scenes.length + ' 个'),
                    state.scenes.length === 0
                      ? h('div', { style: S.hint }, '还没有场景。')
                      : state.scenes.map((scene) =>
                          h(
                            'div',
                            { key: scene.id, style: S.scene },
                            h(
                              'div',
                              { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                              h('div', { style: { ...S.text, flex: 1 } }, scene.text),
                              h(
                                'button',
                                { style: { ...S.btn, ...S.btnSm }, onClick: () => removeScene(scene.id) },
                                '删',
                              ),
                            ),
                            scene.variants.length > 0
                              ? h(
                                  'div',
                                  { style: { ...S.hint, marginTop: 6 } },
                                  '已有 ' + scene.variants.length + ' 篇候选',
                                )
                              : null,
                          ),
                        ),
                  ),
                  h(
                    'div',
                    { style: S.row },
                    h(
                      'button',
                      { style: primary(), onClick: generate, disabled: state.busy !== '' },
                      state.busy === 'generate' ? '生成中…（每个场景一次调用）' : '✨ 按场景生成候选',
                    ),
                    h(
                      'span',
                      { style: S.hint },
                      state.profile.trim() === '' ? '当前档案为空 —— 这一轮是冷启动' : '会带上当前档案',
                    ),
                  ),
                )
              : null,

            state.tab === 'rate'
              ? h(
                  'div',
                  { style: S.card },
                  h(
                    'div',
                    { style: S.label },
                    '句级标注 —— 共 ' + sentenceTotal + ' 句，已标 ' + sentenceRated + ' 句',
                  ),
                  h(
                    'div',
                    { style: { ...S.hint, marginBottom: 8 } },
                    '鼠标点每句右边的 👍 / 👎；或键盘：J / K 上下句，G 好，B 踩，空格清除。标到句子，提炼出来的规律才准。',
                  ),
                  sentenceTotal === 0
                    ? h('div', { style: S.hint }, '还没有候选。去「① 场景」点生成。')
                    : state.scenes.map((scene) =>
                        scene.variants.length === 0
                          ? null
                          : h(
                              'div',
                              { key: scene.id, style: S.scene },
                              h('div', { style: { ...S.hint, marginBottom: 6 } }, scene.text),
                              h(
                                'div',
                                { style: S.variants },
                                scene.variants.map((variant) =>
                                  h(VariantRow, {
                                    key: variant.id,
                                    sceneId: scene.id,
                                    variant,
                                    active: state.active,
                                    onActivate: (key) => setState({ active: key }),
                                    onMark: markSentence,
                                    onRemove: removeVariant,
                                  }),
                                ),
                              ),
                            ),
                      ),
                  h(
                    'div',
                    { style: { ...S.row, marginTop: 10 } },
                    h('button', { style: btn(), onClick: generate, disabled: state.busy !== '' }, '✨ 再来一轮'),
                    h('button', { style: primary(), onClick: distill, disabled: state.busy !== '' }, '标完了，提炼'),
                  ),
                )
              : null,

            state.tab === 'rules'
              ? h(
                  'div',
                  { style: S.card },
                  h('div', { style: S.label }, '提炼规律 —— 提炼只是「提议」，采纳与否你逐条点'),
                  h(
                    'div',
                    { style: { ...S.hint, marginBottom: 8 } },
                    '只看同一场景里你赞的句子和你踩的句子差在哪里 —— 这样提炼出的是「怎么写」，不是「写了什么」。勾上的会立刻写进档案；取消勾选会把它从档案里删掉。',
                  ),
                  h(
                    'div',
                    { style: S.row },
                    h(
                      'button',
                      { style: primary(), onClick: distill, disabled: state.busy !== '' },
                      state.busy === 'distill' ? '提炼中…' : '⚗ 提炼规律',
                    ),
                    h(
                      'button',
                      { style: btn(), onClick: refine, disabled: state.busy !== '' || rules.length === 0 },
                      state.busy === 'refine' ? '抽象中…' : '🔍 更通用',
                    ),
                    h(
                      'button',
                      { style: btn(), onClick: clearPending, disabled: state.busy !== '' },
                      '清掉未采纳',
                    ),
                    h('input', {
                      style: { ...S.input, width: 120 },
                      value: state.provider,
                      placeholder: 'provider',
                      onChange: (event) => setState({ provider: event.target.value }),
                    }),
                    h('input', {
                      style: { ...S.input, width: 140 },
                      value: state.model,
                      placeholder: 'model',
                      onChange: (event) => setState({ model: event.target.value }),
                    }),
                    h('span', { style: S.hint }, '留空 = dsh 默认模型'),
                  ),
                  h(
                    'div',
                    { style: { ...S.row, marginTop: 10 } },
                    h(
                      'span',
                      { style: S.hint },
                      '共 ' + rules.length + ' 条 · 已采纳 ' + rules.filter((r) => r.adopted).length + ' 条' +
                        (rules.length > 0 ? ' —— 点文字可改，点「喜欢/避免」可换小节' : ''),
                    ),
                    h('span', { style: { flex: 1 } }),
                    rules.some((r) => !r.adopted)
                      ? h(
                          'button',
                          { style: btn(), onClick: adoptAll, disabled: state.busy !== '' },
                          '全部采纳',
                        )
                      : null,
                  ),
                  rules.length === 0
                    ? h(
                        'div',
                        { style: { ...S.hint, marginTop: 10 } },
                        '还没有规律。先去「② 句级标注」给句子点赞/踩，再回来点提炼。',
                      )
                    : h(
                        'div',
                        { style: { marginTop: 8 } },
                        rules.map((item) =>
                          h(
                            'div',
                            {
                              key: item.id,
                              style: {
                                ...S.ruleRow,
                                opacity: item.adopted ? 1 : 0.78,
                                borderLeftWidth: 3,
                                borderLeftColor: item.kind === 'liked' ? '#2f9e5f' : '#d9534f',
                              },
                            },
                            h('input', {
                              type: 'checkbox',
                              style: S.checkbox,
                              checked: item.adopted,
                              title: item.adopted ? '取消勾选会把它从档案里删掉' : '勾上就写进档案',
                              onChange: (event) => setRuleAdopted(item.id, event.target.checked),
                            }),
                            h(
                              'button',
                              {
                                style: { ...S.btn, ...S.btnSm, flexShrink: 0 },
                                title: '切换这一条属于「喜欢」还是「避免」',
                                onClick: () =>
                                  changeRuleKind(item.id, item.kind === 'liked' ? 'disliked' : 'liked'),
                              },
                              item.kind === 'liked' ? '喜欢' : '避免',
                            ),
                            h('input', {
                              style: S.ruleInput,
                              value: item.rule,
                              onChange: (event) => editRule(item.id, event.target.value),
                            }),
                            h(
                              'span',
                              { style: { ...S.hint, flexShrink: 0, opacity: 0.55 } },
                              item.adopted ? '已进档案' : '待定',
                            ),
                          ),
                        ),
                      ),
                )
              : null,

            state.tab === 'profile'
              ? h(
                  'div',
                  { style: S.card },
                  h('div', { style: S.label }, '写作偏好档案 —— 这就是那份「最合适的提示词」'),
                  h(
                    'div',
                    { style: { ...S.hint, marginBottom: 8 } },
                    '档案由「③ 提炼」里勾选的规律实时生成，所以这里只读。要改就回上一页改那一条。',
                  ),
                  h('textarea', {
                    style: { ...S.area, minHeight: 240, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
                    value: profile,
                    readOnly: true,
                    placeholder: '还没有档案。标几轮、提炼一次、勾选要采纳的规律。',
                  }),
                  h(
                    'div',
                    { style: { ...S.row, marginTop: 8 } },
                    h(
                      'button',
                      { style: btn(), onClick: () => refreshProfile().catch((e) => setState({ error: errorText(e) })) },
                      '刷新',
                    ),
                    h('span', { style: S.hint }, '盘上位置：<根>/.dsh-taste/profile.md；也可直接复制去当提示词。'),
                  ),
                )
              : null,

            state.message !== '' ? h('div', { style: S.hint }, state.message) : null,
            state.error !== '' ? h('div', { style: S.err }, state.error) : null,
          ),
        ),
      )
    }

    function FooterAction() {
      // 不订阅 store：按钮只需要一个开关动作，订阅反而让它跟着每次标注重渲染
      return h(
        'button',
        {
          style: { ...S.btn, display: 'flex', alignItems: 'center' },
          title: '口味闭环：场景 → 模型写 → 逐句点赞踩 → 提炼提示词',
          onClick: () => setState({ open: !state.open }),
        },
        '🎯 口味',
      )
    }

    function OverlayHost() {
      const s = useStore()
      if (!s.open) return null
      return h(Panel, null)
    }

    return {
      name: NS,
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('sidebar.footer.action', () =>
          slots.register({ name: 'sidebar.footer.action', id: 'taste-loop', order: 8 }, () => h(FooterAction, null)),
        )
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'taste-loop', order: 26 }, () => h(OverlayHost, null)),
        )
      },
    }
  },
})
