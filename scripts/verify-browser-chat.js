const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

async function main() {
    console.log('🚀 Starting Puppeteer browser verification...');
    const screenshotsDir = path.resolve(__dirname, '../assets/test-screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--use-gl=swiftshader'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    page.on('requestfailed', req => {
        console.error(`[Network Failed]: ${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    });
    page.on('response', res => {
        if (res.status() >= 400) {
            console.error(`[Network ${res.status()}]: ${res.request().method()} ${res.url()}`);
        }
    });

    const errors = [];
    page.on('console', msg => {
        const text = msg.text();
        if (msg.type() === 'error') {
            errors.push(text);
            console.error('[Browser Error]:', text);
        } else {
            console.log('[Browser Console]:', text);
        }
    });

    page.on('pageerror', err => {
        errors.push(err.message);
        console.error('[Browser PageError]:', err.message);
    });

    console.log('📍 Navigating to http://127.0.0.1:3000/ ...');
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the app container to mount
    await page.waitForSelector('.sb-desktop-app-container', { timeout: 15000 });
    console.log('✓ Desktop app container mounted');

    // Wait a moment for animations
    await new Promise(r => setTimeout(r, 2000));
    const initScreenshot = path.join(screenshotsDir, '01-initial-home.png');
    await page.screenshot({ path: initScreenshot, fullPage: false });
    console.log(`📸 Initial screenshot saved: ${initScreenshot}`);

    // Look for chat textarea
    const textareaSelector = 'textarea.sb-composer-textarea, textarea';
    await page.waitForSelector(textareaSelector, { timeout: 10000 });
    console.log('✓ Composer textarea found');

    const promptText = 'build a 3d scene of the battle of lexington';
    console.log(`✍️ Typing prompt: "${promptText}"`);
    await page.focus(textareaSelector);
    await page.keyboard.type(promptText, { delay: 30 });

    console.log('⏎ Submitting prompt via Enter...');
    await page.keyboard.press('Enter');

    // Wait for response, message bubbles, or 3D canvas to render
    console.log('⏳ Waiting for response and 3D canvas stage...');
    await new Promise(r => setTimeout(r, 6000));

    const submittedScreenshot = path.join(screenshotsDir, '02-chat-submitted-3d-scene.png');
    await page.screenshot({ path: submittedScreenshot, fullPage: false });
    console.log(`📸 Chat submitted screenshot saved: ${submittedScreenshot}`);

    // Wait for completion & stage transition
    await new Promise(r => setTimeout(r, 6000));
    const finalScreenshot = path.join(screenshotsDir, '03-completed-stage.png');
    await page.screenshot({ path: finalScreenshot, fullPage: false });
    console.log(`📸 Completed stage screenshot saved: ${finalScreenshot}`);

    // Check if the canvas / 3D viewport or split stage rendered
    const hasError = await page.evaluate(() => {
        const body = document.body;
        const text = body ? body.innerText : '';
        const root = document.getElementById('root');
        const rootEmpty = !root || root.children.length === 0;
        const messages = Array.from(document.querySelectorAll('.sb-drawer-msg-row')).map(m => m.innerText);
        const stageWrapper = document.querySelector('.sb-3d-stage-wrapper, .sb-surface-main-viewport, .sb-chatgpt-document-card, canvas');
        return {
            rootEmpty,
            has3DStage: !!stageWrapper,
            hasMessages: messages.length > 0,
            messagesText: messages,
            hasComposer: !!document.querySelector('textarea'),
            bodyLength: text.length
        };
    });

    console.log('🔍 Render Inspection:', hasError);

    if (hasError.rootEmpty) {
        throw new Error('Root container was unmounted (blank screen bug reproduced)!');
    }

    if (!hasError.hasMessages && !hasError.has3DStage) {
        throw new Error('Neither messages nor 3D stage rendered after prompt submission.');
    }

    console.log('🎉 Verification successful: App rendered smoothly without blank screens or unmounted trees!');
    await browser.close();
}

main().catch(err => {
    console.error('❌ Browser verification failed:', err);
    process.exit(1);
});
