const express = require("express");
const auth = require("../middleware/auth");
const { activeCompanyContext } = require("../services/auth/companyContext");
const {
  sendChatMessage,
  listChats,
  getChat,
  deleteChat,
} = require("../controllers/chatController");

const router = express.Router();

// Every chat route: JWT auth, THEN authorized-company-context
// resolution. No route below ever sees req.companyContext.tenantId
// without both having passed.
router.use(auth, activeCompanyContext);

router.get("/", listChats);
router.post("/message", sendChatMessage);
router.post("/:chatId/message", sendChatMessage);
router.get("/:chatId", getChat);
router.delete("/:chatId", deleteChat);

module.exports = router;
