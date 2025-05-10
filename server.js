// server.js (Main Application for Sharing Site)
import express from 'express';
import methodOverride from 'method-override';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs/promises'; // 引入 fs.promises 以便異步操作文件系統

import articleRoutes from './routes/articles.js'; // 引入文章路由
// 從 articleStore 導入 publicUploadsArticlesDir 以便確保文件夾存在
import { publicUploadsArticlesDir } from './utils/articleStore.js';

dotenv.config(); // 加載 .env 文件中的環境變量

const __filename = fileURLToPath(import.meta.url); // 獲取當前文件的絕對路徑
const __dirname = path.dirname(__filename); // 獲取當前文件所在的文件夾路徑

const app = express();
// 此端口由 start.cjs (APP_INTERNAL_PORT) 通過環境變量 PORT 或 NOTEPAD_PORT (兼容舊名) 設置
const APP_PORT = 3200;// process.env.PORT || process.env.NOTEPAD_PORT ||

// 確保基礎 public/uploads 和 public/uploads/articles 文件夾存在
// articleStore.js 中的 ensureDir 會處理 data/articles 和 public/uploads/articles
// 但為確保 public/uploads 基礎文件夾存在，可以單獨檢查或依賴 articleStore 的初始化。
const baseUploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdir(baseUploadsDir, { recursive: true }).catch(err => {
    // 如果文件夾已存在，mkdir 會拋出 EEXIST 錯誤，可以忽略
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保基礎 public/uploads 文件夾:", err);
});
fs.mkdir(publicUploadsArticlesDir, { recursive: true }).catch(err => {
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保 public/uploads/articles 文件夾:", err);
});


// 中間件設置
app.set('view engine', 'ejs'); // 設置模板引擎為 EJS
app.set('views', path.join(__dirname, 'views')); // 設置模板文件夾路徑
app.use(express.urlencoded({ extended: true })); // 解析 URL 編碼的請求體 (用於表單提交)
app.use(express.json()); // 解析 JSON 格式的請求體
app.use(methodOverride('_method')); // 允許在 HTML 表單中使用 PUT/DELETE 等 HTTP 方法 (例如 ?_method=DELETE)

// 靜態文件服務 (CSS, JS, 以及上傳的內容)
// 重要：這裡的 '/uploads' 路徑將服務 'public/uploads' 中的文件
// 這意味著像 '/uploads/articles/article_id/filename.pdf' 這樣的附件鏈接將會生效。
app.use(express.static(path.join(__dirname, 'public')));


// 路由配置
// 所有文章相關的路由 (公開的和管理的) 現在都在 articleRoutes 中
// 管理路由的保護由 start.cjs 網關針對 /admin/* 路徑處理
app.use('/', articleRoutes); // 將文章路由掛載到根路徑

// 主應用的基本 404 處理器 (如果沒有路由匹配)
app.use((req, res, next) => {
  res.status(404).render('public/404', { pageTitle: '頁面未找到' });
});

// 主應用的全局錯誤處理器 (捕獲路由處理器中的 next(err) 調用)
app.use((err, req, res, next) => {
  console.error("[MainApp] 未處理的錯誤:", err.stack); // 在服務器控制台打印錯誤堆棧
  res.status(err.status || 500).render('public/error', { // 渲染錯誤頁面
    message: err.message || '服務器發生內部錯誤。',
    error: process.env.NODE_ENV === 'development' ? err : {}, // 僅在開發環境向客戶端顯示詳細錯誤信息
    pageTitle: '錯誤'
  });
});

app.listen(APP_PORT, () => {
  console.log(`[MainApp] 網絡分享站應用程序服務器正在 http://localhost:${APP_PORT} (內部端口) 上運行`);
});
