require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const OpenAI = require("openai");
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
app.use(express.json({ limit: "30mb" }));

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const openrouterClient = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

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

