const { app, BrowserWindow, screen, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain } = require('electron');
const path = require('path');
require('./server.js');

let win;
let tray = null;
let currentIconStyle = 'player';
let currentWidgetStyle = 'eq'; // 🚨 현재 위젯 모드 상태 저장
let previousBounds = null;

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
                click: () => {
                    if (!win.isVisible()) win.show();
                    win.webContents.send('hide-widget-for-settings');
                    setTimeout(() => {
                        // 🚨 previousBounds 백업 로직 삭제! (더 이상 필요 없습니다)
                        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
                        win.setResizable(true);
                        win.setBounds({ x: 0, y: 0, width: width, height: height });
                        win.setResizable(false);
                        win.webContents.send('open-settings');
                    }, 300);
                },
            },
            { type: 'separator' },
            {
                label: isWindowVisible ? '숨기기' : '보이기',
                accelerator: 'CommandOrControl+Shift+Space',
                registerAccelerator: false,
                click: () => {
                    isWindowVisible ? win.hide() : (win.show(), win.focus());
                },
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

    ipcMain.on('update-system-settings', (event, settings) => {
        if (win && !win.isDestroyed()) {
            win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
        }

        if (settings.globalShortcut) {
            if (!globalShortcut.isRegistered('CommandOrControl+Shift+Space')) {
                globalShortcut.register('CommandOrControl+Shift+Space', () => {
                    if (win.isVisible() && !win.isMinimized()) win.hide();
                    else { win.show(); win.focus(); }
                });
            }
        } else {
            globalShortcut.unregister('CommandOrControl+Shift+Space');
        }

        // 아이콘은 설정 누르자마자 즉시 변경
        changeTrayIcon(settings.trayIcon);

        // 🚨 핵심: 위젯 스타일 상태만 저장해둠 (당장 창 크기를 바꾸면 모달이 잘려버림!)
        currentWidgetStyle = settings.widgetStyle;
    });

    ipcMain.on('close-settings', () => {
        setWindowMode(currentWidgetStyle);

        win.webContents.send('show-widget-after-settings');
    });

    win.setResizable(false);
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

// Mac 마이크 접근 권한 요청
const { systemPreferences } = require('electron');
if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone');
}

app.on('window-all-closed', () => app.quit());