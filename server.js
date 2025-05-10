// server.js (主應用程式 - 分享網站核心邏輯)
import express from 'express';
import methodOverride from 'method-override'; // 允許表單提交 PUT/DELETE 請求
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv'; // 用於載入 .env 檔案中的環境變數
import fs from 'fs/promises'; // 使用 Promise 版本的 fs 模組

import articleRoutes from './routes/articles.js'; // 引入文章相關的路由
import { publicUploadsArticlesDir } from './utils/articleStore.js'; // 導入附件上傳目錄的常量

dotenv.config(); // 在應用程式開始時載入 .env 檔案

const __filename = fileURLToPath(import.meta.url); // 獲取當前 ES 模組檔案的絕對路徑
const __dirname = path.dirname(__filename); // 獲取當前檔案所在的文件夾路徑

const app = express();
// 主應用程式監聽的內部端口。
// 這個端口號由 start.cjs 腳本透過環境變數 PORT (或 NOTEPAD_PORT) 傳遞過來。
// 如果環境變數未設定，則預設為 3000。
const APP_INTERNAL_PORT = process.env.PORT || process.env.NOTEPAD_PORT || 3000;

// **新增：從環境變數讀取由網關傳遞過來的公開端口號，用於日誌記錄**
const GATEWAY_PUBLIC_PORT_FOR_LOGGING = process.env.GATEWAY_PUBLIC_PORT || '未知 (請檢查網關配置)';

// 應用啟動時確保基礎的公共上傳資料夾存在
// data/articles 和 public/uploads/articles 由 articleStore.js 中的 ensureDir 處理
// 但為確保 public/uploads 基礎資料夾存在，可以單獨檢查或依賴 articleStore 的初始化。
const basePublicUploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdir(basePublicUploadsDir, { recursive: true }).catch(err => {
    // 如果資料夾已存在，mkdir 會拋出 EEXIST 錯誤，這是正常的，可以忽略
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保基礎 public/uploads 資料夾:", err);
});
fs.mkdir(publicUploadsArticlesDir, { recursive: true }).catch(err => {
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保 public/uploads/articles 資料夾:", err);
});


// --- 中介軟體設定 ---
app.set('view engine', 'ejs'); // 設定視圖引擎為 EJS
app.set('views', path.join(__dirname, 'views')); // 設定 EJS 範本檔案的存放目錄

app.use(express.urlencoded({ extended: true })); // 解析 URL 編碼的請求體 (通常來自 HTML 表單)
app.use(express.json()); // 解析 JSON 格式的請求體
app.use(methodOverride('_method')); // 啟用 method-override，允許表單透過查詢參數指定 HTTP 方法 (例如 <form method="POST" action="/path?_method=DELETE">)

// 設定靜態檔案服務
// 'public' 資料夾下的所有檔案 (如 CSS, 用戶端 JS, 圖片) 都可以直接透過 URL 存取
// 例如，public/css/style.css 可以透過 http://localhost:PUBLIC_PORT/css/style.css 存取
// 上傳的附件也會存放在 public/uploads/articles/ 下，因此也可以透過類似路徑存取
app.use(express.static(path.join(__dirname, 'public')));


// --- 路由配置 ---
// 所有與文章相關的路由（包括公開頁面如首頁、文章詳情，以及管理頁面如 /admin/articles, /admin/new 等）
// 都定義在 ./routes/articles.js 檔案中，並掛載到應用的根路徑 '/'。
// 對於 /admin/* 路徑的存取控制（是否已登入）主要由 start.cjs 認證閘道負責。
// start.cjs 會確保只有已認證的使用者（主管理員或普通使用者）的 /admin/* 請求才會被代理到這裡。
app.use('/', articleRoutes);

// --- 錯誤處理中介軟體 ---
// 404 錯誤處理：如果請求沒有匹配到任何之前的路由，則執行此中介軟體
app.use((req, res, next) => {
  res.status(404).render('public/404', { pageTitle: '頁面未找到 - 網路分享站' });
});

// 全域錯誤處理器：捕獲在路由處理器中透過 next(err) 傳遞的錯誤
app.use((err, req, res, next) => {
  console.error("[MainApp] 應用程式發生未處理的錯誤:", err.stack); // 在伺服器控制台列印詳細的錯誤堆疊資訊
  res.status(err.status || 500).render('public/error', { // 渲染一個通用的錯誤頁面
    message: err.message || '伺服器發生內部錯誤，請稍後再試。',
    // 僅在開發環境下向用戶端顯示詳細的錯誤物件（包括堆疊）
    error: process.env.NODE_ENV === 'development' ? err : {},
    pageTitle: '發生錯誤 - 網路分享站'
  });
});

// 啟動 Express 應用程式，監聽指定的內部端口
app.listen(APP_INTERNAL_PORT, () => {
  console.log(`[MainApp] 網路分享站主應用程式正在 http://localhost:${APP_INTERNAL_PORT} (內部端口) 上運行`);
  // **修改：在日誌訊息中使用從環境變數讀取的 GATEWAY_PUBLIC_PORT_FOR_LOGGING**
  console.log(`[MainApp] 此應用由認證閘道 (start.cjs) 管理，請透過公開端口 (例如 ${GATEWAY_PUBLIC_PORT_FOR_LOGGING}) 存取。`);
});
