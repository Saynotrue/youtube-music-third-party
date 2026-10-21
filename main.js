const { app, BrowserWindow, screen, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain } = require('electron');
const path = require('path');

// ─── 전역 창 참조 및 상태 ────────────────────────────────
let win;
let tray = null;
let currentIconStyle = 'player';
let currentWidgetStyle = 'eq';

// ─── 2. 앱 실행 및 메인 윈도우 생성 ───────────────────────
app.whenReady().then(() => {
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
        alwaysOnTop: true, // 🚨 앱 켜질 때 기본 위젯 모드이므로 항상 위 활성화
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

    // 창 보이기/숨기기: 전체화면 창이 다른 창 뒤에 있으면(Alt+Tab으로 넘어간 경우) 숨기지 않고 앞으로 가져옴
    function isWindowShown() {
        if (!win.isVisible() || win.isMinimized()) return false;
        return !win.isFullScreen() || win.isFocused();
    }
    function bringWindowToFront() {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
    function toggleWindow() {
        isWindowShown() ? win.hide() : bringWindowToFront();
    }

    // ─── 4. 동적 컨텍스트 메뉴 ────────────────────────────
    function getDynamicContextMenu() {
        const isWindowVisible = isWindowShown();
        return Menu.buildFromTemplate([
            {
                label: '설정',
                click: () => {
                    if (!win.isVisible()) win.show();
                    win.focus();
                    // 강제로 최상단으로 한 번 끌어올린 뒤, 설정창 조작을 위해 항상 위 해제
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
                    isWindowVisible ? win.hide() : bringWindowToFront();
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
            win.setSize(320, 360);
            win.setPosition(Math.floor((currentScreen.width - 320) / 2), currentScreen.height - 360 - 20);
            if (win && !win.isDestroyed()) win.webContents.send('change-style', 'lp');
        }
        win.setResizable(false);
    }

    // ─── 6. IPC 통신 (설정 및 창 제어) ────────────────────
    ipcMain.on('update-system-settings', (event, settings) => {
        // 🚨 설정 창에서 변경사항이 들어오더라도 항상 위 여부를 변경하지 않음 (설정창/전체화면 간섭 방지)

        if (settings.globalShortcut) {
            if (!globalShortcut.isRegistered('CommandOrControl+Shift+Space')) {
                globalShortcut.register('CommandOrControl+Shift+Space', toggleWindow);
            }
        } else {
            globalShortcut.unregister('CommandOrControl+Shift+Space');
        }
        changeTrayIcon(settings.trayIcon);
        currentWidgetStyle = settings.widgetStyle;
    });

    ipcMain.on('close-settings', () => {
        setWindowMode(currentWidgetStyle);
        // 🚨 설정 창이 닫히고 위젯 모드로 돌아오면 무조건 항상 위(Always On Top) 활성화
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
        win.webContents.send('show-widget-after-settings');
    });

    win.setResizable(false);
});

// ─── 전체 화면 제어 통신 ────────────────────────────────
ipcMain.on('toggle-fullscreen', (event, isFullscreen) => {
    // 🚨 포커스 된 창을 찾는 방식에서 전역 상태인 win을 직접 참조하도록 안정성 강화
    if (!win || win.isDestroyed()) return;

    // 🚨 위젯 바는 작업 표시줄/Alt+Tab 목록에서 숨기지만(skipTaskbar), 전체화면일 때는 일반 창처럼 표시해야
    //    Windows에서 Alt+Tab으로 다른 창에 갔다가 다시 돌아올 수 있음
    if (isFullscreen) {
        // 🚨 전체화면 켜기: 항상 위 옵션을 강제로 해제하고 꽉 채움
        win.setAlwaysOnTop(false);
        win.setSkipTaskbar(false);
        win.setFullScreen(true);
    } else {
        // 🚨 전체화면 끄기: 전체화면을 풀고 무조건 항상 위 옵션 재활성화
        win.setFullScreen(false);
        win.setSkipTaskbar(true);
        win.setAlwaysOnTop(true, 'screen-saver');
    }
});

// ─── 앱 종료 관리 ─────────────────────────────────────────
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});