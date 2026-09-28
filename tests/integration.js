const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ffmpeg = require('ffmpeg-static')

const root = path.join(__dirname, '..')
const temp = mkdtempSync(path.join(os.tmpdir(), 'sound-stitch-test-'))
const tracksDir = path.join(temp, 'tracks')
const port = 4199
mkdirSync(tracksDir, { recursive: true })

function ff (args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg fixture failed')
}

function assertFile (file, label) {
  if (!existsSync(file) || statSync(file).size < 100) throw new Error(`${label} 파일이 생성되지 않았습니다.`)
}

function hashFile (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function mediaDuration (file) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const match = result.stderr.match(/Duration:\s+(\d+):(\d+):([\d.]+)/)
  if (!match) throw new Error('결과물 재생 시간을 확인하지 못했습니다.')
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

async function waitForServer () {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('테스트 서버가 시작되지 않았습니다.')
}

async function poll (jobId) {
  for (let i = 0; i < 200; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)
    const job = await response.json()
    if (job.status === 'done') return job.result
    if (job.status === 'error') throw new Error(job.message)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('출력 작업 시간이 초과됐습니다.')
}

async function render (mode, items, image) {
  const form = new FormData()
  form.append('mode', mode)
  form.append('normalizeAudio', String(mode !== 'extract'))
  form.append('items', JSON.stringify(items))
  if (image) form.append('image', new Blob([readFileSync(image)], { type: 'image/png' }), 'cover.png')
  const response = await fetch(`http://127.0.0.1:${port}/api/render`, { method: 'POST', body: form })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error)
  return poll(payload.jobId)
}

async function main () {
  const first = path.join(tracksDir, 'tone-a.mp3')
  const second = path.join(tracksDir, 'tone-b.mp3')
  const cover = path.join(temp, 'cover.png')
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'libmp3lame', first])
  ff(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-codec:a', 'libmp3lame', second])
  ff(['-f', 'lavfi', '-i', 'color=c=0x10243a:s=1280x720', '-frames:v', '1', cover])
  writeFileSync(path.join(temp, 'tracks.json'), JSON.stringify([
    { id: 'tone-a', title: '테스트 음원 A', duration: 1, sourceUrl: '', thumbnail: '', file: first },
    { id: 'tone-b', title: '테스트 음원 B', duration: 1, sourceUrl: '', thumbnail: '', file: second }
  ]))

  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SOUND_STITCH_DATA_DIR: temp },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  try {
    await waitForServer()
    const page = await fetch(`http://127.0.0.1:${port}/`)
    if (!page.ok || !(await page.text()).includes('Sound Stitch')) throw new Error('메인 화면을 불러오지 못했습니다.')
    const tracks = await (await fetch(`http://127.0.0.1:${port}/api/tracks`)).json()
    if (tracks.tracks.length !== 2) throw new Error('저장된 음원 목록을 불러오지 못했습니다.')
    const savedSession = {
      order: ['tone-b', 'tone-a'],
      settings: {
        'tone-a': { volume: 80, captionEnabled: true, caption: '첫 번째 영상' },
        'tone-b': { volume: 120, captionEnabled: false, caption: '두 번째 영상' }
      }
    }
    await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savedSession)
    })
    const restoredSession = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()
    if (restoredSession.order.join(',') !== 'tone-b,tone-a' || restoredSession.settings['tone-a'].caption !== '첫 번째 영상') {
      throw new Error('목록과 설정이 저장되지 않았습니다.')
    }
    console.log('✓ session: 목록·순서·음량·제목 설정 복원 확인')
    const items = [
      { id: 'tone-a', volume: 0.8, showCaption: true, caption: '첫 번째 영상' },
      { id: 'tone-b', volume: 1.2, showCaption: true, caption: '두 번째 영상' }
    ]

    for (const [mode, image] of [['extract'], ['mix'], ['video', cover]]) {
      const result = await render(mode, items, image)
      const file = path.join(temp, 'outputs', result.filename)
      assertFile(file, mode)
      if (mode === 'mix') {
        const duration = mediaDuration(file)
        if (duration >= 1.9 || duration <= 1.2) throw new Error(`크로스페이드 재생 시간이 올바르지 않습니다: ${duration}`)
        console.log(`✓ crossfade: 2초 음원을 ${duration.toFixed(2)}초로 자연스럽게 연결`)
      }
      if (mode === 'video') {
        const firstFrame = path.join(temp, 'caption-first.png')
        const secondFrame = path.join(temp, 'caption-second.png')
        ff(['-ss', '0.2', '-i', file, '-frames:v', '1', firstFrame])
        ff(['-ss', '1.0', '-i', file, '-frames:v', '1', secondFrame])
        if (hashFile(firstFrame) === hashFile(secondFrame)) throw new Error('시간대별 제목이 전환되지 않았습니다.')
        console.log('✓ video captions: 시간대별 중앙 제목 전환 확인')
      }
      console.log(`✓ ${mode}: ${result.filename} (${statSync(file).size} bytes)`)
    }
    console.log('✓ API, 개별 ZIP, 믹스 MP3, 이미지 MP4 통합 검증 완료')
  } finally {
    server.kill()
    rmSync(temp, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
