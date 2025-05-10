// routes/articles.js
import express from 'express';
import multer from 'multer'; // 用於處理文件上傳
import path from 'path';
import fs from 'fs/promises'; // 用於異步文件系統操作，例如檢查文件是否存在
import { v4 as uuidv4 } from 'uuid'; // 用於生成唯一ID

// 從 articleStore 導入數據處理函數和常量
import {
  getAllArticles,
  getArticleById,
  saveArticle,
  deleteArticleById,
  addAttachmentToArticle,
  removeAttachmentFromArticle,
  CATEGORIES, // 文章分類
  publicUploadsArticlesDir // 文章附件的公共上傳目錄
} from '../utils/articleStore.js';

const router = express.Router();

// --- Multer 配置，用於文件上傳 ---
// 輔助函數，確保特定文章的上傳文件夾存在
async function ensureArticleUploadDir(articleId) {
  const dir = path.join(publicUploadsArticlesDir, articleId); // 構造特定文章的附件文件夾路徑
  try {
    await fs.access(dir); // 檢查文件夾是否存在
  } catch {
    await fs.mkdir(dir, { recursive: true }); // 如果不存在則遞歸創建
  }
  return dir; // 返回文件夾路徑
}

// Multer 存儲引擎配置
const articleStorage = multer.diskStorage({
  destination: async function (req, file, cb) {
    // 確定文件保存路徑
    // req.params.id 在編輯現有文章時可用
    // req.body.articleIdForUpload 可作為隱藏字段用於編輯，或在新建時由客戶端生成臨時ID
    // 如果是新建文章且沒有 articleIdForUpload，則生成一個臨時ID用於本次上傳
    const articleId = req.params.id || req.body.articleIdForUpload || (req.isNewArticleFlow ? uuidv4() : 'temp_default_id');
    if (req.isNewArticleFlow && !req.body.articleIdForUpload) {
        // 如果是新建文章流程，並且請求體中沒有提供 articleIdForUpload（例如由客戶端生成）
        // 則將 multer 中間件內部生成的 articleId 存儲在請求對象中，以便後續路由處理器使用它來保存文章
        req.tempGeneratedArticleId = articleId;
    }
    const uploadPath = await ensureArticleUploadDir(articleId); // 使用文章ID作為子文件夾
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // 為避免文件名衝突和處理特殊字符，預先處理文件名
    // 使用 uuid 生成唯一前綴，並替換掉文件名中的空格和不安全字符
    cb(null, uuidv4() + '-' + file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, ''));
  }
});

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 設置最大文件大小為 25MB
const upload = multer({
  storage: articleStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // 文件過濾器，可以限制上傳的文件類型
    // 此處允許所有文件類型，如果需要特定類型檢查，可以在此處添加邏輯
    console.log(`[Multer] 文件過濾: ${file.originalname}, mimetype: ${file.mimetype}`);
    cb(null, true); // true 表示接受文件，false 表示拒絕
  }
});

// 中間件，用於標記新建文章流程，以便 multer 的 destination 回調可以生成臨時ID
// 這個中間件會在處理 POST /admin/new 請求之前執行
function markNewArticleFlow(req, res, next) {
    if (req.path === '/admin/new' && req.method === 'POST') {
        req.isNewArticleFlow = true; // 在請求對象上設置一個標記
    }
    next();
}


// =========== PUBLIC ROUTES (公開訪問的路由) ===========

// GET / (網站首頁 - 列出所有文章)
router.get('/', async (req, res, next) => {
  try {
    let articles = await getAllArticles(); // 獲取所有文章
    const { category, q } = req.query; // 獲取查詢參數中的分類和搜索關鍵詞

    if (category) { // 如果有分類篩選
      articles = articles.filter(article => article.category === category);
    }
    if (q) { // 如果有搜索關鍵詞
      const searchTerm = q.toLowerCase();
      articles = articles.filter(article =>
        (article.title && article.title.toLowerCase().includes(searchTerm)) ||
        (article.content && article.content.toLowerCase().includes(searchTerm)) // 也在內容中搜索
      );
    }
    res.render('index', { // 渲染首頁模板
      articles,
      categories: CATEGORIES, // 將分類列表傳遞給模板
      currentCategory: category || '', // 當前選中的分類
      currentSearch: q || '', // 當前搜索的關鍵詞
      pageTitle: '網絡分享站'
    });
  } catch (err) {
    console.error("[Public] 獲取主頁文章時出錯:", err);
    next(err); // 將錯誤傳遞給全局錯誤處理器
  }
});

// GET /articles/:id (查看單個文章詳情)
router.get('/articles/:id', async (req, res, next) => {
  try {
    const article = await getArticleById(req.params.id); // 根據ID獲取文章
    if (!article) {
      // 如果文章未找到，渲染 404 頁面
      return res.status(404).render('public/404', { pageTitle: '未找到分享'});
    }
    res.render('public/show_article', { article, pageTitle: article.title }); // 渲染文章詳情頁面
  } catch (err) {
     console.error(`[Public] 獲取文章 ${req.params.id} 時出錯:`, err);
    next(err);
  }
});

// GET /articles/download/:id/:filename (下載附件)
router.get('/articles/download/:id/:filename', async (req, res, next) => {
    try {
        const articleId = req.params.id;
        const filename = req.params.filename; // 這是存儲的文件名 (例如 uuid-original.pdf)

        const article = await getArticleById(articleId); // 獲取文章信息
        if (!article) {
            return res.status(404).send('找不到文章。');
        }

        // 在文章的附件列表中查找對應的附件信息
        const attachment = article.attachments.find(att => att.filename === filename);
        if (!attachment) {
            return res.status(404).send('找不到附件。');
        }

        // 構造附件的完整物理路徑
        const filePath = path.join(publicUploadsArticlesDir, articleId, filename);

        await fs.access(filePath); // 異步檢查文件是否存在且可訪問，如果不存在會拋出錯誤

        // 設置響應頭以便下載，使用 originalname 作為下載對話框中的文件名
        res.download(filePath, attachment.originalname, (err) => {
            if (err) {
                console.error(`[Download] 下載文件 ${filePath} 時出錯:`, err);
                if (!res.headersSent) { // 確保在發送任何響應頭之前處理錯誤
                    if (err.code === 'ENOENT') { // 雖然 fs.access 應該已捕獲，但作為雙重檢查
                         return res.status(404).send('文件不存在於服務器。');
                    }
                    return res.status(500).send('下載文件時發生錯誤。');
                }
            }
        });
    } catch (err) {
        console.error('[Download] 下載路由常規錯誤:', err);
        if (err.code === 'ENOENT') { // 如果 fs.access 拋出錯誤 (文件未找到)
            return res.status(404).send('請求的文件不存在。');
        }
        next(err); // 其他錯誤交給全局錯誤處理器
    }
});


// =========== ADMIN ROUTES (管理員路由) ===========
// (注意：start.cjs 中的全局中間件已保護 /admin 路徑的訪問權限)

// GET /admin (管理後台 - 列出所有文章以供管理)
// 注意：實際的 /admin 路由前綴由 server.js 中 app.use('/', articleRoutes) 掛載，
// 所以這裡的 /admin 實際上是相對於 articleRoutes 的根，對應到應用的 /admin。
router.get('/admin', async (req, res, next) => {
  try {
    const articles = await getAllArticles(); // 獲取所有文章，默認按更新時間排序
    res.render('admin/list_articles', { // 渲染管理列表頁面
        articles,
        pageTitle: '後台管理 - 文章列表',
        success: req.query.success, // 用於顯示操作成功消息 (來自重定向的查詢參數)
        error: req.query.error     // 用於顯示操作失敗消息
    });
  } catch (err) {
    console.error("[Admin] 獲取管理列表文章時出錯:", err);
    next(err);
  }
});

// GET /admin/new (管理後台 - 顯示創建新文章的表單)
router.get('/admin/new', (req, res) => {
  res.render('admin/new_article', {
    pageTitle: '後台管理 - 新建分享',
    article: { title: '', content: '', category: CATEGORIES[0], attachments: [] }, // 默認空文章對象，預設分類
    categories: CATEGORIES, // 將分類列表傳遞給模板
    error: null // 初始沒有錯誤信息
  });
});

// POST /admin/new (管理後台 - 創建新文章)
// 1. 使用 markNewArticleFlow 中間件標記新文章流程
// 2. 使用 upload.array('attachments', 10) 處理多個文件上傳，字段名為 'attachments'，最多10個文件
router.post('/admin/new', markNewArticleFlow, upload.array('attachments', 10), async (req, res, next) => {
  const { title, content, category } = req.body; // 從請求體獲取表單數據
  if (!title || !category) { // 基本驗證
    // 如果驗證失敗，Multer 上傳的文件可能需要清理（如果它們沒有被自動處理）
    // 簡單起見，我們假設如果標題/分類缺失，我們會帶錯誤重新渲染。
    // 在此請求中由 Multer 上傳的文件如果沒有明確刪除，可能會變成孤立文件。
    // TODO: 添加清理孤立上傳文件的邏輯
    return res.render('admin/new_article', {
      pageTitle: '後台管理 - 新建分享',
      article: { title, content, category, attachments: [] }, // 回填用戶輸入
      categories: CATEGORIES,
      error: '標題和分類是必填項。'
    });
  }

  try {
    // 使用 multer 中間件中生成的臨時文章ID（如果適用）或新生成一個
    // req.tempGeneratedArticleId 是在 multer 的 destination 回調中設置的 (如果 isNewArticleFlow 為 true)
    const articleIdToUse = req.tempGeneratedArticleId || uuidv4();
    const newArticleData = { id: articleIdToUse, title, content, category, attachments: [] }; // 創建文章數據對象時傳入ID

    // 處理上傳的文件並關聯它們
    if (req.files && req.files.length > 0) {
        // 確保此文章的特定上傳文件夾存在 (雖然 multer 的 destination 應該已經創建了)
        await ensureArticleUploadDir(articleIdToUse);
        for (const file of req.files) {
            // Multer 已經將文件保存到由其 destination 回調確定的路徑
            // file.filename 是 Multer 保存時生成的文件名 (uuid-originalname)
            // 我們需要存儲相對於 public/uploads/articles 的路徑以便鏈接和下載
            const relativePath = `/uploads/articles/${articleIdToUse}/${file.filename}`;
            newArticleData.attachments.push({
                originalname: file.originalname, // 原始文件名
                filename: file.filename,         // Multer 保存的文件名
                path: relativePath,              // 用於鏈接/下載的相對路徑
                mimetype: file.mimetype,         // 文件的MIME類型
                size: file.size                  // 文件大小 (字節)
            });
        }
    }
    await saveArticle(newArticleData); // 保存文章數據（包括附件信息）到 JSON 文件
    res.redirect(`/admin?success=分享已成功創建`); // 重定向到管理列表頁並提示成功
  } catch (err) {
    console.error("[Admin] 創建新文章時出錯:", err);
    // TODO: 如果文章保存失敗但在這之前文件已上傳到磁盤，則需要清理這些文件
    next(err);
  }
});


// GET /admin/edit/:id (管理後台 - 顯示編輯文章的表單)
router.get('/admin/edit/:id', async (req, res, next) => {
  try {
    const article = await getArticleById(req.params.id); // 根據ID獲取要編輯的文章
    if (!article) {
      return res.status(404).redirect('/admin?error=未找到指定的分享內容'); // 如果文章不存在，重定向並提示錯誤
    }
    res.render('admin/edit_article', { // 渲染編輯頁面
      pageTitle: `後台管理 - 編輯: ${article.title}`,
      article,
      categories: CATEGORIES,
      error: req.query.error, // 從查詢參數獲取可能的錯誤消息 (例如附件刪除失敗後重定向回來)
      success: req.query.success // 從查詢參數獲取可能的成功消息
    });
  } catch (err) {
    console.error(`[Admin] 獲取文章 ${req.params.id} 進行編輯時出錯:`, err);
    next(err);
  }
});

// POST /admin/edit/:id (管理後台 - 更新文章)
// 使用 upload.array 處理編輯時可能新增的附件，字段名為 'new_attachments'，最多5個
router.post('/admin/edit/:id', upload.array('new_attachments', 5), async (req, res, next) => {
  const articleId = req.params.id;
  const { title, content, category } = req.body; // 獲取表單數據

  if (!title || !category) { // 基本驗證
    // 如果驗證失敗，重新獲取文章數據以渲染表單並顯示錯誤
    const article = await getArticleById(articleId) || { id: articleId, title, content, category, attachments: [] }; // 獲取現有文章數據或創建一個包含ID的空對象
    return res.render('admin/edit_article', {
      pageTitle: `後台管理 - 編輯: ${article.title || '文章'}`,
      article: {...article, title, content, category}, // 使用用戶提交的值回填表單，保留其他原有數據
      categories: CATEGORIES,
      error: '標題和分類是必填項。'
    });
  }

  try {
    let article = await getArticleById(articleId); // 獲取要更新的文章
    if (!article) {
      return res.status(404).redirect('/admin?error=未找到要更新的分享內容');
    }

    // 更新文章的基本信息
    article.title = title;
    article.content = content;
    article.category = category;
    // article.attachments 將通過下面的邏輯處理（添加新附件，舊附件通過單獨路由刪除）

    // 處理本次編輯會話中新上傳的文件
    if (req.files && req.files.length > 0) {
        await ensureArticleUploadDir(articleId); // 確保該文章的附件文件夾存在
        for (const file of req.files) {
            const relativePath = `/uploads/articles/${articleId}/${file.filename}`;
            article.attachments.push({ // 將新附件信息添加到文章的附件列表中
                originalname: file.originalname,
                filename: file.filename, // Multer 保存的文件名
                path: relativePath,      // 用於訪問的路徑
                mimetype: file.mimetype,
                size: file.size
            });
        }
    }

    await saveArticle(article); // 保存更新後的文章數據（這會更新 updatedAt）
    res.redirect(`/admin?success=分享內容已成功更新`); // 重定向到管理列表頁並提示成功
  } catch (err) {
    console.error(`[Admin] 更新文章 ${articleId} 時出錯:`, err);
    next(err);
  }
});

// POST /admin/delete/:id (管理後台 - 刪除文章)
// 為了表單提交的簡便性，這裡使用 POST，但理想情況下應該是 DELETE 方法（需配合 method-override）
// 如果在表單中使用了 <input type="hidden" name="_method" value="DELETE">，則 Express 路由應為 router.delete(...)
router.post('/admin/delete/:id', async (req, res, next) => {
  try {
    const success = await deleteArticleById(req.params.id); // 刪除文章及其附件
    if (!success) {
      // 如果 deleteArticleById 返回 false (例如文件未找到)
      return res.redirect('/admin?error=未找到指定的分享內容或刪除失敗');
    }
    res.redirect('/admin?success=分享內容及其附件已成功刪除'); // 重定向並提示成功
  } catch (err) {
    console.error(`[Admin] 刪除文章 ${req.params.id} 時出錯:`, err);
    next(err);
  }
});


// POST /admin/attachments/delete/:id/:filename (管理後台 - 刪除指定文章的指定附件)
// 同樣，理想情況下是 DELETE 方法
router.post('/admin/attachments/delete/:id/:filename', async (req, res, next) => {
    const { id: articleId, filename } = req.params; // 從路由參數獲取文章ID和要刪除的附件文件名
    try {
        await removeAttachmentFromArticle(articleId, filename); // 移除附件記錄並刪除物理文件
        // 操作成功後重定向回該文章的編輯頁面，並帶上成功消息
        res.redirect(`/admin/edit/${articleId}?success=附件 ${decodeURIComponent(filename)} 已成功刪除`);
    } catch (err) {
        console.error(`[Admin] 從文章 ${articleId} 刪除附件 ${filename} 時出錯:`, err);
        // 操作失敗後重定向回編輯頁面，並帶上錯誤消息
        res.redirect(`/admin/edit/${articleId}?error=附件刪除失敗: ${err.message}`);
    }
});


export default router; // 導出路由
