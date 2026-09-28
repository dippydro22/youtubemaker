const state = {
  tracks: [],
  volumes: {},
  captions: {},
  image: null,
  busy: false,
  sessionReady: false
}

const $ = selector => document.querySelector(selector)
const els = {
  addForm: $('#add-form'),
  urlInput: $('#url-input'),
  addButton: $('#add-form button'),
  addStatus: $('#add-status'),
  trackList: $('#track-list'),
  emptyState: $('#empty-state'),
  trackCount: $('#track-count'),
  template: $('#track-template'),
  imagePicker: $('#image-picker'),
  imageInput: $('#image-input'),
  imageButton: $('#image-button'),
  imagePreview: $('#image-preview'),
  renderButton: $('#render-button'),
  renderLabel: $('#render-label'),
  renderStatus: $('#render-status'),
  resultCard: $('#result-card'),
  totalDuration: $('#total-duration'),
  toast: $('#toast')
}

const modeLabels = {
  extract: '개별 MP3 만들기',
  mix: '믹스 MP3 만들기',
  video: 'MP4 영상 만들기'
}

let audioContext

function setPreviewVolume (audio, percent) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)()
    if (!audio._gain) {
      const source = audioContext.createMediaElementSource(audio)
      audio._gain = audioContext.createGain()
      source.connect(audio._gain).connect(audioContext.destination)
      audio.volume = 1
    }
    if (audioContext.state === 'suspended') audioContext.resume()
    audio._gain.gain.value = Number(percent) / 100
  } catch {
    audio.volume = Math.min(1, Number(percent) / 100)
  }
}

function formatTime (seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function showToast (message) {
  els.toast.textContent = message
  els.toast.classList.add('show')
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 3300)
}

async function request (url, options = {}) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.')
  return data
}

function currentMode () {
  return document.querySelector('input[name="mode"]:checked').value
}

let sessionSaveTimer

function sessionPayload () {
  return {
    order: state.tracks.map(track => track.id),
    settings: Object.fromEntries(state.tracks.map(track => [track.id, {
      volume: state.volumes[track.id] ?? 100,
      captionEnabled: state.captions[track.id]?.enabled !== false,
      caption: state.captions[track.id]?.text || track.title
    }]))
  }
}

async function saveSession () {
  if (!state.sessionReady) return
  clearTimeout(sessionSaveTimer)
  await request('/api/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionPayload())
  })
}

function scheduleSessionSave () {
  if (!state.sessionReady) return
  clearTimeout(sessionSaveTimer)
  sessionSaveTimer = setTimeout(() => saveSession().catch(() => {}), 350)
}

function updateSummary () {
  els.trackCount.textContent = state.tracks.length
  els.totalDuration.textContent = formatTime(state.tracks.reduce((sum, track) => sum + (track.duration || 0), 0))
  els.emptyState.hidden = state.tracks.length > 0
  els.renderButton.disabled = !state.tracks.length || state.busy || (currentMode() === 'video' && !state.image)
}

function renderTracks () {
  els.trackList.innerHTML = ''
  state.tracks.forEach((track, index) => {
    const card = els.template.content.firstElementChild.cloneNode(true)
    card.dataset.id = track.id
    card.querySelector('.track-number').textContent = String(index + 1).padStart(2, '0')
    card.querySelector('.thumbnail').src = track.thumbnail || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="320" height="180"%3E%3Crect width="100%25" height="100%25" fill="%23152537"/%3E%3C/svg%3E'
    card.querySelector('.thumbnail').alt = `${track.title} 미리보기`
    card.querySelector('h3').textContent = track.title
    card.querySelector('.duration').textContent = formatTime(track.duration)
    card.querySelector('audio').src = track.audioUrl

    const volume = card.querySelector('.volume')
    const output = card.querySelector('output')
    volume.value = state.volumes[track.id] ?? 100
    output.value = `${volume.value}%`
    volume.addEventListener('input', () => {
      state.volumes[track.id] = Number(volume.value)
      output.value = `${volume.value}%`
      setPreviewVolume(card.querySelector('audio'), volume.value)
      scheduleSessionSave()
    })

    state.captions[track.id] ||= { enabled: true, text: track.title }
    const captionEnabled = card.querySelector('.caption-enabled')
    const captionText = card.querySelector('.caption-text')
    captionEnabled.checked = state.captions[track.id].enabled
    captionText.value = state.captions[track.id].text
    captionText.disabled = !captionEnabled.checked
    captionEnabled.addEventListener('change', () => {
      state.captions[track.id].enabled = captionEnabled.checked
      captionText.disabled = !captionEnabled.checked
      scheduleSessionSave()
    })
    captionText.addEventListener('input', () => {
      state.captions[track.id].text = captionText.value
      scheduleSessionSave()
    })

    const up = card.querySelector('.move-up')
    const down = card.querySelector('.move-down')
    up.disabled = index === 0
    down.disabled = index === state.tracks.length - 1
    up.addEventListener('click', () => moveTrack(index, index - 1))
    down.addEventListener('click', () => moveTrack(index, index + 1))
    card.querySelector('.remove-button').addEventListener('click', () => removeTrack(track.id))
    els.trackList.append(card)
  })
  updateSummary()
}

function moveTrack (from, to) {
  const [track] = state.tracks.splice(from, 1)
  state.tracks.splice(to, 0, track)
  renderTracks()
  scheduleSessionSave()
}

async function removeTrack (trackId) {
  try {
    await request(`/api/tracks/${trackId}`, { method: 'DELETE' })
    state.tracks = state.tracks.filter(track => track.id !== trackId)
    delete state.volumes[trackId]
    delete state.captions[trackId]
    renderTracks()
    scheduleSessionSave()
    showToast('목록에서 음원을 삭제했습니다.')
  } catch (error) {
    showToast(error.message)
  }
}

function setAddStatus (message, error = false) {
  els.addStatus.hidden = !message
  els.addStatus.textContent = message
  els.addStatus.classList.toggle('error', error)
}

function pollJob (jobId, onUpdate) {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const job = await request(`/api/jobs/${jobId}`)
        onUpdate?.(job)
        if (job.status === 'done') return resolve(job.result)
        if (job.status === 'error') return reject(new Error(job.message))
        setTimeout(poll, 700)
      } catch (error) {
        reject(error)
      }
    }
    poll()
  })
}

els.addForm.addEventListener('submit', async event => {
  event.preventDefault()
  if (state.busy) return
  const url = els.urlInput.value.trim()
  state.busy = true
  els.addButton.disabled = true
  els.addButton.innerHTML = '<span>•••</span> 준비 중'
  setAddStatus('영상 정보를 확인하고 있어요 · 창을 닫지 마세요')
  try {
    const { jobId } = await request('/api/tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    const result = await pollJob(jobId, job => setAddStatus(`${job.message} · ${job.progress}%`))
    state.tracks.push(result.track)
    state.volumes[result.track.id] = 100
    state.captions[result.track.id] = { enabled: true, text: result.track.title }
    els.urlInput.value = ''
    setAddStatus('음원 준비가 끝났습니다. 바로 미리 들을 수 있어요.')
    renderTracks()
    scheduleSessionSave()
    setTimeout(() => setAddStatus(''), 3500)
    showToast('새 음원을 목록에 추가했습니다.')
  } catch (error) {
    setAddStatus(error.message, true)
  } finally {
    state.busy = false
    els.addButton.disabled = false
    els.addButton.innerHTML = '<span>＋</span> 영상 추가'
    updateSummary()
  }
})

document.querySelectorAll('input[name="mode"]').forEach(input => {
  input.addEventListener('change', () => {
    document.querySelectorAll('.mode-card').forEach(card => card.classList.toggle('selected', card.contains(input)))
    els.imagePicker.hidden = input.value !== 'video'
    els.renderLabel.textContent = modeLabels[input.value]
    els.resultCard.hidden = true
    updateSummary()
  })
})

els.imageButton.addEventListener('click', () => els.imageInput.click())
els.imageInput.addEventListener('change', () => {
  const file = els.imageInput.files[0]
  if (!file) return
  if (file.size > 15 * 1024 * 1024) {
    els.imageInput.value = ''
    return showToast('이미지는 15MB 이하로 선택해 주세요.')
  }
  state.image = file
  const img = els.imagePreview.querySelector('img')
  img.src = URL.createObjectURL(file)
  els.imagePreview.querySelector('span').textContent = file.name
  els.imageButton.hidden = true
  els.imagePreview.hidden = false
  updateSummary()
})

els.imagePreview.querySelector('button').addEventListener('click', () => {
  state.image = null
  els.imageInput.value = ''
  els.imagePreview.hidden = true
  els.imageButton.hidden = false
  updateSummary()
})

function showRenderProgress (job) {
  els.renderStatus.hidden = false
  els.renderStatus.querySelector('.progress-track i').style.width = `${job.progress || 0}%`
  els.renderStatus.querySelector('span').textContent = job.message || '처리 중'
  els.renderStatus.querySelector('b').textContent = `${job.progress || 0}%`
}

els.renderButton.addEventListener('click', async () => {
  if (!state.tracks.length || state.busy) return
  state.busy = true
  updateSummary()
  els.resultCard.hidden = true
  showRenderProgress({ progress: 1, message: '작업을 준비하고 있어요' })
  const mode = currentMode()
  const form = new FormData()
  form.append('mode', mode)
  form.append('items', JSON.stringify(state.tracks.map(track => ({
    id: track.id,
    volume: (state.volumes[track.id] ?? 100) / 100,
    showCaption: state.captions[track.id]?.enabled !== false,
    caption: state.captions[track.id]?.text || track.title
  }))))
  if (mode === 'video' && state.image) form.append('image', state.image)

  try {
    await saveSession()
    const { jobId } = await request('/api/render', { method: 'POST', body: form })
    const result = await pollJob(jobId, showRenderProgress)
    els.renderStatus.hidden = true
    els.resultCard.hidden = false
    els.resultCard.querySelector('small').textContent = `${result.kind} · ${result.filename}`
    const link = els.resultCard.querySelector('a')
    link.href = result.url
    link.download = result.filename
    showToast('결과 파일이 완성됐습니다.')
  } catch (error) {
    els.renderStatus.hidden = true
    showToast(error.message)
  } finally {
    state.busy = false
    updateSummary()
  }
})

async function init () {
  try {
    const [{ tracks }, health, session] = await Promise.all([request('/api/tracks'), request('/api/health'), request('/api/session')])
    if (!health.ok) throw new Error('음원 처리 도구를 찾지 못했습니다. 다시 설치해 주세요.')
    const byId = new Map(tracks.map(track => [track.id, track]))
    state.tracks = (session.order || []).map(trackId => byId.get(trackId)).filter(Boolean)
    tracks.forEach(track => { if (!state.tracks.some(saved => saved.id === track.id)) state.tracks.push(track) })
    state.tracks.forEach(track => {
      const saved = session.settings?.[track.id]
      state.volumes[track.id] = saved?.volume ?? 100
      state.captions[track.id] = {
        enabled: saved?.captionEnabled !== false,
        text: saved?.caption || track.title
      }
    })
    state.sessionReady = true
    renderTracks()
  } catch (error) {
    showToast(error.message)
  }
}

init()
