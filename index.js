const express = require("express");
const cors = require("cors");
const { requireUser } = require("./services/auth");

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    const isAllowed = !origin
      || origin.endsWith(".vercel.app")
      || origin.startsWith("http://localhost:")
      || allowedOrigins.includes(origin);
    callback(isAllowed ? null : new Error("Origin is not allowed by CORS"), isAllowed);
  },
}));
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => req.path === "/health" ? next() : requireUser(req, res, next));

app.use(require("./routes/health"));
app.use(require("./routes/character"));
app.use(require("./routes/profile"));
app.use(require("./routes/sessions"));
app.use(require("./routes/settings"));
app.use(require("./routes/memories"));
app.use(require("./routes/followUps"));
app.use(require("./routes/handoffs"));
app.use(require("./routes/promptDocuments"));
app.use(require("./routes/timeline"));
app.use(require("./routes/diary"));
app.use(require("./routes/memoryIndex"));
app.use(require("./routes/memoryPractice"));
app.use(require("./routes/apiConnections"));
app.use(require("./routes/apiUsage"));
app.use(require("./routes/promptPreview"));
app.use(require("./routes/chat"));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
