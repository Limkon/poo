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
  console.log(`[ArticleStore deleteArticleById] 開始刪除文章: ${id}`);
  await ensureDir(articlesDir);
  const articleJsonFilePath = path.join(articlesDir, `${id}.json`);
  const articleUploadsDirForId = path.join(publicUploadsArticlesDir, id);

  try {
    // 步驟 1: 刪除文章的 JSON 資料檔案
    await fs.unlink(articleJsonFilePath);
    console.log(`[ArticleStore deleteArticleById] 成功刪除 JSON 檔案: ${articleJsonFilePath}`);

    // 步驟 2: 刪除關聯的附件目錄及其內容
    try {
      await fs.access(articleUploadsDirForId); // 檢查目錄是否存在
      console.log(`[ArticleStore deleteArticleById] 附件目錄存在，嘗試刪除: ${articleUploadsDirForId}`);
      await fs.rm(articleUploadsDirForId, { recursive: true, force: true });
      console.log(`[ArticleStore deleteArticleById] 成功刪除附件目錄: ${articleUploadsDirForId}`);
    } catch (dirError) {
      if (dirError.code === 'ENOENT') {
        console.log(`[ArticleStore deleteArticleById] 文章 ${id} 沒有附件目錄，跳過刪除。`);
      } else {
        // 對於其他刪除附件目錄的錯誤，我們記錄它，但仍然認為文章（JSON）已成功刪除
        console.error(`[ArticleStore deleteArticleById] 刪除附件目錄 ${articleUploadsDirForId} 時出錯 (非致命):`, dirError);
      }
    }
    console.log(`[ArticleStore deleteArticleById] 文章 ${id} 刪除流程完成，返回 true。`);
    return true; // 主要的 JSON 檔案已刪除，視為成功
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === articleJsonFilePath) {
      console.warn(`[ArticleStore deleteArticleById] 未找到要刪除的文章 JSON 檔案: ${id}。返回 false。`);
      return false; // 文章 JSON 檔案未找到
    }
    // 對於其他導致 JSON 檔案無法刪除的嚴重錯誤，則拋出
    console.error(`[ArticleStore deleteArticleById] 刪除文章 ${id} 時發生嚴重錯誤:`, error);
    throw error;
  }
}

export async function addAttachmentToArticle(articleId, attachmentData) {
    const article = await getArticleById(articleId);
    if (!article) { throw new Error(`未找到 ID 為 ${articleId} 的文章。`); }
    article.attachments.push(attachmentData);
    article.updatedAt = new Date().toISOString();
    const filePath = path.join(articlesDir, `${articleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`[ArticleStore] 已向文章 ${articleId} 添加附件: ${attachmentData.originalname}`);
    return article;
}

export async function removeAttachmentFromArticle(articleId, filenameToDelete) {
    const article = await getArticleById(articleId);
    if (!article) { throw new Error(`未找到 ID 為 ${articleId} 的文章。`); }
    const attachmentIndex = article.attachments.findIndex(att => att.filename === filenameToDelete);
    if (attachmentIndex === -1) { console.warn(`[ArticleStore] 在文章 ${articleId} 記錄中未找到磁碟檔名為 ${filenameToDelete} 的附件。`); return article; }

    const attachmentToRemove = article.attachments[attachmentIndex];
    const physicalFilePath = path.join(publicUploadsArticlesDir, articleId, attachmentToRemove.filename);

    article.attachments.splice(attachmentIndex, 1);
    article.updatedAt = new Date().toISOString();
    const articleJsonFilePath = path.join(articlesDir, `${articleId}.json`);
    await fs.writeFile(articleJsonFilePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`[ArticleStore] 已從文章 ${articleId} 移除附件記錄 (磁碟檔名: ${filenameToDelete}, 原始檔名: ${attachmentToRemove.originalname})`);
    try {
        await fs.unlink(physicalFilePath);
        console.log(`[ArticleStore] 已刪除物理附件檔案: ${physicalFilePath}`);
    } catch (fileError) { console.error(`[ArticleStore] 刪除物理附件檔案 ${physicalFilePath} 時出錯:`, fileError); }
    return article;
}
