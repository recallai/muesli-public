# Muesli

This is a demo application that shows off what you can build with the [Recall.ai Desktop Recording SDK.](https://www.recall.ai/product/desktop-recording-sdk)

This repo is intended to be a mockup of the kind of experience you can build using the Desktop Recording SDK. If you just want a minimal, easily-runnable example to use as a template for your project, or just want to see the bare minimum Desktop Recording SDK integration, check out one of the other sample applications:

* https://github.com/recallai/desktop-sdk-electron-vite-sample
* https://github.com/recallai/desktop-sdk-electron-webpack-sample

# Setup

Modify `.env` to include your Recall.ai API key:

```
RECALLAI_API_KEY=<your key>
```

Additionally, this project by default tries to do live transcription using Deepgram; you'll need to configure your Deepgram credential on the [Recall.ai dashboard!](https://www.recall.ai/login)

If you want to enable the AI summary after a recording is finished, you can specify an OpenRouter API key.

```
OPENROUTER_KEY=<your key>
```

To launch:

```sh
npm install
npm start
```

# Screenshots

![Screenshot 2025-06-16 at 10 10 57 PM](https://github.com/user-attachments/assets/9df12246-b5be-466d-958e-e09ff0b4b3cb)
![Screenshot 2025-06-16 at 10 22 44 PM](https://github.com/user-attachments/assets/685f13ab-7c02-4f29-a987-830d331c4d36)
![Screenshot 2025-06-16 at 10 14 38 PM](https://github.com/user-attachments/assets/75817823-084c-46b0-bbe8-e0195a3f9051)
