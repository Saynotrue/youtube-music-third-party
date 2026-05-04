const { app, BrowserWindow, screen, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain } = require('electron');
const path = require('path');
require('./server.js');

let win;
let tray = null;
let currentIconStyle = 'player';
let currentWidgetStyle = 'eq'; // 🚨 현재 위젯 모드 상태 저장

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

    // --- 🚨 모드에 따라 창 크기와 위치 변경 ---
    function setWindowMode(mode) {
        currentWidgetStyle = mode; // 변경된 상태 저장
        const currentScreen = screen.getPrimaryDisplay().workAreaSize;

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

        win.setResizable(false);
    }

    function getDynamicContextMenu() {
        const isWindowVisible = win.isVisible() && !win.isMinimized();

        return Menu.buildFromTemplate([
            {
                label: '설정',
                click: () => { win.show(); ipcMain.emit('open-settings'); },
            },
            { type: 'separator' },
            {
                label: isWindowVisible ? '숨기기' : '보이기 ',

                accelerator: 'CommandOrControl+Shift+Space',

                registerAccelerator: false,

                click: () => {
                    if (isWindowVisible) {
                        win.hide();
                    } else {
                        win.show();
                        win.focus();
                    }
                },
            },
            { type: 'separator' },
            {
                label: '위젯 스타일',
                submenu: [
                    {
                        label: '가사 바 (가로형)',
                        type: 'radio',
                        checked: currentWidgetStyle === 'eq', // 상태 연동
                        click: () => setWindowMode('eq')
                    },
                    {
                        label: 'LP 플레이어 (위젯형)',
                        type: 'radio',
                        checked: currentWidgetStyle === 'lp', // 상태 연동
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
    }

    tray.on('click', () => {
        tray.popUpContextMenu(getDynamicContextMenu());
    });

    tray.on('right-click', () => {
        if (win.isVisible() && !win.isMinimized()) {
            win.hide();
        } else {
            win.show();
            win.focus();
        }
    });

    globalShortcut.register('CommandOrControl+Shift+Space', () => {
        if (win.isVisible() && !win.isMinimized()) {
            win.hide();
        } else {
            win.show();
            win.focus();
        }
    });

    win.setResizable(false);
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

ipcMain.on('open-settings', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    win.setSize(700, 600);
    win.setPosition(Math.floor((width - 700) / 2), height - 600 - 4);
    win.webContents.send('open-settings');
});

ipcMain.on('close-settings', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    win.setSize(700, 44);
    win.setPosition(Math.floor((width - 700) / 2), height - 44 - 4);
});

// Mac 마이크 접근 권한 요청
const { systemPreferences } = require('electron');
if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone');
}

app.on('window-all-closed', () => app.quit());