const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const css = read("styles.css");
const app = read("app.js");
const pwa = read("pwa.js");
const serviceWorker = read("service-worker.js");
const build = read("scripts/build.js");
const manifest = JSON.parse(read("manifest.webmanifest"));

function createPwaHarness(userAgent) {
    const listeners = new Map();
    const classes = new Set();
    const stored = new Map();
    const elements = {
        pwaInstallBanner: { hidden: true },
        pwaInstallMessage: { textContent: "" },
        pwaInstallButton: { textContent: "" }
    };
    let serviceWorkerRegistrations = 0;

    const navigator = {
        userAgent,
        standalone: false,
        serviceWorker: {
            register: async () => {
                serviceWorkerRegistrations += 1;
            }
        }
    };
    const window = {
        navigator,
        location: { protocol: "https:" },
        matchMedia: () => ({ matches: false }),
        addEventListener: (name, handler) => listeners.set(name, handler)
    };
    const sandbox = {
        window,
        navigator,
        document: {
            body: {
                classList: {
                    add: value => classes.add(value),
                    remove: value => classes.delete(value)
                }
            },
            getElementById: id => elements[id] || null
        },
        sessionStorage: {
            getItem: key => stored.get(key) || null,
            setItem: (key, value) => stored.set(key, value)
        },
        console: { warn: () => {} }
    };

    vm.runInNewContext(pwa, sandbox);
    return {
        classes,
        elements,
        fire: (name, event = {}) => listeners.get(name)?.(event),
        getServiceWorkerRegistrations: () => serviceWorkerRegistrations,
        window
    };
}

test("手機 Header 使用 48px／Logo／48px 三欄且保留獨立活動選擇器", () => {
    assert.match(html, /class="mobile-brand"/);
    assert.match(html, /id="mobileGroupBuySelect"/);
    assert.match(css, /grid-template-columns:\s*48px minmax\(0,\s*1fr\) 48px/);
    assert.match(css, /min-height:\s*calc\(64px \+ env\(safe-area-inset-top\)\)/);
    assert.match(app, /selectMobile\.innerHTML = html/);
});

test("側欄具全畫面遮罩、82vw上限、背景鎖定與52px觸控高度", () => {
    assert.match(html, /id="sidebarBackdrop"/);
    assert.match(css, /width:\s*min\(82vw,\s*300px\)/);
    assert.match(css, /\.sidebar-backdrop\.show[\s\S]*pointer-events:\s*auto/);
    assert.match(css, /body\.sidebar-open[\s\S]*overflow:\s*hidden/);
    assert.match(css, /\.menu-item a[\s\S]*min-height:\s*52px/);
    assert.match(app, /document\.body\.classList\.toggle\('sidebar-open', shouldOpen\)/);
    assert.match(app, /if \(event\.key === 'Escape'\) closeMobileMenu\(\)/);
});

test("首頁標題、卡片名稱與手機優先順序符合簡化規格", () => {
    assert.match(app, /尚未建立團購活動/);
    assert.doesNotMatch(app, /尚未選擇\/建立團購活動/);
    for (const label of ["本團客戶", "訂單金額", "待付款", "待包貨", "待外送", "待自取"]) {
        assert.match(html, new RegExp(`>${label}<`));
    }
    const dashboardHeader = html.slice(html.indexOf('id="dashboard-title"'), html.indexOf("<!-- 統計資訊 -->"));
    assert.match(dashboardHeader, /新增訂單/);
    assert.doesNotMatch(dashboardHeader, /匯出 Excel/);
    assert.match(css, /\.stat-card:nth-child\(3\) \{ order: 1; \}/);
    assert.match(css, /word-break:\s*keep-all/);
    assert.match(css, /white-space:\s*nowrap/);
    assert.match(css, /@media \(max-width:\s*360px\)[\s\S]*grid-template-columns:\s*1fr/);
});

test("動態視窗高度與安全區域避免內建瀏覽器工具列遮擋", () => {
    assert.match(html, /viewport-fit=cover/);
    assert.match(css, /min-height:\s*100vh;\s*\r?\n\s*min-height:\s*100dvh/);
    assert.match(css, /padding:\s*16px 14px calc\(24px \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(css, /bottom:\s*calc\(10px \+ env\(safe-area-inset-bottom\)\)/);
});

test("PWA manifest、Service Worker、安裝提示與build產物契約完整", () => {
    assert.equal(manifest.name, "阿賢 Easy購管理系統");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.scope, "./");
    assert.equal(manifest.icons.length, 2);
    assert.ok(manifest.icons.some(icon => icon.sizes === "192x192"));
    assert.ok(manifest.icons.some(icon => icon.sizes === "512x512"));
    assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
    assert.match(html, /id="pwaInstallBanner"/);
    assert.match(pwa, /beforeinstallprompt/);
    assert.match(pwa, /Line\|FBAN\|FBAV\|Instagram/);
    assert.match(pwa, /if \(isEmbeddedBrowser\(\)\) return/);
    assert.match(pwa, /navigator\.serviceWorker\.register\('\.\/service-worker\.js'\)/);
    assert.match(serviceWorker, /CACHE_NAME/);
    assert.match(serviceWorker, /request\.mode === 'navigate'/);
    assert.match(serviceWorker, /url\.pathname\.includes\('\/api\/'\)/);
    assert.match(build, /manifest\.webmanifest/);
    assert.match(build, /service-worker\.js/);
    assert.match(build, /fs\.cpSync\(path\.join\(root, "icons"\)/);
    assert.ok(fs.existsSync(path.join(root, "icons", "icon-192.svg")));
    assert.ok(fs.existsSync(path.join(root, "icons", "icon-512.svg")));
});

test("Android Chrome 可顯示安裝提示並執行安裝流程", async () => {
    const harness = createPwaHarness(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36"
    );
    let prevented = false;
    let prompted = false;
    harness.fire("beforeinstallprompt", {
        preventDefault: () => { prevented = true; },
        prompt: () => { prompted = true; },
        userChoice: Promise.resolve({ outcome: "accepted" })
    });

    assert.equal(prevented, true);
    assert.equal(harness.elements.pwaInstallBanner.hidden, false);
    assert.equal(harness.classes.has("pwa-install-visible"), true);
    await harness.window.installPwa();
    assert.equal(prompted, true);
    assert.equal(harness.elements.pwaInstallBanner.hidden, true);

    harness.fire("load");
    await Promise.resolve();
    assert.equal(harness.getServiceWorkerRegistrations(), 1);
});

test("LINE 內建瀏覽器不顯示無法使用的 PWA 安裝提示", () => {
    const harness = createPwaHarness(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Line/14.10.2 Mobile Safari/537.36"
    );
    harness.fire("beforeinstallprompt", {
        preventDefault: () => {},
        prompt: () => {},
        userChoice: Promise.resolve({ outcome: "dismissed" })
    });

    assert.equal(harness.elements.pwaInstallBanner.hidden, true);
    assert.equal(harness.classes.has("pwa-install-visible"), false);
});
