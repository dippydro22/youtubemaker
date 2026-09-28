const { app, BrowserWindow, dialog, shell } = require('electron')
const path = require('node:path')

let mainWindow
let localServer

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

async function createWindow () {
  process.env.SOUND_STITCH_DATA_DIR = path.join(app.getPath('userData'), 'data')
  const { startServer } = require('../server')
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
    show: false,
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
  mainWindow.once('ready-to-show', () => mainWindow.show())
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
