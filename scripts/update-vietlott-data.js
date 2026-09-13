const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GAMES = {
    mega645: '645',
    power655: '655',
    lotto535: '535',
    max3d: 'max-3d',
    max3dpro: 'max-3dpro',
    max3dplus: 'max-3d'
};

function parseResultHtml(html, gameType) {
    const anchorIdx = html.indexOf('day_so_ket_qua');
    if (anchorIdx === -1) throw new Error('Không tìm thấy khối kết quả trong trang');
    const windowHtml = html.substring(anchorIdx, anchorIdx + 2500);

    const ballMatches = [...windowHtml.matchAll(/bong_tron[^"]*">\s*(\d+)\s*</g)].map(m => m[1]);
    if (ballMatches.length < 1) throw new Error('Không đọc được số kết quả');

    let numbers;
    if (gameType.startsWith('max3d')) {
        const digits = ballMatches.join('');
        const triplets = [];
        for (let i = 0; i <= digits.length - 3; i += 3) triplets.push(digits.substring(i, i + 3));
        numbers = gameType === 'max3d' ? triplets.slice(0, 1) : triplets.slice(0, 2);
    } else {
        numbers = ballMatches.map(n => parseInt(n, 10));
    }

    const idMatch = html.match(/[Kk]ỳ quay(?: thưởng)?\s*<b>#?(\d+)<\/b>\s*ngày\s*<b>([\d\/]+)<\/b>/);
    if (!idMatch) throw new Error('Không đọc được mã kỳ quay / ngày');

    return { id: `#${idMatch[1]}`, date: idMatch[2], numbers };
}

async function fetchGame(browser, gameType, resultPath) {
    const targetUrl = `https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/${resultPath}`;
    
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        locale: 'vi-VN',
        viewport: { width: 1366, height: 768 },
        extraHTTPHeaders: {
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    });
    
    const page = await context.newPage();
    
    try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // Chờ challenge biến mất (tối đa 25 giây)
        try {
            await page.waitForFunction(
                () => !document.title.includes('Chờ một chút') && !document.title.includes('Just a moment'),
                { timeout: 25000 }
            );
        } catch (e) {
            // Nếu vẫn còn challenge thì thử đợi thêm
            await page.waitForTimeout(5000);
        }

        // Đợi thêm để trang kết quả load xong
        await page.waitForTimeout(3000);

        const title = await page.title();
        const html = await page.content();

        if (title.includes('Chờ một chút') || title.includes('Just a moment')) {
            throw new Error(`Vẫn đang ở trang challenge — Title: "${title}"`);
        }

        return parseResultHtml(html, gameType);
    } finally {
        await context.close();
    }
}

function mergeById(existing, newDraw) {
    const byId = {};
    [newDraw, ...existing].forEach(d => { if (d && d.id) byId[d.id] = d; });
    return Object.values(byId).sort((a, b) => {
        const na = parseInt(String(a.id).replace(/\D/g, ''), 10) || 0;
        const nb = parseInt(String(b.id).replace(/\D/g, ''), 10) || 0;
        return nb - na;
    }).slice(0, 200);
}

async function main() {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    console.log('Khởi động Chromium...');
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });

    for (const [gameType, resultPath] of Object.entries(GAMES)) {
        const filePath = path.join(dataDir, `${gameType}.json`);
        let existing = [];
        if (fs.existsSync(filePath)) {
            try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { existing = []; }
        }

        try {
            console.log(`Đang lấy ${gameType}...`);
            const draw = await fetchGame(browser, gameType, resultPath);
            const merged = mergeById(existing, draw);
            fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
            console.log(`[OK] ${gameType}: ${draw.id} (${draw.date}) — tổng ${merged.length} kỳ`);
        } catch (e) {
            console.warn(`[SKIP] ${gameType}: ${e.message}`);
        }

        // Nghỉ giữa các game
        await new Promise(r => setTimeout(r, 3000));
    }

    await browser.close();
    console.log('Hoàn tất.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
