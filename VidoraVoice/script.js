const micButton = document.getElementById("micButton");
const status = document.getElementById("status");
const userText = document.getElementById("userText");
const sendButton = document.getElementById("sendButton");
const responseBox = document.getElementById("response");
let selectedImage = null;

const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

const recognition = new SpeechRecognition();

recognition.lang = "hi-IN";
recognition.continuous = false;

micButton.onclick = function () {

    recognition.start();

    status.textContent = "🎤 सुन रहा हूँ... बोलिए";
};

recognition.onresult = function (event) {

    const text =
        event.results[0][0].transcript;

    userText.value = text;

    status.textContent =
        "✅ आवाज़ समझ ली गई।";

    sendToVidora(text);
};


async function sendToVidora(message) {

    responseBox.textContent =
        "⏳ Vidora AI जवाब दे रहा है...";

    try {

        const response = await fetch(
            "http://localhost:3000/chat",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

               body: JSON.stringify({
    message: message || "इस फोटो को समझाइए।",
    image: selectedImage
})
            }
        );

        const data = await response.json();

        responseBox.textContent =
            data.reply;

            const speech = new SpeechSynthesisUtterance(data.reply);

speech.lang = "hi-IN";
speech.rate = 1;
speech.pitch = 1;

window.speechSynthesis.speak(speech);

    } catch (error) {

        console.error(error);

        responseBox.textContent =
            "❌ Vidora AI से जवाब नहीं मिला।";
    }
}


sendButton.onclick = function () {

    const message = userText.value.trim();

    if (message !== "") {
        sendToVidora(message);
    }
};

function openImagePicker() {
    document.getElementById("imageInput").click();
}

function handleImage(event) {

    const file = event.target.files[0];

    if (!file) {
        return;
    }

    const reader = new FileReader();

    reader.onload = function () {

        selectedImage = reader.result;

        console.log("Photo तैयार है:", file.name);

        status.textContent =
            "🖼️ Photo AI को भेजने के लिए तैयार है।";
    };

    reader.readAsDataURL(file);
}