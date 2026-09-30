/**
 * dsh-taste-loop — node half（宿主半区）
 *
 * 这个插件做一件事：把「点赞/点踩」变成一份能复用的写作提示词。
 *
 * 闭环（作者只提供场景和判断，不提供成品文字）：
 *   场景（训练材料）→ 模型照场景写 N 篇候选 → 作者按**句子**点赞/踩
 *   → 提炼规律（只有规律，没有原文）→ 作者**逐条勾选**采纳 → 写进 profile.md
 *   → 下一轮生成带着 profile.md 写，并避开被踩过的**具体句子**
 *
 * 为什么颗粒度必须是句子：
 * - 整篇的"好/坏"太钝 —— 一篇里有好句子也有坏句子，整篇判好等于把坏句子也
 *   当成正面例子教给模型（反之亦然）。句级标注才是干净的训练信号。
 * - 回灌时也更精准："这句别再写"能直接照做，"这篇别重演"只能靠猜。
 *
 * 为什么采纳也要逐条：
 * 提炼出来的规律里总有一两条是模型自行发挥、并不代表作者的。整批采纳会把它们
 * 一起写进档案，下一轮就照错的写。所以提炼只是**提议**，档案的每一次变化都由
 * 作者逐条点出来；取消勾选会把它从档案里删掉（不是只取消显示）。
 *
 * 为什么档案要分场景：
 * 短视频脚本要「前 3 秒钩子」，论文要「论证力度」—— 这两套规律混在一个档案里
 * 会互相污染：写脚本时被论文的规范拖住，写论文时被脚本的钩子带偏。所以每个场景
 * 类型一份独立档案（各自的规律 + 各自的训练材料），互不可见。
 *
 * 存储布局（`<根>/.dsh-taste/`）：
 *   index.json              档案清单 + 上次用的那个
 *   profiles/<档案>/profile.md   只有规律 —— 唯一该进写稿上下文的东西
 *   profiles/<档案>/state.json   场景 + 候选原文 + 每句的点赞/踩 —— 给人看、给提炼当输入
 *   废纸篓/<档案>-<时间戳>/       删掉的档案挪到这里，不直接删
 *
 * 旧布局（`<根>/.dsh-taste/profile.md` + `state.json`）在第一次读到时自动迁移成
 * 名为「默认」的档案，原有内容一个字节不动。
 *
 * 为什么档案里不能放原文：原文一轮几千字，带两轮上下文就满了；规律是几百字节，
 * 每一轮都带得动。模型记住「怎么写」能迁移到新场景，记住「这几句长什么样」只会抄。
 *
 * 落点随作品走，不写全局配置。
 */
import { readFile, writeFile, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-taste-loop'

const NS = 'dsh-taste-loop'
const API_PREFIX = '/taste-loop/api/'
const STATE_DIR = '.dsh-taste'
const INDEX_FILE = 'index.json'
const PROFILES_DIR = 'profiles'
const TRASH_DIR = '废纸篓'
const STATE_FILE = 'state.json'
const PROFILE_FILE = 'profile.md'
const DEFAULT_PROFILE = '默认'
/** 同时允许的最多档案数：再多就不叫"分场景"了。 */
const MAX_PROFILES = 40

/** 档案的两个小节：模型按节名输出，这两个标题必须和提示词里的名字一致。 */
const SECTION_LIKED = '已验证偏好（喜欢，继续用）'
const SECTION_DISLIKED = '避免的写法（明确否决，不要出现）'
const PROFILE_TITLE = '# 写作偏好档案'
const PROFILE_NOTE = '> 由 dsh-taste-loop 从场景候选的句级点赞/踩里提炼。只有规律，没有原文。'

/** 单篇候选原文上限。 */
const TEXT_CHARS = 6000
/** 一句话的上限：中文长句罕见超过这个长度，超了就截断，避免单句撑爆状态文件。 */
const SENTENCE_CHARS = 600
/** 单篇候选最多保留多少句标注（防手抖、防超长稿）。 */
const MAX_MARKS = 400
const MAX_SCENES = 200
const MAX_VARIANTS = 60
/** 提炼时每条句子最多带这么多字进模型。 */
const DISTILL_CLIP = 240
/** 被否决/被认可的句子回灌时每条带多少字。 */
const REGURGITATE_CLIP = 200
/** 回灌句子的条数上限：太多了会挤掉场景与档案。 */
const REGURGITATE_MAX = 12
/** 一条规律的长度上限（提示词要求 40 字，这里给足余量，也防模型写成长段）。 */
const RULE_CHARS = 80
/** 档案里最多保留多少条规律：再多就不是"档案"而是"摘抄"了。 */
const MAX_RULES = 200
const GEN_MAX_TOKENS = 3000
const DISTILL_MAX_TOKENS = 2400
/** 压缩/生成任务关掉推理档：不关的话思考链会吃掉输出预算，正文可能一个字都没有。 */
const REASONING_OFF = 'off'

const WRITER_SYSTEM = [
  '你是一名写手。作者会给你一个场景（他的真实任务）、他的偏好档案（从以往句级点赞点踩里提炼的规律），以及同一个场景下他已经明确否决过的句子。',
  '',
  '铁律：',
  '1. 只输出成品正文，不要开场白、不要解释、不要 markdown 代码围栏、不要小标题。',
  '2. 档案里「避免的写法」一条都不要出现。',
  '3. 「已被否决的句子」代表作者不接受的路子 —— 不要重演那种写法的**路数**（句式、口气、信息给法），而不是只换几个词。',
  '4. 「作者认可过的句子」代表他接受的写法：学它们的做法，但不要抄句子、不要复用内容。',
  '5. 不要发明场景和档案之外的设定、数据、人名、术语。',
  '6. 长度按场景要求；场景没写就写到能把这件事说清楚为止。',
].join('\n')

const DISTILL_SYSTEM = [
  '你是一位极其擅长反向提炼写作规律的资深编辑。作者给你的是：一组场景，每个场景下模型写了几篇候选，而作者**逐句**点了赞或踩。',
  '',
  '你的任务：反推出可复用的写法规律，产出一份能直接当作写稿提示词用的偏好档案。',
  '',
  '关键 —— 必须做**同场景内对比**：',
  '把同一个场景里被赞的句子和被踩的句子摆在一起看，它们差在哪里，才是规律所在。',
  '跨场景归纳很容易把「写的是什么」当成「怎么写」，那是废规律，换到新场景一点用没有。',
  '',
  '铁律：',
  '1. 只输出规律，绝不抄原文、绝不引用原句、绝不描述某一句具体内容。',
  '2. 一条规律只讲一件事，不超过 40 个字，写「怎么做」而不是「好/不好」这种评价。',
  '3. 规律要能解释好几个场景里的取舍；只在一个场景、一句话上成立的细节不要写。',
  '4. 宁可少写几条，也不要写空话（不写「更生动」「更细腻」这种无法照做的词）。',
  '5. 已有的规律不要重复输出。',
  '',
  '输出格式：只输出一个 JSON 对象，不要解释文字、不要 markdown 代码围栏。',
  '{"liked":[{"rule":"规律"}],"disliked":[{"rule":"规律"}]}',
  '',
  'liked = 作者喜欢、该继续用的写法；disliked = 作者明确否决、该避免的写法。',
].join('\n')

const REFINE_SYSTEM = [
  '你是一位资深写作教练。作者手上有一批从具体场景里提炼出来的写作规律，他想看看**更一般**的说法。',
  '',
  '你的任务：把这些规律往上抽一层 —— 去掉与具体场景、具体句子绑定的成分，留下可迁移的写作决策。',
  '',
  '判定标准：',
  '- 抽完的规律要能同时覆盖原来好几条，而不只是换几个词。',
  '- 抽完的规律必须仍然**可照做**。最忌讳的是抽成「要写得好」「要自然」「要有感染力」这种谁都能说、谁都不会做的话。',
  '- 如果某条规律本身已经足够一般，就原样保留，不要为了"更一般"而把它抽空。',
  '',
  '铁律：',
  '1. 只输出规律，绝不抄原文、绝不引用原句。',
  '2. 一条规律只讲一件事，不超过 40 个字。',
  '3. 不要把若干条不同的规律合并成一条又长又含糊的。',
  '',
  '输出格式：只输出一个 JSON 对象，不要解释文字、不要 markdown 代码围栏。',
  '{"rules":[{"rule":"规律","kind":"liked"}]}',
  '',
  'kind 取 liked（作者喜欢的写法）或 disliked（作者否决的写法），沿用输入里标给它的那个。',
].join('\n')

const configSchema = z.object({
  root: z.string().default('').description('作品根目录（绝对路径）。留空则用面板里填的那个。'),
  profile: z.string().default('').description('默认档案名。留空则用上次在面板里选的那个。'),
  enabled: z.boolean().default(true).description('关闭后 /taste-loop/api/* 整体返回 503'),
  provider: z.string().default('').description('提炼/生成用的 provider，留空用 dsh 当前默认模型'),
  model: z.string().default('').description('提炼/生成用的 model，留空用 dsh 当前默认模型'),
  variants: z.number().default(3).description('每个场景生成几篇候选（1-5）'),
})

// 0.2.0 起 settings.register 被删掉，改成插件导出 Config，由 dsh 按它自动生成设置页
// 并把解析好的默认值当 apply 的第二个参数传进来；0.1.5 不看这个导出，仍走下面的 register 分支。
export const Config = configSchema

/** 去掉控制字符与首尾空白。 */
const cleanText = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()

const clip = (value, max) => {
  const one = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}

/** 规律文本的归一化：只用于「这条是不是已经在档案里」的判断，不改写原文本。 */
const normRule = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, '')
    .replace(/[。．.,，、；;：:!！?？"'“”‘’()（）[\]【】]/g, '')
    .trim()

/**
 * 档案名 → 可安全当目录名用。
 * 换掉路径分隔符、通配符与保留字符；空名回落到「默认」。
 * 这是在写盘之前唯一的防线：名字直接进路径，不校验就能写到档案目录外面去。
 */
function safeProfileName(value) {
  const raw = cleanText(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  const name = raw === '' ? DEFAULT_PROFILE : raw
  return name.slice(0, 40)
}

/** 面板传入的根目录必须是绝对路径：相对路径在不同 cwd 下会写到意外的位置。 */
function asRoot(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (raw === '') throw new Error('缺少存储根目录：请在面板顶部填写一个绝对路径')
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\')) {
    return raw.replace(/[\\/]+$/, '')
  }
  throw new Error('存储根目录必须是绝对路径（如 E:\\codex\\project），当前是：' + raw)
}

const stateDirOf = (root) => join(root, STATE_DIR)
const indexPathOf = (root) => join(stateDirOf(root), INDEX_FILE)
const profilesDirOf = (root) => join(stateDirOf(root), PROFILES_DIR)
const profileDirOf = (root, profile) => join(profilesDirOf(root), profile)
const statePathOf = (root, profile) => join(profileDirOf(root, profile), STATE_FILE)
const profilePathOf = (root, profile) => join(profileDirOf(root, profile), PROFILE_FILE)

const isLoopback = (req) => {
  const addr = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '').toLowerCase()
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost'
}

/** 读请求体（JSON），带大小上限。 */
function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve({ __error: '请求体过大' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({ __error: '请求体不是合法 JSON' })
      }
    })
    req.on('error', () => resolve({ __error: '读取请求体失败' }))
  })
}

/**
 * 清一篇候选的句级标注。
 * 句子原文与序号都存下来 —— 界面上可以直接显示"被踩的那一句"，
 * 回灌提示词时也不必重新切句（正文改了也不会错位）。
 */
function cleanMarks(value) {
  const out = []
  if (!Array.isArray(value)) return out
  for (const item of value) {
    if (out.length >= MAX_MARKS) break
    if (item === null || typeof item !== 'object') continue
    const rating = item.rating === 'good' || item.rating === 'bad' ? item.rating : ''
    if (rating === '') continue
    const index = Number.isInteger(item.index) && item.index >= 0 ? item.index : out.length
    const text = cleanText(item.text).slice(0, SENTENCE_CHARS)
    if (text === '') continue
    out.push({ index, text, rating })
  }
  out.sort((a, b) => a.index - b.index)
  return out
}

/** 把面板传来的场景清成安全结构：只保留认识的字段，逐层限长限量。 */
function cleanScenes(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (out.length >= MAX_SCENES) break
    if (item === null || typeof item !== 'object') continue
    const text = cleanText(item.text).slice(0, TEXT_CHARS)
    if (text === '') continue
    const variants = []
    const rawVariants = Array.isArray(item.variants) ? item.variants : []
    for (const variant of rawVariants) {
      if (variants.length >= MAX_VARIANTS) break
      if (variant === null || typeof variant !== 'object') continue
      const body = cleanText(variant.text).slice(0, TEXT_CHARS)
      if (body === '') continue
      const rating = variant.rating === 'good' || variant.rating === 'bad' ? variant.rating : ''
      variants.push({
        id: String(variant.id === undefined ? '' : variant.id).slice(0, 64) || 'v' + variants.length,
        label: clip(variant.label, 60),
        text: body,
        rating,
        marks: cleanMarks(variant.marks),
        at: clip(variant.at, 40),
      })
    }
    out.push({
      id: String(item.id === undefined ? '' : item.id).slice(0, 64) || 's' + out.length,
      text,
      variants,
      at: clip(item.at, 40),
    })
  }
  return out
}

/**
 * 等一批服务就绪。
 *
 * 实机踩到的问题（dsh-novel-craft 作者记下的同一个坑）：插件行的 apply 可能早于
 * 服务挂载，同步 apply 里 ctx.get('webServer') 会是 undefined，于是插件静默什么都不做。
 * 所以用 ctx.inject 等它们到位；等不到（headless profile 没有 web 服务）就退出。
 */
function awaitServices(ctx, names, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      ctx.inject(names, (ready) => finish(ready))
    } catch {
      finish(null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
  })
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readTextSafe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function writeText(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** 解析模型输出里的 JSON 对象（容忍代码围栏与前后废话）。 */
function parseJson(text) {
  const raw = String(text).replace(/```[a-zA-Z]*/g, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('模型没有按 JSON 格式输出，无法解析')
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    throw new Error('模型输出的 JSON 解析失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 读档案里的规律条目（`- 文本`，按小节分 kind）。
 * 档案是作者可手改的纯 markdown，所以解析要宽容：只认标题与列表项，别的一律忽略。
 */
function parseProfileRules(text) {
  const out = []
  let kind = null
  for (const raw of String(text === undefined || text === null ? '' : text).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (/^#{1,6}\s/.test(line)) {
      if (/避免|不喜欢|不要做/.test(line)) kind = 'disliked'
      else if (/喜欢|偏好|要学|已验证/.test(line)) kind = 'liked'
      else kind = null
      continue
    }
    if (kind === null) continue
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item === null) continue
    const body = item[1].replace(/[`*]/g, '').trim()
    if (body === '' || body.length < 4) continue
    if (/^（还没有）$/.test(body)) continue
    out.push({ kind, rule: clip(body, RULE_CHARS) })
  }
  return out
}

/** 把规律条目写成档案。 */
function buildProfile(liked, disliked, at) {
  const lines = [PROFILE_TITLE, '', PROFILE_NOTE, '', '> 最后更新：' + at, '', '## ' + SECTION_LIKED, '']
  if (liked.length === 0) lines.push('- （还没有）')
  for (const item of liked) lines.push('- ' + item)
  lines.push('', '## ' + SECTION_DISLIKED, '')
  if (disliked.length === 0) lines.push('- （还没有）')
  for (const item of disliked) lines.push('- ' + item)
  lines.push('')
  return lines.join('\n')
}

/** 清一批模型给出的规律条目，逐条去重。 */
function cleanRules(value, fallbackKind) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(value)) return out
  for (const item of value) {
    if (out.length >= MAX_RULES) break
    if (item === null || typeof item !== 'object') continue
    const rule = clip(item.rule, RULE_CHARS)
    if (rule === '') continue
    const key = normRule(rule)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const kind = item.kind === 'disliked' || item.kind === 'liked' ? item.kind : fallbackKind
    out.push({ kind: kind === 'disliked' ? 'disliked' : 'liked', rule })
  }
  return out
}

export async function apply(ctx, config = {}) {
  const ready = await awaitServices(ctx, ['settings', 'webServer'], 15000)
  // 0.2.0 里 settings 服务还在，只是删掉了 register：不能因为 settings 缺了就提前退出，
  // 真正必须的只有 webServer。
  if (ready === null || ready.webServer === undefined) return

  // 0.1.5：settings.register(ns, schema) 返回一个 scope，配置从 scope.get() 读。
  // 0.2.0：register 没了，改成插件导出 Config（见文件上方），由 dsh 解析默认值后当第二个参数传进来。
  const legacy = ready.settings !== undefined && typeof ready.settings.register === 'function'
  const scope = legacy ? await ready.settings.register(NS, configSchema) : null
  const cfg = () => (legacy ? scope.get() : config)
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')

  /** 每个 root 的档案索引在进程内缓存一份（列表目录要多次读，读盘太碎）。 */
  const indexCache = new Map()

  const readIndex = async (root) => {
    const cached = indexCache.get(root)
    if (cached !== undefined) return cached
    let parsed = null
    const raw = await readTextSafe(indexPathOf(root))
    if (raw !== '') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    const doc = parsed !== null && typeof parsed === 'object' ? parsed : {}
    const list = Array.isArray(doc.profiles)
      ? doc.profiles.map((item) => safeProfileName(item)).filter((item, i, arr) => arr.indexOf(item) === i)
      : []
    const index = {
      profiles: list,
      last: typeof doc.last === 'string' ? safeProfileName(doc.last) : '',
    }
    indexCache.set(root, index)
    return index
  }

  const writeIndex = async (root, index) => {
    const next = {
      profiles: [...new Set(index.profiles.map((item) => safeProfileName(item)))].slice(0, MAX_PROFILES),
      last: safeProfileName(index.last),
      updatedAt: new Date().toISOString(),
    }
    await writeText(indexPathOf(root), JSON.stringify(next, null, 2))
    indexCache.set(root, next)
    return next
  }

  /** 目录里真实存在的档案（索引丢了也能恢复出列表）。 */
  const scanProfiles = async (root) => {
    try {
      const entries = await readdir(profilesDirOf(root), { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  /**
   * 把旧布局迁成「默认」档案。
   *
   * 旧版把 profile.md 与 state.json 直接放在 .dsh-taste/ 下。迁移是**拷贝**不是移动：
   * 万一作者还留着旧版本的插件行，旧路径仍然可读，不会突然读不到东西。
   */
  const migrateLegacy = async (root) => {
    const legacyProfile = join(stateDirOf(root), PROFILE_FILE)
    const legacyState = join(stateDirOf(root), STATE_FILE)
    const hasProfile = await exists(legacyProfile)
    const hasState = await exists(legacyState)
    if (!hasProfile && !hasState) return false
    const dir = profileDirOf(root, DEFAULT_PROFILE)
    await mkdir(dir, { recursive: true })
    if (hasProfile) {
      const target = profilePathOf(root, DEFAULT_PROFILE)
      if (!(await exists(target))) {
        await writeText(target, await readTextSafe(legacyProfile))
      }
    }
    if (hasState) {
      const target = statePathOf(root, DEFAULT_PROFILE)
      if (!(await exists(target))) {
        await writeText(target, await readTextSafe(legacyState))
      }
    }
    return true
  }

  /**
   * 解析出这次请求该用哪个档案。
   * 优先级：面板显式指定 → 索引里"上次用的" → 设置里的默认 → 目录里第一个 → 新建「默认」。
   * 旧的单档案布局在这里被迁移。
   */
  const resolveProfile = async (root, wanted) => {
    let index = await readIndex(root)
    if (index.profiles.length === 0) {
      const migrated = await migrateLegacy(root)
      const scanned = await scanProfiles(root)
      if (scanned.length > 0) {
        index = await writeIndex(root, { profiles: scanned, last: index.last })
      } else if (migrated) {
        index = await writeIndex(root, { profiles: [DEFAULT_PROFILE], last: DEFAULT_PROFILE })
      }
    }
    const requested = cleanText(wanted)
    let name = ''
    if (requested !== '') name = safeProfileName(requested)
    else if (index.last !== '') name = index.last
    else if (cleanText(cfg().profile) !== '') name = safeProfileName(cfg().profile)
    else if (index.profiles.length > 0) name = index.profiles[0]
    else name = DEFAULT_PROFILE
    return { index, name }
  }

  /** 面板首屏：档案清单 + 当前档案的场景 + 规律。 */
  const readPanel = async (root, wanted) => {
    const { index, name } = await resolveProfile(root, wanted)
    const raw = await readTextSafe(statePathOf(root, name))
    let parsed = null
    if (raw !== '') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    const doc = parsed !== null && typeof parsed === 'object' ? parsed : {}
    const profile = await readTextSafe(profilePathOf(root, name))
    const ruled = parseProfileRules(profile)
    return {
      root,
      profileName: name,
      profiles: index.profiles.length > 0 ? index.profiles : [name],
      scenes: cleanScenes(doc.scenes),
      profile,
      liked: ruled.filter((item) => item.kind === 'liked').map((item) => item.rule),
      disliked: ruled.filter((item) => item.kind === 'disliked').map((item) => item.rule),
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
    }
  }

  const readState = async (root, name) => {
    const { name: resolved } = await resolveProfile(root, name)
    const raw = await readTextSafe(statePathOf(root, resolved))
    let parsed = null
    if (raw !== '') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    const doc = parsed !== null && typeof parsed === 'object' ? parsed : {}
    return { name: resolved, scenes: cleanScenes(doc.scenes) }
  }

  const writeState = async (root, name, scenes) => {
    const { name: resolved } = await resolveProfile(root, name)
    await writeText(statePathOf(root, resolved), JSON.stringify({ scenes, updatedAt: new Date().toISOString() }, null, 2))
    // 旧布局仍然同步一份：只在「默认」档案上做，旧版本插件行还挂着时不至于读到空
    if (resolved === DEFAULT_PROFILE) {
      await writeText(join(stateDirOf(root), STATE_FILE), JSON.stringify({ scenes, updatedAt: new Date().toISOString() }, null, 2))
      const legacyProfile = profilePathOf(root, resolved)
      if (await exists(legacyProfile)) {
        await writeText(join(stateDirOf(root), PROFILE_FILE), await readTextSafe(legacyProfile))
      }
    }
    return resolved
  }

  const readProfileRules = async (root, name) => {
    const { name: resolved } = await resolveProfile(root, name)
    const text = await readTextSafe(profilePathOf(root, resolved))
    const rules = parseProfileRules(text)
    return {
      name: resolved,
      text,
      liked: rules.filter((item) => item.kind === 'liked').map((item) => item.rule),
      disliked: rules.filter((item) => item.kind === 'disliked').map((item) => item.rule),
    }
  }

  /** 走哪条模型路由：设置里指定了就用它，否则用 dsh 当前的默认模型。 */
  const resolveRoute = (override) => {
    const provider = String(override?.provider ?? cfg().provider ?? '').trim()
    const model = String(override?.model ?? cfg().model ?? '').trim()
    if (provider !== '' && model !== '') return { provider, model }
    if (defaultModel !== undefined && typeof defaultModel.currentSelection === 'function') {
      let selection
      try {
        selection = defaultModel.currentSelection()
      } catch {
        selection = undefined
      }
      const chosenProvider = String(selection?.provider ?? '').trim()
      const chosenModel = String(selection?.model ?? '').trim()
      if (chosenProvider !== '' && chosenModel !== '') return { provider: chosenProvider, model: chosenModel }
    }
    return null
  }

  /**
   * 一次性的辅助模型调用：流式收完拼成纯文本。
   * 不依赖 @deepseek-ai/dsh-llm 的辅助函数（那是 npm 插件的写法）：
   * 这里手工拼 Message，只用到 llm.stream 这一个公开方法。
   */
  const callModel = async (route, system, user, maxTokens) => {
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('这个 dsh 没有挂载 llm 服务，无法调用模型')
    }
    const build = (useEffort) => ({
      provider: route.provider,
      model: route.model,
      system,
      messages: [
        {
          id: 'taste-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: name },
        },
      ],
      maxTokens,
      ...(useEffort ? { reasoningEffort: REASONING_OFF } : {}),
      signal: AbortSignal.timeout(180000),
    })
    const run = async (useEffort) => {
      let text = ''
      let reason = 'stop'
      let failure = ''
      for await (const chunk of llm.stream(build(useEffort))) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') {
          reason = chunk.reason?.kind ?? 'stop'
          if (chunk.reason?.failure !== undefined) failure = String(chunk.reason.failure.message ?? '')
        }
      }
      return { text, reason, failure }
    }
    let result
    try {
      result = await run(true)
    } catch (error) {
      // 换到不认这个推理档位的模型时退一步再试（别的错误照抛）
      const message = error instanceof Error ? error.message : String(error)
      if (!/reasoning/i.test(message)) throw error
      result = await run(false)
    }
    if (result.reason === 'error' || result.reason === 'aborted') {
      throw new Error('模型调用失败：' + (result.failure === '' ? result.reason : result.failure))
    }
    if (result.text.trim() === '') throw new Error('模型没有输出正文（可能把预算全用在思考上了）')
    if (result.reason === 'max-tokens') throw new Error('模型输出被长度上限截断：把场景写短一点，或减少候选篇数')
    return result.text
  }

  /**
   * 逐条改档案：adopt 加一条，unadopt 删一条（按归一化文本匹配，忽略 kind ——
   * 作者改过措辞也能删掉）。
   *
   * 为什么是逐条而不是整份覆盖：整份覆盖会让"取消勾选"变成"删掉所有没勾的"，
   * 作者手写在档案里的东西会被顺手抹掉。逐条操作只碰他点过的那一条。
   */
  const mutateProfile = async (root, profileName, payload) => {
    const current = await readProfileRules(root, profileName)
    const text = cleanText(payload.rule).slice(0, RULE_CHARS)
    if (text === '') throw new Error('规律文本是空的')
    const kind = payload.kind === 'disliked' ? 'disliked' : 'liked'
    const key = normRule(text)
    const drop = (list) => list.filter((item) => normRule(item) !== key)
    let liked = drop(current.liked)
    let disliked = drop(current.disliked)
    if (payload.action === 'adopt') {
      if (kind === 'liked') liked = [...liked, text]
      else disliked = [...disliked, text]
    } else if (payload.action !== 'unadopt') {
      throw new Error('未知操作：' + String(payload.action))
    }
    const at = new Date().toISOString()
    await writeText(profilePathOf(root, current.name), buildProfile(liked, disliked, at))
    if (current.name === DEFAULT_PROFILE) {
      await writeText(join(stateDirOf(root), PROFILE_FILE), buildProfile(liked, disliked, at))
    }
    return { ok: true, profileName: current.name, liked, disliked, path: profilePathOf(root, current.name), at }
  }

  const webServer = ready.webServer
  if (typeof webServer.register !== 'function') return

  console.log('[taste-loop] ' + name + ' 就绪 · ' + (legacy ? '0.1.x settings.register 模式' : '0.2.x Config 模式'))

  const route = (path, handler) => {
    webServer.register({
      kind: 'exact',
      path: API_PREFIX + path,
      handler: (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        if (!isLoopback(req)) {
          send(403, { error: 'taste-loop api is loopback-only' })
          return
        }
        if (cfg().enabled === false) {
          send(503, { error: 'taste-loop disabled' })
          return
        }
        Promise.resolve()
          .then(async () => {
            const body = req.method === 'POST' ? await readJsonBody(req) : {}
            if (body.__error !== undefined) {
              send(413, { error: body.__error })
              return
            }
            const result = await handler(body, req)
            if (!res.writableEnded) send(200, result)
          })
          .catch((error) => {
            if (!res.writableEnded) send(400, { error: error instanceof Error ? error.message : String(error) })
          })
      },
    })
  }

  /** 面板首屏：档案清单 + 当前档案的场景 + 候选 + 句级标注 + 规律。 */
  route('state', async (body) => {
    const root = cfg().root !== '' ? cfg().root : String(body.root ?? '')
    if (String(root).trim() === '') {
      return { root: '', profileName: '', profiles: [], scenes: [], profile: '', liked: [], disliked: [] }
    }
    return await readPanel(asRoot(root), body.profile)
  })

  /** 档案清单（面板切换用）。 */
  route('profiles', async (body) => {
    const root = asRoot(body.root)
    const { index, name } = await resolveProfile(root, body.profile)
    const known = index.profiles.length > 0 ? index.profiles : [name]
    return { profiles: known, profileName: name, root }
  })

  /** 新建档案：同名视为"切过去"，不覆盖已有内容。 */
  route('profile-create', async (body) => {
    const root = asRoot(body.root)
    const name = safeProfileName(body.name)
    const { index } = await resolveProfile(root, '')
    if (!index.profiles.includes(name) && index.profiles.length >= MAX_PROFILES) {
      throw new Error('档案太多了（上限 ' + MAX_PROFILES + ' 个）')
    }
    await mkdir(profileDirOf(root, name), { recursive: true })
    const next = [...new Set([...index.profiles, name])]
    await writeIndex(root, { profiles: next, last: name })
    const panel = await readPanel(root, name)
    return { ...panel, created: true }
  })

  /** 重命名：挪目录 + 改索引。目标已存在时拒绝，不合并。 */
  route('profile-rename', async (body) => {
    const root = asRoot(body.root)
    const from = safeProfileName(body.from)
    const to = safeProfileName(body.to)
    if (from === to) return await readPanel(root, from)
    const { index } = await resolveProfile(root, from)
    if (!index.profiles.includes(from)) throw new Error('没有这个档案：' + from)
    if (index.profiles.includes(to)) throw new Error('已经有同名档案了：' + to)
    await mkdir(profilesDirOf(root), { recursive: true })
    await rename(profileDirOf(root, from), profileDirOf(root, to))
    const next = index.profiles.map((item) => (item === from ? to : item))
    await writeIndex(root, { profiles: next, last: to })
    return await readPanel(root, to)
  })

  /**
   * 删除档案：挪到 `废纸篓/<档案>-<时间戳>/`，不直接删。
   * 档案是攒出来的东西，误点一下全没了最不可接受。
   */
  route('profile-delete', async (body) => {
    const root = asRoot(body.root)
    const name = safeProfileName(body.name)
    const { index } = await resolveProfile(root, name)
    if (!index.profiles.includes(name)) throw new Error('没有这个档案：' + name)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trash = join(stateDirOf(root), TRASH_DIR, name + '-' + stamp)
    await mkdir(dirname(trash), { recursive: true })
    await rename(profileDirOf(root, name), trash)
    const next = index.profiles.filter((item) => item !== name)
    const last = next.length > 0 ? next[0] : DEFAULT_PROFILE
    await writeIndex(root, { profiles: next, last })
    return {
      deleted: name,
      trash,
      ...(await readPanel(root, last)),
    }
  })

  /** 只存当前档案的场景与候选。 */
  route('save', async (body) => {
    const root = asRoot(body.root)
    const scenes = cleanScenes(body.scenes)
    const resolved = await writeState(root, body.profile, scenes)
    const { index } = await resolveProfile(root, resolved)
    await writeIndex(root, {
      profiles: index.profiles.includes(resolved) ? index.profiles : [...index.profiles, resolved],
      last: resolved,
    })
    return { ok: true, profileName: resolved, scenes: scenes.length }
  })

  /** 读档案（面板载入用）。 */
  route('get-profile', async (body) => {
    const { index, name } = await resolveProfile(asRoot(body.root), body.profile)
    const parsed = await readProfileRules(asRoot(body.root), name)
    return {
      found: parsed.text.trim() !== '',
      profile: parsed.text,
      path: profilePathOf(asRoot(body.root), parsed.name),
      profileName: parsed.name,
      profiles: index.profiles.length > 0 ? index.profiles : [name],
      liked: parsed.liked,
      disliked: parsed.disliked,
    }
  })

  /** 逐条采纳 / 取消采纳。 */
  route('rules-adopt', async (body) => {
    const root = asRoot(body.root)
    return await mutateProfile(root, body.profile, { action: 'adopt', rule: body.rule, kind: body.kind })
  })

  route('rules-unadopt', async (body) => {
    const root = asRoot(body.root)
    return await mutateProfile(root, body.profile, { action: 'unadopt', rule: body.rule, kind: body.kind })
  })

  /**
   * 为当前档案生成候选。
   *
   * 每个场景一次调用（不是一次调用生成全部）：单篇失败只影响那一篇，作者也能中途停。
   * 代价是调用次数等于 场景数 × 候选篇数。
   *
   * 回灌用**句级**：被踩过的句子按"别再写这类"回去，被赞过的按"写这类"回去 ——
   * 比整篇回灌精准，也不会把一篇里的坏句子当成好例子教进去。
   */
  route('generate', async (body) => {
    const root = asRoot(body.root)
    const resolved = await resolveProfile(root, body.profile)
    const scenes = cleanScenes(body.scenes)
    if (scenes.length === 0) throw new Error('至少要有一个场景')
    const routePick = resolveRoute(body)
    if (routePick === null) {
      throw new Error('读不到默认模型：请在 dsh 里设置默认模型，或在设置里填 provider / model')
    }
    const profile = typeof body.profileText === 'string' && body.profileText.trim() !== ''
      ? body.profileText
      : await readTextSafe(profilePathOf(root, resolved.name))
    const requested = Number.isInteger(body.variants) ? body.variants : cfg().variants
    const variants = Math.min(5, Math.max(1, Number.isInteger(requested) ? requested : 3))
    const round = Date.now()
    const failed = []
    let created = 0

    for (const scene of scenes) {
      const goodSentences = []
      const badSentences = []
      for (const variant of scene.variants) {
        for (const mark of variant.marks) {
          if (mark.rating === 'good') goodSentences.push(mark.text)
          else badSentences.push(mark.text)
        }
      }
      const extra = []
      if (goodSentences.length > 0) {
        extra.push('', '【作者逐句认可过的（写这类）】', '')
        for (const text of goodSentences.slice(-REGURGITATE_MAX)) extra.push('- ' + clip(text, REGURGITATE_CLIP))
        extra.push('')
      }
      if (badSentences.length > 0) {
        extra.push('', '【作者逐句否决过的（不要重演这类写法）】', '')
        for (const text of badSentences.slice(-REGURGITATE_MAX)) extra.push('- ' + clip(text, REGURGITATE_CLIP))
        extra.push('')
      }
      const head = ['【场景】', '', scene.text, '']
      if (profile.trim() !== '') head.push('【作者偏好档案（必须遵守）】', '', profile.trim(), '')
      const base = head.concat(extra).join('\n')

      for (let index = 0; index < variants; index += 1) {
        const attempt = index + 1
        const lines = [base, '', '【本次要求】', '']
        lines.push('为上面这个场景写第 ' + attempt + ' 篇候选（共 ' + variants + ' 篇）。')
        lines.push(
          variants > 1
            ? '这一篇必须与同批其它候选在**写法决策**上真正不同（不是换词、换形容、换句式），也不要重复已否决的写法。'
            : '直接写出你认为最合适的一篇。',
        )
        lines.push('', '只输出成品正文。')
        try {
          const text = cleanText(await callModel(routePick, WRITER_SYSTEM, lines.join('\n'), GEN_MAX_TOKENS))
          if (text === '') continue
          created += 1
          scene.variants.push({
            id: 'v' + round + '-' + scene.id + '-' + attempt,
            label: '第 ' + attempt + ' 篇',
            text: text.slice(0, TEXT_CHARS),
            rating: '',
            marks: [],
            at: new Date().toISOString(),
          })
        } catch (error) {
          failed.push(error instanceof Error ? error.message : String(error))
        }
      }
    }

    const name = await writeState(root, resolved.name, scenes)
    return {
      scenes,
      created,
      failed,
      round,
      profileName: name,
      provider: routePick.provider,
      model: routePick.model,
    }
  })

  /**
   * 提炼规律：按场景分组，把每句标注摆出来做对比。
   *
   * 这是整条链路的枢纽 —— 提炼出来的必须是「怎么写」，不是「写了什么」。
   * 返回的只是**提议**：客户端的勾选状态由档案决定，采纳与否逐条由作者点。
   */
  route('distill', async (body) => {
    const root = asRoot(body.root)
    const resolved = await resolveProfile(root, body.profile)
    const incoming = Array.isArray(body.scenes) && body.scenes.length > 0 ? cleanScenes(body.scenes) : null
    const scenes = incoming !== null ? incoming : (await readState(root, resolved.name)).scenes
    const routePick = resolveRoute(body)
    if (routePick === null) {
      throw new Error('读不到默认模型：请在 dsh 里设置默认模型，或在设置里填 provider / model')
    }

    const groups = []
    for (const scene of scenes) {
      const good = []
      const bad = []
      for (const variant of scene.variants) {
        for (const mark of variant.marks) {
          if (mark.rating === 'good') good.push(mark.text)
          else bad.push(mark.text)
        }
      }
      if (good.length === 0 && bad.length === 0) continue
      groups.push({ scene: scene.text, good, bad })
    }
    if (groups.length === 0) throw new Error('还没有任何标注：先给候选里的句子点几个赞或踩，再来提炼')

    const lines = ['请对比每个场景内被赞的句子与被踩的句子，提炼出跨场景通用的写法规律。', '']
    groups.forEach((group, index) => {
      lines.push('=== 场景 ' + (index + 1) + ' ===', '', clip(group.scene, 300), '')
      if (group.good.length > 0) {
        lines.push('--- 作者点赞的句子 ---', '')
        for (const text of group.good) lines.push('- ' + clip(text, DISTILL_CLIP))
        lines.push('')
      }
      if (group.bad.length > 0) {
        lines.push('--- 作者踩过的句子 ---', '')
        for (const text of group.bad) lines.push('- ' + clip(text, DISTILL_CLIP))
        lines.push('')
      }
    })
    const existing = await readProfileRules(root, resolved.name)
    if (existing.text.trim() !== '') {
      lines.push('【现有档案（不要重复这些条目，只补充新的）】', '', existing.text.trim(), '')
    }
    lines.push('请按系统提示的 JSON 格式输出规律。')

    const raw = await callModel(routePick, DISTILL_SYSTEM, lines.join('\n'), DISTILL_MAX_TOKENS)
    const parsed = parseJson(raw)
    let goodCount = 0
    let badCount = 0
    for (const group of groups) {
      goodCount += group.good.length
      badCount += group.bad.length
    }
    const liked = cleanRules(parsed.liked, 'liked')
    const disliked = cleanRules(parsed.disliked, 'disliked')
    return {
      rules: [...liked, ...disliked],
      profileName: resolved.name,
      provider: routePick.provider,
      model: routePick.model,
      sceneCount: groups.length,
      goodCount,
      badCount,
    }
  })

  /**
   * 「更通用」：把还没采纳的规律往上抽一层。
   *
   * 只把**未采纳**的交给模型 —— 已经采纳的规律作者已经认了，不需要再抽象一遍，
   * 而且把它们混进去会让模型倾向于"改写"而不是"抽一层"。
   * 抽完还是提案，仍然逐条勾选：是否更贴合作者的口味，只有作者说了算。
   */
  route('rules-refine', async (body) => {
    const root = asRoot(body.root)
    const routePick = resolveRoute(body)
    if (routePick === null) {
      throw new Error('读不到默认模型：请在 dsh 里设置默认模型，或在设置里填 provider / model')
    }
    const pending = []
    if (Array.isArray(body.rules)) {
      for (const item of body.rules) {
        if (item === null || typeof item !== 'object') continue
        if (item.adopted === true) continue
        const rule = clip(item.rule, RULE_CHARS)
        if (rule === '') continue
        pending.push({ kind: item.kind === 'disliked' ? 'disliked' : 'liked', rule })
      }
    }
    if (pending.length === 0) throw new Error('没有可抽象的规律：先把提炼出来的规律取消全选，或再提炼一轮')

    const lines = ['【待抽象的规律】', '']
    for (const item of pending) {
      lines.push('- [' + (item.kind === 'disliked' ? '避免' : '喜欢') + '] ' + item.rule)
    }
    lines.push('', '请把这些规律往上抽一层，输出更一般的写法规律。逐条沿用原来的 kind。')
    lines.push('', '请按系统提示的 JSON 格式输出。')

    const raw = await callModel(routePick, REFINE_SYSTEM, lines.join('\n'), DISTILL_MAX_TOKENS)
    const parsed = parseJson(raw)
    const refined = cleanRules(parsed.rules, 'liked')
    if (refined.length === 0) throw new Error('模型没有给出可用的更通用规律，再点一次试试')
    return {
      rules: refined,
      profileName: (await resolveProfile(root, body.profile)).name,
      provider: routePick.provider,
      model: routePick.model,
      inputCount: pending.length,
    }
  })
}
