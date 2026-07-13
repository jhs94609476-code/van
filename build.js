const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

// Helper: Load env variables manually from .env file
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const match = trimmed.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
            if (match) {
                const key = match[1];
                let value = match[2].trim();
                // Remove surrounding quotes
                if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
                process.env[key] = value;
            }
        });
    }
}
loadEnv();

// Configuration
const CSV_URL = process.env.GOOGLE_SHEET_CSV_URL || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vStAETGqwhy2ux_FQAzPeS_bPUu_pIk_F7n79vO7LKCgAZ1KYHnqJ37WX5c2Higqtzx8gG6HBq7zouS/pub?gid=641735560&single=true&output=csv';
const LOCAL_DATA_FILE = './data.json';
const TEMPLATE_FILE = './index.html';
const CSS_FILE = './style.css';
const IMAGES_DIR = './images';
const DIST_DIR = './dist';

// Helper: Ensure directory exists recursively (thread-safe for parallel execution)
function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (!fs.existsSync(dirname)) {
        try {
            fs.mkdirSync(dirname, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
    }
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
            try {
                fs.copyFileSync(srcPath, destPath);
            } catch (err) {
                console.warn(`⚠️ Warning: Could not copy file ${entry.name}: ${err.message}`);
            }
        }
    }
}

// Helper: Map Link (Column A) to output filepath under dist
function mapLinkToFilePath(link, region, product) {
    if (!link) {
        // Fallback to region-product slug if no link is provided
        const slug = `${region || 'index'}-${product || ''}`.replace(/[\s/]+/g, '-').replace(/^-+|-+$/g, '');
        return `${slug}.html`.toLowerCase();
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

    // Remove query parameters or hash fragments
    cleanPath = cleanPath.split('?')[0].split('#')[0];

    // 2. Decode URI component (e.g. handle Korean, percent encoding)
    try {
        cleanPath = decodeURIComponent(cleanPath);
    } catch (e) {
        // Ignore decoding errors
    }

    cleanPath = cleanPath.trim();

    // If it's just root, map to index.html
    if (cleanPath === '/' || cleanPath === '') {
        return 'index.html';
    }

    // Remove leading slash
    if (cleanPath.startsWith('/')) {
        cleanPath = cleanPath.substring(1);
    }

    // Remove trailing slash
    if (cleanPath.endsWith('/')) {
        cleanPath = cleanPath.substring(0, cleanPath.length - 1);
    }

    // 3. Ensure it ends with .html
    if (!cleanPath.endsWith('.html')) {
        cleanPath = cleanPath + '.html';
    }

    return cleanPath.toLowerCase();
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
    
    // 2. Load data (Fetch CSV directly or fall back to local file)
    let rows = [];
    try {
        console.log(`🌐 Fetching CSV data from Google Spreadsheet...`);
        const fetchFn = typeof fetch !== 'undefined' ? fetch : null;
        if (!fetchFn) {
            throw new Error('Native fetch is not available in this Node.js version.');
        }
        
        const response = await fetchFn(CSV_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const csvText = await response.text();
        console.log(`✅ CSV successfully loaded (${(csvText.length / 1024 / 1024).toFixed(2)} MB). Parsing...`);
        
        const parsed = Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true
        });
        
        rows = parsed.data;
        console.log(`✅ Successfully parsed ${rows.length} rows from CSV.`);
    } catch (err) {
        console.warn(`⚠️ CSV Fetch/Parse failed (${err.message}). Trying to load local ${LOCAL_DATA_FILE}...`);
        if (fs.existsSync(LOCAL_DATA_FILE)) {
            try {
                rows = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf8'));
                console.log(`✅ Loaded ${rows.length} rows from local JSON data.`);
            } catch (jsonErr) {
                console.error(`❌ Failed to parse local JSON data: ${jsonErr.message}`);
                return;
            }
        } else {
            console.error(`❌ No data source found. Please ensure data.json exists or CSV URL is accessible.`);
            return;
        }
    }
    
    // 3. Recreate/clean dist directory safely to handle Windows file locking
    if (!fs.existsSync(DIST_DIR)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
    } else {
        try {
            const entries = fs.readdirSync(DIST_DIR);
            for (const entry of entries) {
                const entryPath = path.join(DIST_DIR, entry);
                if (fs.statSync(entryPath).isDirectory()) {
                    fs.rmSync(entryPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(entryPath);
                }
            }
        } catch (cleanErr) {
            console.warn(`⚠️ Warning: Could not fully clean dist directory: ${cleanErr.message}`);
        }
    }
    
    // 4. Copy CSS and Images
    if (fs.existsSync(CSS_FILE)) {
        try {
            fs.copyFileSync(CSS_FILE, path.join(DIST_DIR, 'style.css'));
        } catch (err) {
            console.warn(`⚠️ Warning: Could not overwrite style.css: ${err.message}`);
        }
    }
    if (fs.existsSync(IMAGES_DIR)) {
        copyDir(IMAGES_DIR, path.join(DIST_DIR, 'images'));
    }
    
    // 5. Generate pages in batches to optimize file I/O speed
    let successCount = 0;
    let firstRowGenerated = false;
    console.log(`⚙️ Generating HTML pages asynchronously...`);
    
    const BATCH_SIZE = 100;
    let batch = [];
    
    for (const row of rows) {
        const link = (row['링크'] || row.link || '').trim();
        if (!link) {
            continue;
        }
        
        const region = (row['지역(한글'] || row['지역(한글)'] || row['지역'] || row.region || '').trim();
        const product = (row['상품'] || row.product || '').trim();
        const htmlContent = row['결과'] || row.result || row.htmlContent || row.html_content || '';
        
        batch.push({ link, region, product, htmlContent });
        
        if (batch.length >= BATCH_SIZE) {
            await processBatch(batch);
            batch = [];
        }
    }
    
    if (batch.length > 0) {
        await processBatch(batch);
    }
    
    async function processBatch(items) {
        const promises = items.map(async (item) => {
            const filename = mapLinkToFilePath(item.link, item.region, item.product);
            
            // Fallbacks for SEO keywords
            const seoRegion = item.region || '전국';
            const seoProduct = item.product || '결제 시스템';
            
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
            outputHtml = outputHtml.replace(philosophyRegex, `<div class="content-text" id="philosophy-content-area">${item.htmlContent}</div>`);
            
            // Pre-render Region names inside class="region-target" elements for SEO static indexing
            outputHtml = outputHtml.replace(/<span\s+class=["']region-target["']>전국<\/span>/g, `<span class="region-target">${seoRegion}</span>`);
            
            // Write file to dist
            const outputPath = path.join(DIST_DIR, filename);
            ensureDirectoryExistence(outputPath);
            try {
                await fs.promises.writeFile(outputPath, outputHtml, 'utf8');
                successCount++;
                
                let isFirst = false;
                if (!firstRowGenerated) {
                    firstRowGenerated = true;
                    isFirst = true;
                }
                if (isFirst) {
                    const rootIndexPath = path.join(DIST_DIR, 'index.html');
                    await fs.promises.writeFile(rootIndexPath, outputHtml, 'utf8');
                    console.log(`🏠 Generated index.html from the first row data.`);
                }
                
                if (successCount % 1000 === 0) {
                    console.log(`⏳ Generated ${successCount} / ${rows.length} pages...`);
                }
            } catch (err) {
                console.warn(`⚠️ Warning: Could not write file ${filename}: ${err.message}`);
            }
        });
        
        await Promise.all(promises);
    }
    
    console.log(`\n🎉 Success! Generated ${successCount} pages in the ${DIST_DIR}/ directory.`);
}

build();
