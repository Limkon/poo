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
        articleIdToUse = 'temp_unknown_article'; // 應避免這種情況
    }
    const uploadPath = await ensureArticleUploadDir(articleIdToUse);
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // 原始檔名 (file.originalname) 由 multer 從請求中解析，期望是 UTF-8
    console.log(`[Multer Filename CB] 接收到的原始檔名 (file.originalname): '${file.originalname}'`);
    const extension = path.extname(file.originalname);
    // 儲存到磁碟的檔名使用 UUID 以確保唯一性和檔案系統安全
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
    console.log(`[Multer FileFilter] 檔案: ${file.originalname}, mimetype: ${file.mimetype}`);
    cb(null, true);
  }
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
        await fs.access(filePath);
        res.download(filePath, attachment.originalname, (err) => { // 使用 attachment.originalname 進行下載
            if (err) {
                console.error(`[Download] 下載文件 ${filePath} (原始名: ${attachment.originalname}) 時出錯:`, err);
                if (!res.headersSent) {
                    if (err.code === 'ENOENT') { return res.status(404).send('文件不存在於服務器。'); }
                    return res.status(500).send('下載文件時發生錯誤。');
                }
            } else {
                console.log(`[Download] 文件 ${attachment.originalname} 已開始下載。`);
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
    // TODO: 清理已上傳但未關聯的檔案
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
            console.log(`[Admin New Article] 處理上傳檔案: originalname='${file.originalname}', filename on disk='${file.filename}'`);
            const relativePath = `/uploads/articles/${articleIdToUse}/${file.filename}`;
            newArticleData.attachments.push({
                originalname: file.originalname,
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
            console.log(`[Admin Edit Article] 處理新上傳檔案: originalname='${file.originalname}', filename on disk='${file.filename}'`);
            const relativePath = `/uploads/articles/${articleId}/${file.filename}`;
            article.attachments.push({ originalname: file.originalname, filename: file.filename, path: relativePath, mimetype: file.mimetype, size: file.size });
        }
    }
    await saveArticle(article);
    console.log(`[Admin Edit Article] 文章 ${articleId} 更新成功，重定向到 /admin`);
    res.redirect(`/admin?success=分享內容已成功更新`);
  } catch (err) { console.error(`[Admin] 更新文章 ${articleId} 時出錯:`, err); next(err); }
});

router.post('/admin/delete/:id', async (req, res, next) => {
  const articleId = req.params.id;
  console.log(`[ROUTE /admin/delete/:id] 收到刪除文章請求: ${articleId}`);
  try {
    const success = await deleteArticleById(articleId);
    console.log(`[ROUTE /admin/delete/:id] deleteArticleById 為 ${articleId} 返回: ${success}`);
    if (success) {
      console.log(`[ROUTE /admin/delete/:id] 文章 ${articleId} 刪除成功。重定向到 /admin?success=deleted`);
      return res.redirect('/admin?success=分享內容及其附件已成功刪除');
    } else {
      console.log(`[ROUTE /admin/delete/:id] 文章 ${articleId} 刪除失敗 (JSON 未找到)。重定向到 /admin?error=not_found_or_delete_failed`);
      return res.redirect('/admin?error=未找到指定的分享內容或刪除失敗');
    }
  } catch (err) {
    console.error(`[ROUTE /admin/delete/:id] 刪除文章 ${articleId} 時發生嚴重錯誤:`, err);
    return next(err);
  }
});

router.post('/admin/attachments/delete/:id/:filename', async (req, res, next) => {
    const { id: articleId, filename } = req.params;
    console.log(`[ROUTE /admin/attachments/delete] 請求刪除文章 ${articleId} 的附件 (磁碟檔名: ${filename})`);
    try {
        const updatedArticle = await removeAttachmentFromArticle(articleId, filename);
        if (updatedArticle) {
             console.log(`[ROUTE /admin/attachments/delete] 附件 ${filename} 從文章 ${articleId} 刪除成功。`);
             res.redirect(`/admin/edit/${articleId}?success=附件已成功刪除`);
        } else {
            // 這種情況不應該發生，除非 removeAttachmentFromArticle 邏輯改變
             console.warn(`[ROUTE /admin/attachments/delete] removeAttachmentFromArticle 返回了意外的值。`);
             res.redirect(`/admin/edit/${articleId}?error=刪除附件時發生未知錯誤`);
        }
    } catch (err) {
        console.error(`[Admin] 從文章 ${articleId} 刪除附件 ${filename} 時出錯:`, err);
        // 將錯誤傳遞給全局錯誤處理器，而不是直接重定向，以便更好地追蹤問題
        // res.redirect(`/admin/edit/${articleId}?error=附件刪除失敗: ${err.message}`);
        return next(err);
    }
});

export default router;
