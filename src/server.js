const express = require('express');
const axios = require('axios');
const app = express();

require('dotenv').config();

// API configuration for Recall.ai
const RECALLAI_API_URL = process.env.RECALLAI_API_URL || 'https://api.recall.ai';
const RECALLAI_API_KEY = process.env.RECALLAI_API_KEY;

app.get('/start-recording', async (req, res) => {
    console.log(`Creating upload token with API key: ${RECALLAI_API_KEY}`);

    if (!RECALLAI_API_KEY) {
        console.error("RECALLAI_API_KEY is missing! Set it in .env file");
        return res.json({ status: 'error', message: 'RECALLAI_API_KEY is missing' });
    }

    const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`;

    try {
        const response = await axios.post(url, {
            recording_config: {
                transcript: {
                    provider: {
                        deepgram_streaming: {
                            "model": "nova-3",
                            "version": "latest",
                            "language": "en-US",
                            "punctuate": true,
                            "filler_words": false,
                            "profanity_filter": false,
                            "redact": [],
                            "diarize": true,
                            "smart_format": true,
                            "interim_results": false
                        }
                    }
                },
                realtime_endpoints: [
                    {
                        type: "desktop-sdk-callback",
                        events: [
                            "participant_events.join",
                            "video_separate_png.data",
                            "transcript.data",
                            "transcript.provider_data"
                        ]
                    },
                ],
            }
        }, {
            headers: { 'Authorization': `Token ${RECALLAI_API_KEY}` },
            timeout: 9000,
        });

        res.json({ status: 'success', upload_token: response.data.upload_token });
    } catch (e) {
        res.json({ status: 'error', message: e.message });
    }
});

const port = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server listening on http://localhost:${port}`);
    });
}

module.exports = app;
