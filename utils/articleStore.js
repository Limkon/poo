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

ensureDir(articlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保文章資料目錄:", err));
ensureDir(publicUploadsArticlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保公共上傳文章目錄:", err));

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
        new Date(article.createdAt).toISOString();
    } else {
        console.warn(`[ArticleStore] 文章 ${id} 在保存期間缺少或 createdAt 無效。將其設定為 updatedAt。`);
        article.createdAt = article.updatedAt;
    }
  } catch (e) {
    console.warn(`[ArticleStore] 文章 ${id} 在保存期間的 createdAt 格式 ('${article.createdAt}') 無效。將其重設為 updatedAt。`);
    article.createdAt = article.updatedAt;
  }

  const filePath = path.join(articlesDir, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8');
  console.log(`[ArticleStore] 文章已 ${isNewArticle ? '保存' : '更新'}: ${id}`);
  return article;
}

export async function deleteArticleById(id) {
  console.log(`[ArticleStore deleteArticleById] 收到刪除文章請求，ID: ${id}`);
  if (!id || typeof id !== 'string' || id.trim() === '') {
    console.error('[ArticleStore deleteArticleById] 無效的文章 ID:', id);
    throw new Error('無效的文章 ID');
  }
  await ensureDir(articlesDir);
  const articleJsonFilePath = path.join(articlesDir, `${id}.json`);
  const articleUploadsDirForId = path.join(publicUploadsArticlesDir, id);

  let jsonDeleted = false;
  try {
    console.log(`[ArticleStore deleteArticleById] 正在檢查 JSON 檔案是否存在: ${articleJsonFilePath}`);
    await fs.access(articleJsonFilePath); // 檢查檔案是否存在
    console.log(`[ArticleStore deleteArticleById] JSON 檔案存在，嘗試刪除...`);
    await fs.unlink(articleJsonFilePath);
    jsonDeleted = true;
    console.log(`[ArticleStore deleteArticleById] 成功刪除 JSON 檔案: ${articleJsonFilePath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`[ArticleStore deleteArticleById] 未找到要刪除的文章 JSON 檔案: ${id}。可能已被刪除或 ID 錯誤。`);
      return false; // 文章 JSON 檔案未找到，返回 false
    }
    console.error(`[ArticleStore deleteArticleById] 刪除文章 JSON 檔案 ${id} 時發生錯誤:`, error);
    throw error; // 對於其他錯誤，向上拋出
  }

  // 僅當 JSON 檔案成功刪除後才嘗試刪除附件目錄
  if (jsonDeleted) {
    try {
      await fs.access(articleUploadsDirForId); // 檢查附件目錄是否存在
      console.log(`[ArticleStore deleteArticleById] 附件目錄存在，嘗試刪除: ${articleUploadsDirForId}`);
      await fs.rm(articleUploadsDirForId, { recursive: true, force: true });
      console.log(`[ArticleStore deleteArticleById] 成功刪除附件目錄: ${articleUploadsDirForId}`);
    } catch (dirError) {
      if (dirError.code === 'ENOENT') {
        console.log(`[ArticleStore deleteArticleById] 文章 ${id} 沒有附件目錄，跳過刪除。`);
      } else {
        console.error(`[ArticleStore deleteArticleById] 刪除附件目錄 ${articleUploadsDirForId} 時出錯 (非致命):`, dirError);
        // 即使附件目錄刪除失敗，JSON 已刪除，我們仍然可以認為主要刪除操作部分成功
      }
    }
  }
  console.log(`[ArticleStore deleteArticleById] 文章 ${id} 刪除流程完成。JSON 刪除狀態: ${jsonDeleted}`);
  return jsonDeleted; // 返回 JSON 檔案是否成功刪除的狀態
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
        console.warn(`[ArticleStore removeAttachmentFromArticle] 未找到文章 ID: ${articleId}`);
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`);
    }

    const attachmentIndex = article.attachments.findIndex(att => att.filename === filenameToDelete);
    if (attachmentIndex === -1) {
        console.warn(`[ArticleStore removeAttachmentFromArticle] 在文章 ${articleId} 記錄中未找到磁碟檔名為 ${filenameToDelete} 的附件。`);
        // 即使附件記錄不存在，也可能需要嘗試刪除物理文件（如果有的話），或者直接返回
        // 為了安全，如果記錄不存在，我們假設物理文件也不應該存在或不應被刪除
        return article; // 或者可以拋出錯誤表示附件未找到
    }

    const attachmentToRemove = article.attachments[attachmentIndex];
    const physicalFilePath = path.join(publicUploadsArticlesDir, articleId, attachmentToRemove.filename);

    article.attachments.splice(attachmentIndex, 1);
    article.updatedAt = new Date().toISOString();
    const articleJsonFilePath = path.join(articlesDir, `${articleId}.json`);

    try {
        await fs.writeFile(articleJsonFilePath, JSON.stringify(article, null, 2), 'utf-8');
        console.log(`[ArticleStore removeAttachmentFromArticle] 已從文章 ${articleId} 移除附件記錄 (磁碟檔名: ${filenameToDelete}, 原始檔名: ${attachmentToRemove.originalname})`);
    } catch (saveError) {
        console.error(`[ArticleStore removeAttachmentFromArticle] 保存更新後的文章 ${articleId} JSON 時出錯:`, saveError);
        throw saveError; // 拋出錯誤，讓上層處理
    }

    try {
        console.log(`[ArticleStore removeAttachmentFromArticle] 嘗試刪除物理附件檔案: ${physicalFilePath}`);
        await fs.access(physicalFilePath); // 檢查檔案是否存在
        await fs.unlink(physicalFilePath);
        console.log(`[ArticleStore removeAttachmentFromArticle] 已刪除物理附件檔案: ${physicalFilePath}`);
    } catch (fileError) {
        if (fileError.code === 'ENOENT') {
            console.warn(`[ArticleStore removeAttachmentFromArticle] 嘗試刪除物理附件檔案 ${physicalFilePath} 時未找到該檔案。`);
        } else {
            console.error(`[ArticleStore removeAttachmentFromArticle] 刪除物理附件檔案 ${physicalFilePath} 時出錯:`, fileError);
        }
        // 即使刪除物理檔案失敗，記錄也已更新。可以考慮是否需要更複雜的回滾邏輯。
    }
    console.log(`[ArticleStore removeAttachmentFromArticle] 附件 ${filenameToDelete} 從文章 ${articleId} 移除流程完成。`);
    return article;
}
