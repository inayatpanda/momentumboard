// StreetSignal desktop shell: a signed-in window onto the LIVE app. It loads
// the production URL rather than bundling the SPA, so every Netlify deploy
// reaches the desktop immediately — the shell never needs a re-release for
// app changes (only for icon/window/menu work).
const { app, BrowserWindow, shell } = require('electron')

const APP_URL = 'https://thestreetsignal.rqai.co.uk/app/'
const APP_ORIGIN = new URL(APP_URL).origin

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    title: 'StreetSignal',
    backgroundColor: '#0a0d0f', // the app's teal-black — no white flash on boot
    webPreferences: {
      // persist: localStorage carries the licence token between launches
      partition: 'persist:streetsignal',
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // marks desktop boots apart from browser visits in the access telemetry
  // (licences.mts check route splits on this token)
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} StreetSignalDesktop/${app.getVersion()}`)
  win.loadURL(APP_URL)

  // anything off-origin (news links, unusualwhales, report PDFs) opens in the
  // system browser — the shell stays the app, never becomes a browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin !== APP_ORIGIN) {
        shell.openExternal(url)
        return { action: 'deny' }
      }
    } catch {
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== APP_ORIGIN) {
        e.preventDefault()
        shell.openExternal(url)
      }
    } catch {
      e.preventDefault()
    }
  })
  return win
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
