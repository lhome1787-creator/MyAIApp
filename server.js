require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { PDFParse } = require("pdf-parse");

const app = express();

app.use(cors());
app.use(express.json({ limit: "30mb" }));

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});


// PDF TEXT को छोटे हिस्सों में बाँटना
function splitText(text, size = 3000) {

    const chunks = [];

    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }

    return chunks;
}


app.post("/chat", async (req, res) => {

    const message = req.body.message || "";
    const image = req.body.image || null;
    const fileData = req.body.fileData || null;
    const fileName = req.body.fileName || null;

    try {

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

            const response = await client.responses.create({
                model: "gpt-5.6-luna",
                input: input
            });

            return res.json({
                reply: response.output_text
            });
        }


        // =========================
        // NORMAL CHAT
        // =========================

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


const PORT = 3000;

app.listen(PORT, () => {

    console.log(
        `Vidora AI Backend http://localhost:${PORT} पर चालू है`
    );

});