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

// --- Multer 配置 (保持不變) ---
async function ensureArticleUploadDir(articleId) {
  const dir = path.join(publicUploadsArticlesDir, articleId);
  try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
  return dir;
}

const articleStorage = multer.diskStorage({
  destination: async function (req, file, cb) {
    const articleId = req.params.id || req.body.articleIdForUpload || (req.isNewArticleFlow ? uuidv4() : 'temp_default_id');
    if (req.isNewArticleFlow && !req.body.articleIdForUpload) {
        req.tempGeneratedArticleId = articleId;
    }
    const uploadPath = await ensureArticleUploadDir(articleId);
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    cb(null, uuidv4() + '-' + file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, ''));
  }
});

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const upload = multer({
  storage: articleStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => { cb(null, true); }
});

function markNewArticleFlow(req, res, next) {
    if (req.path === '/admin/new' && req.method === 'POST') {
        req.isNewArticleFlow = true;
    }
    next();
}

// =========== PUBLIC ROUTES (保持不變) ===========
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
      pageTitle: '網路分享站'
    });
  } catch (err) { console.error("[Public] 獲取主頁文章時出錯:", err); next(err); }
});

router.get('/articles/:id', async (req, res, next) => {
  try {
    const article = await getArticleById(req.params.id);
    if (!article) { return res.status(404).render('public/404', { pageTitle: '未找到分享'}); }
    res.render('public/show_article', { article, pageTitle: article.title });
  } catch (err) { console.error(`[Public] 獲取文章 ${req.params.id} 時出錯:`, err); next(err); }
});

router.get('/articles/download/:id/:filename', async (req, res, next) => {
    try {
        const articleId = req.params.id;
        const filename = req.params.filename;
        const article = await getArticleById(articleId);
        if (!article) { return res.status(404).send('找不到文章。'); }
        const attachment = article.attachments.find(att => att.filename === filename);
        if (!attachment) { return res.status(404).send('找不到附件。'); }
        const filePath = path.join(publicUploadsArticlesDir, articleId, filename);
        await fs.access(filePath);
        res.download(filePath, attachment.originalname, (err) => {
            if (err) {
                console.error(`[Download] 下載文件 ${filePath} 時出錯:`, err);
                if (!res.headersSent) {
                    if (err.code === 'ENOENT') { return res.status(404).send('文件不存在於服務器。'); }
                    return res.status(500).send('下載文件時發生錯誤。');
                }
            }
        });
    } catch (err) {
        console.error('[Download] 下載路由常規錯誤:', err);
        if (err.code === 'ENOENT') { return res.status(404).send('請求的文件不存在。'); }
        next(err);
    }
});

// =========== ADMIN ROUTES ===========
// (注意：start.cjs 中的全局中介軟體已保護 /admin 路徑的訪問權限)

// GET /admin (文章管理列表 - 主應用處理)
// **修改：傳遞 isUserLoggedIn 和 isUserMaster 給模板**
router.get('/admin', async (req, res, next) => {
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

// GET /admin/new (顯示新建文章表單 - 主應用處理)
// **修改：傳遞 isUserLoggedIn 和 isUserMaster 給模板**
router.get('/admin/new', (req, res) => {
  res.render('admin/new_article', {
    pageTitle: '後台管理 - 新建分享',
    article: { title: '', content: '', category: CATEGORIES[0], attachments: [] },
    categories: CATEGORIES,
    error: null,
    isUserLoggedIn: req.cookies.auth === '1',
    isUserMaster: req.cookies.is_master === 'true'
  });
});

// POST /admin/new (創建新文章 - 主應用處理)
router.post('/admin/new', markNewArticleFlow, upload.array('attachments', 10), async (req, res, next) => {
  const { title, content, category } = req.body;
  if (!title || !category) {
    return res.render('admin/new_article', {
      pageTitle: '後台管理 - 新建分享',
      article: { title, content, category, attachments: [] },
      categories: CATEGORIES,
      error: '標題和分類是必填項。',
      isUserLoggedIn: req.cookies.auth === '1', // **新增**
      isUserMaster: req.cookies.is_master === 'true' // **新增**
    });
  }
  try {
    const articleIdToUse = req.tempGeneratedArticleId || uuidv4();
    const newArticleData = { id: articleIdToUse, title, content, category, attachments: [] };

    if (req.files && req.files.length > 0) {
        await ensureArticleUploadDir(articleIdToUse);
        for (const file of req.files) {
            const relativePath = `/uploads/articles/${articleIdToUse}/${file.filename}`;
            newArticleData.attachments.push({
                originalname: file.originalname, filename: file.filename,
                path: relativePath, mimetype: file.mimetype, size: file.size
            });
        }
    }
    await saveArticle(newArticleData);
    res.redirect(`/admin?success=分享已成功創建`); // **修改：重定向到 /admin 而不是 /admin/articles**
  } catch (err) { console.error("[Admin] 創建新文章時出錯:", err); next(err); }
});

// GET /admin/edit/:id (顯示編輯文章表單 - 主應用處理)
// **修改：傳遞 isUserLoggedIn 和 isUserMaster 給模板**
router.get('/admin/edit/:id', async (req, res, next) => {
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

// POST /admin/edit/:id (更新文章 - 主應用處理)
router.post('/admin/edit/:id', upload.array('new_attachments', 5), async (req, res, next) => {
  const articleId = req.params.id;
  const { title, content, category } = req.body;
  if (!title || !category) {
    const article = await getArticleById(articleId) || { id: articleId, title, content, category, attachments: [] };
    return res.render('admin/edit_article', {
      pageTitle: `後台管理 - 編輯: ${article.title || '文章'}`,
      article: {...article, title, content, category},
      categories: CATEGORIES,
      error: '標題和分類是必填項。',
      isUserLoggedIn: req.cookies.auth === '1', // **新增**
      isUserMaster: req.cookies.is_master === 'true' // **新增**
    });
  }
  try {
    let article = await getArticleById(articleId);
    if (!article) { return res.status(404).redirect('/admin?error=未找到要更新的分享內容'); }
    article.title = title; article.content = content; article.category = category;
    if (req.files && req.files.length > 0) {
        await ensureArticleUploadDir(articleId);
        for (const file of req.files) {
            const relativePath = `/uploads/articles/${articleId}/${file.filename}`;
            article.attachments.push({ originalname: file.originalname, filename: file.filename, path: relativePath, mimetype: file.mimetype, size: file.size });
        }
    }
    await saveArticle(article);
    res.redirect(`/admin?success=分享內容已成功更新`); // **修改：重定向到 /admin**
  } catch (err) { console.error(`[Admin] 更新文章 ${articleId} 時出錯:`, err); next(err); }
});

// POST /admin/delete/:id (刪除文章 - 主應用處理)
router.post('/admin/delete/:id', async (req, res, next) => {
  try {
    const success = await deleteArticleById(req.params.id);
    if (!success) { return res.redirect('/admin?error=未找到指定的分享內容或刪除失敗'); }
    res.redirect('/admin?success=分享內容及其附件已成功刪除'); // **修改：重定向到 /admin**
  } catch (err) { console.error(`[Admin] 刪除文章 ${req.params.id} 時出錯:`, err); next(err); }
});

// POST /admin/attachments/delete/:id/:filename (刪除附件 - 主應用處理)
router.post('/admin/attachments/delete/:id/:filename', async (req, res, next) => {
    const { id: articleId, filename } = req.params;
    try {
        await removeAttachmentFromArticle(articleId, filename);
        res.redirect(`/admin/edit/${articleId}?success=附件 ${decodeURIComponent(filename)} 已成功刪除`);
    } catch (err) {
        console.error(`[Admin] 從文章 ${articleId} 刪除附件 ${filename} 時出錯:`, err);
        res.redirect(`/admin/edit/${articleId}?error=附件刪除失敗: ${err.message}`);
    }
});

export default router;
