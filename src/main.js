const {
	app,
	BrowserWindow,
	ipcMain,
	protocol,
	Notification,
} = require("electron");
const path = require("node:path");
const url = require("url");
const fs = require("fs");
const RecallAiSdk = require("@recallai/desktop-sdk");
const axios = require("axios");
const OpenAI = require("openai");
const sdkLogger = require("./sdk-logger");
require("dotenv").config();

// Function to get the OpenRouter headers
function getHeaderLines() {
	return [
		"HTTP-Referer: https://recall.ai", // Replace with your actual app's URL
		"X-Title: Muesli AI Notetaker",
	];
}

// Initialize OpenAI client with OpenRouter as the base URL
const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_KEY || "your-default-key",
	defaultHeaders: {
		"HTTP-Referer": "https://recall.ai",
		"X-Title": "Muesli AI Notetaker",
	},
});

// Define available models with their capabilities
const MODELS = {
	// Primary models
	PRIMARY: "anthropic/claude-3.7-sonnet",
	FALLBACKS: [],
};

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
	app.quit();
}

// Store detected meeting information
let detectedMeeting = null;

let mainWindow;

const createWindow = () => {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		width: 1024,
		height: 768,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
		titleBarStyle: "hiddenInset",
		backgroundColor: "#f9f9f9",
	});

	// Allow the debug panel header to act as a drag region
	mainWindow.on("ready-to-show", () => {
		try {
			// Set regions that can be used to drag the window
			if (process.platform === "darwin") {
				// Only needed on macOS
				mainWindow.setWindowButtonVisibility(true);
			}
		} catch (error) {
			console.error("Error setting drag regions:", error);
		}
	});

	// and load the index.html of the app.
	mainWindow.loadFile(path.join(__dirname, "index.html"));

	// Open the DevTools in development
	if (process.env.NODE_ENV === "development") {
		// mainWindow.webContents.openDevTools();
	}

	// Listen for navigation events
	ipcMain.on("navigate", (event, page) => {
		if (page === "note-editor") {
			mainWindow.loadFile(path.join(__dirname, "note-editor", "index.html"));
		} else if (page === "home") {
			mainWindow.loadFile(path.join(__dirname, "index.html"));
		}
	});
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
	console.log("Registering IPC handlers...");
	// Log all registered IPC handlers
	console.log("IPC handlers:", Object.keys(ipcMain._invokeHandlers));

	// Set up SDK logger IPC handlers
	ipcMain.on("sdk-log", (event, logEntry) => {
		// Forward logs from renderer to any open windows
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("sdk-log", logEntry);
		}
	});

	// Set up logger event listener to send logs from main to renderer
	sdkLogger.onLog((logEntry) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("sdk-log", logEntry);
		}
	});

	// Create recordings directory if it doesn't exist
	try {
		if (!fs.existsSync(RECORDING_PATH)) {
			fs.mkdirSync(RECORDING_PATH, { recursive: true });
		}
	} catch (e) {
		console.error("Couldn't create the recording path:", e);
	}

	// Initialize the Recall.ai SDK
	initSDK();

	createWindow();

	// When the window is ready, send the initial meeting detection status
	mainWindow.webContents.on("did-finish-load", () => {
		// Send the initial meeting detection status
		mainWindow.webContents.send("meeting-detection-status", {
			detected: detectedMeeting !== null,
		});
	});

	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

// Path to meetings data file in the user's Application Support directory
const meetingsFilePath = path.join(app.getPath("userData"), "meetings.json");

// Path for RecallAI SDK recordings
const RECORDING_PATH = path.join(app.getPath("userData"), "recordings");

// Global state to track active recordings
const activeRecordings = {
	// Map of recordingId -> {noteId, platform, state}
	recordings: {},

	// Register a new recording
	addRecording: function (recordingId, noteId, platform = "unknown") {
		this.recordings[recordingId] = {
			noteId,
			platform,
			state: "recording",
			startTime: new Date(),
		};
		console.log(
			`Recording registered in global state: ${recordingId} for note ${noteId}`
		);
	},

	// Update a recording's state
	updateState: function (recordingId, state) {
		if (this.recordings[recordingId]) {
			this.recordings[recordingId].state = state;
			console.log(`Recording ${recordingId} state updated to: ${state}`);
			return true;
		}
		return false;
	},

	// Remove a recording
	removeRecording: function (recordingId) {
		if (this.recordings[recordingId]) {
			delete this.recordings[recordingId];
			console.log(`Recording ${recordingId} removed from global state`);
			return true;
		}
		return false;
	},

	// Get active recording for a note
	getForNote: function (noteId) {
		for (const [recordingId, info] of Object.entries(this.recordings)) {
			if (info.noteId === noteId) {
				return { recordingId, ...info };
			}
		}
		return null;
	},

	// Get all active recordings
	getAll: function () {
		return { ...this.recordings };
	},
};

// File operation manager to prevent race conditions on both reads and writes
const fileOperationManager = {
	isProcessing: false,
	pendingOperations: [],
	cachedData: null,
	lastReadTime: 0,

	// Read the meetings data with caching to reduce file I/O
	readMeetingsData: async function () {
		// If we have cached data that's recent (less than 500ms old), use it
		const now = Date.now();
		if (this.cachedData && now - this.lastReadTime < 500) {
			return JSON.parse(JSON.stringify(this.cachedData)); // Deep clone
		}

		try {
			// Read from file
			const fileData = await fs.promises.readFile(meetingsFilePath, "utf8");
			const data = JSON.parse(fileData);

			// Update cache
			this.cachedData = data;
			this.lastReadTime = now;

			return data;
		} catch (error) {
			console.error("Error reading meetings data:", error);

			// If file doesn't exist, create it with default structure
			if (error.code === "ENOENT") {
				console.log("Creating default meetings.json file...");
				const defaultData = { upcomingMeetings: [], pastMeetings: [] };

				try {
					// Ensure the user data directory exists
					const userDataDir = path.dirname(meetingsFilePath);
					await fs.promises.mkdir(userDataDir, { recursive: true });

					// Create the default file
					await fs.promises.writeFile(
						meetingsFilePath,
						JSON.stringify(defaultData, null, 2),
						"utf8"
					);
					console.log("Default meetings.json file created successfully");

					// Update cache
					this.cachedData = defaultData;
					this.lastReadTime = now;

					return defaultData;
				} catch (createError) {
					console.error(
						"Error creating default meetings.json file:",
						createError
					);
					// If we can't create the file, still return default data
					return defaultData;
				}
			}

			// For other errors (like JSON parse errors), return empty structure
			return { upcomingMeetings: [], pastMeetings: [] };
		}
	},

	// Schedule an operation that needs to update the meetings data
	scheduleOperation: async function (operationFn) {
		return new Promise((resolve, reject) => {
			// Add this operation to the queue
			this.pendingOperations.push({
				operationFn, // This function will receive the current data and return updated data
				resolve,
				reject,
			});

			// Process the queue if not already processing
			if (!this.isProcessing) {
				this.processQueue();
			}
		});
	},

	// Process the operation queue sequentially
	processQueue: async function () {
		if (this.pendingOperations.length === 0 || this.isProcessing) {
			return;
		}

		this.isProcessing = true;

		try {
			// Get the next operation
			const nextOp = this.pendingOperations.shift();

			// Read the latest data
			const currentData = await this.readMeetingsData();

			try {
				// Execute the operation function with the current data
				const updatedData = await nextOp.operationFn(currentData);

				// If the operation returned data, write it
				if (updatedData) {
					// Update cache immediately
					this.cachedData = updatedData;
					this.lastReadTime = Date.now();

					// Write to file
					await fs.promises.writeFile(
						meetingsFilePath,
						JSON.stringify(updatedData, null, 2)
					);
				}

				// Resolve the operation's promise
				nextOp.resolve({ success: true });
			} catch (opError) {
				console.error("Error in file operation:", opError);
				nextOp.reject(opError);
			}
		} catch (error) {
			console.error("Error in file operation manager:", error);

			// If there was an operation that failed, reject its promise
			if (this.pendingOperations.length > 0) {
				const failedOp = this.pendingOperations.shift();
				failedOp.reject(error);
			}
		} finally {
			this.isProcessing = false;

			// Check if more operations were added while we were processing
			if (this.pendingOperations.length > 0) {
				setImmediate(() => this.processQueue());
			}
		}
	},

	// Helper to write data directly - internally uses scheduleOperation
	writeData: async function (data) {
		return this.scheduleOperation(() => data); // Simply return the data to write
	},
};

// API configuration for Recall.ai
const RECALLAI_API_URL =
	process.env.RECALLAI_API_URL || "https://api.recall.ai";
const RECALLAI_API_KEY = process.env.RECALLAI_API_KEY || "your-default-key";

// Create a desktop SDK upload token
async function createDesktopSdkUpload() {
	try {
		console.log(`Creating upload token with API key: ${RECALLAI_API_KEY}`);

		if (!RECALLAI_API_KEY) {
			console.error("RECALLAI_API_KEY is missing! Set it in .env file");
			return null;
		}

		const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`;

		const response = await axios.post(
			url,
			{
				recording_config: {
					transcript: {
						provider: {
							deepgram_streaming: {
								model: "nova-3",
								version: "latest",
								language: "en-US",
								punctuate: true,
								filler_words: false,
								profanity_filter: false,
								redact: [],
								diarize: true,
								smart_format: true,
								interim_results: false,
							},
						},
					},
					realtime_endpoints: [
						{
							type: "desktop-sdk-callback",
							events: [
								"participant_events.join",
								"video_separate_png.data",
								"transcript.data",
								"transcript.provider_data",
							],
						},
					],
				},
			},
			{
				headers: { Authorization: `Token ${RECALLAI_API_KEY}` },
				timeout: 9000,
			}
		);

		console.log(
			"Upload token created successfully:",
			response.data.upload_token
		);
		return response.data;
	} catch (error) {
		console.error("Error creating upload token:", error.message);
		if (error.response) {
			console.error("Response data:", error.response.data);
			console.error("Response status:", error.response.status);
		}
		return null;
	}
}

// Initialize the Recall.ai SDK
function initSDK() {
	console.log("Initializing Recall.ai SDK");

	// Log the SDK initialization
	sdkLogger.logApiCall("init", {
		dev: process.env.NODE_ENV === "development",
		api_url: RECALLAI_API_URL,
		config: {
			recording_path: RECORDING_PATH,
		},
	});

	RecallAiSdk.init({
		// dev: true,
		api_url: RECALLAI_API_URL,
		config: {
			recording_path: RECORDING_PATH,
		},
	});

	// Listen for meeting detected events
	RecallAiSdk.addEventListener("meeting-detected", (evt) => {
		console.log("Meeting detected:", evt);

		// Log the meeting detected event
		sdkLogger.logEvent("meeting-detected", {
			platform: evt.window.platform,
			windowId: evt.window.id,
		});

		detectedMeeting = evt;

		// Map platform codes to readable names
		const platformNames = {
			zoom: "Zoom",
			"google-meet": "Google Meet",
			slack: "Slack",
			teams: "Microsoft Teams",
		};

		// Get a user-friendly platform name, or use the raw platform name if not in our map
		const platformName =
			platformNames[evt.window.platform] || evt.window.platform;

		// Send a notification
		let notification = new Notification({
			title: `${platformName} Meeting Detected`,
			body: platformName,
		});

		// Handle notification click
		notification.on("click", () => {
			console.log("Notification clicked for platform:", platformName);
			joinDetectedMeeting();
		});

		notification.show();

		// Send the meeting detected status to the renderer process
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("meeting-detection-status", {
				detected: true,
			});
		}
	});

	// Listen for meeting closed events
	RecallAiSdk.addEventListener("meeting-closed", (evt) => {
		console.log("Meeting closed:", evt);

		// Log the SDK meeting-closed event
		sdkLogger.logEvent("meeting-closed", {
			windowId: evt.window.id,
		});

		// Clean up the global tracking when a meeting ends
		if (
			evt.window &&
			evt.window.id &&
			global.activeMeetingIds &&
			global.activeMeetingIds[evt.window.id]
		) {
			console.log(`Cleaning up meeting tracking for: ${evt.window.id}`);
			delete global.activeMeetingIds[evt.window.id];
		}

		detectedMeeting = null;

		// Send the meeting closed status to the renderer process
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("meeting-detection-status", {
				detected: false,
			});
		}
	});

	// Listen for recording ended events
	RecallAiSdk.addEventListener("recording-ended", async (evt) => {
		console.log("Recording ended:", evt);

		// Log the SDK recording-ended event
		sdkLogger.logEvent("recording-ended", {
			windowId: evt.window.id,
		});

		try {
			// Update the note with recording information
			await updateNoteWithRecordingInfo(evt.window.id);

			// Add a small delay before uploading (good practice for file system operations)
			setTimeout(async () => {
				try {
					// Try to get a new upload token for the upload if needed
					const uploadData = await createDesktopSdkUpload();

					if (uploadData && uploadData.upload_token) {
						console.log(
							"Uploading recording with new upload token:",
							uploadData.upload_token
						);

						// Log the uploadRecording API call
						sdkLogger.logApiCall("uploadRecording", {
							windowId: evt.window.id,
							uploadToken: `${uploadData.upload_token.substring(0, 8)}...`, // Log truncated token for security
						});

						RecallAiSdk.uploadRecording({
							windowId: evt.window.id,
							uploadToken: uploadData.upload_token,
						});
					} else {
						// Fallback to regular upload
						console.log("Uploading recording without new token");

						// Log the uploadRecording API call (fallback)
						sdkLogger.logApiCall("uploadRecording", {
							windowId: evt.window.id,
						});

						RecallAiSdk.uploadRecording({ windowId: evt.window.id });
					}
				} catch (uploadError) {
					console.error("Error during upload:", uploadError);
					// Fallback to regular upload

					// Log the uploadRecording API call (error fallback)
					sdkLogger.logApiCall("uploadRecording", {
						windowId: evt.window.id,
						error: "Fallback after error",
					});

					RecallAiSdk.uploadRecording({ windowId: evt.window.id });
				}
			}, 3000); // Wait 3 seconds before uploading
		} catch (error) {
			console.error("Error handling recording ended:", error);
		}
	});

	RecallAiSdk.addEventListener("permissions-granted", async (evt) => {
		console.log("PERMISSIONS GRANTED");
	});

	// Track upload progress
	RecallAiSdk.addEventListener("upload-progress", async (evt) => {
		const { progress, window } = evt;
		console.log(`Upload progress: ${progress}%`);

		// Log the SDK upload-progress event
		// sdkLogger.logEvent('upload-progress', {
		//   windowId: window.id,
		//   progress
		// });

		// Update the note with upload progress if needed
		if (progress === 100) {
			console.log(`Upload completed for recording: ${window.id}`);
			// Could update the note here with upload completion status
		}
	});

	// Track SDK state changes
	RecallAiSdk.addEventListener("sdk-state-change", async (evt) => {
		const {
			sdk: {
				state: { code },
			},
			window,
		} = evt;
		console.log("Recording state changed:", code, "for window:", window?.id);

		// Log the SDK sdk-state-change event
		sdkLogger.logEvent("sdk-state-change", {
			state: code,
			windowId: window?.id,
		});

		// Update recording state in our global tracker
		if (window && window.id) {
			// Get the meeting note ID associated with this window
			let noteId = null;
			if (global.activeMeetingIds && global.activeMeetingIds[window.id]) {
				noteId = global.activeMeetingIds[window.id].noteId;
			}

			// Update the recording state in our tracker
			if (code === "recording") {
				console.log("Recording in progress...");
				if (noteId) {
					// If recording started, add it to our active recordings
					activeRecordings.addRecording(
						window.id,
						noteId,
						window.platform || "unknown"
					);
				}
			} else if (code === "paused") {
				console.log("Recording paused");
				activeRecordings.updateState(window.id, "paused");
			} else if (code === "idle") {
				console.log("Recording stopped");
				activeRecordings.removeRecording(window.id);
			}

			// Notify renderer process about recording state change
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("recording-state-change", {
					recordingId: window.id,
					state: code,
					noteId,
				});
			}
		}
	});

	// Listen for real-time transcript events
	RecallAiSdk.addEventListener("realtime-event", async (evt) => {
		// Only log non-video frame events to prevent flooding the logger
		if (evt.event !== "video_separate_png.data") {
			console.log("Received realtime event:", evt.event);

			// Log the SDK realtime-event event
			sdkLogger.logEvent("realtime-event", {
				eventType: evt.event,
				windowId: evt.window?.id,
			});
		}

		// Handle different event types
		if (evt.event === "transcript.data" && evt.data && evt.data.data) {
			await processTranscriptData(evt);
		} else if (
			evt.event === "transcript.provider_data" &&
			evt.data &&
			evt.data.data
		) {
			await processTranscriptProviderData(evt);
		} else if (
			evt.event === "participant_events.join" &&
			evt.data &&
			evt.data.data
		) {
			await processParticipantJoin(evt);
		} else if (
			evt.event === "video_separate_png.data" &&
			evt.data &&
			evt.data.data
		) {
			await processVideoFrame(evt);
		}
	});

	// Handle errors
	RecallAiSdk.addEventListener("error", async (evt) => {
		console.error("RecallAI SDK Error:", evt);
		const { type, message } = evt;

		// Log the SDK error event
		sdkLogger.logEvent("error", {
			errorType: type,
			errorMessage: message,
		});

		// Show notification for errors
		let notification = new Notification({
			title: "Recording Error",
			body: `Error: ${type} - ${message}`,
		});
		notification.show();
	});
}

// Handle saving meetings data
ipcMain.handle("saveMeetingsData", async (event, data) => {
	try {
		// Use the file operation manager to safely write the file
		await fileOperationManager.writeData(data);
		return { success: true };
	} catch (error) {
		console.error("Failed to save meetings data:", error);
		return { success: false, error: error.message };
	}
});

// Debug handler to check if IPC handlers are registered
ipcMain.handle("debugGetHandlers", async () => {
	console.log("Checking registered IPC handlers...");
	const handlers = Object.keys(ipcMain._invokeHandlers);
	console.log("Registered handlers:", handlers);
	return handlers;
});

// Handler to get active recording ID for a note
ipcMain.handle("getActiveRecordingId", async (event, noteId) => {
	console.log(`getActiveRecordingId called for note: ${noteId}`);

	try {
		// If noteId is provided, get recording for that specific note
		if (noteId) {
			const recordingInfo = activeRecordings.getForNote(noteId);
			return {
				success: true,
				data: recordingInfo,
			};
		}

		// Otherwise return all active recordings
		return {
			success: true,
			data: activeRecordings.getAll(),
		};
	} catch (error) {
		console.error("Error getting active recording ID:", error);
		return { success: false, error: error.message };
	}
});

// Handle deleting a meeting
ipcMain.handle("deleteMeeting", async (event, meetingId) => {
	try {
		console.log(`Deleting meeting with ID: ${meetingId}`);

		// Read current data
		const fileData = await fs.promises.readFile(meetingsFilePath, "utf8");
		const meetingsData = JSON.parse(fileData);

		// Find the meeting
		const pastMeetingIndex = meetingsData.pastMeetings.findIndex(
			(meeting) => meeting.id === meetingId
		);
		const upcomingMeetingIndex = meetingsData.upcomingMeetings.findIndex(
			(meeting) => meeting.id === meetingId
		);

		let meetingDeleted = false;
		let recordingId = null;

		// Remove from past meetings if found
		if (pastMeetingIndex !== -1) {
			// Store the recording ID for later cleanup if needed
			recordingId = meetingsData.pastMeetings[pastMeetingIndex].recordingId;

			// Remove the meeting
			meetingsData.pastMeetings.splice(pastMeetingIndex, 1);
			meetingDeleted = true;
		}

		// Remove from upcoming meetings if found
		if (upcomingMeetingIndex !== -1) {
			// Store the recording ID for later cleanup if needed
			recordingId =
				meetingsData.upcomingMeetings[upcomingMeetingIndex].recordingId;

			// Remove the meeting
			meetingsData.upcomingMeetings.splice(upcomingMeetingIndex, 1);
			meetingDeleted = true;
		}

		if (!meetingDeleted) {
			return { success: false, error: "Meeting not found" };
		}

		// Save the updated data
		await fileOperationManager.writeData(meetingsData);

		// If the meeting had a recording, cleanup the reference in the global tracking
		if (
			recordingId &&
			global.activeMeetingIds &&
			global.activeMeetingIds[recordingId]
		) {
			console.log(
				`Cleaning up tracking for deleted meeting with recording ID: ${recordingId}`
			);
			delete global.activeMeetingIds[recordingId];
		}

		console.log(`Successfully deleted meeting: ${meetingId}`);
		return { success: true };
	} catch (error) {
		console.error("Error deleting meeting:", error);
		return { success: false, error: error.message };
	}
});

// Handle generating AI summary for a meeting (non-streaming)
ipcMain.handle("generateMeetingSummary", async (event, meetingId) => {
	try {
		console.log(
			`Manual summary generation requested for meeting: ${meetingId}`
		);

		// Read current data
		const fileData = await fs.promises.readFile(meetingsFilePath, "utf8");
		const meetingsData = JSON.parse(fileData);

		// Find the meeting
		const pastMeetingIndex = meetingsData.pastMeetings.findIndex(
			(meeting) => meeting.id === meetingId
		);

		if (pastMeetingIndex === -1) {
			return { success: false, error: "Meeting not found" };
		}

		const meeting = meetingsData.pastMeetings[pastMeetingIndex];

		// Check if there's a transcript to summarize
		if (!meeting.transcript || meeting.transcript.length === 0) {
			return {
				success: false,
				error: "No transcript available for this meeting",
			};
		}

		// Log summary generation to console instead of showing a notification
		console.log("Generating AI summary for meeting: " + meetingId);

		// Generate the summary
		const summary = await generateMeetingSummary(meeting);

		// Get meeting title for use in the new content
		const meetingTitle = meeting.title || "Meeting Notes";

		// Get recording ID
		const recordingId = meeting.recordingId;

		// Check for different possible video file patterns
		const possibleFilePaths = recordingId
			? [
					path.join(RECORDING_PATH, `${recordingId}.mp4`),
					path.join(RECORDING_PATH, `macos-desktop-${recordingId}.mp4`),
					path.join(RECORDING_PATH, `macos-desktop${recordingId}.mp4`),
					path.join(RECORDING_PATH, `desktop-${recordingId}.mp4`),
			  ]
			: [];

		// Find the first video file that exists
		let videoExists = false;
		let videoFilePath = null;

		try {
			for (const filePath of possibleFilePaths) {
				if (fs.existsSync(filePath)) {
					videoExists = true;
					videoFilePath = filePath;
					console.log(`Found video file at: ${videoFilePath}`);
					break;
				}
			}
		} catch (err) {
			console.error("Error checking for video files:", err);
		}

		// Create content with the AI-generated summary
		meeting.content = `# ${meetingTitle}\n\n${summary}`;

		// If video exists, store the path separately but don't add it to the content
		if (videoExists) {
			meeting.videoPath = videoFilePath; // Store the path for future reference
			console.log(`Stored video path in meeting object: ${videoFilePath}`);
		} else {
			console.log("Video file not found or no recording ID");
		}

		meeting.hasSummary = true;

		// Save the updated data with summary
		await fileOperationManager.writeData(meetingsData);

		console.log("Updated meeting note with AI summary");

		// Notify the renderer to refresh the note if it's open
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("summary-generated", meetingId);
		}

		return {
			success: true,
			summary,
		};
	} catch (error) {
		console.error("Error generating meeting summary:", error);
		return { success: false, error: error.message };
	}
});

// Handle starting a manual desktop recording
ipcMain.handle("startManualRecording", async (event, meetingId) => {
	try {
		console.log(`Starting manual desktop recording for meeting: ${meetingId}`);

		// Read current data
		const fileData = await fs.promises.readFile(meetingsFilePath, "utf8");
		const meetingsData = JSON.parse(fileData);

		// Find the meeting
		const pastMeetingIndex = meetingsData.pastMeetings.findIndex(
			(meeting) => meeting.id === meetingId
		);

		if (pastMeetingIndex === -1) {
			return { success: false, error: "Meeting not found" };
		}

		const meeting = meetingsData.pastMeetings[pastMeetingIndex];

		try {
			// Prepare desktop audio recording - this is the key difference from our previous implementation
			// It returns a key that we use as the window ID

			// Log the prepareDesktopAudioRecording API call
			sdkLogger.logApiCall("prepareDesktopAudioRecording");

			const key = await RecallAiSdk.prepareDesktopAudioRecording();
			console.log("Prepared desktop audio recording with key:", key);

			// Create a recording token
			const uploadData = await createDesktopSdkUpload();
			if (!uploadData || !uploadData.upload_token) {
				return { success: false, error: "Failed to create recording token" };
			}

			// Store the recording ID in the meeting
			meeting.recordingId = key;

			// Initialize transcript array if not present
			if (!meeting.transcript) {
				meeting.transcript = [];
			}

			// Store tracking info for the recording
			global.activeMeetingIds = global.activeMeetingIds || {};
			global.activeMeetingIds[key] = {
				platformName: "Desktop Recording",
				noteId: meetingId,
			};

			// Register the recording in our active recordings tracker
			activeRecordings.addRecording(key, meetingId, "Desktop Recording");

			// Save the updated data
			await fileOperationManager.writeData(meetingsData);

			// Start recording with the key from prepareDesktopAudioRecording
			console.log("Starting desktop recording with key:", key);

			// Log the startRecording API call
			sdkLogger.logApiCall("startRecording", {
				windowId: key,
				uploadToken: `${uploadData.upload_token.substring(0, 8)}...`, // Log truncated token for security
			});

			RecallAiSdk.startRecording({
				windowId: key,
				uploadToken: uploadData.upload_token,
			});

			return {
				success: true,
				recordingId: key,
			};
		} catch (sdkError) {
			console.error("RecallAI SDK error:", sdkError);
			return {
				success: false,
				error: "Failed to prepare desktop recording: " + sdkError.message,
			};
		}
	} catch (error) {
		console.error("Error starting manual recording:", error);
		return { success: false, error: error.message };
	}
});

// Handle stopping a manual desktop recording
ipcMain.handle("stopManualRecording", async (event, recordingId) => {
	try {
		console.log(`Stopping manual desktop recording: ${recordingId}`);

		// Stop the recording - using the windowId property as shown in the reference

		// Log the stopRecording API call
		sdkLogger.logApiCall("stopRecording", {
			windowId: recordingId,
		});

		// Update our active recordings tracker
		activeRecordings.updateState(recordingId, "stopping");

		RecallAiSdk.stopRecording({
			windowId: recordingId,
		});

		// The recording-ended event will be triggered automatically,
		// which will handle uploading and generating the summary

		return { success: true };
	} catch (error) {
		console.error("Error stopping manual recording:", error);
		return { success: false, error: error.message };
	}
});

// Handle generating AI summary with streaming
ipcMain.handle("generateMeetingSummaryStreaming", async (event, meetingId) => {
	try {
		console.log(
			`Streaming summary generation requested for meeting: ${meetingId}`
		);

		// Read current data
		const fileData = await fs.promises.readFile(meetingsFilePath, "utf8");
		const meetingsData = JSON.parse(fileData);

		// Find the meeting
		const pastMeetingIndex = meetingsData.pastMeetings.findIndex(
			(meeting) => meeting.id === meetingId
		);

		if (pastMeetingIndex === -1) {
			return { success: false, error: "Meeting not found" };
		}

		const meeting = meetingsData.pastMeetings[pastMeetingIndex];

		// Check if there's a transcript to summarize
		if (!meeting.transcript || meeting.transcript.length === 0) {
			return {
				success: false,
				error: "No transcript available for this meeting",
			};
		}

		// Log summary generation to console instead of showing a notification
		console.log("Generating streaming summary for meeting: " + meetingId);

		// Get meeting title for use in the new content
		const meetingTitle = meeting.title || "Meeting Notes";

		// Initial content with placeholders
		meeting.content = `# ${meetingTitle}\n\nGenerating summary...`;

		// Update the note on the frontend right away
		mainWindow.webContents.send("summary-update", {
			meetingId,
			content: meeting.content,
		});

		// Create progress callback for streaming updates
		const streamProgress = (currentText) => {
			// Update content with current streaming text
			meeting.content = `# ${meetingTitle}\n\n## AI-Generated Meeting Summary\n${currentText}`;

			// Send immediate update to renderer - don't debounce or delay this
			if (mainWindow && !mainWindow.isDestroyed()) {
				try {
					// Force immediate send of the update
					mainWindow.webContents.send("summary-update", {
						meetingId,
						content: meeting.content,
						timestamp: Date.now(), // Add timestamp to ensure uniqueness
					});
				} catch (err) {
					console.error("Error sending streaming update to renderer:", err);
				}
			}
		};

		// Generate summary with streaming
		const summary = await generateMeetingSummary(meeting, streamProgress);

		// Make sure the final content is set correctly
		meeting.content = `# ${meetingTitle}\n\n${summary}`;
		meeting.hasSummary = true;

		// Save the updated data with summary
		await fileOperationManager.writeData(meetingsData);

		console.log("Updated meeting note with AI summary (streaming)");

		// Final notification to renderer
		mainWindow.webContents.send("summary-generated", meetingId);

		return {
			success: true,
			summary,
		};
	} catch (error) {
		console.error("Error generating streaming summary:", error);
		return { success: false, error: error.message };
	}
});

// Handle loading meetings data
ipcMain.handle("loadMeetingsData", async () => {
	try {
		// Use our file operation manager to safely read the data
		const data = await fileOperationManager.readMeetingsData();

		// Return the data
		return {
			success: true,
			data: data,
		};
	} catch (error) {
		console.error("Failed to load meetings data:", error);
		return { success: false, error: error.message };
	}
});

// Function to create a new meeting note and start recording
async function createMeetingNoteAndRecord(platformName) {
	console.log("Creating meeting note for platform:", platformName);
	try {
		if (!detectedMeeting) {
			console.error("No active meeting detected");
			return;
		}
		console.log(
			"Detected meeting info:",
			detectedMeeting.window.id,
			detectedMeeting.window.platform
		);

		// Store the meeting window ID for later reference with transcript events
		global.activeMeetingIds = global.activeMeetingIds || {};
		global.activeMeetingIds[detectedMeeting.window.id] = { platformName };

		// Read the current meetings data
		let meetingsData;
		try {
			const fileData = await fs.promises.readFile(meetingsFilePath, "utf8");
			meetingsData = JSON.parse(fileData);
		} catch (error) {
			console.error("Error reading meetings data:", error);
			meetingsData = { upcomingMeetings: [], pastMeetings: [] };
		}

		// Generate a unique ID for the new meeting
		const id = "meeting-" + Date.now();

		// Current date and time
		const now = new Date();

		// Create a template for the note content
		const template = `# ${platformName} Meeting Notes\nRecording: In Progress...`;

		// Create a new meeting object
		const newMeeting = {
			id: id,
			type: "document",
			title: `${platformName} Meeting - ${now.toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})}`,
			subtitle: now.toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			}),
			hasDemo: false,
			date: now.toISOString(),
			participants: [],
			content: template,
			recordingId: detectedMeeting.window.id,
			platform: platformName,
			transcript: [], // Initialize an empty array for transcript data
		};

		// Update the active meeting tracking with the note ID
		if (
			global.activeMeetingIds &&
			global.activeMeetingIds[detectedMeeting.window.id]
		) {
			global.activeMeetingIds[detectedMeeting.window.id].noteId = id;
		}

		// Register this meeting in our active recordings tracker (even before starting)
		// This ensures the UI knows about it immediately
		activeRecordings.addRecording(detectedMeeting.window.id, id, platformName);

		// Add to pastMeetings
		meetingsData.pastMeetings.unshift(newMeeting);

		// Save the updated data
		console.log(`Saving meeting data to ${meetingsFilePath} with ID: ${id}`);
		await fileOperationManager.writeData(meetingsData);

		// Verify the file was written by reading it back
		try {
			const verifyData = await fs.promises.readFile(meetingsFilePath, "utf8");
			const parsedData = JSON.parse(verifyData);
			const verifyMeeting = parsedData.pastMeetings.find((m) => m.id === id);

			if (verifyMeeting) {
				console.log(`Successfully verified meeting ${id} was saved`);

				// Tell the renderer to open the new note
				if (mainWindow && !mainWindow.isDestroyed()) {
					// We need a significant delay to make sure the file is fully processed and loaded
					// This ensures the renderer has time to process the file and recognize the new meeting
					setTimeout(async () => {
						try {
							// Force a file reload before sending the message
							await fs.promises.readFile(meetingsFilePath, "utf8");

							console.log(`Sending IPC message to open meeting note: ${id}`);
							mainWindow.webContents.send("open-meeting-note", id);

							// Send another message after 2 seconds as a backup
							setTimeout(() => {
								console.log(
									`Sending backup IPC message to open meeting note: ${id}`
								);
								mainWindow.webContents.send("open-meeting-note", id);
							}, 2000);
						} catch (error) {
							console.error(
								"Error before sending open-meeting-note message:",
								error
							);
						}
					}, 1500); // Increased delay for safety
				}
			} else {
				console.error(`Meeting ${id} not found in saved data!`);
			}
		} catch (verifyError) {
			console.error("Error verifying saved data:", verifyError);
		}

		// Start recording with upload token
		console.log("Starting recording for meeting:", detectedMeeting.window.id);

		try {
			// Get upload token
			const uploadData = await createDesktopSdkUpload();

			if (!uploadData || !uploadData.upload_token) {
				console.error(
					"Failed to get upload token. Recording without upload token."
				);

				// Log the startRecording API call (no token fallback)
				sdkLogger.logApiCall("startRecording", {
					windowId: detectedMeeting.window.id,
				});

				RecallAiSdk.startRecording({
					windowId: detectedMeeting.window.id,
				});
			} else {
				console.log(
					"Starting recording with upload token:",
					uploadData.upload_token
				);

				// Log the startRecording API call with upload token
				sdkLogger.logApiCall("startRecording", {
					windowId: detectedMeeting.window.id,
					uploadToken: `${uploadData.upload_token.substring(0, 8)}...`, // Log truncated token for security
				});

				RecallAiSdk.startRecording({
					windowId: detectedMeeting.window.id,
					uploadToken: uploadData.upload_token,
				});
			}
		} catch (error) {
			console.error("Error starting recording with upload token:", error);

			// Fallback to recording without token

			// Log the startRecording API call (error fallback)
			sdkLogger.logApiCall("startRecording", {
				windowId: detectedMeeting.window.id,
				error: "Fallback after error",
			});

			RecallAiSdk.startRecording({
				windowId: detectedMeeting.window.id,
			});
		}

		return id;
	} catch (error) {
		console.error("Error creating meeting note:", error);
	}
}

// Function to process video frames
async function processVideoFrame(evt) {
	try {
		const windowId = evt.window?.id;
		if (!windowId) {
			console.error("Missing window ID in video frame event");
			return;
		}

		// Check if we have this meeting in our active meetings
		if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
			console.log(`No active meeting found for window ID: ${windowId}`);
			return;
		}

		const noteId = global.activeMeetingIds[windowId].noteId;
		if (!noteId) {
			console.log(`No note ID found for window ID: ${windowId}`);
			return;
		}

		// Extract the video data
		const frameData = evt.data.data;
		if (!frameData || !frameData.buffer) {
			console.log("No video frame data in event");
			return;
		}

		// Get data from the event
		const frameBuffer = frameData.buffer; // base64 encoded PNG
		const frameTimestamp = frameData.timestamp;
		const frameType = frameData.type; // 'webcam' or 'screenshare'
		const participantData = frameData.participant;

		// Extract participant info
		const participantId = participantData?.id;
		const participantName = participantData?.name || "Unknown";

		// Log minimal info to avoid flooding the console
		// console.log(`Received ${frameType} frame from ${participantName} (ID: ${participantId}) at ${frameTimestamp.absolute}`);

		// Send the frame to the renderer
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("video-frame", {
				noteId,
				participantId,
				participantName,
				frameType,
				buffer: frameBuffer,
				timestamp: frameTimestamp,
			});
		}
	} catch (error) {
		console.error("Error processing video frame:", error);
	}
}

// Function to process participant join events
async function processParticipantJoin(evt) {
	try {
		const windowId = evt.window?.id;
		if (!windowId) {
			console.error("Missing window ID in participant join event");
			return;
		}

		// Check if we have this meeting in our active meetings
		if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
			console.log(`No active meeting found for window ID: ${windowId}`);
			return;
		}

		const noteId = global.activeMeetingIds[windowId].noteId;
		if (!noteId) {
			console.log(`No note ID found for window ID: ${windowId}`);
			return;
		}

		// Extract the participant data
		const participantData = evt.data.data.participant;
		if (!participantData) {
			console.log("No participant data in event");
			return;
		}

		const participantName = participantData.name || "Unknown Participant";
		const participantId = participantData.id;
		const isHost = participantData.is_host;
		const platform = participantData.platform;

		console.log(
			`Participant joined: ${participantName} (ID: ${participantId}, Host: ${isHost})`
		);

		// Skip "Host" and "Guest" generic names
		if (
			participantName === "Host" ||
			participantName === "Guest" ||
			participantName.includes("others") ||
			participantName.split(" ").length > 3
		) {
			console.log(`Skipping generic participant name: ${participantName}`);
			return;
		}

		// Use the file operation manager to safely update the meetings data
		await fileOperationManager.scheduleOperation(async (meetingsData) => {
			// Find the meeting note with this ID
			const noteIndex = meetingsData.pastMeetings.findIndex(
				(meeting) => meeting.id === noteId
			);
			if (noteIndex === -1) {
				console.log(`No meeting note found with ID: ${noteId}`);
				return null; // Return null to indicate no changes needed
			}

			// Get the meeting and initialize participants array if needed
			const meeting = meetingsData.pastMeetings[noteIndex];
			if (!meeting.participants) {
				meeting.participants = [];
			}

			// Check if participant already exists (based on ID)
			const existingParticipantIndex = meeting.participants.findIndex(
				(p) => p.id === participantId
			);

			if (existingParticipantIndex !== -1) {
				// Update existing participant
				meeting.participants[existingParticipantIndex] = {
					id: participantId,
					name: participantName,
					isHost: isHost,
					platform: platform,
					joinTime: new Date().toISOString(),
					status: "active",
				};
			} else {
				// Add new participant
				meeting.participants.push({
					id: participantId,
					name: participantName,
					isHost: isHost,
					platform: platform,
					joinTime: new Date().toISOString(),
					status: "active",
				});
			}

			console.log(`Added/updated participant data for meeting: ${noteId}`);

			// Notify the renderer if this note is currently being edited
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("participants-updated", noteId);
			}

			// Return the updated data to be written
			return meetingsData;
		});

		console.log(`Processed participant join event for meeting: ${noteId}`);
	} catch (error) {
		console.error("Error processing participant join event:", error);
	}
}

let currentUnknownSpeaker = -1;

async function processTranscriptProviderData(evt) {
	// let speakerId = evt.data.data.payload.
	try {
		if (
			evt.data.data.data.payload.channel.alternatives[0].words[0].speaker !==
			undefined
		) {
			currentUnknownSpeaker =
				evt.data.data.data.payload.channel.alternatives[0].words[0].speaker;
		}
	} catch (error) {
		// console.error("Error processing provider data:", error);
	}
}

// Function to process transcript data and store it with the meeting note
async function processTranscriptData(evt) {
	try {
		const windowId = evt.window?.id;
		if (!windowId) {
			console.error("Missing window ID in transcript event");
			return;
		}

		// Check if we have this meeting in our active meetings
		if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
			console.log(`No active meeting found for window ID: ${windowId}`);
			return;
		}

		const noteId = global.activeMeetingIds[windowId].noteId;
		if (!noteId) {
			console.log(`No note ID found for window ID: ${windowId}`);
			return;
		}

		// Extract the transcript data
		const words = evt.data.data.words || [];
		if (words.length === 0) {
			return; // No words to process
		}

		// Get speaker information
		let speaker;
		if (
			evt.data.data.participant?.name &&
			evt.data.data.participant?.name !== "Host" &&
			evt.data.data.participant?.name !== "Guest"
		) {
			speaker = evt.data.data.participant?.name;
		} else if (currentUnknownSpeaker !== -1) {
			speaker = `Speaker ${currentUnknownSpeaker}`;
		} else {
			speaker = "Unknown Speaker";
		}

		// Combine all words into a single text
		const text = words.map((word) => word.text).join(" ");

		console.log(`Transcript from ${speaker}: "${text}"`);

		// Use the file operation manager to safely update the meetings data
		await fileOperationManager.scheduleOperation(async (meetingsData) => {
			// Find the meeting note with this ID
			const noteIndex = meetingsData.pastMeetings.findIndex(
				(meeting) => meeting.id === noteId
			);
			if (noteIndex === -1) {
				console.log(`No meeting note found with ID: ${noteId}`);
				return null; // Return null to indicate no changes needed
			}

			// Add the transcript data
			const meeting = meetingsData.pastMeetings[noteIndex];

			// Initialize transcript array if it doesn't exist
			if (!meeting.transcript) {
				meeting.transcript = [];
			}

			// Add the new transcript entry
			meeting.transcript.push({
				text,
				speaker,
				timestamp: new Date().toISOString(),
			});

			console.log(`Added transcript data for meeting: ${noteId}`);

			// Notify the renderer if this note is currently being edited
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("transcript-updated", noteId);
			}

			// Return the updated data to be written
			return meetingsData;
		});

		console.log(`Processed transcript data for meeting: ${noteId}`);
	} catch (error) {
		console.error("Error processing transcript data:", error);
	}
}

// Function to generate AI summary from transcript with streaming support
async function generateMeetingSummary(meeting, progressCallback = null) {
	try {
		if (!meeting.transcript || meeting.transcript.length === 0) {
			console.log("No transcript available to summarize");
			return "No transcript available to summarize.";
		}

		console.log(`Generating AI summary for meeting: ${meeting.id}`);

		// Format the transcript into a single text for the AI to process
		const transcriptText = meeting.transcript
			.map((entry) => `${entry.speaker}: ${entry.text}`)
			.join("\n");

		// Format detected participants if available
		let participantsText = "";
		if (meeting.participants && meeting.participants.length > 0) {
			participantsText =
				"Detected participants:\n" +
				meeting.participants
					.map((p) => `- ${p.name}${p.isHost ? " (Host)" : ""}`)
					.join("\n");
		}

		// Define a system prompt to guide the AI's response with a specific format
		const systemMessage =
			"You are an AI assistant that summarizes meeting transcripts. " +
			"You MUST format your response using the following structure:\n\n" +
			"# Participants\n" +
			"- [List all participants mentioned in the transcript]\n\n" +
			"# Summary\n" +
			"- [Key discussion point 1]\n" +
			"- [Key discussion point 2]\n" +
			"- [Key decisions made]\n" +
			"- [Include any important deadlines or dates mentioned]\n\n" +
			"# Action Items\n" +
			"- [Action item 1] - [Responsible person if mentioned]\n" +
			"- [Action item 2] - [Responsible person if mentioned]\n" +
			"- [Add any other action items discussed]\n\n" +
			"Stick strictly to this format with these exact section headers. Keep each bullet point concise but informative.";

		// Prepare the messages array for the API
		const messages = [
			{ role: "system", content: systemMessage },
			{
				role: "user",
				content: `Summarize the following meeting transcript with the EXACT format specified in your instructions:
${participantsText ? participantsText + "\n\n" : ""}
Transcript:
${transcriptText}`,
			},
		];

		// If no progress callback provided, use the non-streaming version
		if (!progressCallback) {
			// Call the OpenAI API (via OpenRouter) for summarization (non-streaming)
			const response = await openai.chat.completions.create({
				model: MODELS.PRIMARY, // Use our primary model for a good balance of quality and speed
				messages: messages,
				max_tokens: 1000,
				temperature: 0.7,
				fallbacks: MODELS.FALLBACKS, // Use our defined fallback models
				transform_to_openai: true, // Ensures consistent response format across models
				route: "fallback", // Automatically use fallbacks if the primary model is unavailable
			});

			// Log which model was actually used
			console.log(
				`AI summary generated successfully using model: ${response.model}`
			);

			// Return the generated summary
			return response.choices[0].message.content;
		} else {
			// Use streaming version and accumulate the response
			let fullText = "";

			// Create a streaming request
			const stream = await openai.chat.completions.create({
				model: MODELS.PRIMARY, // Use our primary model for a good balance of quality and speed
				messages: messages,
				max_tokens: 1000,
				temperature: 0.7,
				stream: true,
				fallbacks: MODELS.FALLBACKS, // Use our defined fallback models
				transform_to_openai: true, // Ensures consistent response format across models
				route: "fallback", // Automatically use fallbacks if the primary model is unavailable
			});

			// Handle streaming events
			return new Promise((resolve, reject) => {
				// Process the stream
				(async () => {
					try {
						// Log the model being used when first chunk arrives (if available)
						let modelLogged = false;

						for await (const chunk of stream) {
							// Log the model on first chunk if available
							if (!modelLogged && chunk.model) {
								console.log(`Streaming with model: ${chunk.model}`);
								modelLogged = true;
							}

							// Extract the text content from the chunk
							const content = chunk.choices[0]?.delta?.content || "";

							if (content) {
								// Add the new text chunk to our accumulated text
								fullText += content;

								// Log each token for debugging (less verbose)
								if (content.length < 50) {
									console.log(`Received token: "${content}"`);
								} else {
									console.log(`Received content of length: ${content.length}`);
								}

								// Call the progress callback immediately with each token
								if (progressCallback) {
									progressCallback(fullText);
								}
							}
						}

						console.log("AI summary streaming completed");
						resolve(fullText);
					} catch (error) {
						console.error("Stream error:", error);
						reject(error);
					}
				})();
			});
		}
	} catch (error) {
		console.error("Error generating meeting summary:", error);

		// Check if it's an OpenRouter/OpenAI specific error
		if (error.status) {
			return `Error generating summary: API returned status ${error.status}: ${error.message}`;
		} else if (error.response) {
			// Handle errors with a response object
			return `Error generating summary: ${error.response.status} - ${
				error.response.data?.error?.message || error.message
			}`;
		} else {
			// Default error handling
			return `Error generating summary: ${error.message}`;
		}
	}
}

// Function to update a note with recording information when recording ends
async function updateNoteWithRecordingInfo(recordingId) {
	try {
		// Read the current meetings data
		let meetingsData;
		try {
			const fileData = await fs.promises.readFile(meetingsFilePath, "utf8");
			meetingsData = JSON.parse(fileData);
		} catch (error) {
			console.error("Error reading meetings data:", error);
			return;
		}

		// Find the meeting note with this recording ID
		const noteIndex = meetingsData.pastMeetings.findIndex(
			(meeting) => meeting.recordingId === recordingId
		);

		if (noteIndex === -1) {
			console.log("No meeting note found for recording ID:", recordingId);
			return;
		}

		// Format current date
		const now = new Date();
		const formattedDate = now.toLocaleString();

		// Update the meeting note content
		const meeting = meetingsData.pastMeetings[noteIndex];
		const content = meeting.content;

		// Replace the "Recording: In Progress..." line with completed information
		let updatedContent = content.replace(
			"Recording: In Progress...",
			`Recording: Completed at ${formattedDate}\n`
		);

		// Update the meeting object
		meeting.content = updatedContent;
		meeting.recordingComplete = true;
		meeting.recordingEndTime = now.toISOString();

		// Save the initial update
		await fileOperationManager.writeData(meetingsData);

		// Generate AI summary if there's a transcript
		if (meeting.transcript && meeting.transcript.length > 0) {
			console.log(`Generating AI summary for meeting ${meeting.id}...`);

			// Log summary generation to console instead of showing a notification
			console.log("Generating AI summary for meeting: " + meeting.id);

			// Get meeting title for use in the new content
			const meetingTitle = meeting.title || "Meeting Notes";

			// Create initial content with placeholder
			meeting.content = `# ${meetingTitle}\nGenerating summary...`;

			// Notify any open editors immediately
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("summary-update", {
					meetingId: meeting.id,
					content: meeting.content,
				});
			}

			// Create progress callback for streaming updates
			const streamProgress = (currentText) => {
				// Update content with current streaming text
				meeting.content = `# ${meetingTitle}\n\n${currentText}`;

				// Send immediate update to renderer if note is open
				if (mainWindow && !mainWindow.isDestroyed()) {
					try {
						mainWindow.webContents.send("summary-update", {
							meetingId: meeting.id,
							content: meeting.content,
							timestamp: Date.now(), // Add timestamp to ensure uniqueness
						});
					} catch (err) {
						console.error("Error sending streaming update to renderer:", err);
					}
				}
			};

			// Generate the summary with streaming updates
			const summary = await generateMeetingSummary(meeting, streamProgress);

			// Check for different possible video file patterns
			const possibleFilePaths = [
				path.join(RECORDING_PATH, `${recordingId}.mp4`),
				path.join(RECORDING_PATH, `macos-desktop-${recordingId}.mp4`),
				path.join(RECORDING_PATH, `macos-desktop${recordingId}.mp4`),
				path.join(RECORDING_PATH, `desktop-${recordingId}.mp4`),
			];

			// Find the first video file that exists
			let videoExists = false;
			let videoFilePath = null;

			try {
				for (const filePath of possibleFilePaths) {
					if (fs.existsSync(filePath)) {
						videoExists = true;
						videoFilePath = filePath;
						console.log(`Found video file at: ${videoFilePath}`);
						break;
					}
				}
			} catch (err) {
				console.error("Error checking for video files:", err);
			}

			console.log("Attempting to embed video file", videoFilePath);

			// Set the content to just the summary
			meeting.content = `${summary}`;

			// If video exists, store the path separately but don't add it to the content
			if (videoExists) {
				meeting.videoPath = videoFilePath; // Store the path for future reference
				console.log(`Stored video path in meeting object: ${videoFilePath}`);
			} else {
				console.log("Video file not found, continuing without embedding");
			}

			meeting.hasSummary = true;

			// Save the updated data with summary
			await fileOperationManager.writeData(meetingsData);

			console.log("Updated meeting note with AI summary");
		}

		// If the note is currently open, notify the renderer to refresh it
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("recording-completed", meeting.id);
		}
	} catch (error) {
		console.error("Error updating note with recording info:", error);
	}
}

// Function to check if there's a detected meeting available
ipcMain.handle("checkForDetectedMeeting", async () => {
	return detectedMeeting !== null;
});

// Function to join the detected meeting
ipcMain.handle("joinDetectedMeeting", async () => {
	return joinDetectedMeeting();
});

// Function to handle joining a detected meeting
async function joinDetectedMeeting() {
	try {
		console.log("Join detected meeting called");

		if (!detectedMeeting) {
			console.log("No detected meeting available");
			return { success: false, error: "No active meeting detected" };
		}

		// Map platform codes to readable names
		const platformNames = {
			zoom: "Zoom",
			"google-meet": "Google Meet",
			slack: "Slack",
			teams: "Microsoft Teams",
		};

		// Get a user-friendly platform name, or use the raw platform name if not in our map
		const platformName =
			platformNames[detectedMeeting.window.platform] ||
			detectedMeeting.window.platform;

		console.log("Joining detected meeting for platform:", platformName);

		// Ensure main window exists and is visible
		if (!mainWindow || mainWindow.isDestroyed()) {
			console.log("Creating new main window");
			createWindow();
		}

		// Bring window to front with focus
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();

		// Process with more reliable timing
		return new Promise((resolve) => {
			// Wait a moment for the window to be fully focused and ready
			setTimeout(async () => {
				console.log("Window is ready, creating new meeting note");

				try {
					// Create a new meeting note and start recording
					const id = await createMeetingNoteAndRecord(platformName);

					console.log("Created new meeting with ID:", id);
					resolve({ success: true, meetingId: id });
				} catch (err) {
					console.error("Error creating meeting note:", err);
					resolve({ success: false, error: err.message });
				}
			}, 800); // Increased timeout for more reliability
		});
	} catch (error) {
		console.error("Error in joinDetectedMeeting:", error);
		return { success: false, error: error.message };
	}
}
