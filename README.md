# 網路分享網站

這是一個基於 Node.js、Express 和 EJS 的網路分享網站，允許使用者公開瀏覽分享內容，並提供一個受密碼保護的後台管理系統，用於建立、編輯和刪除分享文章及其附件。

## 功能特性

* **公開分享瀏覽**：任何人都可以存取網站首頁，按分類或關鍵詞搜尋瀏覽分享內容。
* **文章詳情查看**：點擊文章可查看完整內容和下載附件。
* **附件上傳與下載**：管理員可以在建立或編輯文章時上傳多個附件，訪客可以下載這些附件。
* **文章分類**：文章可以歸類到預定義的分類中（如：軟體、資訊、雜記等）。
* **後台管理系統**：
    * 透過主密碼登入受保護的管理後台。
    * 管理員可以建立、編輯和刪除分享文章。
    * 管理員可以管理文章的附件（上傳新附件、刪除現有附件）。
* **本地檔案儲存**：文章資料以 JSON 檔案的形式儲存在伺服器本地，附件也儲存在本地檔案系統中。
* **響應式設計**：基礎樣式考慮了不同裝置的顯示效果。
* **富文本編輯**：後台管理使用 Quill.js 進行文章內容的富文本編輯。
* - 支持[alwaysdata](https://www.alwaysdata.com/en/)空间一键安装，SSH登陆后执行以下命令，安装完成后在alwaysdata空间设置中找到Command*添加node server.js
     ```bash
     bash <(curl -fsSL https://raw.githubusercontent.com/Limkon/poo/master/setup.sh)
     ```

## 專案檔案結構

network-sharing-site/  
+-- data/
|   +-- articles/         # (執行時自動建立) 儲存文章的 JSON 資料檔案   
+-- public/  
|   +-- css/  
|   |   +-- style.css     # 主要的 CSS 樣式檔案  
|   +-- js/  
|   |   +-- script.js     # 用戶端 JavaScript (主要用於 Quill 編輯器初始化)  
|   +-- uploads/   
|       +-- articles/     # (執行時自動建立) 儲存文章附件的實際檔案   
+-- views/    
|   +-- partials/         # EJS 範本的共享部分   
|   |   +-- header.ejs    # 頁首   
|   |   +-- footer.ejs    # 頁腳   
|   +-- admin/            # 後台管理相關的 EJS 範本   
|   |   +-- list_articles.ejs   # 管理員查看文章列表   
|   |   +-- new_article.ejs     # 新建文章表單   
|   |   +-- edit_article.ejs    # 編輯文章表單   
|   +-- public/           # 公開頁面相關的 EJS 範本   
|   |   +-- show_article.ejs    # 顯示單個文章詳情   
|   |   +-- 404.ejs             # 404 頁面未找到   
|   |   +-- error.ejs           # 通用錯誤頁面   
|   +-- index.ejs           # 網站首頁 - 公開的文章列表   
+-- routes/   
|   +-- articles.js       # 處理所有與文章相關的路由 (包括公開和管理)   
+-- utils/   
|   +-- articleStore.js   # 管理文章資料的工具函數 (讀取、寫入 JSON 檔案等)   
+-- .env                    # (可選) 環境變數設定檔 (例如埠號)   
+-- package.json            # 專案依賴、腳本等設定資訊   
+-- server.js               # 主應用程式 - 分享網站的核心邏輯 (Express 應用)   
+-- start.cjs               # 應用程式啟動腳本，包含認證閘道和反向代理邏輯   



## 安裝與啟動

1.  **複製或下載專案**：將所有檔案和資料夾按上述結構放置在您的本地電腦上。
2.  **安裝依賴**：在專案根目錄下開啟終端機，執行：
    ```bash
    npm install
    ```
3.  **設定環境變數 (可選)**：
    * 在專案根目錄下建立一個 `.env` 檔案。
    * 根據需要設定以下變數 (如果未設定，將使用腳本中的預設值)：
        ```
        PUBLIC_PORT=8100       # 認證閘道監聽的公開埠號
        APP_INTERNAL_PORT=3000 # 主應用 (server.js) 監聽的內部埠號
        NODE_ENV=development   # 設定為 'development' 以在錯誤頁面顯示詳細堆疊資訊
        ```
4.  **啟動應用**：
    ```bash
    npm start
    ```
    或者，使用 `nodemon` 進行開發 (如果已安裝並在 `package.json` 中設定)：
    ```bash
    npm run dev
    ```
5.  **首次執行 - 設定主密碼**：
    * 在瀏覽器中存取 `http://localhost:8100/setup` (或您在 `.env` 中設定的 `PUBLIC_PORT`)。
    * 依照提示設定用於後台管理的主密碼。
6.  **存取網站**：
    * **公開網站首頁**：`http://localhost:8100/`
    * **後台管理登入**：`http://localhost:8100/login`
    * **後台管理面板** (使用主密碼登入後)：`http://localhost:8100/admin`

## 主要技術棧

* **後端**: Node.js, Express.js
* **前端範本**: EJS (Embedded JavaScript templates)
* **資料儲存**: 本地檔案系統 (JSON 檔案儲存文章資料，直接儲存附件檔案)
* **認證**: 基於 Cookie 的主密碼認證 (用於後台管理)
* **富文本編輯**: Quill.js
* **檔案上傳**: Multer

## 注意事項

* 請確保 `encryption.secret.key` 檔案得到妥善保管，它是解密主密碼的關鍵。如果遺失，已設定的主密碼將無法恢復。
* 附件直接儲存在 `public/uploads/articles/` 資料夾下，按文章 ID 分組。請確保伺服器對此資料夾有寫入權限。
* 錯誤處理和安全性方面可以根據實際部署需求進一步加強。
