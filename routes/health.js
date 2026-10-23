const express = require("express");
const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ status: "OK", message: "AI Lover Backend is running" });
});

module.exports = router;
