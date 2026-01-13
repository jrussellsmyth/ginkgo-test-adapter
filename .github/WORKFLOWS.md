# GitHub Actions Workflows

This repository includes two GitHub Actions workflows for automated building, testing, and packaging.

## CI Workflow

**File:** `.github/workflows/ci.yml`

**Triggers:**
- Push to `main` branch
- Pull requests to `main` branch

**Purpose:**
Runs continuous integration tests to ensure code quality and compatibility across platforms.

**Actions:**
1. Checks out code
2. Sets up Node.js 20.x
3. Installs dependencies
4. Compiles TypeScript
5. Runs ESLint
6. Runs tests (on Linux only, due to VS Code test requirements)

**Matrix Testing:**
Tests run on three platforms:
- Ubuntu (latest)
- Windows (latest)
- macOS (latest)

## Package Workflow

**File:** `.github/workflows/package.yml`

**Triggers:**
- Release creation
- Manual workflow dispatch (via GitHub Actions UI)

**Purpose:**
Packages the extension into a `.vsix` file for distribution.

**Actions:**
1. Checks out code
2. Sets up Node.js 20.x
3. Installs dependencies
4. Compiles TypeScript
5. Runs ESLint
6. Installs `@vscode/vsce` (VS Code Extension Manager)
7. Packages extension using `vsce package`
8. Uploads `.vsix` artifact (90-day retention)

## Using the Workflows

### Running CI
The CI workflow runs automatically on every push and pull request to the main branch.

### Creating a Package
To create a packaged extension:

1. **On Release:** Create a new release on GitHub, and the workflow will automatically run.

2. **Manual Trigger:** 
   - Go to the "Actions" tab in GitHub
   - Select "Package Extension" workflow
   - Click "Run workflow"
   - Choose the branch to package
   - Click "Run workflow"

3. **Download the artifact:**
   - After the workflow completes, find it in the workflow run
   - Download the `ginkgo-test-adapter-vsix` artifact
   - Extract the `.vsix` file

### Installing the Packaged Extension
```bash
code --install-extension ginkgo-test-adapter-0.0.1.vsix
```

## Security

Both workflows follow security best practices:
- Use explicit `contents: read` permissions (principle of least privilege)
- Pin action versions for reproducibility
- Use `npm ci` for consistent dependency installation

## Future Enhancements

Consider adding:
- A LICENSE file to eliminate the `--skip-license` flag in packaging
- Cross-platform test support if VS Code test infrastructure allows
- Automatic publishing to VS Code Marketplace on release
