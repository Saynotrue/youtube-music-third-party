const { app, BrowserWindow, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
require('./server.js');

let win;
let tray = null;

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
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
            webSecurity: false
        }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile('renderer/index.html');

    const iconPath = path.join(__dirname, 'tray', 'trayTemplate.png');
    const trayIcon = nativeImage.createFromPath(iconPath);

    trayIcon.setTemplateImage(true);

    // 트레이 생성
    tray = new Tray(trayIcon);
    tray.setToolTip('YouTube Lyrics Bar'); // 마우스 올렸을 때 뜨는 글자

    // 우클릭 시 나타날 메뉴 만들기
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Bar 보이기/숨기기',
            click: () => {
                win.isVisible() ? win.hide() : win.show();
            }
        },
        { type: 'separator' }, // 구분선
        {
            label: '종료',
            click: () => {
                app.isQuiting = true;
                app.quit();
            }
        }
    ]);

    // 좌클릭 이벤트: 앱 켜기/끄기 토글
    tray.on('click', () => {
        if (win.isVisible()) {
            win.hide();
        } else {
            win.show();
        }
    });

    // 우클릭 이벤트: 메뉴 띄우기
    tray.on('right-click', () => {
        tray.popUpContextMenu(contextMenu);
    });
});

// (main.js 추가 내용) Mac 마이크 접근 권한 요청
const { systemPreferences } = require('electron');
if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone');
}


app.on('window-all-closed', () => app.quit());