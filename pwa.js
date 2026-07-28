(function initializePwaSupport() {
    let deferredInstallPrompt = null;

    const banner = () => document.getElementById('pwaInstallBanner');
    const message = () => document.getElementById('pwaInstallMessage');
    const installButton = () => document.getElementById('pwaInstallButton');
    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
    const userAgent = () => window.navigator.userAgent || '';
    const isEmbeddedBrowser = () => /Line|FBAN|FBAV|Instagram/i.test(userAgent());

    function wasDismissed() {
        try {
            return sessionStorage.getItem('easygo_pwa_install_dismissed') === '1';
        } catch (_error) {
            return false;
        }
    }

    function showInstallBanner(text, buttonText = '立即安裝') {
        const element = banner();
        if (!element || isStandalone() || wasDismissed()) return;
        if (message()) message().textContent = text;
        if (installButton()) installButton().textContent = buttonText;
        element.hidden = false;
        document.body.classList.add('pwa-install-visible');
    }

    function hideInstallBanner() {
        const element = banner();
        if (element) element.hidden = true;
        document.body.classList.remove('pwa-install-visible');
    }

    window.dismissPwaInstall = function dismissPwaInstall() {
        try {
            sessionStorage.setItem('easygo_pwa_install_dismissed', '1');
        } catch (_error) {
            // 瀏覽器禁止 sessionStorage 時仍可關閉提示。
        }
        hideInstallBanner();
    };

    window.installPwa = async function installPwa() {
        if (!deferredInstallPrompt) {
            window.dismissPwaInstall();
            return;
        }
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        hideInstallBanner();
    };

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        if (isEmbeddedBrowser()) return;
        deferredInstallPrompt = event;
        showInstallBanner('安裝後可用獨立視窗開啟，不顯示一般瀏覽器網址列。');
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        hideInstallBanner();
    });

    window.addEventListener('load', () => {
        if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
            let reloadingForUpdate = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (reloadingForUpdate) return;
                reloadingForUpdate = true;
                window.location.reload();
            });
            navigator.serviceWorker.register('./service-worker.js').catch(error => {
                console.warn('Service Worker 註冊失敗', error);
            });
        }

        const isiOS = /iPad|iPhone|iPod/.test(userAgent());
        if (isiOS && !isEmbeddedBrowser() && !isStandalone()) {
            showInstallBanner('請點 Safari 分享按鈕，再選「加入主畫面」。', '知道了');
        }
    });
}());
