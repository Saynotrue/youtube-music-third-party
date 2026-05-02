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
        // 🚨 중요: 처음에 resizable을 true로 열어둬야 창 크기 변경 버그를 막을 수 있어!
        resizable: true, 
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
    
    // F11 전체화면 버그 방지
    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F11') {
            event.preventDefault(); 
        }
    });

    // --- 트레이 아이콘 경로 설정 ---
    let trayIconPath;
    if (process.platform === 'win32') {
        trayIconPath = path.join(__dirname, 'tray', 'Windows', 'playerTemplate_white.png');
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

    // 아이콘 변경 함수
    function changeTrayIcon(style) {
        currentIconStyle = style;
        const iconName = style === 'player' ? 'playerTemplate' : 'spectrumTemplate';

        let newTrayIconPath;
        if (process.platform === 'win32') {
            newTrayIconPath = path.join(__dirname, 'tray', 'Windows', `${iconName}_white.png`);
        } else {
            newTrayIconPath = path.join(__dirname, 'tray', 'macOS', `${iconName}.png`);
        }

        const newTrayIcon = nativeImage.createFromPath(newTrayIconPath);
        if (process.platform === 'darwin') {
            newTrayIcon.setTemplateImage(true);
        }

        tray.setImage(newTrayIcon);
    }

    // --- 🚨 핵심: 모드에 따라 창 크기와 위치 변경 ---
    function setWindowMode(mode) {
        const currentScreen = screen.getPrimaryDisplay().workAreaSize;
        
        // 👇 추가: 사이즈를 바꾸기 직전에만 사이즈 변경을 허용 (버그 뚫기!)
        win.setResizable(true); 

        if (mode === 'eq') {
            win.setSize(700, 44);
            win.setPosition(Math.floor((currentScreen.width - 700) / 2), currentScreen.height - 44 - 4);
            if (win && !win.isDestroyed()) win.webContents.send('change-style', 'eq');
        } else if (mode === 'lp') {
            win.setSize(320, 320); 
            win.setPosition(Math.floor((currentScreen.width - 320) / 2), currentScreen.height - 320 - 20); 
            if (win && !win.isDestroyed()) win.webContents.send('change-style', 'lp');
        }

        // 👇 추가: 사이즈가 바뀌었으니 사용자가 마우스로 창을 못 늘리게 다시 꽉 잠금!
        win.setResizable(false); 
    }

    // 트레이 메뉴
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Bar 보이기/숨기기',
            click: () => {
                win.isVisible() ? win.hide() : win.show();
            }
        },
        { type: 'separator' }, 
        {
            label: '위젯 스타일', 
            submenu: [
                {
                    label: '가사 바 (가로형)',
                    type: 'radio',
                    checked: true,
                    click: () => setWindowMode('eq')
                },
                {
                    label: 'LP 플레이어 (위젯형)',
                    type: 'radio',
                    checked: false,
                    click: () => setWindowMode('lp')
                }
            ]
        },
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
        { type: 'separator' }, 
        {
            label: '종료',
            click: () => {
                app.isQuiting = true;
                app.quit();
            }
        }
    ]);

    tray.on('click', () => {
        tray.popUpContextMenu(contextMenu);
    });

    tray.on('right-click', () => {
        if (win.isVisible()) {
            win.hide();
        } else {
            win.show();
        }
    });

    // 앱 실행 직후에는 창 크기를 못 바꾸게 잠가두기
    win.setResizable(false);
});

// Mac 마이크 접근 권한 요청
const { systemPreferences } = require('electron');
if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone');
}

app.on('window-all-closed', () => app.quit());