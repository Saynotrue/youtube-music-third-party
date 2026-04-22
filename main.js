const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
require('./server.js');

let win;

app.whenReady().then(() => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const barWidth = 700;
    const barHeight = 44;

    win = new BrowserWindow({
        width: barWidth,
        height: barHeight,
        x: Math.floor((width - barWidth) / 2),
        y: height - barHeight - 4,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        icon: path.join(__dirname, 'build', 'icon256.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
            webSecurity: false
        }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile('renderer/index.html');
});

// (main.js 추가 내용) Mac 마이크 접근 권한 요청
const { systemPreferences } = require('electron');
if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone');
}

app.on('window-all-closed', () => app.quit());