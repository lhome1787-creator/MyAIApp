require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const OpenAI = require("openai");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { PDFParse } = require("pdf-parse");
const Parser = require("rss-parser");
const newsParser = new Parser();

const app = express();

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }
);

app.use(cors());
app.use(express.json({
    limit: "30mb",
    verify: (req, res, buf) => {
        if (req.originalUrl === "/razorpay-webhook") {
            req.rawBody = Buffer.from(buf);
        }
    }
}));

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});
const openrouterClient = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

app.post("/local-chat", async (req, res) => {
    try {
        const message = req.body?.message;

        if (typeof message !== "string" || !message.trim()) {
            return res.status(400).json({
                reply: "कृपया अपना सवाल लिखिए।"
            });
        }

        // GitHub repository में मौजूद data.json पढ़ें
        const fs = require("fs").promises;
        const filePath = __dirname + "/data.json";

        const fileContent = await fs.readFile(filePath, "utf8");
        const knowledge = JSON.parse(fileContent);

        if (!Array.isArray(knowledge)) {
            throw new Error("data.json में सवालों की सूची नहीं है");
        }

        // सवाल को सामान्य रूप में बदलें
        function normalize(text) {
            return String(text)
                .toLocaleLowerCase()
                .normalize("NFC")
                .replace(/[^\p{L}\p{N}\s]/gu, " ")
                .trim()
                .replace(/\s+/g, " ");
        }

        const question = normalize(message);

        // पहले बिल्कुल समान सवाल खोजें
        const exactMatch = knowledge.find(item =>
            item &&
            typeof item.question === "string" &&
            normalize(item.question) === question
        );

        if (exactMatch) {
            return res.json({
                reply: exactMatch.answer,
                source: "Vidora AI local knowledge",
                match: "exact"
            });
        }

        // फिर साझा शब्दों के आधार पर मिलते-जुलते सवाल खोजें
        const questionWords = new Set(question.split(" "));
        let bestItem = null;
        let bestScore = 0;

        for (const item of knowledge) {
            if (
                !item ||
                typeof item.question !== "string" ||
                typeof item.answer !== "string"
            ) {
                continue;
            }

            const savedQuestion = normalize(item.question);
            const savedWords = new Set(savedQuestion.split(" "));

            const commonWords = [...questionWords].filter(word =>
                savedWords.has(word)
            );

            const score = commonWords.length /
                Math.max(questionWords.size, savedWords.size, 1);

            if (score > bestScore) {
                bestScore = score;
                bestItem = item;
            }
        }

        if (bestItem && bestScore >= 0.6) {
            return res.json({
                reply: bestItem.answer,
                source: "Vidora AI local knowledge",
                match: "similar",
                confidence: Number(bestScore.toFixed(2)),
                matched_question: bestItem.question
            });
        }

        return res.json({
            reply: "इस सवाल का जवाब अभी मेरे स्थानीय डेटा में नहीं है।",
            source: "local knowledge",
            match: "not_found"
        });

    } catch (error) {
        console.error("Local Chat error:", error.message);

        return res.status(500).json({
            reply: "स्थानीय ज्ञान पढ़ने में समस्या आई।"
        });
    }
});

// Create Razorpay subscription for logged-in user
app.post("/create-subscription", async (req, res) => {
    try {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;

        if (!token) {
            return res.status(401).json({
                error: "कृपया पहले Login करें।"
            });
        }

        const { data: { user }, error } =
            await supabaseAdmin.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({
                error: "Login session valid नहीं है।"
            });
        }

        const subscription = await razorpay.subscriptions.create({
            plan_id: process.env.RAZORPAY_PLAN_ID,
            total_count: 12,
            quantity: 1,
            customer_notify: 1,
            notes: {
                supabase_user_id: user.id,
                plan: "Vidora AI Pro"
            }
        });
        const { error: saveError } = await supabaseAdmin
  .from("vidora_subscriptions")
  .upsert({
    user_id: user.id,
    razorpay_subscription_id: subscription.id,
    plan_name: "Vidora AI Pro",
    status: subscription.status || "created"
  }, {
    onConflict: "razorpay_subscription_id"
  });

if (saveError) {
  throw saveError;
}
        return res.json({
            subscriptionId: subscription.id,
            keyId: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error("Subscription creation error:", error.message);
        return res.status(500).json({
            error: "Subscription बनाने में समस्या आई।"
        });
    }
});
// Verify Razorpay webhook signature
app.post(
    "/razorpay-webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        try {
            const signature = req.headers["x-razorpay-signature"];

            if (!signature || !process.env.RAZORPAY_WEBHOOK_SECRET) {
                return res.status(400).send("Missing webhook signature or secret");
            }

            const expectedSignature = crypto
                .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
                .update(req.rawBody)
                .digest("hex");

            const received = Buffer.from(signature, "utf8");
            const expected = Buffer.from(expectedSignature, "utf8");

            if (
                received.length !== expected.length ||
                !crypto.timingSafeEqual(received, expected)
            ) {
                return res.status(400).send("Invalid webhook signature");
            }

            // Signature verified. Do not grant Pro access yet.
            // We will add verified subscription/payment handling next.
            return res.status(200).send("Webhook signature verified");
        } catch (error) {
            console.error("Razorpay webhook error:", error.message);
            return res.status(500).send("Webhook processing failed");
        }
    }
);
async function getLatestNews(query = "India") {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=hi&gl=IN&ceid=IN:hi`;

    const feed = await newsParser.parseURL(url);

    return feed.items.slice(0, 5).map(item => ({
        title: item.title,
        link: item.link,
        date: item.pubDate
    }));
}

// PDF TEXT को छोटे हिस्सों में बाँटना
function splitText(text, size = 3000) {

    const chunks = [];

    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }

    return chunks;
}

function isAdvancedQuestion(message) {
    const keywords = [
        "latest", "current", "news",
        "code", "programming",
        "complex", "advanced",
        "research", "analysis"
    ];

    return keywords.some(word =>
        message.toLowerCase().includes(word)
    );
}
function isAdvancedQuestion(message) {
    const keywords = [
        "latest",
        "current",
        "today",
        "news",
        "2026",
        "research",
        "advanced",
        "latest news"
    ];

    return keywords.some(keyword =>
        message.toLowerCase().includes(keyword)
    );
}

app.post("/chat", async (req, res) => {

    const message = req.body.message || "";
    const image = req.body.image || null;
    const fileData = req.body.fileData || null;
    const fileName = req.body.fileName || null;
    // 🔐 Verify logged-in user
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

    if (!token) {
        return res.status(401).json({
            reply: "कृपया पहले Google से Login करें।"
        });
    }

    const { data: { user }, error: userError } =
        await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
        return res.status(401).json({
            reply: "Login session valid नहीं है। कृपया फिर से Login करें।"
        });
    }

    // 🚦 10 AI requests per day per user
    const { data: requestNumber, error: limitError } =
        await supabaseAdmin.rpc("consume_daily_request", {
            p_user_id: user.id
        });

        console.log("DAILY LIMIT:", {
    userId: user.id,
    requestNumber,
    limitError
});

    if (limitError) {
        console.error("Daily limit error:", limitError);

        return res.status(500).json({
            reply: "Daily request limit check में समस्या आई।"
        });
    }

    if (requestNumber === 0) {
        return res.status(429).json({
            reply: "आज की 10 AI requests पूरी हो गई हैं। कल फिर 10 requests मिलेंगी।"
        });
    }

    const advanced = isAdvancedQuestion(message);
    const wantsNews = /news|खबर|समाचार|latest|ताजा|आज की खबर|current affairs/i.test(message);

    try {

        if (wantsNews) {
    const news = await getLatestNews(message);

    if (!news.length) {
        return res.json({
            reply: "अभी कोई ताजा खबर नहीं मिली।"
        });
    }

    const reply = news.map((item, index) =>
        `${index + 1}. ${item.title}\n🕐 ${item.date || ""}\n🔗 ${item.link}`
    ).join("\n\n");

    return res.json({
        reply: "📰 आज की ताजा खबरें:\n\n" + reply
    });
}

        // =========================
        // PDF
        // =========================

        if (fileData) {

            console.log("PDF पढ़ना शुरू...");

            const pdfBuffer = Buffer.from(fileData, "base64");

            const parser = new PDFParse({
                data: pdfBuffer
            });

            const result = await parser.getText();

            await parser.destroy();

            const text = result.text || "";

            console.log(
                `PDF text मिला: ${text.length} characters`
            );

            if (!text.trim()) {

                return res.json({
                    reply: "इस PDF से text नहीं निकाला जा सका।"
                });
            }

            const chunks = splitText(text);

            console.log(
                `PDF को ${chunks.length} हिस्सों में बाँटा गया।`
            );


            // हर हिस्से की छोटी summary
            const summaries = [];

            for (let i = 0; i < chunks.length; i++) {

                console.log(
                    `PDF हिस्सा ${i + 1}/${chunks.length} process हो रहा है...`
                );

                const response = await client.responses.create({

                    model: "gpt-5.6-luna",

                    max_output_tokens: 1000,

                    input: `
आप BPSC परीक्षा के expert हैं।

नीचे PDF का एक हिस्सा दिया गया है।

इसे ध्यान से पढ़कर:
1. मुख्य जानकारी निकालें
2. BPSC परीक्षा के लिए महत्वपूर्ण facts निकालें
3. महत्वपूर्ण घटनाएँ, व्यक्ति, स्थान और आँकड़े निकालें
4. अनावश्यक जानकारी छोड़ दें

PDF का हिस्सा:

${chunks[i]}
`
                });

                summaries.push(response.output_text);
            }


            // सभी summaries को जोड़ना
            const combinedSummary = summaries.join("\n\n");


            console.log("Final summary बनाई जा रही है...");


            const finalResponse = await client.responses.create({

                model: "gpt-5.6-luna",

                input: `
आप BPSC परीक्षा के expert हैं।

नीचे एक बड़ी PDF के अलग-अलग हिस्सों से बनाई गई summaries दी गई हैं।

User का प्रश्न:
${message || "इस PDF का BPSC परीक्षा के लिए summary बनाओ।"}

इन summaries को मिलाकर एक साफ और उपयोगी final answer बनाइए।

Format:

## 📚 PDF Summary

## ⭐ BPSC के लिए 10 Important Points

## 🎯 Exam में पूछे जा सकने वाले Facts

जहाँ जरूरी हो वहाँ bullet points और छोटे वाक्यों का प्रयोग करें।

Summaries:

${combinedSummary}
`
            });


            return res.json({
                reply: finalResponse.output_text
            });
        }


        // =========================
        // IMAGE
        // =========================

        if (image) {

            const input = [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: message || "इस फोटो को समझाइए।"
                        },
                        {
                            type: "input_image",
                            image_url: image
                        }
                    ]
                }
            ];

            const visionResponse = await openrouterClient.chat.completions.create({
    model: "openrouter/free",
    messages: [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: message || "इस फोटो को ध्यान से समझाकर हिंदी में उत्तर दें।"
                },
                {
                    type: "image_url",
                    image_url: {
                        url: image
                    }
                }
            ]
        }
    ]
});

console.log("✅ OpenRouter Qwen Vision response received");

return res.json({
    reply: visionResponse.choices[0].message.content
});

        }


        // =========================
        // NORMAL CHAT
        // =========================
try {

    if (advanced) {
    throw new Error("ADVANCED_QUESTION");
}
    const openrouterResponse = await openrouterClient.chat.completions.create({
    model: "openrouter/free",
    messages: [
        {
            role: "user",
            content: `हमेशा हिंदी में उत्तर दें। सरल और स्पष्ट भाषा में जवाब दें।

User: ${message}`
        }
    ]
});

console.log("✅ OpenRouter Llama response received");

return res.json({
    reply: openrouterResponse.choices[0].message.content
});

   

} catch (ollamaError) {
    console.log("Cloud AI error:", ollamaError.message);
}
        const response = await client.responses.create({
    model: "gpt-5.6-luna",
    instructions: "You are Vidora AI, an AI assistant created for study, exams, learning and general help. Your name is Vidora AI. Never say that you are ChatGPT. If asked your name, say: 'मैं Vidora AI हूँ।'",
    input: message
});

        res.json({
            reply: response.output_text
        });


    } catch (error) {

        console.error(error);

        res.status(500).json({
            reply: "AI से जवाब प्राप्त नहीं हो पाया।"
        });
    }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Vidora AI Backend http://localhost:${PORT} पर चालू है`
    );

});

