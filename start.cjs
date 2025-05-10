const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createProxyMiddleware } = require('http-proxy-middleware');

// --- 1. 配置和常量 ---
const PUBLIC_PORT = 8100; // 用戶訪問的公開端口
const APP_INTERNAL_PORT = 3200; // server.js (主應用) 固定監聽的內部端口

// 加密和密碼存儲文件路徑
const MASTER_PASSWORD_STORAGE_FILE = path.join(__dirname, 'master_auth_config.enc');
const USER_CREDENTIALS_STORAGE_FILE = path.join(__dirname, 'user_credentials.enc'); // 保留以備將來擴展，目前主要用於主密碼
const MASTER_SECRET_KEY_FILE = path.join(__dirname, 'encryption.secret.key'); // 主加密密鑰存儲文件

const ALGORITHM = 'aes-256-cbc'; // 加密算法
const IV_LENGTH = 16; // 初始化向量長度

let serverJsProcess = null; // 用於存儲主應用 (server.js) 的子進程對象
let isShuttingDown = false; // 標記是否正在優雅關閉

// --- 1a. 獲取或生成主加密密鑰文本 ---
function initializeEncryptionSecretKeyText() {
    if (fs.existsSync(MASTER_SECRET_KEY_FILE)) {
        console.log(`[AUTH_GATE] 應用提示：正在從 ${MASTER_SECRET_KEY_FILE} 讀取主加密密鑰...`);
        const keyText = fs.readFileSync(MASTER_SECRET_KEY_FILE, 'utf8').trim();
        if (keyText.length < 64) { // 建議密鑰長度
            console.warn(`[AUTH_GATE] 安全警告：${MASTER_SECRET_KEY_FILE} 中的密鑰文本長度 (${keyText.length}) 可能不足。建議使用更長的密鑰。`);
        }
        return keyText;
    } else {
        console.log(`[AUTH_GATE] 應用提示：主加密密鑰文件 ${MASTER_SECRET_KEY_FILE} 不存在。正在生成新密鑰...`);
        const newKeyText = crypto.randomBytes(48).toString('hex'); // 生成一個96個字符的十六進制字符串作為密鑰文本
        try {
            fs.writeFileSync(MASTER_SECRET_KEY_FILE, newKeyText, { encoding: 'utf8', mode: 0o600 }); // 以安全權限寫入文件
            fs.chmodSync(MASTER_SECRET_KEY_FILE, 0o600); // 再次確保文件權限
            console.log(`[AUTH_GATE] 應用提示：新的主加密密鑰已生成並保存到 ${MASTER_SECRET_KEY_FILE} (權限 600)。`);
            console.warn(`[AUTH_GATE] 重要：請務必安全備份 ${MASTER_SECRET_KEY_FILE} 文件！刪除此文件將導致所有已加密密碼無法解密。`);
            return newKeyText;
        } catch (err) {
            console.error(`[AUTH_GATE] 嚴重錯誤：無法寫入或設置主加密密鑰文件 ${MASTER_SECRET_KEY_FILE} 的權限。程序將退出。`, err);
            process.exit(1); // 關鍵錯誤，退出程序
        }
    }
}

const ENCRYPTION_SECRET_KEY_TEXT = initializeEncryptionSecretKeyText();
// 使用 scrypt 從密鑰文本派生實際的加密密鑰，增加破解難度
const DERIVED_ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET_KEY_TEXT, 'a_fixed_salt_for_scrypt_derivation_v1_auth_gate', 32); // 鹽值最好是隨機生成並存儲，此處為簡化示例使用固定值

let isMasterPasswordSetupNeeded = !fs.existsSync(MASTER_PASSWORD_STORAGE_FILE); // 檢查主密碼是否已設置

// --- 1b. 啟動和管理 server.js (主應用) ---
function startMainApp() {
    if (serverJsProcess && !serverJsProcess.killed) {
        console.log('[AUTH_GATE] 主應用 (server.js) 已在運行中或正在嘗試啟動。');
        return;
    }
    console.log(`[AUTH_GATE] 嘗試啟動主應用 (server.js)，該應用應固定監聽端口 ${APP_INTERNAL_PORT}...`);
    const mainAppPath = path.join(__dirname, 'server.js'); // 假設主應用 server.js 在同一目錄

    if (!fs.existsSync(mainAppPath)) {
        console.error(`[AUTH_GATE] 嚴重錯誤：主應用文件 ${mainAppPath} 未找到。請確保路徑正確。`);
        return;
    }

    // 將主應用需要監聽的端口作為環境變量傳遞
    const mainAppEnv = { ...process.env, PORT: APP_INTERNAL_PORT.toString(), NOTEPAD_PORT: APP_INTERNAL_PORT.toString() }; // NOTEPAD_PORT 用於兼容 server.js 可能使用的舊名稱
    const options = { stdio: 'inherit', env: mainAppEnv }; // stdio: 'inherit' 使子進程的輸出直接顯示在父進程的控制台

    serverJsProcess = spawn(process.execPath, [mainAppPath], options); // 使用 process.execPath (通常是 node) 啟動子進程

    serverJsProcess.on('error', (err) => {
        console.error(`[AUTH_GATE] 啟動主應用 (server.js) 失敗: ${err.message}`);
        serverJsProcess = null;
    });

    serverJsProcess.on('exit', (code, signal) => {
        const reason = code !== null ? `退出碼 ${code}` : (signal ? `信號 ${signal}` : '未知原因');
        console.log(`[AUTH_GATE] 主應用 (server.js) 已退出 (${reason})。`);
        serverJsProcess = null;
        // 可選：在主應用意外退出時嘗試重啟 (僅在非關閉且主密碼已設置時)
        if (!isShuttingDown && !isMasterPasswordSetupNeeded) {
            console.log('[AUTH_GATE] 嘗試在5秒後重啟主應用...');
            setTimeout(startMainApp, 5000);
        }
    });

    if (serverJsProcess && serverJsProcess.pid) {
        console.log(`[AUTH_GATE] 主應用 (server.js) 進程已啟動，PID: ${serverJsProcess.pid}，監聽內部端口 ${APP_INTERNAL_PORT}`);
    } else {
        console.error(`[AUTH_GATE] 主應用 (server.js) 未能立即獲取PID，可能啟動失敗。請檢查 ${mainAppPath} 是否可執行以及是否有錯誤輸出。`);
        serverJsProcess = null;
    }
}

// --- 2. 加密與解密函數 ---
function encryptUserPassword(text) {
    try {
        const iv = crypto.randomBytes(IV_LENGTH); // 生成隨機初始化向量
        const cipher = crypto.createCipheriv(ALGORITHM, DERIVED_ENCRYPTION_KEY, iv); // 創建加密器
        let encrypted = cipher.update(text, 'utf8', 'hex'); // 加密文本
        encrypted += cipher.final('hex'); // 完成加密
        return iv.toString('hex') + ':' + encrypted; // 將IV和密文合併返回
    } catch (error) {
        console.error("[AUTH_GATE] 數據加密函數內部錯誤:", error);
        throw new Error("數據加密失敗。");
    }
}

function decryptUserPassword(text) {
    try {
        const parts = text.split(':'); // 分離IV和密文
        if (parts.length !== 2) {
            console.error("[AUTH_GATE] 數據解密失敗：密文格式無效（缺少IV）。");
            return null;
        }
        const iv = Buffer.from(parts.shift(), 'hex'); // 從十六進制還原IV
        const encryptedText = parts.join(':'); // 獲取密文部分
        const decipher = crypto.createDecipheriv(ALGORITHM, DERIVED_ENCRYPTION_KEY, iv); // 創建解密器
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8'); // 解密文本
        decrypted += decipher.final('utf8'); // 完成解密
        return decrypted;
    } catch (error) {
        // 常見錯誤如 "Error: Invalid IV length" 或 "Error: error:06065064:digital envelope routines:EVP_DecryptFinal_ex:bad decrypt"
        console.error("[AUTH_GATE] 數據解密函數內部錯誤:", error.message);
        return null;
    }
}

// 用戶憑證（用於多用戶）在此簡化的僅管理員設置中未使用
// 但保留函數以備將來擴展。
function readUserCredentials() {
    if (!fs.existsSync(USER_CREDENTIALS_STORAGE_FILE)) {
        return {}; // 如果文件不存在，返回空對象
    }
    try {
        const encryptedData = fs.readFileSync(USER_CREDENTIALS_STORAGE_FILE, 'utf8');
        if (!encryptedData.trim()) return {}; // 如果文件為空，返回空對象
        const decryptedData = decryptUserPassword(encryptedData);
        if (decryptedData === null) { // 如果解密失敗
            console.error("[AUTH_GATE] 無法解密用戶憑證文件。文件可能已損壞或加密密鑰已更改。");
            return {};
        }
        return JSON.parse(decryptedData);
    } catch (error) {
        console.error("[AUTH_GATE] 讀取或解析用戶憑證失敗:", error);
        return {};
    }
}

function saveUserCredentials(usersObject) {
    try {
        const dataToEncrypt = JSON.stringify(usersObject, null, 2); // 格式化JSON以便閱讀
        const encryptedData = encryptUserPassword(dataToEncrypt);
        fs.writeFileSync(USER_CREDENTIALS_STORAGE_FILE, encryptedData, 'utf8');
    } catch (error) {
        console.error("[AUTH_GATE] 保存用戶憑證失敗:", error);
        throw new Error("保存用戶憑證失敗。");
    }
}

// --- 3. Express 應用設置 ---
const app = express();
app.use(bodyParser.urlencoded({ extended: true })); // 解析 URL 編碼的請求體
app.use(cookieParser()); // 解析 cookie

// 頁面樣式 (與主應用保持一致)
const pageStyles = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: #f8f9fa; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; color: #212529; padding: 20px 0; box-sizing: border-box; }
    .container { background-color: #fff; padding: 30px 40px; border-radius: 0.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid rgba(0,0,0,0.125); text-align: center; width: 400px; max-width: 90%; margin-bottom: 20px; }
    .admin-container { width: 800px; max-width: 95%; text-align: left; }
    h2 { margin-top: 0; margin-bottom: 25px; color: #212529; font-size: 1.75rem; font-weight: 500; }
    h3 { margin-top: 30px; margin-bottom: 15px; color: #212529; font-size: 1.25rem; border-bottom: 1px solid #dee2e6; padding-bottom: 8px; font-weight: 500; }
    input[type="password"], input[type="text"] { width: 100%; padding: 0.5rem 0.75rem; margin-bottom: 1rem; border: 1px solid #ced4da; border-radius: 0.25rem; box-sizing: border-box; font-size: 1rem; line-height: 1.5; color: #495057; background-color: #fff; background-clip: padding-box; transition: border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out; }
    input[type="password"]:focus, input[type="text"]:focus { border-color: #80bdff; outline: 0; box-shadow: 0 0 0 0.2rem rgba(0, 123, 255, 0.25); }
    button[type="submit"], .button-link { display: inline-block; font-weight: 400; color: #fff; text-align: center; vertical-align: middle; cursor: pointer; user-select: none; background-color: #007bff; border: 1px solid #007bff; padding: 0.5rem 1rem; font-size: 1rem; line-height: 1.5; border-radius: 0.25rem; transition: color 0.15s ease-in-out, background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out; margin-top: 10px; text-decoration: none; }
    button[type="submit"].full-width { width: 100%; }
    button[type="submit"]:hover, .button-link:hover { background-color: #0056b3; border-color: #0056b3; color: #fff; text-decoration: none; }
    button[type="submit"].danger { background-color: #dc3545; border-color: #dc3545; }
    button[type="submit"].danger:hover { background-color: #c82333; border-color: #bd2130; }
    .message { margin-bottom: 1rem; font-weight: 500; font-size: 0.95em; padding: 0.75rem 1.25rem; border: 1px solid transparent; border-radius: 0.25rem; }
    .error-message { color: #721c24; background-color: #f8d7da; border-color: #f5c6cb; }
    .success-message { color: #155724; background-color: #d4edda; border-color: #c3e6cb; }
    .info-message { color: #0c5460; background-color: #d1ecf1; border-color: #bee5eb; font-size: 0.85em; margin-top: 15px; line-height: 1.4; }
    label { display: block; text-align: left; margin-bottom: 0.5rem; font-weight: 500; font-size: 0.9em; color: #495057; }
    a { color: #007bff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; background-color: #fff; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #dee2e6; vertical-align: middle; }
    th { background-color: #e9ecef; font-weight: 500; color: #495057; }
    .actions form { display: inline-block; margin-right: 5px; }
    .actions button { padding: 0.25rem 0.5rem; font-size: 0.875rem; line-height: 1.5; margin-top: 0; }
    .form-row { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; margin-bottom: 1rem; }
    .form-row .field { flex-grow: 1; min-width: 150px; }
    .form-row label, .form-row input { margin-bottom: 0; }
    .form-row button { align-self: flex-end; }
    .logout-link-container { width: 100%; text-align: right; margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #dee2e6; }
    .logout-link-container .button-link { background-color: #6c757d; border-color: #6c757d; }
    .logout-link-container .button-link:hover { background-color: #5a6268; border-color: #545b62; }
    .nav-links { margin-top: 1.5rem; text-align: center; }
    .nav-links .button-link { margin: 0 0.5rem; }
`;

// --- 4. 啟動模式判斷和日誌 ---
if (isMasterPasswordSetupNeeded) {
    console.log("[AUTH_GATE] 應用提示：未找到主密碼配置文件。首次運行，請設置主密碼。");
} else {
    console.log("[AUTH_GATE] 應用提示：主密碼配置文件已存在。");
}

// --- 5. 全局身份驗證和設置重定向中間件 ---
app.use((req, res, next) => {
    // 允許公開訪問的路徑前綴或確切路徑 (例如靜態資源)
    const publicPaths = ['/', '/articles', '/css', '/js', '/uploads', '/favicon.ico'];
    const authPaths = ['/login', '/do_login', '/setup', '/do_setup']; // 認證相關路徑
    const adminPath = '/admin'; // 管理後台路徑前綴

    // 檢查是否為靜態資源路徑
    const isStaticAsset = req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/uploads/');
    if (isStaticAsset) {
        return next(); // 靜態資源直接通過，由後面的代理或 express.static 處理
    }

    const isAuthPath = authPaths.includes(req.path);
    const isAdminArea = req.path.startsWith(adminPath);

    // 如果主密碼尚未設置
    if (isMasterPasswordSetupNeeded) {
        if (req.path === '/setup' || req.path === '/do_setup') { // 只允許訪問設置頁面
            return next();
        }
        return res.redirect('/setup'); // 其他所有請求重定向到設置頁面
    }

    // 如果請求的是管理區域
    if (isAdminArea) {
        if (req.cookies.auth === '1' && req.cookies.is_master === 'true') {
            return next(); // 已認證主用戶，允許訪問管理區
        }
        // 未認證或非主用戶嘗試訪問管理區，重定向到登錄頁（或顯示403）
        console.warn(`[AUTH_GATE] 未授權用戶嘗試訪問管理頁面: ${req.path}. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
        return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`); // 帶上返回地址以便登錄後跳轉
    }

    // 對於非管理區域的請求
    // 如果是認證相關路徑 (login, setup), 則直接處理
    if (isAuthPath) {
        // 如果已登錄主賬戶，訪問登錄頁則重定向到管理頁
        if (req.path === '/login' && req.cookies.auth === '1' && req.cookies.is_master === 'true') {
            return res.redirect('/admin');
        }
        return next();
    }

    // 其他所有路徑 (包括公開路徑和需要代理的路径)
    // 這個網關現在主要負責 /admin 的認證。其他路徑將由主應用處理（通過代理）。
    return next();
});


// --- 6. 路由定義 ---

// == SETUP MASTER PASSWORD ROUTES == (設置主密碼路由)
app.get('/setup', (req, res) => {
    if (!isMasterPasswordSetupNeeded) { // 如果主密碼已設置，重定向到登錄頁
         return res.redirect('/login');
    }
    const error = req.query.error; // 從查詢參數獲取錯誤信息
    let errorMessageHtml = '';
    if (error === 'mismatch') errorMessageHtml = '<p class="message error-message">兩次輸入的密碼不匹配！</p>';
    else if (error === 'short') errorMessageHtml = '<p class="message error-message">主密碼長度至少需要8個字符！</p>';
    else if (error === 'write_failed') errorMessageHtml = '<p class="message error-message">保存主密碼失敗，請檢查服務器權限或日誌。</p>';
    else if (error === 'encrypt_failed') errorMessageHtml = '<p class="message error-message">主密碼加密失敗，請檢查服務器日誌。</p>';

    res.send(`
        <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>設置初始主密碼</title><style>${pageStyles}</style></head>
        <body><div class="container">
            <form method="POST" action="/do_setup">
                <h2>首次運行：設置主密碼 (用於後台管理)</h2>
                ${errorMessageHtml}
                <label for="newPassword">新主密碼 (至少8位):</label>
                <input type="password" id="newPassword" name="newPassword" required minlength="8" autofocus>
                <label for="confirmPassword">確認新主密碼:</label>
                <input type="password" id="confirmPassword" name="confirmPassword" required minlength="8">
                <button type="submit" class="full-width">設置主密碼並保存</button>
            </form>
        </div></body></html>
    `);
});

app.post('/do_setup', (req, res) => {
    if (!isMasterPasswordSetupNeeded) {
        return res.status(403).send("錯誤：主密碼已設置。");
    }
    const { newPassword, confirmPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
        return res.redirect('/setup?error=short');
    }
    if (newPassword !== confirmPassword) {
        return res.redirect('/setup?error=mismatch');
    }

    try {
        const encryptedPassword = encryptUserPassword(newPassword);
        fs.writeFileSync(MASTER_PASSWORD_STORAGE_FILE, encryptedPassword, 'utf8');
        isMasterPasswordSetupNeeded = false; // 標記主密碼已設置
        console.log("[AUTH_GATE] 主密碼已成功設置並加密保存。");
        if (!fs.existsSync(USER_CREDENTIALS_STORAGE_FILE)) { // 初始化用戶憑證文件（如果不存在）
            saveUserCredentials({});
        }
        startMainApp(); // 主密碼設置成功後啟動主應用
        res.send(`
            <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>設置成功</title><style>${pageStyles}</style></head>
            <body><div class="container">
                <h2 class="success-message">主密碼設置成功！</h2>
                <p>後台管理的主密碼已設置。主應用服務已啟動。</p>
                <p>您可以 <a href="/login">前往登錄頁面</a> 使用主密碼登錄後台管理。</p>
                <p>或直接訪問 <a href="/">網站首頁</a>。</p>
            </div></body></html>
        `);
    } catch (error) {
        console.error("[AUTH_GATE] 保存加密主密碼文件失敗:", error);
        res.redirect('/setup?error=write_failed');
    }
});

// == LOGIN ROUTES (Primarily for Admin) == (主要用於管理員登錄的路由)
app.get('/login', (req, res) => {
    // 如果已作為主管理員登錄，則重定向到管理頁面或指定的返回URL
    if (req.cookies.auth === '1' && req.cookies.is_master === 'true') {
        return res.redirect(req.query.returnTo || '/admin');
    }

    const error = req.query.error;
    const info = req.query.info;
    let messageHtml = '';
    if (error === 'invalid') messageHtml = '<p class="message error-message">主密碼錯誤！</p>';
    else if (error === 'decrypt_failed') messageHtml = '<p class="message error-message">無法驗證密碼。可能是密鑰問題或文件損壞。</p>';
    else if (error === 'master_not_set') messageHtml = `<p class="message error-message">主密碼尚未設置，請先 <a href="/setup">設置主密碼</a>。</p>`;
    else if (info === 'logged_out') messageHtml = '<p class="message success-message">您已成功登出後台管理。</p>';
    if (req.query.returnTo) messageHtml += `<p class="message info-message">登錄後將返回到: ${decodeURIComponent(req.query.returnTo)}</p>`;


    res.send(`
        <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>後台管理登錄</title><style>${pageStyles}</style></head>
        <body><div class="container">
            <form method="POST" action="/do_login${req.query.returnTo ? '?returnTo=' + encodeURIComponent(req.query.returnTo) : ''}" id="loginForm">
                <h2>後台管理登錄</h2>
                ${messageHtml}
                <label for="password">主密碼:</label>
                <input type="password" id="password" name="password" required autofocus>
                <input type="hidden" name="username" value=""> <button type="submit" class="full-width">登錄</button>
                 <p class="info-message" style="margin-top: 20px;"><a href="/">返回網站首頁</a></p>
            </form>
        </div></body></html>
    `);
});

app.post('/do_login', (req, res) => {
    if (isMasterPasswordSetupNeeded) {
        return res.redirect('/login?error=master_not_set');
    }
    const { password: submittedPassword } = req.body; // 主賬戶登錄僅需密碼

    if (!submittedPassword) {
        return res.redirect(`/login?error=invalid${req.query.returnTo ? '&returnTo=' + encodeURIComponent(req.query.returnTo) : ''}`);
    }

    try {
        if (!fs.existsSync(MASTER_PASSWORD_STORAGE_FILE)) {
             isMasterPasswordSetupNeeded = true; // 如果主密碼文件丟失，應重新設置
             return res.redirect('/setup');
        }
        const encryptedMasterPasswordFromFile = fs.readFileSync(MASTER_PASSWORD_STORAGE_FILE, 'utf8');
        const storedDecryptedMasterPassword = decryptUserPassword(encryptedMasterPasswordFromFile);

        if (storedDecryptedMasterPassword === null) { // 解密失敗
            return res.redirect(`/login?error=decrypt_failed${req.query.returnTo ? '&returnTo=' + encodeURIComponent(req.query.returnTo) : ''}`);
        }
        if (submittedPassword === storedDecryptedMasterPassword) { // 密碼匹配
            // 設置認證 cookie
            res.cookie('auth', '1', { maxAge: 3600 * 1000 * 8, httpOnly: true, path: '/', sameSite: 'Lax' }); // 8 小時有效期
            res.cookie('is_master', 'true', { maxAge: 3600 * 1000 * 8, httpOnly: true, path: '/', sameSite: 'Lax' });
            console.log("[AUTH_GATE] 主密碼登錄成功。");
            const returnTo = req.query.returnTo ? decodeURIComponent(req.query.returnTo) : '/admin'; // 獲取返回地址或默認到 /admin
            return res.redirect(returnTo);
        } else { // 密碼不匹配
            return res.redirect(`/login?error=invalid${req.query.returnTo ? '&returnTo=' + encodeURIComponent(req.query.returnTo) : ''}`);
        }
    } catch (error) {
        console.error("[AUTH_GATE] 登錄處理時发生未知錯誤:", error);
        res.status(500).send("服務器內部錯誤，無法處理登錄請求。");
    }
});

// == LOGOUT ROUTE (for Admin) == (管理員登出路由)
app.get('/logout', (req, res) => {
    // 清除認證 cookie
    res.clearCookie('auth', { path: '/', httpOnly: true, sameSite: 'Lax' });
    res.clearCookie('is_master', { path: '/', httpOnly: true, sameSite: 'Lax' });
    console.log("[AUTH_GATE] 管理員已登出。");
    res.redirect('/login?info=logged_out'); // 重定向到登錄頁並提示已登出
});

// --- 7. 反向代理中間件 ---
const proxyToMainApp = createProxyMiddleware({
    target: `http://localhost:${APP_INTERNAL_PORT}`, // 代理目標：主應用程序
    changeOrigin: true, // 更改請求頭中的 host 為目標 URL 的 host
    ws: true, // 支持 WebSocket 代理 (如果主應用使用)
    logLevel: 'info', // 代理日誌級別: 'debug', 'info', 'warn', 'error', 'silent'
    onError: (err, req, res, target) => { // 代理出錯時的回調
        console.error('[AUTH_GATE_PROXY] 代理發生錯誤:', err.message, '請求:', req.method, req.url, '目標:', target);
        if (res && typeof res.writeHead === 'function' && !res.headersSent) { // 如果響應頭未發送
             try { res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' }); } catch (e) { console.error("寫入代理錯誤頭部時出錯:", e); }
        }
        if (res && typeof res.end === 'function' && res.writable && !res.writableEnded) { // 如果響應可寫且未結束
            try {
                res.end(`
                    <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>代理錯誤</title><style>${pageStyles}</style></head>
                    <body><div class="container">
                        <h2 class="error-message">代理錯誤 (502 Bad Gateway)</h2>
                        <p>抱歉，無法連接到後端分享網站服務。</p>
                        <p>可能的原因：</p>
                        <ul>
                            <li>主應用 (server.js) 未能啟動或已崩潰。</li>
                            <li>主應用未在預期的內部端口 ${APP_INTERNAL_PORT} 上監聽。</li>
                        </ul>
                        <p>請檢查服務器日誌以獲取更多信息。</p>
                        <p>錯誤詳情: ${err.message}</p>
                        <div class="nav-links">
                            <a href="/" class="button-link" onclick="location.reload(); return false;">重試</a>
                            <a href="/logout" class="button-link danger" style="margin-left:10px;">登出管理後台</a>
                        </div>
                    </div></body></html>
                `);
            } catch (e) { console.error("結束代理錯誤響應時出錯:", e); }
        } else if (res && typeof res.end === 'function' && !res.writableEnded) { // 如果流不可寫但尚未結束，嘗試結束它
             try { res.end(); } catch (e) { /* ignore */ }
        }
    }
});

// 應用代理中間件
// 所有未被上面特定認證路由處理的請求，都嘗試代理到主應用
app.use((req, res, next) => {
    const authRelatedPaths = ['/login', '/do_login', '/setup', '/do_setup', '/logout'];
    // 如果請求不是由上面的認證路由處理的，則代理到主應用
    if (!authRelatedPaths.includes(req.path) && !req.path.startsWith('/admin')) {
        return proxyToMainApp(req, res, next);
    }
    // 如果是 /admin 路徑，並且已通过全局中间件的认证检查，也应该被代理
    // （注意：全局中間件已經處理了 /admin 的訪問控制，這裡確保它被代理）
    if (req.path.startsWith('/admin') && req.cookies.auth === '1' && req.cookies.is_master === 'true') {
        return proxyToMainApp(req, res, next);
    }
    // 其他情況（例如未被特定路由處理的未認證請求，或訪問 /admin 但未通過認證的）
    // 這些情況應該已經被全局中間件重定向或處理了。
    next();
});


// --- 8. 服務器啟動 ---
const server = app.listen(PUBLIC_PORT, () => {
    console.log(`[AUTH_GATE] 認證網關與反向代理服務已在端口 ${PUBLIC_PORT} 上啟動。`);
    if (isMasterPasswordSetupNeeded) {
        console.log(`[AUTH_GATE] 請訪問 http://localhost:${PUBLIC_PORT}/setup 完成初始主密碼設置。`);
    } else {
        console.log(`[AUTH_GATE] 主應用將由本服務管理。`);
        console.log(`[AUTH_GATE] 公共網站訪問: http://localhost:${PUBLIC_PORT}/`);
        console.log(`[AUTH_GATE] 後台管理登錄: http://localhost:${PUBLIC_PORT}/login`);
        if (!serverJsProcess || serverJsProcess.killed) { // 確保主應用已啟動
            startMainApp();
        }
    }
    console.warn(
        `[AUTH_GATE] 安全提示：用戶密碼使用 AES-256-CBC 加密。` +
        `請確保 ${MASTER_SECRET_KEY_FILE} 文件的安全和備份。此文件是解密所有密碼的關鍵！`
    );
});

server.on('error', (error) => { // 監聽服務器錯誤事件
    if (error.syscall !== 'listen') {
        console.error('[AUTH_GATE] 發生了一個非監聽相關的服務器錯誤:', error);
        return;
    }
    switch (error.code) {
        case 'EACCES': // 權限不足
            console.error(`[AUTH_GATE] 錯誤：端口 ${PUBLIC_PORT} 需要提升的權限。請嘗試使用 sudo 或以管理員身份運行，或使用大於1024的端口。`);
            process.exit(1);
            break;
        case 'EADDRINUSE': // 端口已被佔用
            console.error(`[AUTH_GATE] 錯誤：端口 ${PUBLIC_PORT} 已被其他應用程序占用。請關閉占用該端口的程序或更改 PUBLIC_PORT 配置。`);
            process.exit(1);
            break;
        default:
            console.error('[AUTH_GATE] 服務器啟動時發生未知監聽錯誤:', error);
            process.exit(1);
    }
});

// --- 9. 優雅關閉處理 ---
function shutdownGracefully(signal) {
    if (isShuttingDown) return; // 防止重複執行
    isShuttingDown = true; // 標記正在關閉
    console.log(`[AUTH_GATE] 收到 ${signal}。正在關閉服務...`);

    // 關閉 HTTP 服務器
    const serverClosePromise = new Promise((resolve) => {
        server.close(() => {
            console.log('[AUTH_GATE] HTTP 服務已關閉。');
            resolve();
        });
    });

    // 關閉子進程 (主應用)
    const childProcessPromise = new Promise((resolve) => {
        if (serverJsProcess && !serverJsProcess.killed) {
            console.log('[AUTH_GATE] 正在嘗試終止主應用 (server.js)...');
            const killTimeout = setTimeout(() => { // 設置超時強制終止
                if (serverJsProcess && !serverJsProcess.killed) {
                    console.warn('[AUTH_GATE] 主應用未在 SIGTERM 後3秒內退出，強制發送 SIGKILL...');
                    serverJsProcess.kill('SIGKILL'); // 強制終止
                }
                resolve(); // 無論如何都要 resolve
            }, 3000);

            serverJsProcess.on('exit', (code, exitSignal) => { // 監聽子進程退出事件
                clearTimeout(killTimeout); // 清除超時
                console.log(`[AUTH_GATE] 主應用已成功退出 (Code: ${code}, Signal: ${exitSignal})。`);
                resolve();
            });

            const killed = serverJsProcess.kill('SIGTERM'); // 嘗試優雅終止
            if (!killed && serverJsProcess && !serverJsProcess.killed) { // 如果發送信號失敗
                 console.warn('[AUTH_GATE] 向主應用發送 SIGTERM 信號失敗 (可能已退出或無權限)。');
                 clearTimeout(killTimeout);
                 resolve();
            } else if (!serverJsProcess || serverJsProcess.killed) { // 如果子進程已不存在或已死亡
                clearTimeout(killTimeout);
                resolve();
            }
        } else {
            console.log('[AUTH_GATE] 主應用未運行或已被終止。');
            resolve();
        }
    });

    // 等待所有關閉操作完成
    Promise.all([serverClosePromise, childProcessPromise]).then(() => {
        console.log('[AUTH_GATE] 所有服務已關閉。優雅退出。');
        process.exit(0);
    }).catch(err => {
        console.error('[AUTH_GATE] 優雅關閉期間發生錯誤:', err);
        process.exit(1); // 即使有錯誤也退出
    });

    // 設置一個總的關閉超時，以防萬一
    setTimeout(() => {
        console.error('[AUTH_GATE] 優雅關閉超時 (10秒)，強制退出。');
        process.exit(1);
    }, 10000);
}

process.on('SIGINT', () => shutdownGracefully('SIGINT')); // 捕獲 Ctrl+C
process.on('SIGTERM', () => shutdownGracefully('SIGTERM')); // 捕獲 kill 命令
