const express = require('express')
const multer = require('multer')
const archiver = require('archiver')
const { spawn } = require('node:child_process')
const { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const packagedPath = file => file.includes('app.asar') ? file.replace('app.asar', 'app.asar.unpacked') : file
const ffmpegPath = packagedPath(require('ffmpeg-static'))

const app = express()
const PORT = Number(process.env.PORT || 4173)
const ROOT = __dirname
const DATA = process.env.SOUND_STITCH_DATA_DIR || path.join(ROOT, 'data')
const TRACKS_DIR = path.join(DATA, 'tracks')
const OUTPUTS_DIR = path.join(DATA, 'outputs')
const VIDEO_OUTPUTS_DIR = process.env.SOUND_STITCH_VIDEO_OUTPUT_DIR || OUTPUTS_DIR
const UPLOADS_DIR = path.join(DATA, 'uploads')
const TRACKS_DB = path.join(DATA, 'tracks.json')
const SESSION_DB = path.join(DATA, 'session.json')
const YTDLP = packagedPath(path.join(ROOT, 'node_modules', 'youtube-dl-exec', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'))

for (const dir of [DATA, TRACKS_DIR, OUTPUTS_DIR, VIDEO_OUTPUTS_DIR, UPLOADS_DIR]) mkdirSync(dir, { recursive: true })

const jobs = new Map()
let tracks = loadTracks()
let lifecycleHooks = {}

function loadTracks () {
  try {
    return JSON.parse(readFileSync(TRACKS_DB, 'utf8')).filter(track => existsSync(track.file))
  } catch {
    return []
  }
}

function saveTracks () {
  writeFileSync(TRACKS_DB, JSON.stringify(tracks, null, 2))
}

function loadSession () {
  try {
    return JSON.parse(readFileSync(SESSION_DB, 'utf8'))
  } catch {
    return { order: [], settings: {} }
  }
}

function cleanSession (value) {
  const known = new Set(tracks.map(track => track.id))
  const order = Array.isArray(value?.order) ? [...new Set(value.order.filter(trackId => known.has(trackId)))] : []
  tracks.forEach(track => { if (!order.includes(track.id)) order.push(track.id) })
  const settings = {}
  for (const trackId of order) {
    const raw = value?.settings?.[trackId] || {}
    settings[trackId] = {
      volume: Math.max(0, Math.min(200, Number(raw.volume) || 0)),
      captionEnabled: raw.captionEnabled !== false,
      caption: String(raw.caption || tracks.find(track => track.id === trackId)?.title || '').trim().slice(0, 120)
    }
    if (raw.volume == null) settings[trackId].volume = 100
  }
  return { order, settings }
}

function saveSession (value) {
  const session = cleanSession(value)
  writeFileSync(SESSION_DB, JSON.stringify(session, null, 2))
  return session
}

function id () {
  return crypto.randomBytes(8).toString('hex')
}

function publicTrack (track) {
  return {
    id: track.id,
    title: track.title,
    duration: track.duration,
    sourceUrl: track.sourceUrl,
    thumbnail: track.thumbnail,
    audioUrl: `/media/tracks/${path.basename(track.file)}`
  }
}

function isYouTubeUrl (value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    return url.protocol === 'https:' && ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)
  } catch {
    return false
  }
}

function cleanError (error) {
  const text = String(error?.message || error || '알 수 없는 오류')
  if (/sign in|cookies|bot/i.test(text)) return '이 영상은 로그인 또는 추가 인증이 필요해 가져올 수 없습니다.'
  if (/private video/i.test(text)) return '비공개 영상은 가져올 수 없습니다.'
  if (/copyright|unavailable|not available/i.test(text)) return '이 영상은 현재 다운로드할 수 없습니다.'
  return text.split('\n').slice(-3).join(' ').slice(0, 360)
}

function createJob (type, message) {
  const job = { id: id(), type, status: 'working', progress: 2, message, createdAt: Date.now() }
  jobs.set(job.id, job)
  return job
}

function updateJob (job, patch) {
  Object.assign(job, patch)
}

function run (command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const read = (chunk, target) => {
      const text = chunk.toString()
      if (target === 'stdout') stdout += text
      else stderr += text
      if (onLine) text.split(/\r?\n/).filter(Boolean).forEach(onLine)
    }
    child.stdout.on('data', chunk => read(chunk, 'stdout'))
    child.stderr.on('data', chunk => read(chunk, 'stderr'))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || stdout || `${path.basename(command)} 종료 코드 ${code}`))
    })
  })
}

async function extractTrack (job, url) {
  try {
    updateJob(job, { progress: 8, message: '영상 정보를 확인하고 있어요' })
    const infoResult = await run(YTDLP, ['--dump-single-json', '--no-playlist', '--no-warnings', url])
    const info = JSON.parse(infoResult.stdout)
    const trackId = id()
    const outputTemplate = path.join(TRACKS_DIR, `${trackId}.%(ext)s`)
    updateJob(job, { progress: 18, message: '음원을 내려받고 있어요' })

    await run(YTDLP, [
      '--no-playlist', '--newline', '--no-warnings',
      '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
      '--ffmpeg-location', ffmpegPath, '--output', outputTemplate, url
    ], line => {
      const match = line.match(/\[download\]\s+([\d.]+)%/)
      if (match) updateJob(job, { progress: 18 + Math.round(Number(match[1]) * 0.72), message: `음원 추출 중 · ${Math.round(Number(match[1]))}%` })
      if (/ExtractAudio/.test(line)) updateJob(job, { progress: 93, message: 'MP3로 변환하고 있어요' })
    })

    const file = path.join(TRACKS_DIR, `${trackId}.mp3`)
    if (!existsSync(file)) throw new Error('추출된 MP3 파일을 찾지 못했습니다.')
    const track = {
      id: trackId,
      title: String(info.title || '제목 없는 영상'),
      duration: Number(info.duration || 0),
      sourceUrl: url,
      thumbnail: info.thumbnail || '',
      file
    }
    tracks.push(track)
    saveTracks()
    updateJob(job, { status: 'done', progress: 100, message: '음원 준비 완료', result: { track: publicTrack(track) } })
  } catch (error) {
    updateJob(job, { status: 'error', message: cleanError(error) })
  }
}

function runFfmpeg (args, job, start = 10, span = 80) {
  return run(ffmpegPath, ['-hide_banner', '-y', ...args], line => {
    if (/time=/.test(line)) updateJob(job, { progress: Math.min(start + span - 2, job.progress + 1), message: '순서대로 이어 붙이고 있어요' })
  })
}

function transitionDuration (first, second) {
  const durations = [first, second].map(item => Number(item.track.duration) || 0).filter(Boolean)
  return Number(Math.min(3, ...(durations.length ? durations.map(duration => Math.max(0.1, duration / 2)) : [3])).toFixed(2))
}

async function mixTracks (items, output, job) {
  const inputs = []
  const filters = []
  items.forEach((item, index) => {
    inputs.push('-i', item.track.file)
    const volume = Math.max(0, Math.min(2, Number(item.volume) || 0))
    filters.push(`[${index}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${volume}[a${index}]`)
  })
  if (items.length === 1) {
    filters.push('[a0]anull[outa]')
  } else {
    let previous = '[a0]'
    for (let index = 1; index < items.length; index++) {
      const outputLabel = index === items.length - 1 ? '[outa]' : `[xf${index}]`
      filters.push(`${previous}[a${index}]acrossfade=d=${transitionDuration(items[index - 1], items[index])}:c1=tri:c2=tri${outputLabel}`)
      previous = outputLabel
    }
  }
  await runFfmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[outa]', '-codec:a', 'libmp3lame', '-b:a', '256k', output], job)
}

function makeZip (items, output) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(output)
    const archive = archiver('zip', { zlib: { level: 6 } })
    stream.on('close', resolve)
    stream.on('error', reject)
    archive.on('error', reject)
    archive.pipe(stream)
    const used = new Set()
    items.forEach((item, index) => {
      let safe = item.track.title.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80) || `음원-${index + 1}`
      if (used.has(safe)) safe += `-${index + 1}`
      used.add(safe)
      archive.file(item.track.file, { name: `${String(index + 1).padStart(2, '0')} ${safe}.mp3` })
    })
    archive.finalize()
  })
}

function assTime (seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor((centiseconds % 360000) / 6000)
  const secs = Math.floor((centiseconds % 6000) / 100)
  const fraction = centiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
}

function assText (value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\r?\n/g, '\\N')
}

function createCaptionFile (items, file) {
  const starts = [0]
  for (let index = 1; index < items.length; index++) {
    const previousStart = starts[index - 1]
    const previousDuration = Math.max(0, Number(items[index - 1].track.duration) || 0)
    starts.push(Math.max(previousStart, previousStart + previousDuration - transitionDuration(items[index - 1], items[index])))
  }
  const events = []
  items.forEach((item, index) => {
    const start = starts[index]
    const end = index < items.length - 1
      ? starts[index + 1]
      : start + Math.max(0, Number(item.track.duration) || 0)
    if (item.showCaption && item.caption && end > start) {
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Center,,0,0,0,,${assText(item.caption)}`)
    }
  })
  if (!events.length) return false
  const contents = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Center,Malgun Gothic,64,&H00FFFFFF,&H000000FF,&H00000000,&H88000000,-1,0,0,0,100,100,0,0,3,18,0,5,110,110,80,1',
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events
  ].join('\r\n')
  writeFileSync(file, `\uFEFF${contents}`, 'utf8')
  return true
}

function ffmpegFilterPath (file) {
  return file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'")
}

async function render (job, mode, rawItems, imageFile) {
  let captionFile
  try {
    const items = rawItems.map(item => ({
      track: tracks.find(track => track.id === item.id),
      volume: item.volume,
      showCaption: item.showCaption !== false,
      caption: String(item.caption || '').trim().slice(0, 120)
    })).filter(item => item.track)
    if (!items.length) throw new Error('처리할 음원이 없습니다.')
    updateJob(job, { progress: 8, message: '출력 파일을 준비하고 있어요' })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

    if (mode === 'extract') {
      const output = path.join(OUTPUTS_DIR, `sound-stitch-${stamp}.zip`)
      await makeZip(items, output)
      return updateJob(job, { status: 'done', progress: 100, message: '개별 음원 ZIP 완성', result: { url: `/media/outputs/${path.basename(output)}`, filename: path.basename(output), kind: 'ZIP' } })
    }

    const mixed = path.join(OUTPUTS_DIR, `sound-stitch-${stamp}.mp3`)
    updateJob(job, { progress: 12, message: '음량을 적용해 이어 붙이고 있어요' })
    await mixTracks(items, mixed, job)
    if (mode === 'mix') {
      return updateJob(job, { status: 'done', progress: 100, message: '믹스 MP3 완성', result: { url: `/media/outputs/${path.basename(mixed)}`, filename: path.basename(mixed), kind: 'MP3' } })
    }

    if (!imageFile) throw new Error('영상에 사용할 이미지를 선택해 주세요.')
    const video = path.join(VIDEO_OUTPUTS_DIR, `sound-stitch-${stamp}.mp4`)
    captionFile = path.join(UPLOADS_DIR, `captions-${job.id}.ass`)
    const hasCaptions = createCaptionFile(items, captionFile)
    const videoFilter = [
      'scale=1920:1080:force_original_aspect_ratio=decrease',
      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      'format=yuv420p'
    ]
    if (hasCaptions) videoFilter.push(`ass=filename='${ffmpegFilterPath(captionFile)}'`)
    updateJob(job, { progress: 55, message: '이미지와 음원으로 영상을 만들고 있어요' })
    await runFfmpeg([
      '-loop', '1', '-i', imageFile, '-i', mixed,
      '-c:v', 'libx264', '-tune', 'stillimage', '-vf', videoFilter.join(','),
      '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', video
    ], job, 55, 43)
    updateJob(job, { status: 'done', progress: 100, message: 'MP4 영상 완성', result: { url: `/video-output/${path.basename(video)}`, filename: path.basename(video), kind: 'MP4' } })
    if (typeof lifecycleHooks.onVideoComplete === 'function') lifecycleHooks.onVideoComplete(video)
  } catch (error) {
    updateJob(job, { status: 'error', message: cleanError(error) })
  } finally {
    for (const temporary of [imageFile, captionFile]) {
      if (temporary && existsSync(temporary)) {
        try { unlinkSync(temporary) } catch {}
      }
    }
  }
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, done) => done(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype))
})

app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(ROOT, 'public')))
app.use('/media', express.static(DATA, { fallthrough: false }))
app.use('/video-output', express.static(VIDEO_OUTPUTS_DIR, { fallthrough: false }))

app.get('/api/health', (_req, res) => res.json({ ok: Boolean(ffmpegPath && existsSync(ffmpegPath) && existsSync(YTDLP)) }))
app.get('/api/tracks', (_req, res) => res.json({ tracks: tracks.map(publicTrack) }))
app.get('/api/session', (_req, res) => res.json(saveSession(loadSession())))

app.put('/api/session', (req, res) => {
  res.json(saveSession(req.body))
})

app.post('/api/tracks', (req, res) => {
  const url = String(req.body.url || '').trim()
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: '올바른 YouTube 주소를 입력해 주세요.' })
  const job = createJob('extract', '추출을 시작할게요')
  res.status(202).json({ jobId: job.id })
  extractTrack(job, url)
})

app.delete('/api/tracks/:id', (req, res) => {
  const target = tracks.find(track => track.id === req.params.id)
  const before = tracks.length
  tracks = tracks.filter(track => track.id !== req.params.id)
  if (before === tracks.length) return res.status(404).json({ error: '음원을 찾지 못했습니다.' })
  if (target?.file && existsSync(target.file)) {
    try { unlinkSync(target.file) } catch {}
  }
  saveTracks()
  res.json({ ok: true })
})

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: '작업 상태를 찾지 못했습니다.' })
  res.json(job)
})

app.post('/api/render', upload.single('image'), (req, res) => {
  let items
  try { items = JSON.parse(req.body.items || '[]') } catch { items = [] }
  const mode = ['extract', 'mix', 'video'].includes(req.body.mode) ? req.body.mode : 'mix'
  if (!items.length) return res.status(400).json({ error: '한 개 이상의 음원을 등록해 주세요.' })
  if (mode === 'video' && !req.file) return res.status(400).json({ error: '영상에 사용할 이미지를 선택해 주세요.' })
  const job = createJob('render', '출력 작업을 시작할게요')
  res.status(202).json({ jobId: job.id })
  render(job, mode, items, req.file?.path)
})

app.use((error, _req, res, _next) => res.status(500).json({ error: cleanError(error) }))

function startServer (port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const address = server.address()
      console.log(`Sound Stitch 실행 중: http://127.0.0.1:${address.port}`)
      resolve(server)
    })
    server.once('error', reject)
  })
}

function setLifecycleHooks (hooks = {}) {
  lifecycleHooks = hooks
}

if (require.main === module) startServer()

module.exports = { app, setLifecycleHooks, startServer }
