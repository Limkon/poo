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
  console.log(`[ArticleStore deleteArticleById] 開始刪除文章 ID: ${id}`);
  await ensureDir(articlesDir); // 確保文章 JSON 目錄存在
  const articleJsonFilePath = path.join(articlesDir, `${id}.json`);
  const articleUploadsDirForId = path.join(publicUploadsArticlesDir, id); // 特定文章的附件目錄

  let jsonDeleted = false;
  try {
    // 步驟 1: 嘗試刪除文章的 JSON 資料檔案
    await fs.unlink(articleJsonFilePath);
    jsonDeleted = true;
    console.log(`[ArticleStore deleteArticleById] 成功刪除 JSON 檔案: ${articleJsonFilePath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`[ArticleStore deleteArticleById] 未找到要刪除的文章 JSON 檔案: ${id}。可能已被刪除或 ID 錯誤。`);
      return false; // 文章 JSON 檔案未找到，視為刪除失敗（或目標不存在）
    }
    // 對於其他導致 JSON 檔案無法刪除的嚴重錯誤，則拋出
    console.error(`[ArticleStore deleteArticleById] 刪除文章 JSON 檔案 ${id} 時發生錯誤:`, error);
    throw error; // 向上拋出錯誤，讓路由處理器捕獲
  }

  // 步驟 2: 如果 JSON 檔案成功刪除，則嘗試刪除關聯的附件目錄及其內容
  if (jsonDeleted) {
    try {
      await fs.access(articleUploadsDirForId); // 檢查附件目錄是否存在
      console.log(`[ArticleStore deleteArticleById] 附件目錄存在，嘗試刪除: ${articleUploadsDirForId}`);
      await fs.rm(articleUploadsDirForId, { recursive: true, force: true }); // 遞迴強制刪除
      console.log(`[ArticleStore deleteArticleById] 成功刪除附件目錄: ${articleUploadsDirForId}`);
    } catch (dirError) {
      if (dirError.code === 'ENOENT') {
        console.log(`[ArticleStore deleteArticleById] 文章 ${id} 沒有附件目錄，跳過刪除。`);
      } else {
        // 對於其他刪除附件目錄的錯誤，我們記錄它，但主要操作（刪除JSON）已完成
        console.error(`[ArticleStore deleteArticleById] 刪除附件目錄 ${articleUploadsDirForId} 時出錯 (非致命):`, dirError);
      }
    }
  }
  console.log(`[ArticleStore deleteArticleById] 文章 ${id} 刪除流程完成。`);
  return jsonDeleted; // 返回 JSON 檔案是否成功刪除的狀態
}

export async function removeAttachmentFromArticle(articleId, filenameToDelete) { // filenameToDelete 是儲存在磁碟上的安全檔名
    console.log(`[ArticleStore removeAttachment] 開始從文章 ${articleId} 移除附件 (磁碟檔名: ${filenameToDelete})`);
    const article = await getArticleById(articleId);
    if (!article) {
        console.warn(`[ArticleStore removeAttachment] 未找到文章 ID: ${articleId}`);
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`); // 拋出錯誤以便路由捕獲
    }

    const attachmentIndex = article.attachments.findIndex(att => att.filename === filenameToDelete);
    if (attachmentIndex === -1) {
        console.warn(`[ArticleStore removeAttachment] 在文章 ${articleId} 記錄中未找到磁碟檔名為 ${filenameToDelete} 的附件。`);
        return article; // 或者可以拋出錯誤表示附件未找到
    }

    const attachmentToRemove = article.attachments[attachmentIndex];
    const physicalFilePath = path.join(publicUploadsArticlesDir, articleId, attachmentToRemove.filename);

    // 從文章的附件記錄中移除
    article.attachments.splice(attachmentIndex, 1);
    article.updatedAt = new Date().toISOString();

    // 保存更新後的文章 JSON 資料
    try {
        const articleJsonFilePath = path.join(articlesDir, `${articleId}.json`);
        await fs.writeFile(articleJsonFilePath, JSON.stringify(article, null, 2), 'utf-8');
        console.log(`[ArticleStore removeAttachment] 已從文章 ${articleId} 移除附件記錄 (磁碟檔名: ${filenameToDelete}, 原始檔名: ${attachmentToRemove.originalname})`);
    } catch (saveError) {
        console.error(`[ArticleStore removeAttachment] 保存更新後的文章 ${articleId} JSON 時出錯:`, saveError);
        throw saveError; // 拋出錯誤
    }

    // 刪除物理檔案
    try {
        await fs.unlink(physicalFilePath);
        console.log(`[ArticleStore removeAttachment] 已刪除物理附件檔案: ${physicalFilePath}`);
    } catch (fileError) {
        console.error(`[ArticleStore removeAttachment] 刪除物理附件檔案 ${physicalFilePath} 時出錯:`, fileError);
        // 即使刪除物理檔案失敗，記錄也已更新，可以考慮是否需要更複雜的回滾邏輯
    }
    return article; // 返回更新後的文章物件
}
