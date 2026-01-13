# ginkgo-test-adapter

A Visual Studio Code extension that adds Ginkgo test support to the VS Code Test Explorer.

## Features

This extension provides comprehensive support for running and debugging Ginkgo tests in VS Code:

* **Test Explorer Integration**: All Ginkgo tests are automatically discovered and displayed in the VS Code Test Explorer sidebar
* **Code Lens Support**: "▶ Run Test" and "🐛 Debug Test" code lenses appear directly in your test files above each test specification and container
* **Test Execution**: Run individual tests, test containers, or entire test suites from the Test Explorer or Code Lens
* **Debug Support**: Debug Ginkgo tests with full breakpoint support
* **Automatic Test Discovery**: Tests are automatically discovered when you open a workspace containing Ginkgo tests

## Requirements

* [Ginkgo](https://onsi.github.io/ginkgo/) must be installed and available in your PATH
* Go 1.16 or higher

## Using Code Lens

When you open a Ginkgo test file (`*_test.go`), the extension automatically displays Code Lens actions above each test:

* **▶ Run Test**: Executes the test and displays results in the Test Explorer
* **🐛 Debug Test**: Starts a debug session for the test with breakpoint support

Code Lens actions are available for:
* Individual test specifications (`It`, `Specify`, table test entries)
* Test containers (`Describe`, `Context`, `When`)

## Extension Settings

This extension contributes the following settings:

* `ginkgoTestAdapter.ginkgoPath`: Path to the ginkgo executable. Default: `"ginkgo"`
* `ginkgoTestAdapter.environmentVariables`: Environment variables to be set when running/debugging tests via the extension. Default: `{}`
* `ginkgoTestAdapter.buildTags`: Build tags to be set when running/debugging tests via the extension. Default: `[]`

### Configuration Examples

To configure these settings, open your VS Code settings (File > Preferences > Settings) and search for "Ginkgo Test Adapter", or edit your `settings.json` file directly:

```json
{
  "ginkgoTestAdapter.ginkgoPath": "/usr/local/bin/ginkgo",
  "ginkgoTestAdapter.environmentVariables": {
    "CGO_ENABLED": "0",
    "GOOS": "linux"
  },
  "ginkgoTestAdapter.buildTags": ["integration", "e2e"]
}
```

## Known Issues

Please report issues on the [GitHub repository](https://github.com/jrussellsmyth/ginkgo-test-adapter/issues).

## Release Notes

### 0.0.1

Initial release with:
* Test Explorer integration
* Code Lens support for run and debug actions
* Automatic test discovery
* Support for test containers and individual specs

---

**Enjoy!**
