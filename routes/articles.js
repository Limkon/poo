// routes/articles.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import {
  getAllArticles, getArticleById, saveArticle, deleteArticleById,
  addAttachmentToArticle, removeAttachmentFromArticle,
  CATEGORIES, publicUploadsArticlesDir
} from '../utils/articleStore.js';

const router = express.Router();

// --- Multer 配置 ---
async function ensureArticleUploadDir(articleId) {
  const dir = path.join(publicUploadsArticlesDir, articleId);
  try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
  return dir;
}

const articleStorage = multer.diskStorage({
  destination: async function (req, file, cb) {
    const articleIdParam = req.params.id || req.body.articleIdForUpload;
    let articleIdToUse;
    if (articleIdParam) {
        articleIdToUse = articleIdParam;
    } else if (req.isNewArticleFlow) {
        if (!req.tempGeneratedArticleId) {
            req.tempGeneratedArticleId = uuidv4();
        }
        articleIdToUse = req.tempGeneratedArticleId;
    } else {
        console.warn('[Multer Destination] 無法確定文章 ID，將使用預設臨時 ID');
        articleIdToUse = 'temp_unknown_article';
    }
    const uploadPath = await ensureArticleUploadDir(articleIdToUse);
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // **嘗試解碼 originalname (以防萬一)**
    let originalnameDecoded = file.originalname;
    try {
        // 瀏覽器通常會以 UTF-8 發送，但 multer 內部可能已經處理了
        // 這裡的 decodeURIComponent 更多是為了確保，如果它是被 URL 編碼過的
        originalnameDecoded = decodeURIComponent(file.originalname);
    } catch (e) {
        console.warn(`[Multer Filename CB] 解碼 originalname '${file.originalname}' 失敗:`, e.message);
        // 如果解碼失敗，仍然使用原始的 file.originalname
    }
    console.log(`[Multer Filename CB] 接收到的原始檔名 (file.originalname): '${file.originalname}', 解碼嘗試後: '${originalnameDecoded}'`);
    const extension = path.extname(originalnameDecoded); // 使用解碼後的名稱獲取副檔名
    const diskFilename = uuidv4() + extension;
    console.log(`[Multer Filename CB] 生成的磁碟檔名: '${diskFilename}'`);
    cb(null, diskFilename);
  }
});

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const upload = multer({
  storage: articleStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    console.log(`[Multer FileFilter] 檔案: ${file.originalname}, mimetype: ${file.mimetype}, encoding: ${file.encoding}`);
    cb(null, true);
  },
  // **新增：嘗試指定 Multer 處理檔名的編碼，儘管這不是標準選項，但某些舊版本或特定情況下可能有用**
  // **注意：標準的 Multer API 並沒有 preservePath 或 charset 選項直接用於檔名編碼。**
  // **檔名編碼主要依賴於客戶端（瀏覽器）如何發送 multipart/form-data 以及 Node.js/Express 如何解析請求頭。**
  // **我們主要依賴 Multer 自身對 Content-Disposition 標頭的正確解析。**
  // preservePath: true // 這個選項通常用於保留原始路徑，與檔名編碼關係不大
});

function markNewArticleFlow(req, res, next) {
    if ((req.path === '/admin/new' || (req.path.startsWith('/admin/edit/') && req.method === 'POST')) && req.method === 'POST') {
        req.isNewArticleFlow = req.path === '/admin/new';
    }
    next();
}

// =========== PUBLIC ROUTES ===========
router.get('/', async (req, res, next) => {
  try {
    let articles = await getAllArticles();
    const { category, q } = req.query;
    if (category) { articles = articles.filter(article => article.category === category); }
    if (q) {
      const searchTerm = q.toLowerCase();
      articles = articles.filter(article =>
        (article.title && article.title.toLowerCase().includes(searchTerm)) ||
        (article.content && article.content.toLowerCase().includes(searchTerm))
      );
    }
    res.render('index', {
      articles,
      categories: CATEGORIES,
      currentCategory: category || '',
      currentSearch: q || '',
      pageTitle: '網路分享站',
      isUserLoggedIn: req.cookies && req.cookies.auth === '1',
      isUserMaster: req.cookies && req.cookies.is_master === 'true'
    });
  } catch (err) { console.error("[Public] 獲取主頁文章時出錯:", err); next(err); }
});

router.get('/articles/:id', async (req, res, next) => {
  try {
    const article = await getArticleById(req.params.id);
    if (!article) { return res.status(404).render('public/404', {
        pageTitle: '未找到分享',
        isUserLoggedIn: req.cookies && req.cookies.auth === '1',
        isUserMaster: req.cookies && req.cookies.is_master === 'true'
    }); }
    res.render('public/show_article', {
        article,
        pageTitle: article.title,
        isUserLoggedIn: req.cookies && req.cookies.auth === '1',
        isUserMaster: req.cookies && req.cookies.is_master === 'true'
    });
  } catch (err) { console.error(`[Public] 獲取文章 ${req.params.id} 時出錯:`, err); next(err); }
});

router.get('/articles/download/:id/:filename', async (req, res, next) => {
    try {
        const articleId = req.params.id;
        const filename = req.params.filename; // 這是儲存在磁碟上的安全檔名 (UUID.ext)
        const article = await getArticleById(articleId);
        if (!article) { return res.status(404).send('找不到文章。'); }
        const attachment = article.attachments.find(att => att.filename === filename);
        if (!attachment) { return res.status(404).send('找不到附件記錄。'); }

        const filePath = path.join(publicUploadsArticlesDir, articleId, filename);
        console.log(`[Download] 準備下載檔案: ${filePath}, 原始名稱 (用於下載提示): '${attachment.originalname}'`);

        // 使用 RFC 5987 方式處理非 ASCII 字元，確保 UTF-8 編碼
        // 並確保 originalname 是字串類型
        const originalnameForHeader = String(attachment.originalname || 'download'); // 提供一個備用名
        const encodedOriginalname = encodeURIComponent(originalnameForHeader);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedOriginalname}`);

        await fs.access(filePath);
        res.download(filePath, originalnameForHeader, (err) => {
            if (err) {
                console.error(`[Download] 下載文件 ${filePath} (原始名: ${originalnameForHeader}) 時出錯:`, err);
                if (!res.headersSent) {
                    if (err.code === 'ENOENT') { return res.status(404).send('文件不存在於服務器。'); }
                    return res.status(500).send('下載文件時發生錯誤。');
                }
            } else {
                console.log(`[Download] 文件 ${originalnameForHeader} 已開始下載。`);
            }
        });
    } catch (err) {
        console.error('[Download] 下載路由常規錯誤:', err);
        if (err.code === 'ENOENT') { return res.status(404).send('請求的文件不存在。'); }
        next(err);
    }
});

// =========== ADMIN ROUTES ===========
router.get('/admin', async (req, res, next) => {
  console.log(`[ROUTE GET /admin] 請求 cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  try {
    const articles = await getAllArticles();
    res.render('admin/list_articles', {
        articles,
        pageTitle: '後台管理 - 文章列表',
        success: req.query.success,
        error: req.query.error,
        isUserLoggedIn: req.cookies.auth === '1',
        isUserMaster: req.cookies.is_master === 'true'
    });
  } catch (err) {
    console.error("[Admin] 獲取管理列表文章時出錯:", err);
    next(err);
  }
});

router.get('/admin/new', (req, res) => {
  console.log(`[ROUTE GET /admin/new] 請求 cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  res.render('admin/new_article', {
    pageTitle: '後台管理 - 新建分享',
    article: { title: '', content: '', category: CATEGORIES[0], attachments: [] },
    categories: CATEGORIES,
    error: null,
    isUserLoggedIn: req.cookies.auth === '1',
    isUserMaster: req.cookies.is_master === 'true'
  });
});

router.post('/admin/new', markNewArticleFlow, upload.array('attachments', 10), async (req, res, next) => {
  const { title, content, category } = req.body;
  console.log(`[ROUTE POST /admin/new] 請求 cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  if (!title || !category) {
    return res.render('admin/new_article', {
      pageTitle: '後台管理 - 新建分享',
      article: { title, content, category, attachments: [] },
      categories: CATEGORIES,
      error: '標題和分類是必填項。',
      isUserLoggedIn: req.cookies.auth === '1',
      isUserMaster: req.cookies.is_master === 'true'
    });
  }
  try {
    const articleIdToUse = req.tempGeneratedArticleId || uuidv4();
    const newArticleData = { id: articleIdToUse, title, content, category, attachments: [] };

    if (req.files && req.files.length > 0) {
        await ensureArticleUploadDir(articleIdToUse);
        for (const file of req.files) {
            let originalnameToStore = file.originalname;
            try {
                // 再次嘗試解碼以防萬一，但主要依賴 multer 的處理
                originalnameToStore = decodeURIComponent(file.originalname);
            } catch (e) {
                console.warn(`[Admin New Article] 解碼 originalname '${file.originalname}' 失敗，將使用原始值:`, e.message);
            }
            console.log(`[Admin New Article] 處理上傳檔案: originalname='${originalnameToStore}', filename on disk='${file.filename}', encoding='${file.encoding}'`);
            const relativePath = `/uploads/articles/${articleIdToUse}/${file.filename}`;
            newArticleData.attachments.push({
                originalname: originalnameToStore,
                filename: file.filename,
                path: relativePath,
                mimetype: file.mimetype,
                size: file.size
            });
        }
    }
    await saveArticle(newArticleData);
    console.log(`[Admin New Article] 文章 ${articleIdToUse} 創建成功，重定向到 /admin`);
    res.redirect(`/admin?success=分享已成功創建`);
  } catch (err) { console.error("[Admin] 創建新文章時出錯:", err); next(err); }
});

router.get('/admin/edit/:id', async (req, res, next) => {
  console.log(`[ROUTE GET /admin/edit/:id] 請求 cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  try {
    const article = await getArticleById(req.params.id);
    if (!article) { return res.status(404).redirect('/admin?error=未找到指定的分享內容'); }
    res.render('admin/edit_article', {
      pageTitle: `後台管理 - 編輯: ${article.title}`,
      article,
      categories: CATEGORIES,
      error: req.query.error,
      success: req.query.success,
      isUserLoggedIn: req.cookies.auth === '1',
      isUserMaster: req.cookies.is_master === 'true'
    });
  } catch (err) { console.error(`[Admin] 獲取文章 ${req.params.id} 進行編輯時出錯:`, err); next(err); }
});

router.post('/admin/edit/:id', markNewArticleFlow, upload.array('new_attachments', 5), async (req, res, next) => {
  const articleId = req.params.id;
  const { title, content, category } = req.body;
  console.log(`[ROUTE POST /admin/edit/:id] 請求 cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  if (!title || !category) {
    const article = await getArticleById(articleId) || { id: articleId, title, content, category, attachments: [] };
    return res.render('admin/edit_article', {
      pageTitle: `後台管理 - 編輯: ${article.title || '文章'}`,
      article: {...article, title, content, category},
      categories: CATEGORIES,
      error: '標題和分類是必填項。',
      isUserLoggedIn: req.cookies.auth === '1',
      isUserMaster: req.cookies.is_master === 'true'
    });
  }
  try {
    let article = await getArticleById(articleId);
    if (!article) { return res.status(404).redirect('/admin?error=未找到要更新的分享內容'); }
    article.title = title; article.content = content; article.category = category;
    if (req.files && req.files.length > 0) {
        await ensureArticleUploadDir(articleId);
        for (const file of req.files) {
            let originalnameToStore = file.originalname;
            try {
                originalnameToStore = decodeURIComponent(file.originalname);
            } catch (e) {
                 console.warn(`[Admin Edit Article] 解碼 originalname '${file.originalname}' 失敗，將使用原始值:`, e.message);
            }
            console.log(`[Admin Edit Article] 處理新上傳檔案: originalname='${originalnameToStore}', filename on disk='${file.filename}', encoding='${file.encoding}'`);
            const relativePath = `/uploads/articles/${articleId}/${file.filename}`;
            article.attachments.push({ originalname: originalnameToStore, filename: file.filename, path: relativePath, mimetype: file.mimetype, size: file.size });
        }
    }
    await saveArticle(article);
    console.log(`[Admin Edit Article] 文章 ${articleId} 更新成功，重定向到 /admin`);
    res.redirect(`/admin?success=分享內容已成功更新`);
  } catch (err) { console.error(`[Admin] 更新文章 ${articleId} 時出錯:`, err); next(err); }
});

router.post('/admin/delete/:id', async (req, res, next) => {
  const articleId = req.params.id;
  console.log(`[ROUTE /admin/delete/:id] 收到刪除文章請求 ID: ${articleId}. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  try {
    console.log(`[ROUTE /admin/delete/:id] 準備呼叫 deleteArticleById(${articleId})`);
    const success = await deleteArticleById(articleId);
    console.log(`[ROUTE /admin/delete/:id] deleteArticleById(${articleId}) 返回: ${success}`);
    if (success) {
      console.log(`[ROUTE /admin/delete/:id] 文章 ${articleId} 刪除成功。重定向到 /admin?success=deleted`);
      return res.redirect('/admin?success=分享內容及其附件已成功刪除');
    } else {
      console.warn(`[ROUTE /admin/delete/:id] 文章 ${articleId} 刪除失敗 (可能未找到或 articleStore 返回 false)。重定向到 /admin?error=delete_failed`);
      return res.redirect('/admin?error=未找到指定的分享內容或刪除失敗');
    }
  } catch (err) {
    console.error(`[ROUTE /admin/delete/:id] 刪除文章 ${articleId} 時發生嚴重錯誤:`, err.message, err.stack);
    // 確保將錯誤傳遞給下一個錯誤處理中介軟體
    return next(err);
  }
});

router.post('/admin/attachments/delete/:id/:filename', async (req, res, next) => {
    const { id: articleId, filename } = req.params;
    console.log(`[ROUTE /admin/attachments/delete] 請求刪除文章 ${articleId} 的附件 (磁碟檔名: ${filename}). Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
    try {
        console.log(`[ROUTE /admin/attachments/delete] 準備呼叫 removeAttachmentFromArticle(${articleId}, ${filename})`);
        const updatedArticle = await removeAttachmentFromArticle(articleId, filename);
        console.log(`[ROUTE /admin/attachments/delete] removeAttachmentFromArticle 返回:`, updatedArticle ? '成功 (返回更新後的文章)' : '失敗或文章/附件未找到');

        if (updatedArticle) {
             console.log(`[ROUTE /admin/attachments/delete] 附件 ${filename} 從文章 ${articleId} 刪除成功。重定向...`);
             res.redirect(`/admin/edit/${articleId}?success=附件已成功刪除`);
        } else {
             console.warn(`[ROUTE /admin/attachments/delete] removeAttachmentFromArticle 未能成功刪除附件 ${filename} (可能未找到)。`);
             res.redirect(`/admin/edit/${articleId}?error=刪除附件時發生錯誤或附件未找到`);
        }
    } catch (err) {
        console.error(`[Admin] 從文章 ${articleId} 刪除附件 ${filename} 時出錯:`, err.message, err.stack);
        return next(err);
    }
});

export default router;
