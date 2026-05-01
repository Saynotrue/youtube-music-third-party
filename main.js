const { app, BrowserWindow, screen, Tray, Menu, nativeImage, nativeTheme } = require('electron');
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

    // --- 트레이 아이콘 경로 설정 ---
    let trayIconPath;

    if (process.platform === 'win32') {
        trayIconPath = path.join(__dirname, 'tray', 'windows', 'playerTemplate_white.png');
    } else {
        trayIconPath = path.join(__dirname, 'tray', 'macOS', 'playerTemplate.png');
    }

    const trayIcon = nativeImage.createFromPath(trayIconPath);


    if (process.platform === 'darwin') {
        trayIcon.setTemplateImage(true);
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('YouTube Lyrics Bar');


    let currentIconStyle = 'player';

    // 2. 아이콘 변경 함수 만들기
    function changeTrayIcon(style) {
        currentIconStyle = style;
        const iconName = style === 'player' ? 'playerTemplate' : 'spectrumTemplate';
        
        let newTrayIconPath;
        if (process.platform === 'win32') {
            // 새로 정리하신 windows 폴더 경로 적용!
            newTrayIconPath = path.join(__dirname, 'tray', 'windows', `${iconName}_white.png`);
        } else {
            // 새로 정리하신 macOS 폴더 경로 적용!
            newTrayIconPath = path.join(__dirname, 'tray', 'macOS', `${iconName}.png`);
        }

        const newTrayIcon = nativeImage.createFromPath(newTrayIconPath);
        
        if (process.platform === 'darwin') {
            newTrayIcon.setTemplateImage(true);
        }

        tray.setImage(newTrayIcon);
    }

    // 3. 메뉴에 '아이콘 스타일' 하위 메뉴 추가하기
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Bar 보이기/숨기기',
            click: () => {
                win.isVisible() ? win.hide() : win.show();
            }
        },
        { type: 'separator' }, // 구분선
        {
            label: '아이콘 스타일',
            submenu: [
                {
                    label: '음표 모양 (Player)',
                    type: 'radio',
                    checked: currentIconStyle === 'player',
                    click: () => changeTrayIcon('player')
                },
                {
                    label: '스펙트럼 모양 (Spectrum)',
                    type: 'radio',
                    checked: currentIconStyle === 'spectrum',
                    click: () => changeTrayIcon('spectrum')
                }
            ]
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
        tray.popUpContextMenu(contextMenu);
    });

    // 우클릭 이벤트: 메뉴 띄우기
    tray.on('right-click', () => {
        if (win.isVisible()) {
            win.hide();
        } else {
            win.show();
        }
    });
});

// (main.js 추가 내용) Mac 마이크 접근 권한 요청
const { systemPreferences } = require('electron');
if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone');
}


app.on('window-all-closed', () => app.quit());