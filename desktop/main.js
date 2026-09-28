const { app, BrowserWindow, dialog, shell } = require('electron')
const path = require('node:path')

let mainWindow
let localServer

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
})

async function createWindow () {
  process.env.SOUND_STITCH_DATA_DIR ||= path.join(app.getPath('userData'), 'data')
  const { setLifecycleHooks, startServer } = require('../server')
  setLifecycleHooks({
    onVideoComplete: videoPath => {
      if (process.env.SOUND_STITCH_SKIP_REVEAL !== '1') shell.showItemInFolder(videoPath)
      setTimeout(() => app.quit(), 2500)
    }
  })
  localServer = await startServer(0)
  const port = localServer.address().port

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 640,
    title: 'Sound Stitch',
    backgroundColor: '#07101d',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) event.preventDefault()
  })
  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
}

app.whenReady().then(createWindow).catch(error => {
  dialog.showErrorBox('Sound Stitch 실행 오류', error.message)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (localServer) localServer.close()
})
