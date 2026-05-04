const { app, BrowserWindow, screen, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain } = require('electron');
const path = require('path');
require('./server.js');

let win;
let tray = null;
let setupWindow = null; // 🚨 추가: Spotify 셋업 창 변수
let currentIconStyle = 'player';
let currentWidgetStyle = 'eq';
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

    // --- 트레이 아이콘 설정 ---
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
        if (process.platform === 'darwin') newTrayIcon.setTemplateImage(true);
        tray.setImage(newTrayIcon);
    }

    // --- 윈도우 모드 변경 함수 ---
    function setWindowMode(mode) {
        currentWidgetStyle = mode;
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

    // --- 🚨 Spotify API 셋업 창 생성 로직 추가 ---
    ipcMain.on('open-setup-window', () => {
        if (setupWindow) {
            setupWindow.focus();
            return;
        }

        setupWindow = new BrowserWindow({
            width: 450,
            height: 550,
            resizable: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        // 파일 구조(image_c47e9f.png)에 따른 정확한 경로 설정
        const setupPath = path.join(__dirname, 'renderer', 'setup.html');
        setupWindow.loadFile(setupPath);

        setupWindow.on('closed', () => {
            setupWindow = null;
        });
    });

    function getDynamicContextMenu() {
        const isWindowVisible = win.isVisible() && !win.isMinimized();
        return Menu.buildFromTemplate([
            {
                label: '설정',
                click: () => {
                    if (!win.isVisible()) win.show();
                    win.webContents.send('hide-widget-for-settings');
                    setTimeout(() => {
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
        changeTrayIcon(settings.trayIcon);
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

app.on('window-all-closed', () => app.quit());