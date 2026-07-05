const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// 这就是教程里要求的“健康检查接口” (Health Check)
app.get('/health', (req, res) => {
    res.json({ 
        status: "OK", 
        message: "服务运行正常！你的AI恋人后台已经接通电源。" 
    });
});

// 让服务器在指定端口监听请求
app.listen(PORT, () => {
    console.log(`服务器已成功启动，正在启动端口: http://localhost:${PORT}`);
});
