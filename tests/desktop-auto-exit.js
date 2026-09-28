const { spawn, spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('electron')
const ffmpeg = require('ffmpeg-static')

const root = path.join(__dirname, '..')
const temp = mkdtempSync(path.join(os.tmpdir(), 'sound-stitch-desktop-test-'))
const tracksDir = path.join(temp, 'tracks')
mkdirSync(tracksDir, { recursive: true })

function fixture (args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || '테스트 파일 생성 실패')
}

function waitForPort (child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('데스크톱 서버가 시작되지 않았습니다.')), 15000)
    const inspect = chunk => {
      output += chunk.toString()
      const match = output.match(/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', code => reject(new Error(`데스크톱 앱이 너무 일찍 종료됐습니다: ${code}`)))
  })
}

async function poll (port, jobId) {
  for (let index = 0; index < 100; index++) {
    const job = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()
    if (job.status === 'done') return job
    if (job.status === 'error') throw new Error(job.message)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('영상 제작 시간이 초과됐습니다.')
}

function waitForExit (child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('영상 제작 후 앱이 자동 종료되지 않았습니다.')), 10000)
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`데스크톱 앱 종료 코드: ${code}`))
    })
  })
}

async function main () {
  const audio = path.join(tracksDir, 'tone.mp3')
  const cover = path.join(temp, 'cover.png')
  fixture(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'libmp3lame', audio])
  fixture(['-f', 'lavfi', '-i', 'color=c=0x10243a:s=1280x720', '-frames:v', '1', cover])
  writeFileSync(path.join(temp, 'tracks.json'), JSON.stringify([
    { id: 'tone', title: '자동 종료 테스트', duration: 1, sourceUrl: 'https://example.test/video', thumbnail: '', file: audio }
  ]))

  const child = spawn(electron, ['.'], {
    cwd: root,
    env: { ...process.env, SOUND_STITCH_DATA_DIR: temp, SOUND_STITCH_SKIP_REVEAL: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  try {
    const port = await waitForPort(child)
    const form = new FormData()
    form.append('mode', 'video')
    form.append('items', JSON.stringify([{ id: 'tone', volume: 1, showCaption: true, caption: '자동 종료 테스트' }]))
    form.append('image', new Blob([readFileSync(cover)], { type: 'image/png' }), 'cover.png')
    const response = await fetch(`http://127.0.0.1:${port}/api/render`, { method: 'POST', body: form })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error)
    await poll(port, payload.jobId)
    await waitForExit(child)
    console.log('✓ desktop: 영상 제작 완료 후 자동 종료 확인')
  } finally {
    if (!child.killed) child.kill()
    rmSync(temp, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
