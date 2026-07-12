const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// 允许前端访问
app.use(cors());

// 允许接收 JSON
app.use(express.json());

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "AI Lover Backend is running!"
  });
});

// 测试聊天接口（目前先不调用 DeepSeek）
app.post("/chat", async (req, res) => {

  const {
    provider,
    apiKey,
    model,
    message
  } = req.body;

  console.log("收到请求：");
  console.log({
    provider,
    model,
    message
  });

  // 目前先返回测试内容
  res.json({
    success: true,
    reply: `你好，我收到了你的消息："${message}"`
  });

});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});