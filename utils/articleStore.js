// utils/articleStore.js
import fs from 'fs/promises'; // 引入 Promise 版本的 fs 模組
import path from 'path';
import { fileURLToPath } from 'url'; // 用於處理 ES 模組中的 __dirname
import { v4 as uuidv4 } from 'uuid'; // 用於生成唯一 ID

// 獲取當前檔案和目錄路徑
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRootDir = path.resolve(__dirname, '..'); // 專案根目錄
const articlesDir = path.join(projectRootDir, 'data', 'articles'); // 儲存文章 JSON 資料的目錄
export const publicUploadsArticlesDir = path.join(projectRootDir, 'public', 'uploads', 'articles'); // 儲存實際附件檔案的公開目錄

// 定義文章分類
export const CATEGORIES = ["軟體", "咨讯", "杂记", "分享资料", "网络资源", "其他"];

// 確保目錄存在的輔助函數
async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath); // 檢查目錄是否可存取
  } catch (error) {
    if (error.code === 'ENOENT') { // 如果目錄不存在 (Error NO ENTry)
      await fs.mkdir(dirPath, { recursive: true }); // 遞迴建立目錄
      console.log(`[ArticleStore] 已建立目錄: ${dirPath}`);
    } else {
      // 如果是其他錯誤 (例如權限問題)，則重新拋出
      console.error(`[ArticleStore] 存取目錄 ${dirPath} 時出錯:`, error);
      throw error;
    }
  }
}

// 模組載入時確保基礎目錄存在
ensureDir(articlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保文章資料目錄:", err));
ensureDir(publicUploadsArticlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保公共上傳文章目錄:", err));


// 獲取所有文章
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
  } catch (error) {
    console.error('[ArticleStore] 讀取所有文章時出錯:', error);
    throw error;
  }
}

// 根據ID獲取單個文章
export async function getArticleById(id) {
  const filePath = path.join(articlesDir, `${id}.json`);
  try {
    await ensureDir(articlesDir);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    console.error(`[ArticleStore] 讀取文章 ${id} 時出錯:`, error);
    throw error;
  }
}

// 保存文章 (新建或更新) - 使用更健壯的 createdAt 處理邏輯
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

// 根據ID刪除文章及其附件
export async function deleteArticleById(id) {
  console.log(`[ArticleStore deleteArticleById] 開始刪除文章 ID: ${id}`);
  await ensureDir(articlesDir);
  const articleJsonFilePath = path.join(articlesDir, `${id}.json`);
  const articleUploadsDirForId = path.join(publicUploadsArticlesDir, id);

  let jsonDeleted = false;
  try {
    await fs.unlink(articleJsonFilePath);
    jsonDeleted = true;
    console.log(`[ArticleStore deleteArticleById] 成功刪除 JSON 檔案: ${articleJsonFilePath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`[ArticleStore deleteArticleById] 未找到要刪除的文章 JSON 檔案: ${id}。可能已被刪除或 ID 錯誤。`);
      return false;
    }
    console.error(`[ArticleStore deleteArticleById] 刪除文章 JSON 檔案 ${id} 時發生錯誤:`, error);
    throw error;
  }

  if (jsonDeleted) {
    try {
      await fs.access(articleUploadsDirForId);
      console.log(`[ArticleStore deleteArticleById] 附件目錄存在，嘗試刪除: ${articleUploadsDirForId}`);
      await fs.rm(articleUploadsDirForId, { recursive: true, force: true });
      console.log(`[ArticleStore deleteArticleById] 成功刪除附件目錄: ${articleUploadsDirForId}`);
    } catch (dirError) {
      if (dirError.code === 'ENOENT') {
        console.log(`[ArticleStore deleteArticleById] 文章 ${id} 沒有附件目錄，跳過刪除。`);
      } else {
        console.error(`[ArticleStore deleteArticleById] 刪除附件目錄 ${articleUploadsDirForId} 時出錯 (非致命):`, dirError);
      }
    }
  }
  console.log(`[ArticleStore deleteArticleById] 文章 ${id} 刪除流程完成。`);
  return jsonDeleted;
}

// **確保 addAttachmentToArticle 函數已定義並導出**
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

// **確保 removeAttachmentFromArticle 函數已定義並導出**
export async function removeAttachmentFromArticle(articleId, filenameToDelete) { // filenameToDelete 是儲存在磁碟上的安全檔名
    console.log(`[ArticleStore removeAttachmentFromArticle] 開始從文章 ${articleId} 移除附件 (磁碟檔名: ${filenameToDelete})`);
    const article = await getArticleById(articleId);
    if (!article) {
        console.warn(`[ArticleStore removeAttachmentFromArticle] 未找到文章 ID: ${articleId}`);
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`);
    }

    const attachmentIndex = article.attachments.findIndex(att => att.filename === filenameToDelete);
    if (attachmentIndex === -1) {
        console.warn(`[ArticleStore removeAttachmentFromArticle] 在文章 ${articleId} 記錄中未找到磁碟檔名為 ${filenameToDelete} 的附件。`);
        // 即使附件記錄不存在，也可能需要嘗試刪除物理文件（如果有的話），或者直接返回
        // 為了安全，如果記錄不存在，我們假設物理文件也不應該存在或不應被刪除
        return article;
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
    return article;
}
