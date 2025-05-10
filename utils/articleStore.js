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
// 這些操作是異步的，但在模組首次載入時執行，後續函數呼叫前應已完成或拋出錯誤。
ensureDir(articlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保文章資料目錄:", err));
ensureDir(publicUploadsArticlesDir).catch(err => console.error("[ArticleStore] 啟動時未能確保公共上傳文章目錄:", err));


// 獲取所有文章
export async function getAllArticles() {
  try {
    await ensureDir(articlesDir); // 確保文章資料目錄存在
    const files = await fs.readdir(articlesDir); // 讀取目錄下的所有檔案名稱
    const articles = [];
    for (const file of files) {
      if (path.extname(file) === '.json') { // 只處理 .json 檔案
        const filePath = path.join(articlesDir, file);
        const data = await fs.readFile(filePath, 'utf-8'); // 異步讀取檔案內容
        articles.push(JSON.parse(data)); // 解析JSON並加入到陣列
      }
    }
    // 預設按更新時間降序排序 (最新的在前)
    articles.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return articles;
  } catch (error) {
    console.error('[ArticleStore] 讀取所有文章時出錯:', error);
    throw error; // 向上拋出錯誤
  }
}

// 根據ID獲取單個文章
export async function getArticleById(id) {
  const filePath = path.join(articlesDir, `${id}.json`); // 建構檔案路徑
  try {
    await ensureDir(articlesDir); // 確保目錄存在
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') { // 如果檔案未找到
      return null;
    }
    console.error(`[ArticleStore] 讀取文章 ${id} 時出錯:`, error);
    throw error;
  }
}

// 保存文章 (新建或更新) - 使用更健壯的 createdAt 處理邏輯
export async function saveArticle(articleData) {
  await ensureDir(articlesDir); // 確保目錄存在
  const id = articleData.id || uuidv4(); // 如果是新文章 (沒有ID)，則生成一個新的UUID
  const isNewArticle = !articleData.id; // 判斷是否為新文章
  let existingArticle = null;

  if (!isNewArticle) {
    existingArticle = await getArticleById(id); // 嘗試獲取現有文章資料
  }

  const nowISO = new Date().toISOString(); // 當前時間的 ISO 字串

  const article = {
    id: id,
    title: articleData.title,
    content: articleData.content || '', // 預設為空字串
    category: articleData.category || CATEGORIES[CATEGORIES.length - 1], // 如果未提供分類，預設為 "其他"
    attachments: articleData.attachments || [], // 附件資訊陣列，預設為空陣列
    // createdAt 邏輯:
    // 1. 如果是新文章，使用當前時間。
    // 2. 如果是更新文章，並且 articleData 中有有效的 createdAt，則使用它。
    // 3. 如果是更新文章，但 articleData 中沒有 createdAt，則嘗試使用現有文章的 createdAt。
    // 4. 如果以上都沒有（例如現有文章也沒有 createdAt），則退回到使用當前時間 (或 updatedAt 的值)。
    createdAt: isNewArticle
                  ? nowISO
                  : (articleData.createdAt || (existingArticle ? existingArticle.createdAt : nowISO)),
    updatedAt: nowISO // 總是用當前時間作為更新時間
  };

  // 確保 createdAt 是一個有效的 ISO 字串，以防萬一
  try {
    if (article.createdAt) {
        new Date(article.createdAt).toISOString(); // 嘗試轉換，如果無效會拋出錯誤
    } else {
        // 如果 createdAt 仍然是 null/undefined (例如 existingArticle 也沒有 createdAt)，則設定為 updatedAt
        console.warn(`[ArticleStore] 文章 ${id} 在保存期間缺少或 createdAt 無效。將其設定為 updatedAt。`);
        article.createdAt = article.updatedAt;
    }
  } catch (e) {
    // 如果 article.createdAt 格式無效，導致 new Date(article.createdAt).toISOString() 拋錯
    console.warn(`[ArticleStore] 文章 ${id} 在保存期間的 createdAt 格式 ('${article.createdAt}') 無效。將其重設為 updatedAt。`);
    article.createdAt = article.updatedAt;
  }


  const filePath = path.join(articlesDir, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8'); // 將文章物件序列化為JSON並寫入檔案，null, 2 用於格式化JSON輸出
  console.log(`[ArticleStore] 文章已 ${isNewArticle ? '保存' : '更新'}: ${id}`);
  return article; // 返回保存或更新後的文章物件
}

// 根據ID刪除文章及其附件
export async function deleteArticleById(id) {
  await ensureDir(articlesDir); // 確保文章資料目錄存在
  const articleJsonFilePath = path.join(articlesDir, `${id}.json`); // 文章JSON檔案的路徑
  const articleUploadsDirForId = path.join(publicUploadsArticlesDir, id); // 特定文章的附件目錄路徑

  try {
    // 刪除文章的 JSON 資料檔案
    await fs.unlink(articleJsonFilePath);
    console.log(`[ArticleStore] 已刪除文章 JSON: ${articleJsonFilePath}`);

    // 刪除關聯的附件目錄及其內容
    try {
        await fs.access(articleUploadsDirForId); // 檢查附件目錄是否存在
        await fs.rm(articleUploadsDirForId, { recursive: true, force: true }); // 遞迴強制刪除目錄及其所有內容
        console.log(`[ArticleStore] 已刪除附件目錄: ${articleUploadsDirForId}`);
    } catch (dirError) {
        if (dirError.code === 'ENOENT') { // 如果附件目錄不存在
            console.log(`[ArticleStore] 文章 ${id} 沒有附件目錄，跳過刪除。`);
        } else {
            // 其他刪除目錄的錯誤
            console.error(`[ArticleStore] 刪除附件目錄 ${articleUploadsDirForId} 時出錯:`, dirError);
            // 可以決定是否應該拋出此錯誤或僅警告，目前僅記錄錯誤
        }
    }
    return true; // 表示刪除操作（至少JSON檔案）成功
  } catch (error) {
    if (error.code === 'ENOENT') { // 如果文章JSON檔案未找到
      console.warn(`[ArticleStore] 未找到要刪除的文章 JSON 檔案: ${id}`);
      return false; // 表示文章未找到，刪除未執行
    }
    console.error(`[ArticleStore] 刪除文章 ${id} 時出錯:`, error);
    throw error; // 向上拋出其他錯誤
  }
}

// 向文章添加附件記錄的函數
export async function addAttachmentToArticle(articleId, attachmentData) {
    const article = await getArticleById(articleId); // 首先獲取文章資料
    if (!article) {
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`);
    }
    article.attachments.push(attachmentData); // 將新的附件資訊加入到附件陣列
    article.updatedAt = new Date().toISOString(); // 更新文章的更新時間
    // 保存更新後的文章資料回JSON檔案
    const filePath = path.join(articlesDir, `${articleId}.json`);
    await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`[ArticleStore] 已向文章 ${articleId} 添加附件: ${attachmentData.originalname}`);
    return article; // 返回更新後的文章物件
}

// 從文章移除附件記錄並刪除物理檔案的函數
export async function removeAttachmentFromArticle(articleId, filenameToDelete) { // filenameToDelete 是儲存在磁碟上的安全檔名
    const article = await getArticleById(articleId); // 獲取文章資料
    if (!article) {
        throw new Error(`未找到 ID 為 ${articleId} 的文章。`);
    }

    // 查找要刪除的附件在陣列中的索引 (基於磁碟檔名)
    const attachmentIndex = article.attachments.findIndex(att => att.filename === filenameToDelete);
    if (attachmentIndex === -1) { // 如果未找到附件記錄
        console.warn(`[ArticleStore] 在文章 ${articleId} 記錄中未找到磁碟檔名為 ${filenameToDelete} 的附件。`);
        return article; // 或拋出錯誤，取決於業務邏輯
    }

    const attachmentToRemove = article.attachments[attachmentIndex];
    // 附件的物理檔案路徑 (基於儲存時的 filename，即磁碟檔名)
    const physicalFilePath = path.join(publicUploadsArticlesDir, articleId, attachmentToRemove.filename);

    // 從文章的附件記錄中移除
    article.attachments.splice(attachmentIndex, 1);
    article.updatedAt = new Date().toISOString(); // 更新文章的更新時間

    // 保存更新後的文章 JSON 資料
    const articleJsonFilePath = path.join(articlesDir, `${articleId}.json`);
    await fs.writeFile(articleJsonFilePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`[ArticleStore] 已從文章 ${articleId} 移除附件記錄 (磁碟檔名: ${filenameToDelete}, 原始檔名: ${attachmentToRemove.originalname})`);

    // 刪除物理檔案
    try {
        await fs.unlink(physicalFilePath); // 刪除實際儲存的附件檔案
        console.log(`[ArticleStore] 已刪除物理附件檔案: ${physicalFilePath}`);
    } catch (fileError) {
        console.error(`[ArticleStore] 刪除物理附件檔案 ${physicalFilePath} 時出錯:`, fileError);
        // 如果刪除物理檔案失敗，可能需要考慮是否回滾記錄的移除，或僅記錄錯誤
        // 目前僅記錄錯誤
    }
    return article; // 返回更新後的文章物件
}
