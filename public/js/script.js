// public/js/script.js

// 確保在 DOM 完全加載後執行腳本
document.addEventListener('DOMContentLoaded', function () {
    // 嘗試獲取 Quill 編輯器的容器元素
    const editorContainer = document.getElementById('editor-container');

    // 僅在編輯器容器存在時（即在新建或編輯文章的頁面）才初始化 Quill
    if (editorContainer) {
        const quill = new Quill('#editor-container', {
            theme: 'snow', // 使用 'snow' 主題，這是一個常見的帶有工具欄的主題
            modules: {
                toolbar: [ // 配置工具欄選項
                    [{ 'header': [1, 2, 3, 4, 5, 6, false] }], // 標題等級
                    [{ 'font': [] }], // 字體選擇

                    ['bold', 'italic', 'underline', 'strike'],        // 粗體、斜體、下劃線、刪除線
                    [{ 'color': [] }, { 'background': [] }],          // 文字顏色、背景顏色 (高亮)

                    [{ 'list': 'ordered'}, { 'list': 'bullet' }, { 'list': 'check' }], // 有序列表、無序列表、任務列表
                    [{ 'script': 'sub'}, { 'script': 'super' }],      // 上標、下標
                    [{ 'indent': '-1'}, { 'indent': '+1' }],          // 縮進
                    [{ 'direction': 'rtl' }],                         // 文字方向 (從右到左)

                    [{ 'size': ['small', false, 'large', 'huge'] }],  // 字體大小

                    [{ 'align': [] }], // 對齊方式

                    ['blockquote', 'code-block'], // 引用塊、代碼塊
                    ['link', 'image', 'video'],   // 插入鏈接、圖片、視頻 (注意：圖片/視頻上傳通常需要額外的服務器端處理邏輯)

                    ['clean'] // 清除格式按鈕
                ]
            },
            placeholder: '在此輸入分享內容...' // 編輯器內的佔位符文本
        });

        // 獲取包含 Quill 編輯器的表單和用於提交內容的隱藏 input 欄位
        const articleForm = document.getElementById('article-form'); // 假設表單的 ID 是 'article-form'
        const quillContentInput = document.getElementById('quill-content'); // 假設隱藏 input 的 ID 是 'quill-content'

        // 確保表單和隱藏 input 都存在
        if (articleForm && quillContentInput) {
            // 監聽表單的提交事件
            articleForm.addEventListener('submit', function() {
                // 在表單提交前，從 Quill 編輯器獲取 HTML 內容
                // 並將其賦值給隱藏的 input 欄位，以便與其他表單數據一起提交到後端
                quillContentInput.value = quill.root.innerHTML;

                // 可選：檢查內容是否為 Quill 的默認空內容 "<p><br></p>"
                // 如果是，可以選擇將其設置為空字符串，以避免在數據庫中存儲無意義的空標籤
                if (quill.getText().trim().length === 0 && quill.root.innerHTML === '<p><br></p>') {
                    // quillContentInput.value = ''; // 取消註釋此行以在提交時將空內容轉換為空字符串
                }
            });
        }
    }

    // 可以在這裡添加其他全局的客戶端 JavaScript 功能
    console.log("網絡分享站客戶端腳本已加載。");
});
