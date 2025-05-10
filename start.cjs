// start.cjs (認證網關和反向代理 - 再次修正普通使用者登錄重定向)
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createProxyMiddleware } = require('http-proxy-middleware');

// --- 1. 配置和常量 ---
const PUBLIC_PORT = process.env.PUBLIC_PORT || 8100;
const APP_INTERNAL_PORT = process.env.APP_INTERNAL_PORT || 3000;

const MASTER_PASSWORD_STORAGE_FILE = path.join(__dirname, 'master_auth_config.enc');
const USER_CREDENTIALS_STORAGE_FILE = path.join(__dirname, 'user_credentials.enc');
const MASTER_SECRET_KEY_FILE = path.join(__dirname, 'encryption.secret.key');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

let serverJsProcess = null;
let isShuttingDown = false;

// --- 1a. 獲取或生成主加密密鑰文本 ---
function initializeEncryptionSecretKeyText() {
    if (fs.existsSync(MASTER_SECRET_KEY_FILE)) {
        console.log(`[AUTH_GATE] 應用提示：正在從 ${MASTER_SECRET_KEY_FILE} 讀取主加密密鑰...`);
        const keyText = fs.readFileSync(MASTER_SECRET_KEY_FILE, 'utf8').trim();
        if (keyText.length < 64) {
            console.warn(`[AUTH_GATE] 安全警告：${MASTER_SECRET_KEY_FILE} 中的密鑰文本長度 (${keyText.length}) 可能不足。建議使用更長的密鑰。`);
        }
        return keyText;
    } else {
        console.log(`[AUTH_GATE] 應用提示：主加密密鑰文件 ${MASTER_SECRET_KEY_FILE} 不存在。正在生成新密鑰...`);
        const newKeyText = crypto.randomBytes(48).toString('hex');
        try {
            fs.writeFileSync(MASTER_SECRET_KEY_FILE, newKeyText, { encoding: 'utf8', mode: 0o600 });
            fs.chmodSync(MASTER_SECRET_KEY_FILE, 0o600);
            console.log(`[AUTH_GATE] 應用提示：新的主加密密鑰已生成並保存到 ${MASTER_SECRET_KEY_FILE} (權限 600)。`);
            console.warn(`[AUTH_GATE] 重要：請務必安全備份 ${MASTER_SECRET_KEY_FILE} 文件！刪除此文件將導致所有已加密密碼無法解密。`);
            return newKeyText;
        } catch (err) {
            console.error(`[AUTH_GATE] 嚴重錯誤：無法寫入或設置主加密密鑰文件 ${MASTER_SECRET_KEY_FILE} 的權限。程序將退出。`, err);
            process.exit(1);
        }
    }
}

const ENCRYPTION_SECRET_KEY_TEXT = initializeEncryptionSecretKeyText();
const DERIVED_ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET_KEY_TEXT, 'a_fixed_salt_for_scrypt_derivation_v1_auth_gate', 32);

let isMasterPasswordSetupNeeded = !fs.existsSync(MASTER_PASSWORD_STORAGE_FILE);

// --- 1b. 啟動和管理 server.js (主應用) ---
function startMainApp() {
    if (serverJsProcess && !serverJsProcess.killed) {
        console.log('[AUTH_GATE] 主應用 (server.js) 已在運行中或正在嘗試啟動。');
        return;
    }
    console.log(`[AUTH_GATE] 嘗試啟動主應用 (server.js)，該應用應固定監聽端口 ${APP_INTERNAL_PORT}...`);
    const mainAppPath = path.join(__dirname, 'server.js');

    if (!fs.existsSync(mainAppPath)) {
        console.error(`[AUTH_GATE] 嚴重錯誤：主應用文件 ${mainAppPath} 未找到。請確保路徑正確。`);
        return;
    }

    const mainAppEnv = {
        ...process.env,
        PORT: APP_INTERNAL_PORT.toString(),
        NOTEPAD_PORT: APP_INTERNAL_PORT.toString(),
        GATEWAY_PUBLIC_PORT: PUBLIC_PORT.toString()
    };
    const options = { stdio: 'inherit', env: mainAppEnv };

    serverJsProcess = spawn(process.execPath, [mainAppPath], options);

    serverJsProcess.on('error', (err) => {
        console.error(`[AUTH_GATE] 啟動主應用 (server.js) 失敗: ${err.message}`);
        serverJsProcess = null;
    });

    serverJsProcess.on('exit', (code, signal) => {
        const reason = code !== null ? `退出碼 ${code}` : (signal ? `信號 ${signal}` : '未知原因');
        console.log(`[AUTH_GATE] 主應用 (server.js) 已退出 (${reason})。`);
        serverJsProcess = null;
        if (!isShuttingDown && !isMasterPasswordSetupNeeded) {
            console.log('[AUTH_GATE] 嘗試在5秒後重啟主應用...');
            setTimeout(startMainApp, 5000);
        }
    });

    if (serverJsProcess && serverJsProcess.pid) {
        console.log(`[AUTH_GATE] 主應用 (server.js) 進程已啟動，PID: ${serverJsProcess.pid}，監聽內部端口 ${APP_INTERNAL_PORT}`);
    } else {
        console.error(`[AUTH_GATE] 主應用 (server.js) 未能立即獲取PID，可能啟動失敗。`);
        serverJsProcess = null;
    }
}

// --- 2. 加密與解密函數 ---
function encryptUserPassword(text) {
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, DERIVED_ENCRYPTION_KEY, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
        console.error("[AUTH_GATE] 數據加密函數內部錯誤:", error);
        throw new Error("數據加密失敗。");
    }
}

function decryptUserPassword(text) {
    try {
        const parts = text.split(':');
        if (parts.length !== 2) {
            console.error("[AUTH_GATE] 數據解密失敗：密文格式無效（缺少IV）。");
            return null;
        }
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = parts.join(':');
        const decipher = crypto.createDecipheriv(ALGORITHM, DERIVED_ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error("[AUTH_GATE] 數據解密函數內部錯誤:", error.message);
        return null;
    }
}

// --- 2b. User Credentials Management ---
function readUserCredentials() {
    if (!fs.existsSync(USER_CREDENTIALS_STORAGE_FILE)) {
        return {};
    }
    try {
        const encryptedData = fs.readFileSync(USER_CREDENTIALS_STORAGE_FILE, 'utf8');
        if (!encryptedData.trim()) return {};
        const decryptedData = decryptUserPassword(encryptedData);
        if (decryptedData === null) {
            console.error("[AUTH_GATE] 無法解密用戶憑證文件。文件可能已損壞或加密密鑰已更改。");
            return {};
        }
        return JSON.parse(decryptedData);
    } catch (error) {
        console.error("[AUTH_GATE] 讀取或解析用戶憑證失敗:", error);
        if (error instanceof SyntaxError && fs.existsSync(USER_CREDENTIALS_STORAGE_FILE)) {
            console.warn("[AUTH_GATE] 用戶憑證文件解析JSON失敗，文件可能已損壞。");
        }
        return {};
    }
}

function saveUserCredentials(usersObject) {
    try {
        const dataToEncrypt = JSON.stringify(usersObject, null, 2);
        const encryptedData = encryptUserPassword(dataToEncrypt);
        fs.writeFileSync(USER_CREDENTIALS_STORAGE_FILE, encryptedData, 'utf8');
    } catch (error) {
        console.error("[AUTH_GATE] 保存用戶憑證失敗:", error);
        throw new Error("保存用戶憑證失敗。");
    }
}

// --- 3. Express 應用設置 ---
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

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

// --- 5. 全局中介軟體 - 處理重定向和基礎訪問控制 ---
app.use((req, res, next) => {
    const authSpecificPaths = ['/login', '/do_login', '/setup', '/do_setup', '/logout'];
    const gatewayUserAdminBasePath = '/user-admin';
    const mainAppAdminBasePath = '/admin';

    const staticAssetPath = req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/uploads/');
    if (staticAssetPath) {
        return next();
    }

    if (isMasterPasswordSetupNeeded) {
        if (req.path === '/setup' || req.path === '/do_setup') {
            return next();
        }
        return res.redirect('/setup');
    }

    if (req.path.startsWith(gatewayUserAdminBasePath)) {
        return next(); // 由後面的 userAdminRouter 及其 ensureMasterAdmin 處理
    }

    if (req.path.startsWith(mainAppAdminBasePath)) {
        if (req.cookies.auth === '1') {
            return next(); // 允許已登入使用者訪問主應用的 /admin/*，將被代理
        } else {
            console.warn(`[AUTH_GATE] 未經身份驗證的使用者嘗試存取主應用的管理路徑: ${req.path}`);
            return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
        }
    }

    if (authSpecificPaths.includes(req.path)) {
        if (req.cookies.auth === '1' && (req.path === '/login' || req.path === '/setup')) {
            if (req.cookies.is_master === 'true') {
                return res.redirect(gatewayUserAdminBasePath);
            } else {
                return res.redirect(mainAppAdminBasePath); // 普通使用者已登入，訪問 /login 則跳轉到文章管理
            }
        }
        return next();
    }
    return next(); // 其他公開路徑，將被代理
});


// --- 6. 特定路由定義 ---

// == SETUP MASTER PASSWORD ROUTES ==
app.get('/setup', (req, res) => {
    if (!isMasterPasswordSetupNeeded) {
         return res.redirect('/login');
    }
    const error = req.query.error;
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
        isMasterPasswordSetupNeeded = false;
        console.log("[AUTH_GATE] 主密碼已成功設置並加密保存。");
        if (!fs.existsSync(USER_CREDENTIALS_STORAGE_FILE)) {
            saveUserCredentials({});
            console.log("[AUTH_GATE] 空的用戶憑證文件已創建。");
        }
        startMainApp();
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

// == LOGIN ROUTES ==
app.get('/login', (req, res) => {
    if (req.cookies.auth === '1') {
        if (req.cookies.is_master === 'true') {
            return res.redirect(req.query.returnTo && req.query.returnTo.startsWith('/user-admin') ? req.query.returnTo : '/user-admin');
        } else {
            // **修改：普通使用者已登入，如果嘗試訪問 /login，則跳轉到 /admin (主應用的文章管理)**
            const returnToTarget = req.query.returnTo && !req.query.returnTo.startsWith('/user-admin') ? req.query.returnTo : '/admin';
            return res.redirect(returnToTarget);
        }
    }

    const error = req.query.error;
    const info = req.query.info;
    let messageHtml = '';
    if (error === 'invalid') messageHtml = '<p class="message error-message">用戶名或密碼錯誤！</p>';
    else if (error === 'decrypt_failed') messageHtml = '<p class="message error-message">無法驗證密碼。可能是密鑰問題或文件損壞。</p>';
    else if (error === 'read_failed') messageHtml = '<p class="message error-message">無法讀取密碼配置。請聯繫管理員。</p>';
    else if (error === 'no_user_file') messageHtml = '<p class="message error-message">用戶憑證文件不存在或無法讀取。</p>';
    else if (error === 'master_not_set') messageHtml = `<p class="message error-message">主密碼尚未設置，請先 <a href="/setup">設置主密碼</a>。</p>`;
    else if (info === 'logged_out') messageHtml = '<p class="message success-message">您已成功登出。</p>';
    if (req.query.returnTo) messageHtml += `<p class="message info-message">登錄後將返回到: ${decodeURIComponent(req.query.returnTo)}</p>`;

    res.send(`
        <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>登錄</title><style>${pageStyles}</style></head>
        <body><div class="container">
            <form method="POST" action="/do_login${req.query.returnTo ? '?returnTo=' + encodeURIComponent(req.query.returnTo) : ''}" id="loginForm">
                <h2>登錄</h2>
                ${messageHtml}
                <label for="username">用戶名 (主帳戶登錄請留空):</label>
                <input type="text" id="username" name="username" autofocus>
                <label for="password">密碼:</label>
                <input type="password" id="password" name="password" required>
                <button type="submit" class="full-width">登錄</button>
                 <p class="info-message" style="margin-top: 20px;"><a href="/">返回網站首頁</a></p>
            </form>
        </div></body></html>
    `);
});

app.post('/do_login', (req, res) => {
    if (isMasterPasswordSetupNeeded) {
        return res.redirect('/login?error=master_not_set');
    }
    const { username, password: submittedPassword } = req.body;
    const returnToUrl = req.query.returnTo ? decodeURIComponent(req.query.returnTo) : null;
    const cookieMaxAge = 60 * 1000; // 1 分鐘有效期

    if (!submittedPassword) {
        return res.redirect(`/login?error=invalid${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
    }

    try {
        if (!username || username.trim() === "") { // 主密碼登錄
            if (!fs.existsSync(MASTER_PASSWORD_STORAGE_FILE)) {
                 isMasterPasswordSetupNeeded = true;
                 return res.redirect('/setup');
            }
            const encryptedMasterPasswordFromFile = fs.readFileSync(MASTER_PASSWORD_STORAGE_FILE, 'utf8');
            const storedDecryptedMasterPassword = decryptUserPassword(encryptedMasterPasswordFromFile);

            if (storedDecryptedMasterPassword === null) {
                return res.redirect(`/login?error=decrypt_failed${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
            }
            if (submittedPassword === storedDecryptedMasterPassword) {
                res.cookie('auth', '1', { maxAge: cookieMaxAge, httpOnly: true, path: '/', sameSite: 'Lax' });
                res.cookie('is_master', 'true', { maxAge: cookieMaxAge, httpOnly: true, path: '/', sameSite: 'Lax' });
                console.log("[AUTH_GATE] 主密碼登錄成功。");
                return res.redirect(returnToUrl && returnToUrl.startsWith('/user-admin') ? returnToUrl : '/user-admin');
            } else {
                return res.redirect(`/login?error=invalid${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
            }
        } else { // 普通用戶登錄
            if (!fs.existsSync(USER_CREDENTIALS_STORAGE_FILE)) {
                 console.warn("[AUTH_GATE] 用戶嘗試登錄，但用戶憑證文件不存在。");
                 return res.redirect(`/login?error=no_user_file${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
            }
            const users = readUserCredentials();
            if (Object.keys(users).length === 0 && fs.existsSync(USER_CREDENTIALS_STORAGE_FILE) && fs.readFileSync(USER_CREDENTIALS_STORAGE_FILE, 'utf8').trim().length > 0) {
                console.warn("[AUTH_GATE] 用戶憑證文件可能已損壞或無法解密。");
                return res.redirect(`/login?error=decrypt_failed${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
            }

            const userData = users[username];

            if (!userData || !userData.passwordHash) {
                return res.redirect(`/login?error=invalid${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
            }

            const storedDecryptedPassword = decryptUserPassword(userData.passwordHash);
            if (storedDecryptedPassword === null) {
                console.error(`[AUTH_GATE] 解密用戶 '${username}' 的密碼失敗。`);
                return res.redirect(`/login?error=decrypt_failed${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
            }

            if (submittedPassword === storedDecryptedPassword) {
                res.cookie('auth', '1', { maxAge: cookieMaxAge, httpOnly: true, path: '/', sameSite: 'Lax' });
                res.cookie('is_master', 'false', { maxAge: cookieMaxAge, httpOnly: true, path: '/', sameSite: 'Lax' });
                console.log(`[AUTH_GATE] 用戶 '${username}' 登錄成功。`);
                // **修改：普通使用者登入後，重定向到 /admin (由主應用處理的文章管理)**
                let redirectTarget = returnToUrl || '/admin'; // 默認跳轉到主應用的 /admin
                if (returnToUrl && returnToUrl.startsWith('/user-admin')) { // 如果 returnTo 是 user-admin，則忽略，跳轉到 /admin
                    redirectTarget = '/admin';
                }
                // 如果 returnToUrl 本身就是 /admin 或 /admin/* (且不是 /user-admin/*)，則使用它
                return res.redirect(redirectTarget);
            } else {
                return res.redirect(`/login?error=invalid${returnToUrl ? '&returnTo=' + encodeURIComponent(returnToUrl) : ''}`);
            }
        }
    } catch (error) {
        console.error("[AUTH_GATE] 登錄處理時发生未知錯誤:", error);
        res.status(500).send("服務器內部錯誤，無法處理登錄請求。");
    }
});

// == LOGOUT ROUTE ==
app.get('/logout', (req, res) => {
    res.clearCookie('auth', { path: '/', httpOnly: true, sameSite: 'Lax' });
    res.clearCookie('is_master', { path: '/', httpOnly: true, sameSite: 'Lax' });
    console.log("[AUTH_GATE] 用戶已登出。");
    res.redirect('/login?info=logged_out');
});


// == USER ADMIN ROUTES (Handled by Gateway, for Master Admin only) ==
const userAdminRouter = express.Router();

function ensureMasterAdmin(req, res, next) {
    if (req.cookies.auth === '1' && req.cookies.is_master === 'true') {
        return next();
    }
    console.warn("[AUTH_GATE] 未授權訪問網關使用者管理區域，Cookies: ", req.cookies);
    res.status(403).send(`
        <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>訪問被拒絕</title><style>${pageStyles}</style></head>
        <body><div class="container">
            <h2 class="error-message">訪問被拒絕</h2>
            <p>您必須以主密碼用戶身份登錄才能訪問此使用者管理頁面。</p>
            <a href="/login?returnTo=${encodeURIComponent(req.originalUrl)}" class="button-link">去登錄</a>
            <a href="/" class="button-link" style="margin-left:10px; background-color:#6c757d; border-color:#6c757d;">返回網站首頁</a>
        </div></body></html>`);
}

userAdminRouter.get('/', ensureMasterAdmin, (req, res) => {
    const users = readUserCredentials();
    const error = req.query.error;
    const success = req.query.success;
    let messageHtml = '';
    if (error === 'user_exists') messageHtml = '<p class="message error-message">錯誤：用戶名已存在。</p>';
    else if (error === 'password_mismatch') messageHtml = '<p class="message error-message">錯誤：兩次輸入的密碼不匹配。</p>';
    else if (error === 'missing_fields') messageHtml = '<p class="message error-message">錯誤：所有必填字段均不能为空。</p>';
    else if (error === 'password_empty') messageHtml = '<p class="message error-message">錯誤：普通用戶密碼不能為空。</p>';
    else if (error === 'unknown') messageHtml = '<p class="message error-message">發生未知錯誤。</p>';
    else if (error === 'user_not_found') messageHtml = '<p class="message error-message">錯誤: 未找到指定用戶。</p>';
    else if (error === 'invalid_username') messageHtml = '<p class="message error-message">錯誤: 用戶名不能是 "master" 或包含非法字符，且長度至少3位。</p>';

    if (success === 'user_added') messageHtml = '<p class="message success-message">用戶添加成功。</p>';
    else if (success === 'user_deleted') messageHtml = '<p class="message success-message">用戶刪除成功。</p>';
    else if (success === 'password_changed') messageHtml = '<p class="message success-message">用戶密碼修改成功。</p>';

    let usersTableHtml = '<table><thead><tr><th>用戶名</th><th>操作</th></tr></thead><tbody>';
    if (Object.keys(users).length === 0) {
        usersTableHtml += '<tr><td colspan="2" style="text-align:center;">當前沒有普通用戶。</td></tr>';
    } else {
        for (const username in users) {
            usersTableHtml += `
                <tr>
                    <td>${username}</td>
                    <td class="actions">
                        <form method="POST" action="/user-admin/delete" style="display:inline;">
                            <input type="hidden" name="usernameToDelete" value="${username}">
                            <button type="submit" class="danger" onclick="return confirm('確定要刪除用戶 ${username} 嗎？');">刪除</button>
                        </form>
                        <form method="POST" action="/user-admin/change-password-page" style="display:inline;">
                             <input type="hidden" name="usernameToChange" value="${username}">
                             <button type="submit">修改密碼</button>
                        </form>
                    </td>
                </tr>`;
        }
    }
    usersTableHtml += '</tbody></table>';

    res.send(`
        <!DOCTYPE html><html lang="zh-CN">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>用戶管理 (網關)</title><style>${pageStyles}</style></head>
        <body>
            <div class="container admin-container">
                <div class="logout-link-container"><a href="/logout" class="button-link">登出主帳戶</a></div>
                <h2>用戶管理面板 (網關主帳戶)</h2>
                ${messageHtml}
                <h3>現有普通用戶</h3>
                ${usersTableHtml}
                <h3>添加新普通用戶</h3>
                <form method="POST" action="/user-admin/add">
                    <div class="form-row">
                        <div class="field">
                            <label for="newUsername">新用戶名 (至少3位，僅字母數字下劃線):</label>
                            <input type="text" id="newUsername" name="newUsername" required pattern="^[a-zA-Z0-9_.-]+$" minlength="3">
                        </div>
                        <div class="field">
                            <label for="newUserPassword">新用戶密碼 (不能為空):</label>
                            <input type="password" id="newUserPassword" name="newUserPassword" required>
                        </div>
                         <div class="field">
                            <label for="confirmNewUserPassword">確認密碼:</label>
                            <input type="password" id="confirmNewUserPassword" name="confirmNewUserPassword" required>
                        </div>
                        <button type="submit">添加用戶</button>
                    </div>
                </form>
                <div class="nav-links">
                    <a href="/admin" class="button-link" style="background-color:#28a745; border-color:#28a745;">訪問文章管理 (主應用)</a>
                </div>
                 <p class="info-message" style="margin-top:20px;">此頁面用於管理可以登錄分享網站的普通用戶帳戶。主應用自身的管理（如文章管理）請通過上方“訪問文章管理”鏈接操作。</p>
            </div>
        </body></html>
    `);
});

userAdminRouter.post('/add', ensureMasterAdmin, (req, res) => {
    const { newUsername, newUserPassword, confirmNewUserPassword } = req.body;
    if (!newUsername || !newUserPassword || !confirmNewUserPassword ) {
        return res.redirect('/user-admin?error=missing_fields');
    }
    if (newUserPassword.trim() === '') {
        return res.redirect('/user-admin?error=password_empty');
    }
    if (newUserPassword !== confirmNewUserPassword) {
        return res.redirect('/user-admin?error=password_mismatch');
    }
    if (newUsername.toLowerCase() === "master" || !/^[a-zA-Z0-9_.-]+$/.test(newUsername) || newUsername.length < 3) {
        return res.redirect('/user-admin?error=invalid_username');
    }

    const users = readUserCredentials();
    if (users[newUsername]) {
        return res.redirect('/user-admin?error=user_exists');
    }

    try {
        users[newUsername] = { passwordHash: encryptUserPassword(newUserPassword) };
        saveUserCredentials(users);
        console.log(`[AUTH_GATE_ADMIN] 普通用戶 '${newUsername}' 已添加。`);
        res.redirect('/user-admin?success=user_added');
    } catch (error) {
        console.error("[AUTH_GATE_ADMIN] 添加用戶失敗:", error);
        res.redirect('/user-admin?error=unknown');
    }
});

userAdminRouter.post('/delete', ensureMasterAdmin, (req, res) => {
    const { usernameToDelete } = req.body;
    if (!usernameToDelete) {
        return res.redirect('/user-admin?error=unknown');
    }
    const users = readUserCredentials();
    if (!users[usernameToDelete]) {
        return res.redirect('/user-admin?error=user_not_found');
    }
    delete users[usernameToDelete];
    try {
        saveUserCredentials(users);
        console.log(`[AUTH_GATE_ADMIN] 普通用戶 '${usernameToDelete}' 已刪除。`);
        res.redirect('/user-admin?success=user_deleted');
    } catch (error) {
        console.error(`[AUTH_GATE_ADMIN] 刪除用戶 '${usernameToDelete}' 失敗:`, error);
        res.redirect('/user-admin?error=unknown');
    }
});

userAdminRouter.post('/change-password-page', ensureMasterAdmin, (req, res) => {
    const { usernameToChange } = req.body;
    const error = req.query.error;
    let errorMessageHtml = '';
    if (error === 'mismatch') errorMessageHtml = '<p class="message error-message">兩次輸入的密碼不匹配！</p>';
    else if (error === 'missing_fields') errorMessageHtml = '<p class="message error-message">錯誤：所有密碼字段均為必填項。</p>';
    else if (error === 'password_empty') errorMessageHtml = '<p class="message error-message">錯誤：新密碼不能為空。</p>';
    else if (error === 'unknown') errorMessageHtml = '<p class="message error-message">發生未知錯誤。</p>';

    if (!usernameToChange) return res.redirect('/user-admin?error=unknown');

    const users = readUserCredentials();
    if (!users[usernameToChange]) {
        return res.redirect('/user-admin?error=user_not_found');
    }

    res.send(`
        <!DOCTYPE html><html lang="zh-CN">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>修改用戶密碼 (網關)</title><style>${pageStyles}</style></head>
        <body>
            <div class="container">
                <h2>修改用戶 '${usernameToChange}' 的密碼</h2>
                ${errorMessageHtml}
                <form method="POST" action="/user-admin/perform-change-password">
                    <input type="hidden" name="username" value="${usernameToChange}">
                    <label for="newPassword">新密碼 (不能為空):</label>
                    <input type="password" id="newPassword" name="newPassword" required>
                    <label for="confirmPassword">確認新密碼:</label>
                    <input type="password" id="confirmPassword" name="confirmPassword" required>
                    <button type="submit" class="full-width">確認修改密碼</button>
                    <div class="nav-links">
                        <a href="/user-admin" class="button-link" style="background-color:#6c757d; border-color:#6c757d;">返回用戶管理</a>
                    </div>
                </form>
            </div>
        </body></html>
    `);
});

userAdminRouter.post('/perform-change-password', ensureMasterAdmin, (req, res) => {
    const { username, newPassword, confirmPassword } = req.body;
    const redirectUrl = `/user-admin/change-password-page`;
    const queryParams = new URLSearchParams({ usernameToChange: username });

    if (!username || !newPassword || !confirmPassword) {
        queryParams.append('error', 'missing_fields');
        return res.redirect(`${redirectUrl}?${queryParams.toString()}`);
    }
    if (newPassword.trim() === '') {
        queryParams.append('error', 'password_empty');
        return res.redirect(`${redirectUrl}?${queryParams.toString()}`);
    }
    if (newPassword !== confirmPassword) {
        queryParams.append('error', 'mismatch');
        return res.redirect(`${redirectUrl}?${queryParams.toString()}`);
    }

    const users = readUserCredentials();
    if (!users[username]) {
        return res.redirect('/user-admin?error=user_not_found');
    }

    try {
        users[username].passwordHash = encryptUserPassword(newPassword);
        saveUserCredentials(users);
        console.log(`[AUTH_GATE_ADMIN] 用戶 '${username}' 的密碼已修改。`);
        res.redirect('/user-admin?success=password_changed');
    } catch (error) {
        console.error(`[AUTH_GATE_ADMIN] 修改用戶 '${username}' 密碼失敗:`, error);
        queryParams.append('error', 'unknown');
        return res.redirect(`${redirectUrl}?${queryParams.toString()}`);
    }
});

app.use('/user-admin', userAdminRouter);


// --- 7. 反向代理中間件 ---
const proxyToMainApp = createProxyMiddleware({
    target: `http://localhost:${APP_INTERNAL_PORT}`,
    changeOrigin: true,
    ws: true,
    logLevel: 'debug',
    onError: (err, req, res, target) => {
        console.error('[AUTH_GATE_PROXY] 代理發生錯誤:', err.message, '請求:', req.method, req.url, '目標:', target);
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
             try { res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' }); } catch (e) { console.error("寫入代理錯誤頭部時出錯:", e); }
        }
        if (res && typeof res.end === 'function' && res.writable && !res.writableEnded) {
            try {
                res.end(`
                    <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>代理錯誤</title><style>${pageStyles}</style></head>
                    <body><div class="container">
                        <h2 class="error-message">代理錯誤 (502 Bad Gateway)</h2>
                        <p>抱歉，無法連接到後端分享網站服務。</p>
                        <p>錯誤詳情: ${err.message}</p>
                        <div class="nav-links">
                            <a href="/" class="button-link" onclick="location.reload(); return false;">重試</a>
                            <a href="/logout" class="button-link danger" style="margin-left:10px;">登出</a>
                        </div>
                    </div></body></html>
                `);
            } catch (e) { console.error("結束代理錯誤響應時出錯:", e); }
        } else if (res && typeof res.end === 'function' && !res.writableEnded) {
             try { res.end(); } catch (e) { /* ignore */ }
        }
    }
});

app.use(proxyToMainApp);


// --- 8. 服務器啟動 ---
const server = app.listen(PUBLIC_PORT, () => {
    console.log(`[AUTH_GATE] 認證網關與反向代理服務已在端口 ${PUBLIC_PORT} 上啟動。`);
    if (isMasterPasswordSetupNeeded) {
        console.log(`[AUTH_GATE] 請訪問 http://localhost:${PUBLIC_PORT}/setup 完成初始主密碼設置。`);
    } else {
        console.log(`[AUTH_GATE] 主應用將由本服務管理。`);
        console.log(`[AUTH_GATE] 公共網站訪問: http://localhost:${PUBLIC_PORT}/`);
        console.log(`[AUTH_GATE] 登錄頁面: http://localhost:${PUBLIC_PORT}/login`);
        console.log(`[AUTH_GATE] 主管理員使用者管理: http://localhost:${PUBLIC_PORT}/user-admin (使用主密碼登錄)`);
        if (!serverJsProcess || serverJsProcess.killed) {
            startMainApp();
        }
    }
    console.warn(
        `[AUTH_GATE] 安全提示：用戶密碼使用 AES-256-CBC 加密。` +
        `請確保 ${MASTER_SECRET_KEY_FILE} 文件的安全和備份。此文件是解密所有密碼的關鍵！`
    );
});

server.on('error', (error) => {
    if (error.syscall !== 'listen') {
        console.error('[AUTH_GATE] 發生了一個非監聽相關的服務器錯誤:', error);
        return;
    }
    switch (error.code) {
        case 'EACCES':
            console.error(`[AUTH_GATE] 錯誤：端口 ${PUBLIC_PORT} 需要提升的權限。`);
            process.exit(1);
            break;
        case 'EADDRINUSE':
            console.error(`[AUTH_GATE] 錯誤：端口 ${PUBLIC_PORT} 已被其他應用程序占用。`);
            process.exit(1);
            break;
        default:
            console.error('[AUTH_GATE] 服務器啟動時發生未知監聽錯誤:', error);
            process.exit(1);
    }
});

// --- 9. 優雅關閉處理 ---
function shutdownGracefully(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[AUTH_GATE] 收到 ${signal}。正在關閉服務...`);

    const serverClosePromise = new Promise((resolve) => {
        server.close(() => {
            console.log('[AUTH_GATE] HTTP 服務已關閉。');
            resolve();
        });
    });

    const childProcessPromise = new Promise((resolve) => {
        if (serverJsProcess && !serverJsProcess.killed) {
            console.log('[AUTH_GATE] 正在嘗試終止主應用 (server.js)...');
            const killTimeout = setTimeout(() => {
                if (serverJsProcess && !serverJsProcess.killed) {
                    console.warn('[AUTH_GATE] 主應用未在 SIGTERM 後3秒內退出，強制發送 SIGKILL...');
                    serverJsProcess.kill('SIGKILL');
                }
                resolve();
            }, 3000);
            serverJsProcess.on('exit', () => { clearTimeout(killTimeout); resolve(); });
            serverJsProcess.kill('SIGTERM');
        } else {
            resolve();
        }
    });

    Promise.all([serverClosePromise, childProcessPromise]).then(() => {
        console.log('[AUTH_GATE] 所有服務已關閉。優雅退出。');
        process.exit(0);
    }).catch(err => {
        console.error('[AUTH_GATE] 優雅關閉期間發生錯誤:', err);
        process.exit(1);
    });

    setTimeout(() => {
        console.error('[AUTH_GATE] 優雅關閉超時 (10秒)，強制退出。');
        process.exit(1);
    }, 10000);
}

process.on('SIGINT', () => shutdownGracefully('SIGINT'));
process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
