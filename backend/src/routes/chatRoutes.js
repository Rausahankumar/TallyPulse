const express = require("express");
const auth = require("../middleware/auth");
const { activeCompanyContext } = require("../services/auth/companyContext");
const { chatLimiters } = require("../middleware/rateLimit");
const {
  sendChatMessage,
  listChats,
  getChat,
  renameChat,
  deleteChat,
} = require("../controllers/chatController");

const router = express.Router();

// Every chat route: JWT auth, THEN authorized-company-context
// resolution. No route below ever sees req.companyContext.tenantId
// without both having passed.
router.use(auth, activeCompanyContext);

router.get("/", listChats);
// The two routes that send a question (each is a paid model call) are rate-limited per user, after auth so the user is known.
router.post("/message", ...chatLimiters, sendChatMessage);
router.post("/:chatId/message", ...chatLimiters, sendChatMessage);
router.get("/:chatId", getChat);
router.patch("/:chatId", renameChat);
router.delete("/:chatId", deleteChat);

module.exports = router;
