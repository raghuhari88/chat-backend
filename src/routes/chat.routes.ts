import { Router, Request, Response } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { pool } from "../db";
import { firestore } from "../firebase";
import { authenticate } from "../middleware/auth";

const router = Router();

router.use(authenticate);

const createChatSchema = z.object({
  userAId: z.string().uuid(),
  userBId: z.string().uuid(),
});

const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(5000),
});

const userSchema = z.object({
  userId: z.string().uuid(),
});

const lastSeenSchema = userSchema.extend({
  messageId: z.string().min(1),
});

const messageIdSchema = z.object({
  messageId: z.string().min(1),
});

const getAuthUserId = (req: Request): string => {
  if (!req.authUser) {
    throw new Error("Authenticated user missing");
  }
  return req.authUser.id;
};

// Common authorization helper
async function isChatMember(
  chatId: string,
  userId: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM chat_members
     WHERE chat_id = $1 AND user_id = $2`,
    [chatId, userId]
  );

  return result.rowCount === 1;
}

// 1. Create or get a 1:1 chat
router.post(
  "/chat/create",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = createChatSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          message: "Invalid user IDs",
          errors: parsed.error.flatten(),
        });
        return;
      }

      const { userAId, userBId } = parsed.data;
      const currentUserId = getAuthUserId(req);

      if (userAId === userBId) {
        res.status(400).json({
          message: "Cannot create a chat with yourself",
        });
        return;
      }

      if (
        currentUserId !== userAId &&
        currentUserId !== userBId
      ) {
        res.status(403).json({
          message: "You must be a participant in this chat",
        });
        return;
      }

      const [lowId, highId] =
        userAId < userBId
          ? [userAId, userBId]
          : [userBId, userAId];

      const result = await pool.query<{ id: string }>(
        `INSERT INTO chats (user_low_id, user_high_id)
         VALUES ($1, $2)
         ON CONFLICT (user_low_id, user_high_id)
         DO UPDATE SET user_low_id = EXCLUDED.user_low_id
         RETURNING id`,
        [lowId, highId]
      );

      const chatId = result.rows[0].id;

      await pool.query(
        `INSERT INTO chat_members (chat_id, user_id)
         VALUES ($1, $2), ($1, $3)
         ON CONFLICT DO NOTHING`,
        [chatId, lowId, highId]
      );

      res.status(200).json({ chatId });
    } catch (error) {
      console.error("Create chat error:", error);
      res.status(500).json({ message: "Unable to create chat" });
    }
  }
);

// 2. Send a message
router.post(
  "/chat/:chatId/message/send",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { chatId } = req.params;
      const parsed = sendMessageSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          message: "Message text is required",
        });
        return;
      }

      const senderId = getAuthUserId(req);

      if (!(await isChatMember(chatId, senderId))) {
        res.status(403).json({ message: "Access denied" });
        return;
      }

      const ref = firestore
        .collection("chats")
        .doc(chatId)
        .collection("messages")
        .doc();

      const message = {
        senderId,
        text: parsed.data.text,
        createdAt: FieldValue.serverTimestamp(),
      };

      await ref.set(message);

      res.status(201).json({
        messageId: ref.id,
        chatId,
        senderId,
        text: parsed.data.text,
      });
    } catch (error) {
      console.error("Send message error:", error);
      res.status(500).json({ message: "Unable to send message" });
    }
  }
);

// 3. Get messages, newest first
router.get(
  "/chat/:chatId/messages",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { chatId } = req.params;
      const userId = getAuthUserId(req);

      if (!(await isChatMember(chatId, userId))) {
        res.status(403).json({ message: "Access denied" });
        return;
      }

      const rawLimit = req.query.limit ?? "50";
      const limitValue = Number(rawLimit);

      if (
        typeof rawLimit !== "string" ||
        !Number.isInteger(limitValue) ||
        limitValue < 1 ||
        limitValue > 100
      ) {
        res.status(400).json({
          message: "limit must be an integer between 1 and 100",
        });
        return;
      }

      const snapshot = await firestore
        .collection("chats")
        .doc(chatId)
        .collection("messages")
        .orderBy("createdAt", "desc")
        .limit(limitValue)
        .get();

      const messages = snapshot.docs.map((doc) => ({
        messageId: doc.id,
        ...doc.data(),
      }));

      res.json({ messages });
    } catch (error) {
      console.error("Get messages error:", error);
      res.status(500).json({ message: "Unable to fetch messages" });
    }
  }
);

// 4. Mark a message as read
router.post(
  "/chat/:chatId/message/:messageId/read",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { chatId, messageId } = req.params;
      const userId = getAuthUserId(req);

      if (!(await isChatMember(chatId, userId))) {
        res.status(403).json({ message: "Access denied" });
        return;
      }

      const messageRef = firestore
        .collection("chats")
        .doc(chatId)
        .collection("messages")
        .doc(messageId);

      const message = await messageRef.get();

      if (!message.exists) {
        res.status(404).json({ message: "Message not found" });
        return;
      }

      await messageRef
        .collection("readReceipts")
        .doc(userId)
        .set(
          {
            userId,
            readAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      res.json({ message: "Message marked as read" });
    } catch (error) {
      console.error("Mark read error:", error);
      res.status(500).json({ message: "Unable to update read receipt" });
    }
  }
);

// 5. Update last seen message
router.post(
  "/chat/:chatId/lastseen",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { chatId } = req.params;
      const parsed = lastSeenSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          message: "Valid messageId is required",
        });
        return;
      }

      const userId = getAuthUserId(req);

      if (parsed.data.userId !== userId) {
        res.status(403).json({
          message: "You can update only your own last seen state",
        });
        return;
      }

      if (!(await isChatMember(chatId, userId))) {
        res.status(403).json({ message: "Access denied" });
        return;
      }

      const messageRef = firestore
        .collection("chats")
        .doc(chatId)
        .collection("messages")
        .doc(parsed.data.messageId);

      const message = await messageRef.get();

      if (!message.exists) {
        res.status(404).json({ message: "Message not found" });
        return;
      }

      await firestore
        .collection("chats")
        .doc(chatId)
        .collection("members")
        .doc(userId)
        .set(
          {
            lastSeenMessageId: parsed.data.messageId,
            lastSeenAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      res.json({ message: "Last seen updated" });
    } catch (error) {
      console.error("Last seen error:", error);
      res.status(500).json({ message: "Unable to update last seen" });
    }
  }
);

// 6. List all chats for the authenticated user
router.get(
  "/user/:userId/chats",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = userSchema.safeParse(req.params);

      if (!parsed.success) {
        res.status(400).json({ message: "Invalid user ID" });
        return;
      }

      const userId = getAuthUserId(req);

      if (parsed.data.userId !== userId) {
        res.status(403).json({
          message: "You can list only your own chats",
        });
        return;
      }

      const result = await pool.query(
        `SELECT
           c.id AS "chatId",
           c.created_at AS "createdAt",
           ARRAY(
             SELECT cm2.user_id
             FROM chat_members cm2
             WHERE cm2.chat_id = c.id
             ORDER BY cm2.user_id
           ) AS "memberIds"
         FROM chats c
         JOIN chat_members cm
           ON cm.chat_id = c.id
         WHERE cm.user_id = $1
         ORDER BY c.created_at DESC`,
        [userId]
      );

      res.json({ chats: result.rows });
    } catch (error) {
      console.error("List chats error:", error);
      res.status(500).json({ message: "Unable to list chats" });
    }
  }
);

export default router;
