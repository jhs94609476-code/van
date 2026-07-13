const fs = require('fs');
const path = require('path');

// Configuration
const API_URL = 'https://script.google.com/macros/s/AKfycbwgIOmGRm8Tp5h-vBA6XtGd_M1-1JhmIys1wko9ZeETD1BT1AfjDD-Vs2foPMqAW-US/exec';
const LOCAL_DATA_FILE = './data.json';
const TEMPLATE_FILE = './index.html';
const CSS_FILE = './style.css';
const IMAGES_DIR = './images';
const DIST_DIR = './dist';

// Helper: Ensure directory exists recursively
function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

// Helper: Copy directory recursively
function copyDir(src, dest) {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Helper: Map Link (Column A) to output filepath under dist
function mapLinkToFilePath(link, region, product) {
    if (!link) {
        // Fallback to region-product slug if no link is provided
        const slug = `${region || 'index'}-${product || ''}`.replace(/[\s/]+/g, '-').replace(/^-+|-+$/g, '');
        return `${slug}.html`;
    }

    let cleanPath = link.trim();

    // 1. Handle absolute URL
    if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
        try {
            const urlObj = new URL(cleanPath);
            cleanPath = urlObj.pathname;
        } catch (e) {
            console.warn(`⚠️ Failed to parse URL: ${cleanPath}. Using as path.`);
        }
    }

    // 2. Decode URI component (e.g. handle Korean, percent encoding)
    try {
        cleanPath = decodeURIComponent(cleanPath);
    } catch (e) {
        // Ignore decoding errors
    }

    // 3. Remove leading/trailing slash and whitespace
    cleanPath = cleanPath.trim();

    // If it's just root, map to index.html
    if (cleanPath === '/' || cleanPath === '') {
        return 'index.html';
    }

    if (cleanPath.startsWith('/')) {
        cleanPath = cleanPath.substring(1);
    }

    // 4. Ensure it ends with .html
    if (!cleanPath.endsWith('.html')) {
        if (cleanPath.endsWith('/')) {
            cleanPath = cleanPath + 'index.html';
        } else {
            cleanPath = cleanPath + '.html';
        }
    }

    return cleanPath;
}

// Build function
async function build() {
    console.log('🚀 Starting static page generation...');
    
    // 1. Validate template
    if (!fs.existsSync(TEMPLATE_FILE)) {
        console.error(`❌ Template file ${TEMPLATE_FILE} not found.`);
        return;
    }
    const templateHtml = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    
    // 2. Load data (Fetch from Google App Script or fall back to local file)
    let rows = [];
    try {
        console.log(`🌐 Fetching data from Google App Script API...`);
        const fetchFn = typeof fetch !== 'undefined' ? fetch : null;
        if (!fetchFn) {
            throw new Error('Native fetch is not available in this Node.js version.');
        }
        
        const response = await fetchFn(API_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        // Since Google Apps Script can return HTML on errors, check content-type before parsing JSON
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await response.text();
            if (text.includes('doGet')) {
                throw new Error('Google Apps Script lacks a doGet handler or is not deployed as a public web app.');
            }
            throw new Error(`Invalid response content type: ${contentType}`);
        }
        
        rows = await response.json();
        console.log(`✅ Successfully fetched ${rows.length} rows from Google Sheets API.`);
    } catch (err) {
        console.warn(`⚠️ API Fetch failed (${err.message}). Trying to load local ${LOCAL_DATA_FILE}...`);
        if (fs.existsSync(LOCAL_DATA_FILE)) {
            try {
                rows = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf8'));
                console.log(`✅ Loaded ${rows.length} rows from local JSON data.`);
            } catch (jsonErr) {
                console.error(`❌ Failed to parse local JSON data: ${jsonErr.message}`);
                return;
            }
        } else {
            console.error(`❌ No data source found. Please ensure data.json exists or Google Apps Script is accessible.`);
            createSampleDataFile();
            return;
        }
    }
    
    // 3. Recreate dist directory
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });
    
    // 4. Copy CSS and Images
    if (fs.existsSync(CSS_FILE)) {
        fs.copyFileSync(CSS_FILE, path.join(DIST_DIR, 'style.css'));
    }
    if (fs.existsSync(IMAGES_DIR)) {
        copyDir(IMAGES_DIR, path.join(DIST_DIR, 'images'));
    }
    
    // 5. Generate pages
    let successCount = 0;
    for (const row of rows) {
        // Extract values supporting multiple key names from sheet (Column A, B, C, E)
        const link = row.link || row['링크'] || row.url || row['주소'] || row.path || row.A || row['A열'] || '';
        const region = row.region || row['지역'] || row.B || row['B열'] || '';
        const product = row.product || row['상품'] || row.C || row['C열'] || '';
        const htmlContent = row.result || row['결과'] || row.htmlContent || row.html_content || row['원고'] || row['본문'] || row.E || row['E열'] || '';
        
        // Skip completely empty or invalid rows
        if (!link && !region && !product) {
            console.warn(`⚠️ Skipping empty/invalid row:`, row);
            continue;
        }
        
        // Map path/filename using Column A
        const filename = mapLinkToFilePath(link, region, product);
        
        // Fallbacks for SEO keywords
        const seoRegion = region || '전국';
        const seoProduct = product || '결제 시스템';
        
        // SEO Rule 1: {지역(한글)} {상품} 추천 및 가격 비교 | 합리적인 선택
        const title = `${seoRegion} ${seoProduct} 추천 및 가격 비교 | 합리적인 선택`;
        
        // SEO Rule 2: {지역(한글)}에서 매장 오픈 및 교체를 위해 합리적인 {상품} 업체를 찾으시나요? 거품 없는 가격과 투명한 계약, {지역(한글)} 전 지역 신속한 당일 설치와 철저한 관리 서비스를 확인해 보세요.
        const description = `${seoRegion}에서 매장 오픈 및 교체를 위해 합리적인 ${seoProduct} 업체를 찾으시나요? 거품 없는 가격과 투명한 계약, ${seoRegion} 전 지역 신속한 당일 설치와 철저한 관리 서비스를 확인해 보세요.`;
        
        // Generate final HTML
        let outputHtml = templateHtml;
        
        // Replace Title Tag
        outputHtml = outputHtml.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
        
        // Replace Meta Description Tag
        outputHtml = outputHtml.replace(/<meta\s+name=["']description["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta name="description" content="${description}">`);
        
        // Inject Philosophy Content (E Column html)
        const philosophyRegex = /<div\s+class=["']content-text["']\s+id=["']philosophy-content-area["']>\s*<\/div>/i;
        outputHtml = outputHtml.replace(philosophyRegex, `<div class="content-text" id="philosophy-content-area">${htmlContent}</div>`);
        
        // Pre-render Region names inside class="region-target" elements for SEO static indexing
        outputHtml = outputHtml.replace(/<span\s+class=["']region-target["']>전국<\/span>/g, `<span class="region-target">${seoRegion}</span>`);
        
        // Write file to dist
        const outputPath = path.join(DIST_DIR, filename);
        ensureDirectoryExistence(outputPath);
        fs.writeFileSync(outputPath, outputHtml, 'utf8');
        console.log(`📄 Generated: ${filename} (mapped from "${link || 'fallback'}")`);
        successCount++;
    }
    
    console.log(`\n🎉 Success! Generated ${successCount} pages in the ${DIST_DIR}/ directory.`);
}

function createSampleDataFile() {
    const sampleData = [
        {
            "link": "/gangnam-pos",
            "region": "강남구",
            "product": "포스기",
            "result": "<p>강남구 사장님들을 위한 결제 관리의 최상의 선택...</p><div class=\"highlight-text\">\"강남구 전 지역 즉시 당일 설치 보장\"</div><p>매장 결제 문제, 이제 전문가에게 맡겨보세요.</p>"
        },
        {
            "link": "https://example.com/seocho-kiosk.html",
            "region": "서초구",
            "product": "키오스크",
            "result": "<p>서초구 요식업 매장 오픈 및 교체를 위한 스마트 오더...</p><div class=\"highlight-text\">\"테이블 회전율 향상과 간편 주문의 결합\"</div><p>철저한 사후 관리 서비스도 함께 제공합니다.</p>"
        }
    ];
    fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(sampleData, null, 2), 'utf8');
    console.log(`📝 Created a sample data file at ${LOCAL_DATA_FILE} to help you get started.`);
}

build();
