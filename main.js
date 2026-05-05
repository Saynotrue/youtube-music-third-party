const { app, BrowserWindow, screen, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── 1. Spotify 환경 설정 관리 (config.json) ────────────────
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
    // 1. userData에 저장된 설정 우선 로드[cite: 8]
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        Object.assign(process.env, config);
        return true;
    }
    // 2. 개발 환경 fallback: 프로젝트 루트 .env[cite: 8]
    if (!app.isPackaged) {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            require('dotenv').config({ path: envPath });
            if (process.env.SPOTIFY_CLIENT_ID) return true;
        }
    }
    return false;
}

function saveConfig(clientId, clientSecret) {
    const config = {
        SPOTIFY_CLIENT_ID: clientId,
        SPOTIFY_CLIENT_SECRET: clientSecret,
        REDIRECT_URI: 'http://127.0.0.1:8888/callback',
        PORT: '8888',
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    Object.assign(process.env, config); // 현재 프로세스 환경변수 업데이트[cite: 8]
}

// ─── 전역 창 참조 및 상태 ────────────────────────────────
let win;
let tray = null;
let setupWindow = null;
let isAlwaysOnTopConfig = true;
let currentIconStyle = 'player';
let currentWidgetStyle = 'eq';

// ─── 2. 앱 실행 및 메인 윈도우 생성 ───────────────────────
app.whenReady().then(() => {
    // 환경변수 로드 (Spotify 설정이 없어도 진행됨)
    loadConfig();

    // 통합 서버 구동
    require('./server.js');

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

    // F11 전체화면 버그 방지[cite: 7]
    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F11') event.preventDefault();
    });

    // ─── 3. 트레이 아이콘 설정 (OS 맞춤형) ────────────────
    let trayIconPath;
    if (process.platform === 'win32') {
        trayIconPath = path.join(__dirname, 'tray', 'Windows', 'playerTemplate_white.png');
    } else {
        trayIconPath = path.join(__dirname, 'tray', 'macOS', 'playerTemplate.png');
    }

    const trayIcon = nativeImage.createFromPath(trayIconPath);
    if (process.platform === 'darwin') trayIcon.setTemplateImage(true);

    tray = new Tray(trayIcon);
    tray.setToolTip('LyricsBar');

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

    // ─── 4. 동적 컨텍스트 메뉴 ────────────────────────────
    function getDynamicContextMenu() {
        const isWindowVisible = win.isVisible() && !win.isMinimized();
        return Menu.buildFromTemplate([
            {
                label: '설정',
                click: () => {
                    if (!win.isVisible()) win.show();
                    win.focus();
                    win.setAlwaysOnTop(true, 'screen-saver');
                    win.setAlwaysOnTop(false);

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

    // ─── 5. 윈도우 모드 변경 (Bar / LP) ───────────────────
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

    // ─── 6. IPC 통신 (설정 및 창 제어) ────────────────────
    ipcMain.on('update-system-settings', (event, settings) => {
        isAlwaysOnTopConfig = settings.alwaysOnTop;
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
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(isAlwaysOnTopConfig, 'screen-saver');
        win.webContents.send('show-widget-after-settings');
    });

    // ─── 7. Spotify Setup 창 통신 ─────────────────────────
    ipcMain.on('open-setup-window', () => {
        if (setupWindow) {
            setupWindow.focus();
            return;
        }
        setupWindow = new BrowserWindow({
            width: 450,
            height: 550,
            resizable: false,
            alwaysOnTop: true,
            parent: win,
            modal: false,
            backgroundColor: '#121212',
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
        setupWindow.on('closed', () => { setupWindow = null; });
    });

    // setup 창에서 자격증명 제출 시
    ipcMain.on('setup-submit', (event, { clientId, clientSecret }) => {
        const cleanId = clientId.trim();
        const cleanSecret = clientSecret.trim();

        saveConfig(cleanId, cleanSecret);
        if (setupWindow) setupWindow.close();

        shell.openExternal('http://127.0.0.1:8888/login');
    });

    // Spotify 개발자 대시보드 열기[cite: 8]
    ipcMain.on('open-spotify-dashboard', () => {
        shell.openExternal('https://developer.spotify.com/dashboard');
    });

    win.setResizable(false);
});

// ─── 앱 종료 관리 ─────────────────────────────────────────
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
    e.preventDefault(); // 트레이 백그라운드 유지를 위해 바로 종료되지 않게 할 수도 있습니다.
});