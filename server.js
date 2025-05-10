// server.js (主應用程式 - 分享網站核心邏輯)
import express from 'express';
import methodOverride from 'method-override';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import cookieParser from 'cookie-parser'; // **新增：引入 cookie-parser**

import articleRoutes from './routes/articles.js';
import { publicUploadsArticlesDir } from './utils/articleStore.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const APP_INTERNAL_PORT = process.env.PORT || process.env.NOTEPAD_PORT || 3000;
const GATEWAY_PUBLIC_PORT_FOR_LOGGING = process.env.GATEWAY_PUBLIC_PORT || '未知 (請檢查網關配置)';

const basePublicUploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdir(basePublicUploadsDir, { recursive: true }).catch(err => {
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保基礎 public/uploads 文件夾:", err);
});
fs.mkdir(publicUploadsArticlesDir, { recursive: true }).catch(err => {
    if (err.code !== 'EEXIST') console.error("[MainApp] 未能確保 public/uploads/articles 文件夾:", err);
});

// --- 中介軟體設定 ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser()); // **新增：使用 cookie-parser 中介軟體**
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// --- 路由配置 ---
app.use('/', articleRoutes);

// --- 錯誤處理中介軟體 ---
app.use((req, res, next) => {
  res.status(404).render('public/404', {
    pageTitle: '頁面未找到 - 網路分享站',
    // 為 404 頁面也傳遞登入狀態，以便頁眉能正確顯示
    isUserLoggedIn: req.cookies && req.cookies.auth === '1',
    isUserMaster: req.cookies && req.cookies.is_master === 'true'
  });
});

app.use((err, req, res, next) => {
  console.error("[MainApp] 應用程式發生未處理的錯誤:", err.stack);
  res.status(err.status || 500).render('public/error', {
    message: err.message || '服務器發生內部錯誤，請稍後再試。',
    error: process.env.NODE_ENV === 'development' ? err : {},
    pageTitle: '發生錯誤 - 網絡分享站',
    // 為錯誤頁面也傳遞登入狀態
    isUserLoggedIn: req.cookies && req.cookies.auth === '1',
    isUserMaster: req.cookies && req.cookies.is_master === 'true'
  });
});

app.listen(APP_INTERNAL_PORT, () => {
  console.log(`[MainApp] 網路分享站主應用程式正在 http://localhost:${APP_INTERNAL_PORT} (內部端口) 上運行`);
  console.log(`[MainApp] 此應用由認證網關 (start.cjs) 管理，請透過公開端口 (例如 ${GATEWAY_PUBLIC_PORT_FOR_LOGGING}) 存取。`);
});
