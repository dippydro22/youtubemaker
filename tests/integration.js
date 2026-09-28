const { spawn, spawnSync } = require('node:child_process')
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
    const items = [{ id: 'tone-a', volume: 0.8 }, { id: 'tone-b', volume: 1.2 }]

    for (const [mode, image] of [['extract'], ['mix'], ['video', cover]]) {
      const result = await render(mode, items, image)
      const file = path.join(temp, 'outputs', result.filename)
      assertFile(file, mode)
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
