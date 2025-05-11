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

console.log('[routes/articles.js] 模組已載入');

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
    // file.originalname 由 multer 從請求中解析，期望是 UTF-8
    // 瀏覽器通常會以 UTF-8 發送 multipart/form-data 中的檔名
    // Node.js 和 Express 通常也能正確處理 UTF-8 的請求頭
    // 如果這裡的 file.originalname 仍然是亂碼，問題可能更深層次
    console.log(`[Multer Filename CB] 接收到的原始檔名 (file.originalname): '${file.originalname}' (Buffer: ${Buffer.from(file.originalname).toString('hex')})`);

    // 嘗試解碼以防萬一，但如果 multer 本身收到的就是錯誤編碼，這裡解碼可能也無效或出錯
    let originalnameDecoded = file.originalname;
    try {
        // 假設瀏覽器可能錯誤地用 latin1 編碼了 UTF-8 字元，然後伺服器又按 UTF-8 解讀了 latin1...
        // 這是一個非常複雜的猜測，通常不應該這樣做。
        // const maybeLatin1Buffer = Buffer.from(file.originalname, 'latin1');
        // originalnameDecoded = maybeLatin1Buffer.toString('utf8');
        // console.log(`[Multer Filename CB] 嘗試 latin1 -> utf8 解碼後: '${originalnameDecoded}'`);
        // 如果原始檔名已經是正確的 UTF-8，則 decodeURIComponent 可能不需要或導致錯誤
        // originalnameDecoded = decodeURIComponent(file.originalname);
    } catch (e) {
        console.warn(`[Multer Filename CB] 解碼 originalname '${file.originalname}' 失敗:`, e.message);
        // 如果解碼失敗，仍然使用原始的 file.originalname
    }

    const extension = path.extname(originalnameDecoded); // 使用（可能解碼後的）名稱獲取副檔名
    const diskFilename = uuidv4() + extension; // 儲存到磁碟的檔名使用 UUID
    console.log(`[Multer Filename CB] 生成的磁碟檔名: '${diskFilename}' (基於 originalname: '${originalnameDecoded}')`);
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
  console.log('[ROUTE GET /] 處理首頁請求');
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
  console.log(`[ROUTE GET /articles/:id] 處理文章詳情請求, ID: ${req.params.id}`);
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
    console.log(`[ROUTE GET /articles/download/:id/:filename] 請求下載附件`);
    try {
        const articleId = req.params.id;
        const filename = req.params.filename; // 這是儲存在磁碟上的安全檔名 (UUID.ext)
        const article = await getArticleById(articleId);
        if (!article) { return res.status(404).send('找不到文章。'); }
        const attachment = article.attachments.find(att => att.filename === filename);
        if (!attachment) { return res.status(404).send('找不到附件記錄。'); }

        const filePath = path.join(publicUploadsArticlesDir, articleId, filename);
        console.log(`[Download] 準備下載檔案: ${filePath}, 原始名稱 (用於下載提示): '${attachment.originalname}'`);

        const originalnameForHeader = String(attachment.originalname || 'download');
        const encodedOriginalname = encodeURIComponent(originalnameForHeader);
        // RFC 5987 方式處理非 ASCII 字元
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedOriginalname}`);

        await fs.access(filePath); // 確保文件存在
        res.download(filePath, attachment.originalname, (err) => { // 傳遞原始名稱給 download，但 header 已設定
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
  console.log(`[ROUTE GET /admin] 處理後台文章列表請求. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
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
  console.log(`[ROUTE GET /admin/new] 處理新建文章頁面請求. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
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
  console.log(`[ROUTE POST /admin/new] 處理創建新文章請求. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  const { title, content, category } = req.body;
  if (!title || !category) {
    console.log('[ROUTE POST /admin/new] 標題或分類缺失，重新渲染表單');
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
            // **重要：這裡直接使用 multer 提供的 file.originalname**
            // **如果這裡的 originalname 已經是亂碼，則問題在 multer 接收或瀏覽器發送階段**
            console.log(`[Admin New Article] 處理上傳檔案: originalname from multer='${file.originalname}', filename on disk='${file.filename}', encoding='${file.encoding}'`);
            const relativePath = `/uploads/articles/${articleIdToUse}/${file.filename}`; // 使用 multer 保存的檔名
            newArticleData.attachments.push({
                originalname: originalnameToStore, // 儲存 multer 提供的原始檔名
                filename: file.filename,         // 儲存磁碟上的安全檔名 (由 multer 的 filename 回呼生成)
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
  console.log(`[ROUTE GET /admin/edit/:id] 處理編輯文章頁面請求, ID: ${req.params.id}. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
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
  console.log(`[ROUTE POST /admin/edit/:id] 處理更新文章請求, ID: ${articleId}. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
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
            console.log(`[Admin Edit Article] 處理新上傳檔案: originalname from multer='${file.originalname}', filename on disk='${file.filename}', encoding='${file.encoding}'`);
            const relativePath = `/uploads/articles/${articleId}/${file.filename}`;
            article.attachments.push({ originalname: originalnameToStore, filename: file.filename, path: relativePath, mimetype: file.mimetype, size: file.size });
        }
    }
    await saveArticle(article);
    console.log(`[Admin Edit Article] 文章 ${articleId} 更新成功，重定向到 /admin`);
    res.redirect(`/admin?success=分享內容已成功更新`);
  } catch (err) { console.error(`[Admin] 更新文章 ${articleId} 時出錯:`, err); next(err); }
});

// **修改：增強刪除文章路由的日誌和錯誤處理**
router.post('/admin/delete/:id', async (req, res, next) => {
  const articleId = req.params.id;
  console.log(`[ROUTE POST /admin/delete/:id] 收到刪除文章請求 ID: ${articleId}. Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
  try {
    console.log(`[ROUTE POST /admin/delete/:id] 準備呼叫 deleteArticleById(${articleId})`);
    const success = await deleteArticleById(articleId);
    console.log(`[ROUTE POST /admin/delete/:id] deleteArticleById(${articleId}) 返回: ${success}`);
    if (success) {
      console.log(`[ROUTE POST /admin/delete/:id] 文章 ${articleId} 刪除成功。重定向到 /admin?success=deleted`);
      return res.redirect('/admin?success=分享內容及其附件已成功刪除');
    } else {
      console.warn(`[ROUTE POST /admin/delete/:id] 文章 ${articleId} 刪除失敗 (可能未找到或 articleStore 返回 false)。重定向到 /admin?error=delete_failed`);
      return res.redirect('/admin?error=未找到指定的分享內容或刪除失敗');
    }
  } catch (err) {
    console.error(`[ROUTE POST /admin/delete/:id] 刪除文章 ${articleId} 時發生嚴重錯誤:`, err.message, err.stack);
    return next(err); // 將錯誤傳遞給全局錯誤處理器
  }
});

// **修改：增強刪除附件路由的日誌和錯誤處理**
router.post('/admin/attachments/delete/:id/:filename', async (req, res, next) => {
    const { id: articleId, filename } = req.params;
    console.log(`[ROUTE POST /admin/attachments/delete] 請求刪除文章 ${articleId} 的附件 (磁碟檔名: ${filename}). Cookies: auth=${req.cookies.auth}, is_master=${req.cookies.is_master}`);
    try {
        console.log(`[ROUTE POST /admin/attachments/delete] 準備呼叫 removeAttachmentFromArticle(${articleId}, ${filename})`);
        const updatedArticle = await removeAttachmentFromArticle(articleId, filename); // 等待異步操作完成
        console.log(`[ROUTE POST /admin/attachments/delete] removeAttachmentFromArticle 返回:`, updatedArticle ? '成功 (返回更新後的文章)' : '失敗或文章/附件未找到');

        if (updatedArticle) { // 假設成功時返回更新後的文章物件
             console.log(`[ROUTE POST /admin/attachments/delete] 附件 ${filename} 從文章 ${articleId} 刪除成功。重定向...`);
             res.redirect(`/admin/edit/${articleId}?success=附件已成功刪除`);
        } else {
             // 如果 removeAttachmentFromArticle 在找不到文章或附件時返回 null/undefined 而不拋錯
             console.warn(`[ROUTE POST /admin/attachments/delete] removeAttachmentFromArticle 未能成功刪除附件 ${filename} (可能未找到)。`);
             res.redirect(`/admin/edit/${articleId}?error=刪除附件時發生錯誤或附件未找到`);
        }
    } catch (err) {
        console.error(`[Admin] 從文章 ${articleId} 刪除附件 ${filename} 時出錯:`, err.message, err.stack);
        return next(err); // 將錯誤傳遞給全局錯誤處理器
    }
});

export default router;
