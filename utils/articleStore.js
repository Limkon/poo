// utils/articleStore.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRootDir = path.resolve(__dirname, '..');
const articlesDir = path.join(projectRootDir, 'data', 'articles');
export const publicUploadsArticlesDir = path.join(projectRootDir, 'public', 'uploads', 'articles');

export const CATEGORIES = ["軟體", "咨讯", "杂记", "分享资料", "网络资源", "其他"];

async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.mkdir(dirPath, { recursive: true });
      console.log(`[ArticleStore] 已建立目錄: ${dirPath}`);
    } else {
      console.error(`[ArticleStore] 存取目錄 ${dirPath} 時出錯:`, error);
      throw error;
    }
  }
}

// Initialize directories on module load
(async () => {
    try {
        await ensureDir(articlesDir);
        await ensureDir(publicUploadsArticlesDir);
    } catch (error) {
        console.error("[ArticleStore] 啟動時初始化目錄失敗:", error);
    }
})();


export async function getAllArticles() {
  try {
    await ensureDir(articlesDir);
    const files = await fs.readdir(articlesDir);
    const articles = [];
    for (const file of files) {
      if (path.extname(file) === '.json') {
        const filePath = path.join(articlesDir, file);
        const data = await fs.readFile(filePath, 'utf-8');
        articles.push(JSON.parse(data));
      }
    }
    articles.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return articles;
  } catch (error) { console.error('[ArticleStore] 讀取所有文章時出錯:', error); throw error; }
}

export async function getArticleById(id) {
  const filePath = path.join(articlesDir, `${id}.json`);
  try {
    await ensureDir(articlesDir);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') { return null; }
    console.error(`[ArticleStore] 讀取文章 ${id} 時出錯:`, error); throw error;
  }
}

export async function saveArticle(articleData) {
  await ensureDir(articlesDir);
  const id = articleData.id || uuidv4();
  const isNewArticle = !articleData.id;
  let existingArticle = null;

  if (!isNewArticle) {
    existingArticle = await getArticleById(id);
  }

  const nowISO = new Date().toISOString();
  const article = {
    id: id,
    title: articleData.title,
    content: articleData.content || '',
    category: articleData.category || CATEGORIES[CATEGORIES.length - 1],
    attachments: articleData.attachments || [],
    createdAt: isNewArticle
                  ? nowISO
                  : (articleData.createdAt || (existingArticle ? existingArticle.createdAt : nowISO)),
    updatedAt: nowISO
  };

  try {
    if (article.createdAt) {
        new Date(article.createdAt).toISOString(); // Validate format
    } else {
        console.warn(`[ArticleStore saveArticle] 文章 ${id} 缺少 createdAt，將其設定為 updatedAt。`);
        article.createdAt = article.updatedAt;
    }
  } catch (e) {
    console.warn(`[ArticleStore saveArticle] 文章 ${id} 的 createdAt 格式 ('${article.createdAt}') 無效，將其重設為 updatedAt。`);
    article.createdAt = article.updatedAt;
  }

  const filePath = path.join(articlesDir, `${id}.json`);
  try {
    await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`[ArticleStore saveArticle] 文章已 ${isNewArticle ? '保存' : '更新'}: ${id}`);
    return article;
  } catch (writeError) {
    console.error(`[ArticleStore saveArticle] 寫入文章 JSON 檔案 ${filePath} 時發生錯誤:`, writeError);
    throw writeError;
  }
}

export async function deleteArticleById(id) {
  console.log(`[ArticleStore deleteArticleById] 收到刪除文章請求，ID: ${id}`);
  if (!id || typeof id !== 'string' || id.trim() === '') {
    const errMsg = `[ArticleStore deleteArticleById] 無效的文章 ID: ${id}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }
  await ensureDir(articlesDir);
  const articleJsonFilePath = path.join(articlesDir, `${id}.json`);
  const articleUploadsDirForId = path.join(publicUploadsArticlesDir, id);

  console.log(`[ArticleStore deleteArticleById] 準備刪除 JSON 檔案: ${articleJsonFilePath}`);
  try {
    await fs.unlink(articleJsonFilePath);
    console.log(`[ArticleStore deleteArticleById] 成功刪除 JSON 檔案: ${articleJsonFilePath}`);
  } catch (jsonError) {
    if (jsonError.code === 'ENOENT') {
      console.warn(`[ArticleStore deleteArticleById] 未找到要刪除的文章 JSON 檔案: ${id}。可能已被刪除或 ID 錯誤。`);
      return false;
    }
    console.error(`[ArticleStore deleteArticleById] 刪除文章 JSON 檔案 ${id} 時發生錯誤:`, jsonError);
    throw jsonError;
  }

  console.log(`[ArticleStore deleteArticleById] 準備刪除附件目錄: ${articleUploadsDirForId}`);
  try {
    await fs.access(articleUploadsDirForId);
    console.log(`[ArticleStore deleteArticleById] 附件目錄存在，嘗試刪除...`);
    await fs.rm(articleUploadsDirForId, { recursive: true, force: true });
    console.log(`[ArticleStore deleteArticleById] 成功刪除附件目錄: ${articleUploadsDirForId}`);
  } catch (dirError) {
    if (dirError.code === 'ENOENT') {
      console.log(`[ArticleStore deleteArticleById] 文章 ${id} 沒有附件目錄，跳過刪除。`);
    } else {
      console.error(`[ArticleStore deleteArticleById] 刪除附件目錄 ${articleUploadsDirForId} 時出錯 (非致命，JSON已刪除):`, dirError);
    }
  }
  console.log(`[ArticleStore deleteArticleById] 文章 ${id} 刪除流程完成。`);
  return true;
}


export async function addAttachmentToArticle(articleId, attachmentData) {
    console.log(`[ArticleStore addAttachmentToArticle] 開始向文章 ${articleId} 添加附件: ${attachmentData.originalname}`);
    const article = await getArticleById(articleId);
    if (!article) {
        console.error(`[ArticleStore addAttachmentToArticle] 未找到文章 ID: ${articleId}`);
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`);
    }
    article.attachments.push(attachmentData);
    article.updatedAt = new Date().toISOString();
    const filePath = path.join(articlesDir, `${articleId}.json`);
    try {
        await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8');
        console.log(`[ArticleStore addAttachmentToArticle] 已向文章 ${articleId} 成功添加附件記錄並保存 JSON。`);
        return article;
    } catch (error) {
        console.error(`[ArticleStore addAttachmentToArticle] 保存更新後的文章 ${articleId} JSON 時出錯:`, error);
        throw error;
    }
}

export async function removeAttachmentFromArticle(articleId, filenameToDelete) {
    console.log(`[ArticleStore removeAttachmentFromArticle] 開始從文章 ${articleId} 移除附件 (磁碟檔名: ${filenameToDelete})`);
    let article;
    try {
        article = await getArticleById(articleId);
    } catch (error) {
        console.error(`[ArticleStore removeAttachmentFromArticle] 獲取文章 ${articleId} 失敗:`, error);
        throw error;
    }

    if (!article) {
        const errMsg = `[ArticleStore removeAttachmentFromArticle] 未找到文章 ID: ${articleId}`;
        console.warn(errMsg);
        throw new Error(errMsg);
    }

    const attachmentIndex = article.attachments.findIndex(att => att.filename === filenameToDelete);
    if (attachmentIndex === -1) {
        console.warn(`[ArticleStore removeAttachmentFromArticle] 在文章 ${articleId} 記錄中未找到磁碟檔名為 ${filenameToDelete} 的附件。`);
        return article;
    }

    const attachmentToRemove = article.attachments[attachmentIndex];
    const physicalFilePath = path.join(publicUploadsArticlesDir, articleId, attachmentToRemove.filename);

    article.attachments.splice(attachmentIndex, 1);
    article.updatedAt = new Date().toISOString();
    const articleJsonFilePath = path.join(articlesDir, `${articleId}.json`);

    try {
        await fs.writeFile(articleJsonFilePath, JSON.stringify(article, null, 2), 'utf-8');
        console.log(`[ArticleStore removeAttachmentFromArticle] 已從文章 ${articleId} 移除附件記錄並更新 JSON。`);
    } catch (saveError) {
        console.error(`[ArticleStore removeAttachmentFromArticle] 保存更新後的文章 ${articleId} JSON 時出錯:`, saveError);
        throw saveError;
    }

    try {
        console.log(`[ArticleStore removeAttachmentFromArticle] 嘗試刪除物理附件檔案: ${physicalFilePath}`);
        await fs.access(physicalFilePath);
        await fs.unlink(physicalFilePath);
        console.log(`[ArticleStore removeAttachmentFromArticle] 已刪除物理附件檔案: ${physicalFilePath}`);
    } catch (fileError) {
        if (fileError.code === 'ENOENT') {
            console.warn(`[ArticleStore removeAttachmentFromArticle] 嘗試刪除物理附件檔案 ${physicalFilePath} 時未找到該檔案。`);
        } else {
            console.error(`[ArticleStore removeAttachmentFromArticle] 刪除物理附件檔案 ${physicalFilePath} 時出錯:`, fileError);
        }
    }
    console.log(`[ArticleStore removeAttachmentFromArticle] 附件 ${filenameToDelete} 從文章 ${articleId} 移除流程完成。`);
    return article;
}
