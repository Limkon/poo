// server.js (主應用程式 - 分享網站核心邏輯)
import express from 'express';
import methodOverride from 'method-override'; // 允許表單提交 PUT/DELETE 請求
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv'; // 用於加載 .env 文件中的環境變量
import fs from 'fs/promises'; // 使用 Promise 版本的 fs 模組

import articleRoutes from './routes/articles.js'; // 引入文章相關的路由
import { publicUploadsArticlesDir } from './utils/articleStore.js'; // 導入附件上傳目錄的常量

dotenv.config(); // 在應用程序開始時加載 .env 文件

const __filename = fileURLToPath(import.meta.url); // 獲取當前 ES 模塊文件的絕對路徑
const __dirname = path.dirname(__filename); // 獲取當前文件所在的文件夾路徑

const app = express();
// 主應用程式監聽的內部端口。
// 這個端口號由 start.cjs 腳本通過環境變量 PORT (或 NOTEPAD_PORT) 傳遞過來。
// 如果環境變量未設置，則默認為 3000。
const APP_INTERNAL_PORT = process.env.PORT || process.env.NOTEPAD_PORT || 3000;

// 應用啟動時確保基礎的公共上傳文件夾存在
// data/articles 和 public/uploads/articles 由 articleStore.js 中的 ensureDir 處理
const basePublicUploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdir(basePublicUploadsDir, { recursive: true }).catch(err => {
    // 如果文件夾已存在，mkdir 會拋出 EEXIST 錯誤，這是正常的，可以忽略
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保基礎 public/uploads 文件夾:", err);
});
fs.mkdir(publicUploadsArticlesDir, { recursive: true }).catch(err => {
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保 public/uploads/articles 文件夾:", err);
});


// --- 中間件設置 ---
app.set('view engine', 'ejs'); // 設置視圖引擎為 EJS
app.set('views', path.join(__dirname, 'views')); // 設置 EJS 模板文件的存放目錄

app.use(express.urlencoded({ extended: true })); // 解析 URL 編碼的請求體 (通常來自 HTML 表單)
app.use(express.json()); // 解析 JSON 格式的請求體
app.use(methodOverride('_method')); // 啟用 method-override，允許表單通過查詢參數指定 HTTP 方法 (例如 <form method="POST" action="/path?_method=DELETE">)

// 設置靜態文件服務
// 'public' 文件夾下的所有文件 (如 CSS, 客戶端 JS, 圖片) 都可以直接通過 URL 訪問
// 例如，public/css/style.css 可以通過 http://localhost:PUBLIC_PORT/css/style.css 訪問
// 上傳的附件也會存放在 public/uploads/articles/ 下，因此也可以通過類似路徑訪問
app.use(express.static(path.join(__dirname, 'public')));


// --- 路由配置 ---
// 所有與文章相關的路由（包括公開頁面如首頁、文章詳情，以及管理頁面如 /admin/articles, /admin/new 等）
// 都定義在 ./routes/articles.js 文件中，並掛載到應用的根路徑 '/'。
// 對於 /admin/* 路徑的訪問控制（是否已登錄）主要由 start.cjs 認證網關負責。
// start.cjs 會確保只有已認證的用戶（主管理員或普通用戶）的 /admin/* 請求才會被代理到這裡。
app.use('/', articleRoutes);

// --- 錯誤處理中間件 ---
// 404 錯誤處理：如果請求沒有匹配到任何之前的路由，則執行此中間件
app.use((req, res, next) => {
  res.status(404).render('public/404', { pageTitle: '頁面未找到 - 網絡分享站' });
});

// 全局錯誤處理器：捕獲在路由處理器中通過 next(err) 傳遞的錯誤
app.use((err, req, res, next) => {
  console.error("[MainApp] 應用程序發生未處理的錯誤:", err.stack); // 在服務器控制台打印詳細的錯誤堆棧信息
  res.status(err.status || 500).render('public/error', { // 渲染一個通用的錯誤頁面
    message: err.message || '服務器發生內部錯誤，請稍後再試。',
    // 僅在開發環境下向客戶端顯示詳細的錯誤對象（包括堆棧）
    error: process.env.NODE_ENV === 'development' ? err : {},
    pageTitle: '發生錯誤 - 網絡分享站'
  });
});

// 啟動 Express 應用程序，監聽指定的內部端口
app.listen(APP_INTERNAL_PORT, () => {
  console.log(`[MainApp] 網絡分享站主應用程序正在 http://localhost:${APP_INTERNAL_PORT} (內部端口) 上運行`);
  console.log(`[MainApp] 此應用由認證網關 (start.cjs) 管理，請通過公開端口 (例如 ${PUBLIC_PORT}) 訪問。`);
});
