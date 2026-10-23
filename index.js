const express = require("express");
const cors = require("cors");

require("dotenv").config();

const { corsOrigin, requireUser } = require("./services/auth");

const healthRouter = require("./routes/health");
const characterRouter = require("./routes/character");
const profileRouter = require("./routes/profile");
const sessionsRouter = require("./routes/sessions");
const settingsRouter = require("./routes/settings");
const memoriesRouter = require("./routes/memories");
const followUpsRouter = require("./routes/followUps");
const handoffsRouter = require("./routes/handoffs");
const promptDocumentsRouter = require("./routes/promptDocuments");
const timelineRouter = require("./routes/timeline");
const diaryRouter = require("./routes/diary");
const memoryIndexRouter = require("./routes/memoryIndex");
const memoryPracticeRouter = require("./routes/memoryPractice");
const apiConnectionsRouter = require("./routes/apiConnections");
const apiUsageRouter = require("./routes/apiUsage");
const promptPreviewRouter = require("./routes/promptPreview");
const chatRouter = require("./routes/chat");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => req.path === "/health" ? next() : requireUser(req, res, next));

app.use(healthRouter);
app.use(characterRouter);
app.use(profileRouter);
app.use(sessionsRouter);
app.use(settingsRouter);
app.use(memoriesRouter);
app.use(followUpsRouter);
app.use(handoffsRouter);
app.use(promptDocumentsRouter);
app.use(timelineRouter);
app.use(diaryRouter);
app.use(memoryIndexRouter);
app.use(memoryPracticeRouter);
app.use(apiConnectionsRouter);
app.use(apiUsageRouter);
app.use(promptPreviewRouter);
app.use(chatRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
