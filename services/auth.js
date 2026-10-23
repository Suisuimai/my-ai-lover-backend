const { supabase } = require("./db");

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsOrigin(origin, callback) {
  const isAllowed = !origin
    || origin.endsWith(".vercel.app")
    || origin.startsWith("http://localhost:")
    || allowedOrigins.includes(origin);
  callback(isAllowed ? null : new Error("Origin is not allowed by CORS"), isAllowed);
}

async function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired session" });
  req.user = data.user;
  next();
}

module.exports = { allowedOrigins, corsOrigin, requireUser };
