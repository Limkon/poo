// utils/articleStore.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url); // 獲取當前文件的絕對路徑
const __dirname = path.dirname(__filename); // 獲取當前文件所在的文件夾路徑

const projectRootDir = path.resolve(__dirname, '..'); // 項目根目錄
const articlesDir = path.join(projectRootDir, 'data', 'articles'); // 存儲文章JSON數據的文件夾
export const publicUploadsArticlesDir = path.join(projectRootDir, 'public', 'uploads', 'articles'); // 存儲實際附件文件的文件夾

// 定義文章分類
export const CATEGORIES = ["軟件", "咨讯", "杂记", "分享资料", "网络资源", "其他"]; // 添加了 "其他" 作為一個選項

// 確保文件夾存在的輔助函數
async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath); // 檢查文件夾是否可訪問
  } catch (error) {
    if (error.code === 'ENOENT') { // 如果文件夾不存在 (Error NO ENTry)
      await fs.mkdir(dirPath, { recursive: true }); // 遞歸創建文件夾
      console.log(`[ArticleStore] 已創建文件夾: ${dirPath}`);
    } else {
      // 如果是其他錯誤 (例如權限問題)，則重新拋出
      console.error(`[ArticleStore] 訪問文件夾 ${dirPath} 時出錯:`, error);
      throw error;
    }
  }
}

// 模塊加載時確保基礎文件夾存在
// 這些操作是異步的，但在模塊首次加載時執行，後續函數調用前應已完成或拋出錯誤。
ensureDir(articlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保文章數據文件夾:", err));
ensureDir(publicUploadsArticlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保公共上傳文章文件夾:", err));


// 獲取所有文章
export async function getAllArticles() {
  try {
    await ensureDir(articlesDir); // 確保文章數據目錄存在
    const files = await fs.readdir(articlesDir); // 讀取目錄下的所有文件名
    const articles = [];
    for (const file of files) {
      if (path.extname(file) === '.json') { // 只處理 .json 文件
        const filePath = path.join(articlesDir, file);
        const data = await fs.readFile(filePath, 'utf-8'); // 異步讀取文件內容
        articles.push(JSON.parse(data)); // 解析JSON並添加到數組
      }
    }
    // 默認按更新時間降序排序 (最新的在前)
    articles.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return articles;
  } catch (error) {
    console.error('[ArticleStore] 讀取所有文章時出錯:', error);
    throw error; // 向上拋出錯誤
  }
}

// 根據ID獲取單個文章
export async function getArticleById(id) {
  const filePath = path.join(articlesDir, `${id}.json`); // 構造文件路徑
  try {
    await ensureDir(articlesDir); // 確保目錄存在
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') { // 如果文件未找到
      return null;
    }
    console.error(`[ArticleStore] 讀取文章 ${id} 時出錯:`, error);
    throw error;
  }
}

// 保存文章 (新建或更新)
export async function saveArticle(articleData) {
  await ensureDir(articlesDir); // 確保目錄存在
  const id = articleData.id || uuidv4(); // 如果是新文章 (沒有ID)，則生成一個新的UUID
  const isNewArticle = !articleData.id; // 判斷是否為新文章

  const article = {
    id: id,
    title: articleData.title,
    content: articleData.content || '', // 默認為空字符串
    category: articleData.category || CATEGORIES[CATEGORIES.length -1], // 如果未提供分類，默認為 "其他"
    attachments: articleData.attachments || [], // 附件信息數組，默認為空數組
    createdAt: isNewArticle ? new Date().toISOString() : articleData.createdAt, // 如果是新文章，設置創建時間；否則保留原有創建時間
    updatedAt: new Date().toISOString() // 總是用當前時間作為更新時間
  };
  const filePath = path.join(articlesDir, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8'); // 將文章對象序列化為JSON並寫入文件，null, 2 用於格式化JSON輸出
  console.log(`[ArticleStore] 文章已 ${isNewArticle ? '保存' : '更新'}: ${id}`);
  return article; // 返回保存或更新後的文章對象
}

// 根據ID刪除文章及其附件
export async function deleteArticleById(id) {
  await ensureDir(articlesDir); // 確保文章數據目錄存在
  const articleJsonFilePath = path.join(articlesDir, `${id}.json`); // 文章JSON文件的路徑
  const articleUploadsDirForId = path.join(publicUploadsArticlesDir, id); // 特定文章的附件文件夾路徑

  try {
    // 刪除文章的 JSON 數據文件
    await fs.unlink(articleJsonFilePath);
    console.log(`[ArticleStore] 已刪除文章 JSON: ${articleJsonFilePath}`);

    // 刪除關聯的附件文件夾及其內容
    try {
        await fs.access(articleUploadsDirForId); // 檢查附件文件夾是否存在
        await fs.rm(articleUploadsDirForId, { recursive: true, force: true }); // 遞歸強制刪除文件夾及其所有內容
        console.log(`[ArticleStore] 已刪除附件文件夾: ${articleUploadsDirForId}`);
    } catch (dirError) {
        if (dirError.code === 'ENOENT') { // 如果附件文件夾不存在
            console.log(`[ArticleStore] 文章 ${id} 沒有附件文件夾，跳過刪除。`);
        } else {
            // 其他刪除文件夾的錯誤
            console.error(`[ArticleStore] 刪除附件文件夾 ${articleUploadsDirForId} 時出錯:`, dirError);
            // 可以決定是否應該拋出此錯誤或僅警告，目前僅記錄錯誤
        }
    }
    return true; // 表示刪除操作（至少JSON文件）成功
  } catch (error) {
    if (error.code === 'ENOENT') { // 如果文章JSON文件未找到
      console.warn(`[ArticleStore] 未找到要刪除的文章 JSON 文件: ${id}`);
      return false; // 表示文章未找到，刪除未執行
    }
    console.error(`[ArticleStore] 刪除文章 ${id} 時出錯:`, error);
    throw error; // 向上拋出其他錯誤
  }
}

// 向文章添加附件記錄的函數
export async function addAttachmentToArticle(articleId, attachmentData) {
    const article = await getArticleById(articleId); // 首先獲取文章數據
    if (!article) {
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`);
    }
    article.attachments.push(attachmentData); // 將新的附件信息添加到附件數組
    article.updatedAt = new Date().toISOString(); // 更新文章的更新時間
    // 保存更新後的文章數據回JSON文件
    const filePath = path.join(articlesDir, `${articleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`[ArticleStore] 已向文章 ${articleId} 添加附件: ${attachmentData.originalname}`);
    return article; // 返回更新後的文章對象
}

// 從文章移除附件記錄並刪除物理文件的函數
export async function removeAttachmentFromArticle(articleId, filenameToDelete) {
    const article = await getArticleById(articleId); // 獲取文章數據
    if (!article) {
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`);
    }

    // 查找要刪除的附件在數組中的索引
    const attachmentIndex = article.attachments.findIndex(att => att.filename === filenameToDelete);
    if (attachmentIndex === -1) { // 如果未找到附件記錄
        console.warn(`[ArticleStore] 在文章 ${articleId} 記錄中未找到附件 ${filenameToDelete}。`);
        return article; // 或拋出錯誤，取決於業務邏輯
    }

    const attachmentToRemove = article.attachments[attachmentIndex];
    // 附件的物理文件路徑 (基於存儲時的 filename)
    const physicalFilePath = path.join(publicUploadsArticlesDir, articleId, attachmentToRemove.filename);

    // 從文章的附件記錄中移除
    article.attachments.splice(attachmentIndex, 1);
    article.updatedAt = new Date().toISOString(); // 更新文章的更新時間

    // 保存更新後的文章 JSON 數據
    const articleJsonFilePath = path.join(articlesDir, `${articleId}.json`);
    await fs.writeFile(articleJsonFilePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`[ArticleStore] 已從文章 ${articleId} 移除附件記錄 ${filenameToDelete}`);

    // 刪除物理文件
    try {
        await fs.unlink(physicalFilePath); // 刪除實際存儲的附件文件
        console.log(`[ArticleStore] 已刪除物理附件文件: ${physicalFilePath}`);
    } catch (fileError) {
        console.error(`[ArticleStore] 刪除物理附件文件 ${physicalFilePath} 時出錯:`, fileError);
        // 如果刪除物理文件失敗，可能需要考慮是否回滾記錄的移除，或僅記錄錯誤
        // 目前僅記錄錯誤
    }
    return article; // 返回更新後的文章對象
}
