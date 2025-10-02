const path = require("path");
const nodeExternals = require("webpack-node-externals");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

const baseConfig = {
	mode: process.env.NODE_ENV || "development",
	devtool: "source-map",
	resolve: {
		extensions: [".js", ".jsx", ".json"],
	},
	output: {
		path: path.join(__dirname, "dist"),
	},
};

const mainConfig = {
	...baseConfig,
	target: "electron-main",
	entry: "./src/main.js",
	output: {
		...baseConfig.output,
		filename: "main.js",
	},
	externals: [
		nodeExternals(),
		{
			"@recallai/desktop-sdk": "commonjs @recallai/desktop-sdk",
		},
	],
	module: {
		rules: [
			{
				test: /native_modules[/\\].+\.node$/,
				use: "node-loader",
			},
			{
				test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
				parser: { amd: false },
				use: {
					loader: "@vercel/webpack-asset-relocator-loader",
					options: {
						outputAssetBase: "native_modules",
					},
				},
			},
		],
	},
};

const rendererConfig = {
	...baseConfig,
	target: "electron-renderer",
	entry: {
		renderer: "./src/renderer.js",
		"note-editor/renderer": "./src/pages/note-editor/renderer.js",
	},
	output: {
		...baseConfig.output,
		filename: "[name].js",
	},
	node: {
		__dirname: false,
		__filename: false,
	},
	plugins: [
		new MiniCssExtractPlugin({
			filename: "[name].css",
		}),
		new HtmlWebpackPlugin({
			template: "./src/index.html",
			filename: "index.html",
			chunks: ["renderer"],
		}),
		new HtmlWebpackPlugin({
			template: "./src/pages/note-editor/index.html",
			filename: "note-editor/index.html",
			chunks: ["note-editor/renderer"],
		}),
		new CopyWebpackPlugin({
			patterns: [
				{ from: "src/assets", to: "assets" },
				{
					from: "src/pages/note-editor/styles.css",
					to: "note-editor/styles.css",
				},
			],
		}),
	],
	module: {
		rules: [
			{
				test: /\.css$/,
				use: [MiniCssExtractPlugin.loader, "css-loader"],
			},
			{
				test: /native_modules[/\\].+\.node$/,
				use: "node-loader",
			},
		],
	},
};

const preloadConfig = {
	...baseConfig,
	target: "electron-preload",
	entry: "./src/preload.js",
	output: {
		...baseConfig.output,
		filename: "preload.js",
	},
	externals: [nodeExternals()],
};

module.exports = [mainConfig, rendererConfig, preloadConfig];
