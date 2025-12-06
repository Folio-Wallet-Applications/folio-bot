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

const sessions = {};
const bot = new TelegramBot(TOKEN, { webHook: false });

// Wrapper to log all bot.sendMessage
const sendMessage = async (chatId, text, options = {}) => {
    console.log("📤 BOT SEND MESSAGE:", {
        chatId,
        text,
        options,
    });
    return bot.sendMessage(chatId, text, options);
};

// Wrapper to log bot.sendPhoto
const sendPhoto = async (chatId, fileId, options = {}) => {
    console.log("📤 BOT SEND PHOTO:", {
        chatId,
        fileId,
        caption: options.caption,
    });
    return bot.sendPhoto(chatId, fileId, options);
};

// ========= LOG ALL UPDATES ==========
bot.on("message", msg => {
    console.log("📥 BOT RECEIVED MESSAGE:", {
        chatId: msg.chat.id,
        from: msg.from,
        text: msg.text,
        photo: msg.photo ? "[PHOTO RECEIVED]" : null,
        messageId: msg.message_id,
    });
});

bot.on("callback_query", q => {
    console.log("📥 BOT RECEIVED CALLBACK:", {
        chatId: q.message.chat.id,
        from: q.from,
        data: q.data,
        messageId: q.message.message_id,
    });
});

// =============== CUSTOMER FLOW =====================

bot.onText(/\/start/, async msg => {
    const chatId = msg.chat.id;

    if (chatId === TIGER_GROUP_CHAT_ID) return;

    sessions[chatId] = {};

    await sendMessage(
        chatId,
        "Hi! I’m Folio Giftcard Bot.\nWhat would you like to do?",
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Sell Gift Card", callback_data: "sell_card" }],
                ],
            },
        }
    );
});

bot.on("callback_query", async query => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (chatId === TIGER_GROUP_CHAT_ID) return;

    console.log("🔄 CALLBACK FLOW:", { chatId, data });

    if (data === "sell_card") {
        sessions[chatId] = { step: "ask_brand" };
        await sendMessage(
            chatId,
            "Which card are you selling? (e.g. Apple, Amazon, Steam)"
        );
    } else if (data === "confirm_yes") {
        sessions[chatId].step = "await_card";
        await sendMessage(
            chatId,
            "Great! Please upload a clear picture of your card or send the code."
        );
    } else if (data === "confirm_no") {
        sessions[chatId] = {};
        await sendMessage(
            chatId,
            "Okay, cancelled. You can start again anytime with /start."
        );
    }

    await bot.answerCallbackQuery(query.id);
});

bot.on("message", async msg => {
    const chatId = msg.chat.id;

    // Tiger group → special handler
    if (chatId === TIGER_GROUP_CHAT_ID) {
        return handleTigerGroupMessage(msg);
    }

    if (msg.text && msg.text.startsWith("/start")) return;

    const session = sessions[chatId] || {};

    if (!session.step) {
        await sendMessage(chatId, "Please start by sending /start");
        return;
    }

    if (session.step === "ask_brand") {
        session.brand = msg.text.trim();
        session.step = "ask_amount";
        sessions[chatId] = session;
        console.log("🟦 BRAND SELECTED:", session.brand);
        await sendMessage(
            chatId,
            "How much is the card in USD? (e.g. 25, 50, 100)"
        );
        return;
    }

    if (session.step === "ask_amount") {
        const usdAmount = Number(msg.text.trim());

        if (Number.isNaN(usdAmount) || usdAmount <= 0) {
            await sendMessage(
                chatId,
                "Please enter a valid positive number in USD."
            );
            return;
        }

        session.usdAmount = usdAmount;

        console.log("💰 AMOUNT RECEIVED:", usdAmount);
        console.log("🟩 FETCHING RATE FROM DB FOR BRAND:", session.brand);

        try {
            const res = await pool.query(
                "SELECT tiger_rate_cny_per_usd, ngn_per_cny FROM rates WHERE LOWER(brand) = LOWER($1)",
                [session.brand]
            );

            console.log("📘 DB RESULT:", res.rows);

            if (res.rows.length === 0) {
                await sendMessage(
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

            console.log("🔢 QUOTE COMPUTED:", quote);

            await sendMessage(
                chatId,
                `${session.brand} $${usdAmount}\n` +
                    `Rate: ₦${quote.customerRate} per $\n` +
                    `Estimated payout: ₦${quote.payout}\n\n` +
                    `Do you want to continue and upload your card?`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: "Yes, continue",
                                    callback_data: "confirm_yes",
                                },
                            ],
                            [
                                {
                                    text: "No, cancel",
                                    callback_data: "confirm_no",
                                },
                            ],
                        ],
                    },
                }
            );
        } catch (err) {
            console.error("❌ ERROR FETCHING RATE:", err);
            await sendMessage(
                chatId,
                "Error fetching rate. Please try again later."
            );
            sessions[chatId] = {};
        }
        return;
    }

    if (session.step === "await_card") {
        console.log("📮 CUSTOMER SUBMITTED CARD:", {
            brand: session.brand,
            amount: session.usdAmount,
            chatId,
        });

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
                const photo = msg.photo[msg.photo.length - 1];
                forwardedMsg = await sendPhoto(
                    TIGER_GROUP_CHAT_ID,
                    photo.file_id,
                    { caption }
                );
            } else {
                const details = msg.text || "Customer sent card details.";
                forwardedMsg = await sendMessage(
                    TIGER_GROUP_CHAT_ID,
                    `${caption}\n\nDetails: ${details}`
                );
            }

            console.log("📤 FORWARDED TO TIGER:", forwardedMsg);

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

            console.log("📝 TICKET SAVED:", insertRes.rows[0]);

            await sendMessage(
                chatId,
                `Your card has been submitted.\nTicket ID: ${insertRes.rows[0].id}\nPlease wait while we review it.`
            );
        } catch (err) {
            console.error("❌ ERROR SUBMITTING CARD:", err);
            await sendMessage(
                chatId,
                "Error submitting your card. Please try again later."
            );
        }

        sessions[chatId] = {};
    }
});

// TIGER GROUP HANDLER
async function handleTigerGroupMessage(msg) {
    console.log("🟧 TIGER GROUP MESSAGE:", {
        messageId: msg.message_id,
        replyTo: msg.reply_to_message ? msg.reply_to_message.message_id : null,
        text: msg.text,
    });

    if (!msg.reply_to_message) return;

    const repliedId = msg.reply_to_message.message_id;
    const text = msg.text || "Tiger responded.";

    try {
        const res = await pool.query(
            "SELECT * FROM tickets WHERE tiger_group_message_id = $1",
            [repliedId]
        );

        console.log("🟦 DB LOOKUP TICKET:", res.rows);

        if (res.rows.length === 0) return;

        const ticket = res.rows[0];

        await sendMessage(
            ticket.customer_telegram_id,
            `Update on your trade (Ticket ${ticket.id}):\n\n${text}`
        );

        let newStatus = ticket.status;
        if (text.toLowerCase().includes("completed")) newStatus = "closed";
        else if (text.toLowerCase().includes("processing"))
            newStatus = "in_progress";

        await pool.query(
            "UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2",
            [newStatus, ticket.id]
        );

        console.log("🔄 TICKET STATUS UPDATED:", newStatus);
    } catch (err) {
        console.error("❌ ERROR HANDLING TIGER:", err);
    }
}

// EXPRESS WEBHOOK
app.post("/webhook", (req, res) => {
    console.log("🌐 WEBHOOK RECEIVED:", req.body);
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
