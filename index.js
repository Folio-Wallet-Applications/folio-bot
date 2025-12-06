// index.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");
const { pool } = require("./db");
const { computeRate } = require("./rateLogic");

const app = express();
app.use(bodyParser.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const TIGER_GROUP_CHAT_ID = Number(process.env.TIGER_GROUP_CHAT_ID);

if (!TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
}

// Sessions in memory (per-user simple state)
const sessions = {}; // { userId: { step, brand, usdAmount, quote } }

// Create bot instance (no polling, we use webhooks)
const bot = new TelegramBot(TOKEN, { webHook: false });

// =============== CUSTOMER FLOW HANDLERS =====================

bot.onText(/\/start/, async msg => {
    const chatId = msg.chat.id;

    // Ignore Tiger group
    if (chatId === TIGER_GROUP_CHAT_ID) return;

    sessions[chatId] = {}; // reset

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Sell Gift Card", callback_data: "sell_card" }],
            ],
        },
    };

    await bot.sendMessage(
        chatId,
        "Hi! I’m Folio Giftcard Bot.\nWhat would you like to do?",
        opts
    );
});

bot.on("callback_query", async query => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (chatId === TIGER_GROUP_CHAT_ID) return;

    if (data === "sell_card") {
        sessions[chatId] = { step: "ask_brand" };
        await bot.sendMessage(
            chatId,
            "Which card are you selling? (e.g. Apple, Amazon, Steam)"
        );
    } else if (data === "confirm_yes") {
        if (!sessions[chatId]) sessions[chatId] = {};
        sessions[chatId].step = "await_card";
        await bot.sendMessage(
            chatId,
            "Great! Please upload a clear picture of your card or send the code."
        );
    } else if (data === "confirm_no") {
        sessions[chatId] = {};
        await bot.sendMessage(
            chatId,
            "Okay, cancelled. You can start again anytime with /start."
        );
    }

    await bot.answerCallbackQuery(query.id);
});

// Handle all messages
bot.on("message", async msg => {
    const chatId = msg.chat.id;

    // If message is from Tiger group, handle separately
    if (chatId === TIGER_GROUP_CHAT_ID) {
        return handleTigerGroupMessage(msg);
    }

    // Ignore callback-only messages from start (node-telegram-bot-api also sends message events)
    if (msg.text && msg.text.startsWith("/start")) {
        // already handled above
        return;
    }

    // Customer flow based on session.step
    const session = sessions[chatId] || {};

    if (!session.step) {
        await bot.sendMessage(chatId, "Please start by sending /start");
        return;
    }

    if (session.step === "ask_brand") {
        session.brand = msg.text.trim();
        session.step = "ask_amount";
        sessions[chatId] = session;
        await bot.sendMessage(
            chatId,
            "How much is the card in USD? (e.g. 25, 50, 100)"
        );
        return;
    }

    if (session.step === "ask_amount") {
        const text = msg.text.trim();
        const usdAmount = Number(text);
        if (Number.isNaN(usdAmount) || usdAmount <= 0) {
            await bot.sendMessage(
                chatId,
                "Please enter a valid positive number in USD."
            );
            return;
        }

        session.usdAmount = usdAmount;

        // Fetch rate for this brand from DB
        try {
            const res = await pool.query(
                "SELECT tiger_rate_cny_per_usd, ngn_per_cny FROM rates WHERE LOWER(brand) = LOWER($1)",
                [session.brand]
            );

            if (res.rows.length === 0) {
                await bot.sendMessage(
                    chatId,
                    `No rate configured yet for ${session.brand}. Please try later.`
                );
                sessions[chatId] = {};
                return;
            }

            const { tiger_rate_cny_per_usd: T, ngn_per_cny: K } = res.rows[0];
            const quote = computeRate(Number(T), Number(K), usdAmount);
            session.quote = quote;
            session.step = "confirm";
            sessions[chatId] = session;

            const textMsg =
                `${session.brand} $${usdAmount}\n` +
                `Rate: ₦${quote.customerRate} per $\n` +
                `Estimated payout: ₦${quote.payout}\n\n` +
                `Do you want to continue and upload your card?`;

            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Yes, continue",
                                callback_data: "confirm_yes",
                            },
                        ],
                        [{ text: "No, cancel", callback_data: "confirm_no" }],
                    ],
                },
            };

            await bot.sendMessage(chatId, textMsg, opts);
        } catch (err) {
            console.error("Error fetching rate", err);
            await bot.sendMessage(
                chatId,
                "Error fetching rate. Please try again later."
            );
            sessions[chatId] = {};
        }
        return;
    }

    if (session.step === "await_card") {
        // Customer has uploaded card (image or text), now forward to Tiger group
        const brand = session.brand;
        const usdAmount = session.usdAmount;
        const quote = session.quote;

        const caption =
            `[TICKET - NEW]\n` +
            `Brand: ${brand}\n` +
            `Amount: $${usdAmount}\n` +
            `Est. payout: ₦${quote.payout}\n` +
            `Message: Customer uploaded a card.`;

        let forwardedMsg;
        try {
            if (msg.photo && msg.photo.length > 0) {
                const photo = msg.photo[msg.photo.length - 1]; // largest size
                forwardedMsg = await bot.sendPhoto(
                    TIGER_GROUP_CHAT_ID,
                    photo.file_id,
                    { caption }
                );
            } else {
                const details = msg.text || "Customer sent card details.";
                forwardedMsg = await bot.sendMessage(
                    TIGER_GROUP_CHAT_ID,
                    `${caption}\n\nDetails: ${details}`
                );
            }

            // Save ticket in DB
            const insertRes = await pool.query(
                `INSERT INTO tickets 
           (customer_telegram_id, usd_amount, brand, customer_message_id, tiger_group_message_id, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
                [
                    chatId,
                    usdAmount,
                    brand,
                    msg.message_id,
                    forwardedMsg.message_id,
                    "open",
                ]
            );

            const ticketId = insertRes.rows[0].id;

            await bot.sendMessage(
                chatId,
                `Your card has been submitted.\nTicket ID: ${ticketId}\nPlease wait while we review it.`
            );
        } catch (err) {
            console.error("Error forwarding to Tiger group", err);
            await bot.sendMessage(
                chatId,
                "Error submitting your card. Please try again later."
            );
        }

        // Clear session
        sessions[chatId] = {};
        return;
    }
});

// =============== TIGER GROUP HANDLER =====================

async function handleTigerGroupMessage(msg) {
    // Only react when Tiger uses "Reply"
    if (!msg.reply_to_message) {
        // You can optionally warn them to always use Reply
        return;
    }

    const repliedId = msg.reply_to_message.message_id;
    const text = msg.text || "Tiger responded.";

    try {
        const res = await pool.query(
            "SELECT * FROM tickets WHERE tiger_group_message_id = $1",
            [repliedId]
        );

        if (res.rows.length === 0) {
            console.log("No ticket found for this replied message_id");
            return;
        }

        const ticket = res.rows[0];

        await bot.sendMessage(
            ticket.customer_telegram_id,
            `Update on your trade (Ticket ${ticket.id}):\n\n${text}`
        );

        // Optionally close ticket if Tiger types something like "completed"
        let newStatus = ticket.status;
        if (text.toLowerCase().includes("completed")) {
            newStatus = "closed";
        } else if (text.toLowerCase().includes("processing")) {
            newStatus = "in_progress";
        }

        await pool.query(
            "UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2",
            [newStatus, ticket.id]
        );
    } catch (err) {
        console.error("Error handling Tiger reply", err);
    }
}

// =============== EXPRESS WEBHOOK SETUP =====================

// Telegram will POST updates here
app.post("/webhook", (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Start Express server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(
        "Remember to set Telegram webhook to https://your-domain/webhook"
    );
});
