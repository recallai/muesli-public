# GitHub Actions Workflows

This directory contains GitHub Actions workflows for automating the build and release process of the Muesli application.

## Workflows

### 1. Build and Release (`build-release.yml`)

**Triggers:**
- **Production Branch**: Automatically triggers when you push to the `production` branch
- **Manual Trigger**: Can be triggered manually from GitHub Actions tab

**What it does:**

- Builds the application for Windows, macOS, and Linux
- Creates installers and portable versions for each platform
- Creates a GitHub release with all build artifacts
- Uploads build files as release assets

**Supported Output Formats:**

**Windows:**

- `.exe` - NSIS installer
- `.exe` - Portable executable
- `-win.zip` - Portable zip archive

**macOS:**

- `.dmg` - Disk image installer
- `-mac.zip` - Portable zip archive

**Linux:**

- `.AppImage` - Universal Linux executable
- `.deb` - Debian/Ubuntu package
- `.tar.gz` - Archive file

### 2. Test Build (`test-build.yml`)

**Triggers:**

- Pull requests to main/master branch
- Pushes to main/master branch

**What it does:**

- Runs build tests on Linux
- Verifies that the application builds successfully
- Creates test artifacts for verification

## How to Create a Release

### Method 1: Using Production Branch (Recommended)

1. **Prepare your changes on a development branch:**
   ```bash
   git add .
   git commit -m "feat: new features for release"
   git push origin your-feature-branch
   ```

2. **Merge to production branch:**
   ```bash
   git checkout production
   git merge your-feature-branch
   git push origin production
   ```

3. **The workflow will automatically:**
   - Build for all platforms
   - Create a GitHub release with version from package.json + timestamp
   - Upload all build artifacts

### Method 2: Manual Trigger

1. Go to your repository on GitHub
2. Click on **Actions** tab
3. Select **Build and Release** workflow
4. Click **Run workflow**
5. Choose release type (draft/prerelease/release)
6. Click **Run workflow**

## Configuration

### Electron Builder Settings

The build configuration is in `package.json` under the `"build"` section:

```json
{
	"build": {
		"appId": "com.axoblade.muesli",
		"productName": "Muesli",
		"publish": {
			"provider": "github",
			"owner": "axoblade",
			"repo": "muesli-public"
		}
	}
}
```

### Code Signing

Currently, code signing is disabled for simplicity:

- **macOS**: `CSC_IDENTITY_AUTO_DISCOVERY: false`
- **Windows**: No code signing configured

To enable code signing, you would need to:

1. Add certificates to GitHub Secrets
2. Configure signing in the workflow
3. Update Electron Builder configuration

## Troubleshooting

### Build Failures

1. **Check the Actions tab** for detailed error logs
2. **Common issues:**
   - Missing dependencies
   - Node.js version compatibility
   - Platform-specific build errors

### Missing Artifacts

1. Verify the `release/` directory is being created
2. Check file path patterns in workflow
3. Ensure Electron Builder is generating expected file names

### Release Issues

1. Check repository permissions
2. Verify `GITHUB_TOKEN` has sufficient permissions
3. Ensure you're pushing to the `production` branch
4. Check that package.json has a valid version number

## Files Generated

After a successful build, you'll find files in the `release/` directory:

```
release/
├── Muesli Setup 1.0.0.exe          # Windows installer
├── Muesli 1.0.0.exe                # Windows portable
├── Muesli-1.0.0-win.zip           # Windows zip
├── Muesli-1.0.0.dmg                # macOS installer
├── Muesli-1.0.0-mac.zip           # macOS zip
├── Muesli-1.0.0.AppImage           # Linux AppImage
├── muesli_1.0.0_amd64.deb          # Linux DEB
└── Muesli-1.0.0.tar.gz             # Linux archive
```

**Release Naming:**
- **Production branch releases**: `v1.0.0-20251002-143000` (package.json version + timestamp)
- **Manual releases**: `v20251002-143000` (timestamp-based)

## Next Steps

1. **Test the workflow** by pushing to the production branch
2. **Set up a development workflow** with feature branches merging to production
3. **Customize release notes** in the workflow file
4. **Set up code signing** for production releases
5. **Configure auto-update** functionality if desired

## Development Workflow

**Recommended Git Flow:**
1. Create feature branches from `main` or development branch
2. Make your changes and test locally
3. Create pull requests to review changes
4. Merge approved changes to `production` branch for releases
5. Workflow automatically builds and creates releases
